// 运行时探测：每次调用都读真实机器状态，不缓存、不猜。
// 目的：让插件在「用户装了 Blender / COLMAP / ComfyUI」与「什么都没装」两种机器上
// 都能给出可执行的路线，而不是假设某种后端存在。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { discover } from './hardware.mjs';

function runVersion(command, args, timeoutMs = 9000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, timeout: timeoutMs });
    } catch (error) {
      return finish({ ok: false, error: error.message });
    }
    child.stdout?.on('data', chunk => { out += chunk; });
    child.stderr?.on('data', chunk => { err += chunk; });
    child.on('error', error => finish({ ok: false, error: error.message }));
    child.on('close', code => finish({ ok: code === 0, code, text: `${out}\n${err}`.trim() }));
  });
}

function firstVersionLine(text) {
  return String(text || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
}

async function describe(found, args, label) {
  if (!found) return { found: false, path: null, version: null, usable: false, note: `${label} 未安装或不在 PATH / 常见目录里。` };
  const result = await runVersion(found, args);
  const line = result.ok ? firstVersionLine(result.text) : '';
  return {
    found: true, path: found, version: line || null, usable: Boolean(result.ok),
    note: result.ok ? `${label} 可执行。` : `${label} 找到但 --version 执行失败：${(result.error || result.text || '').slice(0, 200)}`,
  };
}

async function comfyuiProbe(config) {
  const url = config.comfyuiUrl || 'http://127.0.0.1:8188';
  const dirs = [config.comfyuiRoot, 'E:/ComfyUI', 'D:/ComfyUI', path.join(os.homedir(), 'ComfyUI'), path.join(os.homedir(), 'Documents', 'ComfyUI')].filter(Boolean);
  let dir = null;
  for (const candidate of dirs) {
    try { await fs.access(path.join(candidate, 'main.py')); dir = candidate; break; } catch { /* 继续找 */ }
  }
  let reachable = false, stats = null, error = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/system_stats`, { signal: controller.signal });
    if (response.ok) { reachable = true; stats = await response.json(); }
    else error = `HTTP ${response.status}`;
  } catch (e) { error = e.name === 'AbortError' ? '连接超时' : e.message; }
  finally { clearTimeout(timer); }
  return { url, reachable, dir, stats: stats ? { system: stats.system?.os, devices: Array.isArray(stats.devices) ? stats.devices.map(d => d.name) : [] } : null, error };
}

export async function probe(config, { signal } = {}) {
  const hardware = await discover(config, signal);
  const tools = {
    blender: await describe(hardware.tools.blender, ['--version'], 'Blender'),
    colmap: await describe(hardware.tools.colmap, ['--version'], 'COLMAP'),
    ffmpeg: await describe(hardware.tools.ffmpeg, ['-version'], 'FFmpeg'),
    ffprobe: await describe(hardware.tools.ffprobe, ['-version'], 'FFprobe'),
    python: await describe(hardware.tools.python, ['--version'], 'Python'),
  };
  const comfyui = await comfyuiProbe(config);
  const pipeline = {
    modeling: tools.blender.usable ? 'blenderwright' : 'three-procedural',
    reconstruction: tools.colmap.usable ? 'colmap' : null,
    ai3d: comfyui.reachable ? 'comfyui' : null,
    aiPython: hardware.tools.aiPython || null,
  };
  const notes = [...(hardware.notes || [])];
  notes.push(tools.blender.usable
    ? 'Blender 可用：建模/动画/渲染走 Blenderwright。'
    : 'Blender 不可用：建模走 Three.js 程序化生成（studio_three action=generate），渲染走无头 Chrome 截图，不假装有 Blender 渲染。');
  notes.push(tools.colmap.usable ? 'COLMAP 可用：可以做多视图重建。' : 'COLMAP 不可用：多视图重建不可用，只能做程序化建模或已有模型编辑。');
  notes.push(comfyui.reachable ? 'ComfyUI 服务可达：可调用已有 API 工作流。' : `ComfyUI 不可达（${comfyui.url}）：AI 生成路线不可用，不悄悄改用云端。`);
  return {
    detectedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.versions.node,
    gpu: hardware.gpus || [], memoryMiB: hardware.memoryMiB,
    tools, comfyui, pipeline, notes,
  };
}
