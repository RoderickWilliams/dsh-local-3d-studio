// Three.js / glTF 模型读取与修改的宿主侧封装：
// - 依赖（three、@gltf-transform/*）隔离安装在 <dataRoot>/_dependencies/nodejs
// - 真正的解析/改写/导出在 workers/model_edit.mjs 子进程里完成
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../workers/model_edit.mjs', import.meta.url));
const PACKAGES = ['three@0.181.0', '@gltf-transform/core@4', '@gltf-transform/extensions@4', '@gltf-transform/functions@4'];
const OPS = new Set(['transform', 'material', 'rename', 'remove', 'duplicate', 'scaleTo', 'center']);

export function nodeDepsDir(config) {
  return path.join(config.dataRoot, '_dependencies', 'nodejs');
}

export async function depsReady(config) {
  const dir = nodeDepsDir(config);
  for (const name of ['three', '@gltf-transform/core']) {
    try { await fs.access(path.join(dir, 'node_modules', name, 'package.json')); }
    catch { return { installed: false, dir, missing: name }; }
  }
  return { installed: true, dir };
}

function npmCommand() {
  // DSH 里的 process.execPath 未必是 nodejs 安装目录（可能是自带运行时），
  // 所以按「找 npm-cli.js 用 node 直接跑」优先，找不到才退回 npm.cmd。
  const cli = findNpmCli();
  if (cli) return { command: process.execPath, prefix: [cli] };
  if (process.platform === 'win32') {
    const local = path.join(path.dirname(process.execPath), 'npm.cmd');
    return { command: local, prefix: [] };
  }
  return { command: 'npm', prefix: [] };
}

function findNpmCli() {
  const exists = candidate => { try { return fsSync.existsSync(candidate) && candidate; } catch { return false; } };
  const candidates = [];
  if (process.env.npm_execpath && process.env.npm_execpath.endsWith('.js')) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const base of ['C:/Program Files/nodejs', 'C:/Program Files (x86)/nodejs', process.env.APPDATA && path.join(process.env.APPDATA, 'npm')]) {
    if (base) candidates.push(path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  try {
    const where = execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const first = where.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    if (first) candidates.push(path.join(path.dirname(first), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  } catch { /* 找不到 npm 时退回默认命令 */ }
  return candidates.find(exists) || '';
}

async function runProcess(command, args, { cwd, env, signal, timeoutMs = 600000 } = {}) {
  // Windows 下若最终仍是 .cmd（npm.cmd），Node 24 禁止无 shell 直接 spawn（EINVAL），
  // 统一经 cmd.exe /d /s /c，并把整条命令再包一层引号（/s 会剥掉最外层）。
  const useCmd = process.platform === 'win32' && /\.cmd$/i.test(command);
  const quote = value => `"${String(value).replace(/"/g, '\\"')}"`;
  const spawnCommand = useCmd ? (process.env.ComSpec || 'cmd.exe') : command;
  const spawnArgs = useCmd
    ? ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`]
    : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd, env: { ...process.env, ...env }, windowsHide: true,
      windowsVerbatimArguments: useCmd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`命令超时：${command} ${args.join(' ')}`)); }, timeoutMs);
    const onAbort = () => { child.kill(); reject(new Error('已取消。')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

export async function provision(config, { signal } = {}) {
  const dir = nodeDepsDir(config);
  await fs.mkdir(dir, { recursive: true });
  const pkgFile = path.join(dir, 'package.json');
  await fs.writeFile(pkgFile, JSON.stringify({ name: 'studio-nodejs-deps', private: true, type: 'module' }, null, 2), 'utf8');
  const { command, prefix } = npmCommand();
  const result = await runProcess(command, [...prefix, 'install', ...PACKAGES, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, signal });
  if (result.code !== 0) throw new Error(`安装 three/glTF 依赖失败（退出码 ${result.code}）：${result.stderr.trim().slice(-1200)}`);
  const ready = await depsReady(config);
  if (!ready.installed) throw new Error(`依赖安装后仍缺少：${ready.missing}`);
  return { installed: true, dir, packages: PACKAGES, log: result.stdout.trim().slice(-800) };
}

export async function runWorker(config, request, { signal, timeoutMs = 180000 } = {}) {
  const ready = await depsReady(config);
  if (!ready.installed) throw new Error('还没有安装 three/glTF 依赖。先调用 studio_three action=setup（本机网络安装，约几十 MB）。');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: { ...process.env, STUDIO_NODE_DEPS: ready.dir }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('模型处理超时。')); }, timeoutMs);
    const onAbort = () => { child.kill(); reject(new Error('已取消。')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      const line = out.split(/\r?\n/).reverse().find(item => item.startsWith('__RESULT__'));
      if (!line) return reject(new Error(`模型 worker 没有返回结果（退出码 ${code}）：${(err || out).trim().slice(-1200)}`));
      let payload;
      try { payload = JSON.parse(line.slice('__RESULT__'.length)); }
      catch (error) { return reject(new Error(`模型 worker 返回的 JSON 无法解析：${error.message}`)); }
      if (!payload.ok) return reject(new Error(payload.error || '模型处理失败。'));
      resolve(payload);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function validateOps(ops) {
  if (!Array.isArray(ops)) throw new Error('ops 必须是数组。');
  if (ops.length > 64) throw new Error('一次最多 64 个修改操作。');
  return ops.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`第 ${index + 1} 个操作必须是对象。`);
    const op = String(raw.op || '');
    if (!OPS.has(op)) throw new Error(`第 ${index + 1} 个操作不支持：${op || '(空)'}；可用 ${[...OPS].join('、')}。`);
    if (['transform', 'rename', 'remove', 'duplicate'].includes(op) && !String(raw.node || '').trim()) throw new Error(`操作 ${op} 需要 node。`);
    if (op === 'material' && !(typeof raw.material === 'number' ? Number.isInteger(raw.material) && raw.material >= 0 : String(raw.material || '').trim())) throw new Error('material 操作需要 material 名称或从 0 开始的序号。');
    const vectors = ['translation', 'rotation', 'scale'];
    for (const key of vectors) {
      if (raw[key] === undefined) continue;
      const value = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
      if (!value.every(item => Number.isFinite(Number(item)))) throw new Error(`${op}.${key} 必须是有限数字。`);
    }
    if (op === 'material') {
      for (const key of ['metallic', 'roughness', 'alpha']) {
        if (raw[key] !== undefined && !Number.isFinite(Number(raw[key]))) throw new Error(`material.${key} 必须是数字。`);
      }
      for (const key of ['baseColor', 'emissive']) {
        if (raw[key] !== undefined && !/^#[0-9a-f]{6}$/i.test(String(raw[key]))) throw new Error(`material.${key} 必须是 #RRGGBB。`);
      }
    }
    if (op === 'scaleTo' && !(Number(raw.size) > 0)) throw new Error('scaleTo.size 必须是正数。');
    return { ...raw, op };
  });
}

const PRIMITIVES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane']);

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec 必须是对象，形如 { objects: [...] }。');
  const objects = spec.objects;
  if (!Array.isArray(objects) || objects.length === 0) throw new Error('spec.objects 必须是非空数组。');
  if (objects.length > 128) throw new Error('一次最多 128 个图元。');
  objects.forEach((item, index) => {
    const at = `第 ${index + 1} 个图元`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${at}必须是对象。`);
    const type = String(item.type || 'box').toLowerCase();
    if (!PRIMITIVES.has(type)) throw new Error(`${at}类型不支持：${type}；可用 ${[...PRIMITIVES].join('、')}。`);
    for (const key of ['size', 'position', 'rotation', 'scale']) {
      if (item[key] === undefined) continue;
      if (!Array.isArray(item[key]) || !item[key].every(v => Number.isFinite(Number(v)))) throw new Error(`${at}.${key} 必须是有限数字数组。`);
      if ((key === 'size' || key === 'scale') && !item[key].every(v => Number(v) > 0)) throw new Error(`${at}.${key} 必须为正数。`);
    }
    for (const key of ['radius', 'radiusTop', 'radiusBottom', 'height', 'tube']) {
      if (item[key] === undefined) continue;
      const value = Number(item[key]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${at}.${key} 必须是正数。`);
    }
    if (item.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(item.color))) throw new Error(`${at}.color 必须是 #RRGGBB。`);
    if (item.opacity !== undefined && !(Number(item.opacity) >= 0 && Number(item.opacity) <= 1)) throw new Error(`${at}.opacity 必须在 0 到 1 之间。`);
  });
  return { ...spec, objects };
}

export function generatedOutputFor(config, name) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safe = String(name || 'model').replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').slice(0, 40) || 'model';
  return path.join(config.dataRoot, '_samples', `${safe}-${stamp}.glb`);
}

export async function generateModel(config, spec, outputPath, { signal } = {}) {
  return await runWorker(config, { action: 'generate', spec, outputPath }, { signal, timeoutMs: 120000 });
}

export async function resolveModelPath(config, value) {
  if (!value || typeof value !== 'string') throw new Error('需要 modelPath。');
  const candidate = path.isAbsolute(value) ? value : path.resolve(config.projectRoots[0] || process.cwd(), value);
  const resolved = path.resolve(candidate);
  try { await fs.access(resolved); }
  catch { throw new Error(`模型文件不存在：${resolved}`); }
  return resolved;
}

export function viewerPathFor(modelPath) {
  const dir = path.dirname(modelPath);
  const base = path.basename(modelPath, path.extname(modelPath));
  return path.join(dir, `${base}.viewer.html`);
}

export function defaultOutputFor(modelPath) {
  const dir = path.dirname(modelPath);
  const base = path.basename(modelPath, path.extname(modelPath));
  return path.join(dir, `${base}.edited.glb`);
}
