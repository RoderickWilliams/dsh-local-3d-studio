import path from 'node:path';
import os from 'node:os';

export function configuration(input = {}, workspace = process.cwd()) {
  const root = path.resolve(input.dataRoot || path.join(workspace, '3d-studio-projects'));
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const result = {
    dataRoot: root,
    inputRoots: input.inputRoots || [workspace, path.join(os.homedir(), 'Desktop'), path.join(dshHome, 'attachments')],
    blender: input.blender || '', ffmpeg: input.ffmpeg || '', ffprobe: input.ffprobe || '', colmap: input.colmap || '',
    python: input.python || (process.platform === 'win32' ? 'python.exe' : 'python3'),
    aiPython: input.aiPython || input.python || (process.platform === 'win32' ? 'python.exe' : 'python3'),
    mediaPython: input.mediaPython || '',
    modelRoute: input.modelRoute || null,
    visionMode: input.visionMode || 'auto',
    projectRoots: input.projectRoots || [workspace],
    preferredProjects: input.preferredProjects || [],
    skillPaths: input.skillPaths || [path.join(workspace, '.agents/skills/grill-me/SKILL.md'), path.join(workspace, '.agents/skills/grilling/SKILL.md'), path.join(dshHome, 'skills/grill-me/SKILL.md'), path.join(dshHome, 'skills/ffmpeg-ops/SKILL.md')],
    blenderwrightRepo: input.blenderwrightRepo || '',
    blenderwrightPython: input.blenderwrightPython || '',
    comfyuiUrl: input.comfyuiUrl || 'http://127.0.0.1:8188',
    comfyuiRoot: input.comfyuiRoot || '',
    rendererModules: input.rendererModules || '',
    comfyuiWorkflow: input.comfyuiWorkflow || '',
    blenderPort: input.blenderPort ?? 19876,
    textImageModel: input.textImageModel || '',
    triposrRepo: input.triposrRepo || '', triposrWeights: input.triposrWeights || '',
    hunyuanRepo: input.hunyuanRepo || '', hunyuanWeights: input.hunyuanWeights || '',
    hunyuanPaint: input.hunyuanPaint === true,
    taskTimeoutMinutes: input.taskTimeoutMinutes ?? 180,
    maxInputMiB: input.maxInputMiB ?? 2048,
    maxFrames: input.maxFrames ?? 3600,
    maxObjects: input.maxObjects ?? 1200,
    previewSize: input.previewSize ?? 640,
    allowBackground: input.allowBackground !== false,
  };
  if (!Array.isArray(result.inputRoots) || !result.inputRoots.every(p => typeof p === 'string' && path.isAbsolute(p))) {
    throw new Error('inputRoots 必须是允许读取参考素材的绝对目录列表。');
  }
  result.inputRoots = result.inputRoots.map(p => path.resolve(p));
  if (!['auto', 'supported', 'unsupported'].includes(result.visionMode)) throw new Error('visionMode 只能为 auto、supported 或 unsupported。');
  if (result.modelRoute !== null && (typeof result.modelRoute !== 'object' || Array.isArray(result.modelRoute) || typeof result.modelRoute.model !== 'string' || !result.modelRoute.model.trim()
    || (result.modelRoute.provider !== undefined && typeof result.modelRoute.provider !== 'string'))) throw new Error('modelRoute 应为 {model, provider?}；只填路由名称，不填 Key 或凭据。');
  for (const key of ['taskTimeoutMinutes', 'maxInputMiB', 'maxFrames', 'maxObjects', 'previewSize']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error(`${key} 必须是正整数。`);
  }
  for (const key of ['projectRoots', 'preferredProjects', 'skillPaths']) {
    if (!Array.isArray(result[key]) || !result[key].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error(`${key} 必须是绝对路径列表。`);
  }
  const endpoint = new URL(result.comfyuiUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol)) throw new Error('ComfyUI 只允许本机回环地址。');
  if (!Number.isInteger(result.blenderPort) || result.blenderPort < 1024 || result.blenderPort > 65535) throw new Error('blenderPort 必须在 1024—65535 之间。');
  return Object.freeze(result);
}
