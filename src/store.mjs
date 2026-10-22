import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { await fs.rename(tmp, file); }
  catch (error) {
    await fs.unlink(tmp).catch(() => {});
    if (['EPERM', 'EACCES'].includes(error.code)) throw new Error(`不能原子保存 ${file}；请使用当前进程可写的工作目录，或解除该文件的占用。未回退为直接覆盖原文件。`, { cause: error });
    throw error;
  }
}

export class Store {
  constructor(config) { this.config = config; this.root = config.dataRoot; }
  directory(id) {
    if (!/^p_[a-f0-9]{32}$/.test(id)) throw new Error('无效项目编号。');
    return path.join(this.root, id);
  }
  async load(id, owner) {
    const p = JSON.parse(await fs.readFile(path.join(this.directory(id), 'project.json'), 'utf8'));
    if (!owner || p.owner !== owner) throw new Error('此项目不属于当前对话。');
    return p;
  }
  async update(id, owner, change) {
    const dir = this.directory(id), lockPath = path.join(dir, '.write-lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('项目正在更新；若上次程序崩溃，请先使用恢复功能。'); throw e; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      const p = await this.load(id, owner);
      const next = await change(p) || p;
      next.updatedAt = new Date().toISOString();
      await writeJson(path.join(dir, 'project.json'), next);
      return next;
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }
  async input(source, destination) {
    if (!path.isAbsolute(source)) throw new Error('素材必须使用绝对路径。');
    const real = await fs.realpath(source);
    let allowed = false;
    for (const root of [...this.config.inputRoots, this.root]) {
      try { if (inside(await fs.realpath(root), real)) allowed = true; } catch { /* absent root */ }
    }
    if (!allowed) throw new Error('素材不在允许的目录中。请在插件 inputRoots 中添加其父目录，或使用已上传的附件。');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > this.config.maxInputMiB * 1048576) throw new Error('素材不是普通文件，或超过配置的大小上限。');
    const ext = path.extname(real).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.mkv', '.webm', '.wav', '.flac', '.mp3', '.m4a', '.glb', '.gltf', '.obj', '.fbx', '.ply', '.stl'].includes(ext)) {
      const fd = await fs.open(real); const header = Buffer.alloc(16);
      try { await fd.read(header, 0, 16, 0); } finally { await fd.close(); }
      const image = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png'
        : header[0] === 255 && header[1] === 216 ? '.jpg'
          : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : null;
      if (!image) throw new Error('不支持的素材格式；NCM 需要先取得可解码的标准音频副本。');
      destination += image;
    } else destination += ext;
    await fs.copyFile(real, destination, 1);
    return { path: destination, originalName: path.basename(source), bytes: stat.size, sha256: await fileDigest(destination) };
  }
  async create(owner, brief, sourceType, files, hardware) {
    if (!owner || !brief?.trim()) throw new Error('需要当前对话身份与建模需求。');
    if (!['text', 'image', 'video'].includes(sourceType)) throw new Error('输入类型只能是 text、image 或 video。');
    if (files.length > 12) throw new Error('一次最多添加 12 个参考文件。');
    const id = `p_${randomUUID().replaceAll('-', '')}`, dir = this.directory(id);
    await fs.mkdir(path.join(dir, 'inputs'), { recursive: true });
    const inputs = [];
    for (let i = 0; i < files.length; i++) inputs.push(await this.input(files[i], path.join(dir, 'inputs', `reference-${i}`)));
    if (sourceType !== 'text' && !inputs.length) throw new Error('图片或视频模式需要参考文件。');
    const now = new Date().toISOString();
    const p = { id, owner, brief: brief.trim(), sourceType, inputs, hardware, revision: 0, state: 'draft',
      requirements: {}, interview: [], approval: null, plan: null, samples: [], activeJob: null,
      createdAt: now, updatedAt: now };
    await writeJson(path.join(dir, 'project.json'), p);
    return p;
  }
  async ownFile(id, file) {
    const base = await fs.realpath(this.directory(id)), real = await fs.realpath(file);
    if (!inside(base, real) || !(await fs.stat(real)).isFile()) throw new Error('产物必须是项目内的普通文件。');
    return real;
  }
  async releaseStaleLock(id, owner) {
    await this.load(id, owner);
    const lockPath = path.join(this.directory(id), '.write-lock');
    let record;
    try { record = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw new Error('锁记录无法解析，未自动删除。'); }
    if (!Number.isInteger(record.pid) || record.pid < 1) throw new Error('锁记录没有可靠的进程编号，未自动删除。');
    try { process.kill(record.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') { await fs.unlink(lockPath); return; }
      throw new Error('不能确认锁的原进程已经退出，未自动解除。');
    }
    throw new Error('锁的所属进程仍存在，请等待其退出；不会覆盖其他正在写入的任务。');
  }
}
