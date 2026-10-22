import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { executable, run } from './process.mjs';

export function parseNvidia(csv) {
  return csv.trim().split(/\r?\n/).flatMap(line => {
    const fields = line.match(/(?:"[^"]*"|[^,])+/g)?.map(x => x.trim().replace(/^"|"$/g, ''));
    if (!fields || fields.length < 3) return [];
    const memoryMiB = Number(fields[1]), freeMiB = Number(fields[2]);
    return [{ name: fields[0], vendor: 'NVIDIA', dedicatedMiB: Number.isFinite(memoryMiB) ? memoryMiB : null,
      freeMiB: Number.isFinite(freeMiB) ? freeMiB : null, source: 'nvidia-smi' }];
  });
}

export function recommend(report, config) {
  const candidates = report.gpus.filter(g => Number.isFinite(g.dedicatedMiB));
  const best = candidates.sort((a, b) => Math.min(b.dedicatedMiB, b.freeMiB ?? b.dedicatedMiB) - Math.min(a.dedicatedMiB, a.freeMiB ?? a.dedicatedMiB))[0];
  const vram = best?.dedicatedMiB ?? null;
  const free = best?.freeMiB ?? vram;
  const usable = free === null ? null : Math.min(free, vram);
  const tier = usable === null ? 'unknown' : usable < 6144 ? 'basic' : usable < 10240 ? 'balanced' : usable < 21504 ? 'shape' : usable < 29696 ? 'texture' : 'full';
  const width = ['unknown', 'basic'].includes(tier) ? 1280 : 1920;
  const optional = [];
  if (usable !== null && usable >= 6144) optional.push('triposr');
  if (usable !== null && usable >= 10240) optional.push('hunyuan');
  return { tier, gpuName: best?.name || null, dedicatedMiB: vram, usableMiB: usable,
    defaultBackend: 'blenderwright', optionalBackends: optional,
    render: { width, height: Math.round(width * 9 / 16), fps: 24, seconds: 8, samples: tier === 'full' ? 128 : 64,
      device: best ? 'AUTO' : 'CPU' },
    notes: [
      'Blender 程序化建模不依赖三维生成模型权重；显存阈值是保守路由依据，不代表推理必然成功。',
      ...(vram === null ? ['未取得可靠的独立显存容量，保留未知值并使用保守方案。'] : []),
      ...(vram !== null && free < vram * 0.7 ? ['其他程序占用了部分显存，方案按当前可用容量收缩。'] : []),
      ...(config.hunyuanPaint && (usable === null || usable < 29696) ? ['Hunyuan 2.1 完整形状+贴图官方基线约 29GB；此机不默认启用完整链路。'] : []),
      '可用内存、驱动、模型版本和场景大小也会影响生成。',
    ],
  };
}

export async function discover(config, signal) {
  const notes = [], gpus = [];
  const nvidia = await executable('nvidia-smi', [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'NVIDIA Corporation/NVSMI/nvidia-smi.exe')]);
  if (nvidia) {
    try { gpus.push(...parseNvidia((await run(nvidia, ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { signal, timeoutMs: 6000 })).stdout)); }
    catch (e) { notes.push(e.message); }
  }
  if (!gpus.length && process.platform === 'win32') {
    const wmic = await executable('wmic.exe', [path.join(process.env.SystemRoot || 'C:/Windows', 'System32/wbem/WMIC.exe')]);
    if (wmic) try {
      const r = await run(wmic, ['path', 'win32_VideoController', 'get', 'Name', '/value'], { signal, timeoutMs: 6000 });
      for (const m of r.stdout.matchAll(/Name=(.+)/g)) gpus.push({ name: m[1].trim(), vendor: 'unknown', dedicatedMiB: null, freeMiB: null, source: 'wmic-name-only' });
    } catch { notes.push('Windows 未提供可用的显卡名称接口。'); }
    if (!gpus.length) {
      const reg = await executable('reg.exe');
      if (reg) try {
        const data = (await run(reg, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Video', '/s', '/v', 'DriverDesc'], { signal, timeoutMs: 6000 })).stdout;
        const names = new Set([...data.matchAll(/DriverDesc\s+REG_SZ\s+(.+)/g)].map(m => m[1].trim()));
        for (const name of names) gpus.push({ name, vendor: 'unknown', dedicatedMiB: null, freeMiB: null, source: 'windows-driver-name-only' });
      } catch { notes.push('Windows 显卡名称仍不可用；未猜测型号或显存。'); }
    }
  }
  if (!gpus.length && process.platform === 'darwin') {
    const sp = await executable('system_profiler');
    if (sp) try {
      const data = JSON.parse((await run(sp, ['SPDisplaysDataType', '-json'], { signal, timeoutMs: 12000 })).stdout);
      for (const gpu of data.SPDisplaysDataType || []) gpus.push({ name: gpu.sppci_model || gpu._name, vendor: 'Apple/other', dedicatedMiB: null, freeMiB: null, source: 'system_profiler' });
      notes.push('统一内存不当作独立显存；本机模型能力需要单独确认。');
    } catch { notes.push('未能解析 macOS 显卡信息。'); }
  }
  if (!gpus.length && process.platform === 'linux') {
    const lspci = await executable('lspci');
    if (lspci) try {
      const data = (await run(lspci, [], { signal, timeoutMs: 6000 })).stdout;
      for (const line of data.split('\n').filter(x => /VGA|3D controller|Display controller/i.test(x)))
        gpus.push({ name: line.trim(), vendor: 'unknown', dedicatedMiB: null, freeMiB: null, source: 'lspci-name-only' });
    } catch { notes.push('未能取得 Linux 显卡信息。'); }
  }
  const blenderFallbacks = [];
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Blender Foundation');
    try { for (const item of (await fs.readdir(base)).sort().reverse()) blenderFallbacks.push(path.join(base, item, 'blender.exe')); } catch { /* not installed */ }
  } else if (process.platform === 'darwin') blenderFallbacks.push('/Applications/Blender.app/Contents/MacOS/Blender');
  const tools = {};
  for (const name of ['blender', 'ffmpeg', 'ffprobe', 'colmap']) tools[name] = await executable(config[name] || name, name === 'blender' ? blenderFallbacks : []);
  tools.python = await executable(config.python);
  tools.aiPython = await executable(config.aiPython);
  const report = { detectedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model || 'unknown', cpuThreads: os.availableParallelism(),
    memoryMiB: Math.floor(os.totalmem() / 1048576), freeMemoryMiB: Math.floor(os.freemem() / 1048576), gpus, tools, notes };
  report.recommendation = recommend(report, config);
  return report;
}
