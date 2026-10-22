import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executable, run } from './process.mjs';
import { inside, writeJson } from './store.mjs';

export const upstreams = Object.freeze({
  blenderwright: { url: 'https://github.com/HoldMyBeer-gg/blenderwright.git', license: 'MIT', capabilities: ['modeling', 'animation', 'rendering'], python: '>=3.10' },
  triposr: { url: 'https://github.com/VAST-AI-Research/TripoSR.git', license: 'MIT', capabilities: ['image-to-3d'], weights: 'stabilityai/TripoSR', minVramMiB: 6144 },
  hunyuan: { url: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git', license: '腾讯原始模型许可，见上游 LICENSE', capabilities: ['image-to-3d', 'pbr'], weights: 'tencent/Hunyuan3D-2.1', minVramMiB: 10240 },
  comfyui: { url: 'https://github.com/Comfy-Org/ComfyUI.git', license: 'GPL-3.0；所用权重各有许可', capabilities: ['text-to-image', 'workflow'] },
  media: { url: 'https://pypi.org/project/librosa/0.11.0/', license: 'ISC；依赖保留各自许可', capabilities: ['music-beats'], packages: ['librosa==0.11.0'] },
});
const excluded = new Set(['.git', '.venv', 'venv', 'node_modules', 'models', 'weights', 'inputs', 'outputs', '__pycache__', '.reference', '.cache']);
async function exists(p) { try { return (await fs.stat(p)).isFile(); } catch { return false; } }

export function validateAdapter(a, base) {
  if (a?.schemaVersion !== 1 || !/^[a-z][a-z0-9_-]{1,47}$/.test(a.id || '')) throw new Error('适配声明需要 schemaVersion: 1 和有效 id。');
  if (a.localOnly !== true) throw new Error('适配声明必须明确 localOnly: true；不自动接入需要云端充值的项目。');
  if (Object.hasOwn(upstreams, a.id)) throw new Error('自定义适配器请使用独立 id，避免覆盖官方适配器入口。');
  if (!Array.isArray(a.capabilities) || !a.capabilities.length || !a.capabilities.every(x => typeof x === 'string')) throw new Error('适配声明缺少 capabilities。');
  if (!['command', 'comfyui'].includes(a.kind)) throw new Error('适配器 kind 只能是 command 或 comfyui。');
  if (a.kind === 'command' && (typeof a.command !== 'string' || !Array.isArray(a.args) || !a.args.every(x => typeof x === 'string'))) throw new Error('命令适配器需要 command 和 args 数组，不执行 shell 字符串。');
  if (a.kind === 'comfyui' && typeof a.workflow !== 'string') throw new Error('ComfyUI 适配器需要 API 格式 workflow 文件。');
  if (!Array.isArray(a.outputs) || !a.outputs.length || a.outputs.some(x => !x.path || path.isAbsolute(x.path) || !inside(base, path.resolve(base, x.path)))) throw new Error('outputs 必须列出输出目录内的相对文件路径。');
  if (a.minVramMiB !== undefined && (!Number.isInteger(a.minVramMiB) || a.minVramMiB < 0)) throw new Error('minVramMiB 必须是非负整数。');
  return { ...a, root: base, source: 'user-local', preferred: true };
}

export async function inventory(config) {
  const records = [], visited = new Set(); let scanned = 0;
  const managed = await fs.readFile(path.join(config.dataRoot, 'dependencies.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const explicit = [...config.preferredProjects, config.blenderwrightRepo, config.triposrRepo, config.hunyuanRepo].filter(Boolean);
  const roots = [...explicit, ...config.projectRoots, ...Object.values(managed).map(x => x.root)];
  if (managed.media?.pythonPath) records.push({ ...upstreams.media, ...managed.media, source: 'managed', preferred: false });
  async function walk(dir, depth, preferred) {
    if (scanned++ > 600 || visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const manifest = path.join(dir, 'local-3d.adapter.json');
    if (entries.some(e => e.name === 'local-3d.adapter.json')) {
      try { records.push(validateAdapter(JSON.parse(await fs.readFile(manifest, 'utf8')), dir)); }
      catch (e) { records.push({ id: `invalid-${records.length}`, root: dir, invalid: e.message }); }
    }
    for (const [id, markers] of Object.entries({ blenderwright: ['src/blenderwright/server.py'], triposr: ['tsr/system.py'], hunyuan: ['hy3dshape/hy3dshape/pipelines.py', 'hy3dshape/pipelines.py'], comfyui: ['comfy/sd.py'] })) {
      if ((await Promise.all(markers.map(marker => exists(path.join(dir, marker))))).some(Boolean)) {
        const saved = Object.values(managed).find(x => path.resolve(x.root) === path.resolve(dir));
        const py = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        records.push({ id, root: dir, ...upstreams[id], source: saved ? 'managed' : 'local', preferred,
          pythonPath: saved?.pythonPath || (await exists(py) ? py : null), weightsPath: saved?.weightsPath || '', commit: saved?.commit || null });
        return;
      }
    }
    if (depth <= 0) return;
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name) && !entry.name.startsWith('p_')) {
      await walk(path.join(dir, entry.name), depth - 1, preferred);
    }
  }
  for (const root of roots) await walk(path.resolve(root), explicit.includes(root) ? 0 : 2, explicit.includes(root));
  // 用户明确指定 > 用户的适配声明 > 已有本地项目 > 插件托管副本。
  records.sort((a, b) => Number(!!b.preferred) - Number(!!a.preferred) || Number(a.source === 'managed') - Number(b.source === 'managed'));
  return { projects: records, scanned, truncated: scanned > 600,
    missing: Object.keys(upstreams).filter(id => !records.some(x => x.id === id && !x.invalid)) };
}

export async function provision(id, config, { localRoot, downloadWeights = false, signal, onOutput = () => {} } = {}) {
  const recipe = upstreams[id];
  if (!recipe) throw new Error('仅自动获取登记过的官方上游项目；自定义项目通过本地适配声明接入。');
  const all = await inventory(config);
  let selected = all.projects.find(x => x.id === id && (!localRoot || path.resolve(x.root) === path.resolve(localRoot)));
  if (localRoot && !selected) throw new Error('所选本地目录不匹配已识别的项目，已停止。');
  if (selected?.pythonPath && (!downloadWeights || selected.weightsPath)) return { ...selected, reused: true };
  const py = await executable(config.aiPython);
  if (!py) throw new Error('缺少 Python。请配置 aiPython；插件不会安装系统级 Python 或改变管理员配置。');
  const depRoot = path.join(config.dataRoot, '_dependencies');
  await fs.mkdir(depRoot, { recursive: true });
  let root = selected?.root, commit = null;
  if (!root && !recipe.packages) {
    const git = await executable('git');
    if (!git) throw new Error('缺少 Git。请先安装 Git 或在 preferredProjects 中指定已有源码目录。');
    root = path.join(depRoot, `${id}-${randomUUID().slice(0, 8)}`);
    await run(git, ['clone', '--depth', '1', '--', recipe.url, root], { signal, timeoutMs: 600000, onOutput,
      env: { GIT_TERMINAL_PROMPT: '0' } });
    commit = (await run(git, ['-C', root, 'rev-parse', 'HEAD'], { signal, timeoutMs: 10000 })).stdout.trim();
  }
  // 独立环境永远建在插件自己的目录，用户已有仓库及环境不被改写。
  const envDir = path.join(depRoot, `${id}-env-${randomUUID().slice(0, 8)}`);
  await run(py, ['-m', 'venv', envDir], { signal, timeoutMs: 120000, onOutput });
  const pythonPath = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  root ||= envDir;
  const options = { signal, timeoutMs: config.taskTimeoutMinutes * 60000, onOutput, cwd: root };
  if (recipe.packages) await run(pythonPath, ['-m', 'pip', 'install', ...recipe.packages], options);
  else if (id === 'blenderwright') await run(pythonPath, ['-m', 'pip', 'install', root], options);
  else await run(pythonPath, ['-m', 'pip', 'install', '-r', path.join(root, 'requirements.txt')], options);
  let weightsPath = selected?.weightsPath || '';
  if (downloadWeights && recipe.weights) {
    await run(pythonPath, ['-m', 'pip', 'install', 'huggingface_hub'], options);
    weightsPath = path.join(depRoot, `${id}-weights`);
    const worker = new URL('../workers/download_weights.py', import.meta.url);
    await run(pythonPath, [fileURLToPath(worker), recipe.weights, weightsPath], {
      ...options, env: { HF_HUB_OFFLINE: '0', TRANSFORMERS_OFFLINE: '0' } });
  }
  const freeze = (await run(pythonPath, ['-m', 'pip', 'freeze'], options)).stdout;
  const record = { id, root, pythonPath, weightsPath, commit, url: recipe.url, source: selected ? 'local' : 'managed', installedAt: new Date().toISOString() };
  await fs.writeFile(path.join(envDir, 'installed-packages.txt'), freeze);
  const statePath = path.join(config.dataRoot, 'dependencies.json');
  const state = await fs.readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
  state[id] = record;
  await writeJson(statePath, state);
  return record;
}
