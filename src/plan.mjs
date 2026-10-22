import path from 'node:path';
import { digest, fileDigest, inside } from './store.mjs';

const forbidden = /(?:execute.*(?:code|python)|delete|remove|clear_scene|reset|quit|install|download|script)/i;
export const busyStates = new Set(['previewing', 'building']);

export function validatePlan(plan, config) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan 必须是对象。');
  if (JSON.stringify(plan).length > 2 * 1048576) throw new Error('编排方案超过 2MiB；请拆成更小的镜头或模块。');
  for (const k of ['title', 'summary']) if (typeof plan[k] !== 'string' || !plan[k].trim()) throw new Error(`缺少 ${k}。`);
  if (!Array.isArray(plan.previewSteps) || !plan.previewSteps.length || !Array.isArray(plan.buildSteps) || !plan.buildSteps.length) throw new Error('方案需要样例步骤和正式制作步骤。');
  for (const steps of [plan.previewSteps, plan.buildSteps]) {
    if (steps.length > 500) throw new Error('单个阶段最多 500 个现成工具调用；请拆分项目。');
    for (const s of steps) {
      if (!s || !['blender', 'adapter', 'ffmpeg', 'video_frames', 'music_beats'].includes(s.kind)) throw new Error('步骤必须调用已有的 Blender、适配器或媒体处理能力。');
      if (s.kind === 'blender' && (typeof s.tool !== 'string' || forbidden.test(s.tool))) throw new Error('只允许结构化 Blender 工具；不允许原始 Python、删除或安装调用。');
      if (s.kind === 'blender' && (!s.args || typeof s.args !== 'object' || Array.isArray(s.args))) throw new Error('Blender 工具参数必须是对象。');
      if (s.kind === 'adapter' && typeof s.adapterId !== 'string') throw new Error('生成步骤缺少 adapterId。');
      if (s.kind === 'ffmpeg' && (!Array.isArray(s.args) || !s.args.every(x => typeof x === 'string'))) throw new Error('FFmpeg 参数必须是字符串数组。');
    }
  }
  if (!plan.artifacts || !Array.isArray(plan.artifacts.previews) || !plan.artifacts.previews.length || plan.artifacts.previews.length > 6) throw new Error('方案必须声明 1—6 张真实样例图片。');
  if (!plan.artifacts.previews.every(p => typeof p === 'string' && /\.(?:png|jpe?g|webp)$/i.test(p))) throw new Error('样例产物必须声明 PNG、JPEG 或 WebP 图片路径。');
  if (typeof plan.artifacts.previewScene !== 'string' || !/\.blend$/i.test(plan.artifacts.previewScene)) throw new Error('样例阶段必须保存真实可继续编辑的 .blend 工程；概念图片不能替代基础模型。');
  if (typeof plan.artifacts.scene !== 'string' || !/\.blend$/i.test(plan.artifacts.scene) || !Array.isArray(plan.artifacts.models) || !plan.artifacts.models.length
    || !plan.artifacts.models.every(p => typeof p === 'string' && /\.(?:glb|gltf|obj|fbx|ply|stl|usd|usdz|usdc|usda)$/i.test(p))) throw new Error('方案必须交付 .blend 工程和至少一个有效格式的模型文件。');
  if (plan.artifacts.video !== undefined && (typeof plan.artifacts.video !== 'string' || !/\.(?:mp4|mov|webm|mkv)$/i.test(plan.artifacts.video))) throw new Error('视频交付物必须为可播放的视频文件路径。');
  if (plan.artifacts.renders !== undefined && (!Array.isArray(plan.artifacts.renders) || plan.artifacts.renders.length > 48
    || !plan.artifacts.renders.every(p => typeof p === 'string' && /\.(?:png|jpe?g|webp|exr|tiff?)$/i.test(p)))) throw new Error('renders 应为最多 48 个正式渲染图片路径。');
  const r = plan.render || {};
  for (const [key, min, max] of [['width', 64, 7680], ['height', 64, 7680], ['fps', 1, 120], ['frames', 1, config.maxFrames]]) {
    if (!Number.isInteger(r[key]) || r[key] < min || r[key] > max) throw new Error(`render.${key} 必须为 ${min}—${max} 的整数。`);
  }
  if (r.width % 2 || r.height % 2) throw new Error('视频宽高必须为偶数。');
  return structuredClone(plan);
}

export function locations(store, p) {
  const projectDir = store.directory(p.id), revisionDir = path.join(projectDir, `revision-${p.revision}`);
  return { projectDir, revisionDir, previewDir: path.join(revisionDir, 'preview'), buildDir: path.join(revisionDir, 'build'), assetDir: path.join(revisionDir, 'assets') };
}

export function expand(value, store, p) {
  if (Array.isArray(value)) return value.map(v => expand(v, store, p));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, store, p)]));
  if (typeof value !== 'string') return value;
  const vars = locations(store, p);
  const replaced = value.replace(/\{(projectDir|revisionDir|previewDir|buildDir|assetDir|input:\d+)\}/g, (_, key) => {
    if (key.startsWith('input:')) {
      const input = p.inputs[Number(key.slice(6))]; if (!input) throw new Error(`不存在 ${key}。`); return input.path;
    }
    return vars[key];
  });
  // Windows 上 path.join 产出反斜杠，占位符后面常跟 '/'，统一归一化成平台分隔符。
  return replaced === value ? value : path.normalize(replaced);
}

export function validateToolPaths(args, root, inputs = []) {
  for (const [key, value] of Object.entries(args || {})) {
    if (value && typeof value === 'object') { validateToolPaths(value, root, inputs); continue; }
    if (typeof value !== 'string') continue;
    if (/https?:\/\//i.test(value)) throw new Error('本地制作步骤不接受外部 URL；请先取得本机参考素材。');
    if (/^(?:filepath|file_path|output_path|output_dir|directory|folder|filename|texture_path|image_path|hdri_path|input_path|blend_file|render_path)$/i.test(key) && value) {
      if (!path.isAbsolute(value) || (!inside(root, value) && !inputs.includes(value))) throw new Error(`路径参数 ${key} 必须指向当前项目。`);
      if (/(?:save|output|export)/i.test(key) && !inside(root, value)) throw new Error('输出不得覆盖项目外文件。');
    }
  }
}

export async function approvalFingerprint(store, p) {
  const files = [];
  for (const s of p.samples) files.push({ path: s.path, sha256: await fileDigest(await store.ownFile(p.id, s.path)) });
  if (!files.length) throw new Error('尚无可供批准的真实样例。');
  for (const file of p.previewArtifacts || []) files.push({ path: file, sha256: await fileDigest(await store.ownFile(p.id, file)) });
  return digest({ id: p.id, revision: p.revision, plan: p.plan, requirements: p.requirements, files });
}

export function questionAnswers(answer, questionId, affirmative) {
  const item = answer?.answers?.find(a => a.id === questionId);
  return !!item && !item.custom && item.selected?.length === 1 && item.selected[0] === affirmative;
}
