import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apiPackages = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'];

async function packageVersion(name) {
  try {
    const manifest = JSON.parse(await fs.readFile(require.resolve(`${name}/package.json`), 'utf8'));
    return { name, version: manifest.version || null, installed: true };
  } catch {
    // Some hosts do not export package.json. Resolve their entry without executing it.
    try {
      let directory = path.dirname(require.resolve(name));
      for (let depth = 0; depth < 8; depth++) {
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
          if (manifest.name === name) return { name, version: manifest.version || null, installed: true };
        } catch { /* continue to package root */ }
        const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
      }
      return { name, version: null, installed: true };
    } catch { /* a missing optional component remains explicitly unknown */ }
    return { name, version: null, installed: false };
  }
}

export function supportedApi(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (Number(major) !== 0 || Number(minor) !== 2 || Number(patch) < 1) return false;
  if (Number(patch) > 1 || !prerelease) return true;
  return /^rc\.[1-9]\d*$/.test(prerelease);
}

function service(ctx, name) {
  try { return ctx.get?.(name) ?? ctx[name]; } catch { return undefined; }
}
const text = value => typeof value === 'string' && value.length <= 256 ? value : null;

function routeHint(agent, configured) {
  if (configured?.model) return { provider: configured.provider || null, model: configured.model, source: 'configured-route' };
  // Agent shapes differ across host releases; use only whitelisted identity fields.
  // No profile objects, credentials or endpoint settings are serialized.
  const candidate = agent?.model;
  const model = text(candidate) || text(candidate?.model) || text(candidate?.id) || text(agent?.config?.model);
  const provider = text(agent?.provider) || text(candidate?.provider) || text(agent?.config?.provider);
  return model ? { model, provider, source: 'agent-route-fields' } : { model: null, provider: null, source: 'unavailable' };
}

export function selectModel(catalog, route, visionMode = 'auto') {
  const matches = route.model ? catalog.filter(m => m.id === route.model && (!route.provider || route.provider === m.provider)) : [];
  const selected = matches.length === 1 ? matches[0] : null;
  const modalities = Array.isArray(selected?.inputModalities) ? selected.inputModalities : null;
  const vision = visionMode === 'supported' ? true : visionMode === 'unsupported' ? false : modalities ? modalities.includes('image') : null;
  return { ...route, provider: selected?.provider || route.provider, inputModalities: modalities, vision,
    visionEvidence: visionMode !== 'auto' ? 'explicit-configuration' : modalities ? 'host-model-catalog' : 'not-disclosed',
    note: route.model ? '版本名称不代表视觉能力；只使用宿主声明或明确配置。' : '宿主未公开当前对话的模型身份；不把目录中的第一个模型当作当前模型。' };
}

export async function compatibility(ctx, tooling, config = {}, exec) {
  const components = await Promise.all(apiPackages.map(packageVersion));
  const capabilities = {
    defineTool: typeof tooling?.defineTool === 'function',
    register: typeof ctx.tools?.register === 'function',
    schemas: typeof ctx.tools?.schemas === 'function',
    execute: typeof ctx.tools?.execute === 'function',
    guard: typeof ctx.tools?.guard === 'function',
    lifecycle: typeof ctx.effect === 'function' && typeof ctx.on === 'function' && typeof ctx.plugin === 'function',
    systemPrompt: typeof ctx.systemPrompt?.section === 'function',
    nativeQuestions: typeof service(ctx, 'userQuestions')?.ask === 'function',
    nativeImages: typeof service(ctx, 'attachments')?.saveImage === 'function',
    backgroundJobs: typeof service(ctx, 'jobs')?.start === 'function',
    mcpClient: components.find(c => c.name === '@deepseek-ai/dsh-mcp-client').installed,
  };
  const required = ['defineTool', 'register', 'schemas', 'execute', 'guard', 'lifecycle', 'systemPrompt'];
  const missing = required.filter(key => !capabilities[key]);
  const unsupported = components.filter(c => c.version && supportedApi(c.version) === false).map(c => `${c.name}@${c.version}`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) missing.push('Node.js >=22');
  const llm = service(ctx, 'llm');
  let models = [], catalogAvailable = false;
  if (typeof llm?.listModels === 'function') {
    try {
      const listed = await llm.listModels();
      if (Array.isArray(listed)) {
        models = listed.filter(m => m && text(m.id) && text(m.provider)).map(m => ({ id: m.id, provider: m.provider,
          ...(Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities.filter(v => ['text', 'image'].includes(v)) } : {}) }));
        catalogAvailable = true;
      }
    } catch { /* metadata discovery never requests another model or endpoint */ }
  }
  const model = selectModel(models, routeHint(exec?.agent, config.modelRoute), config.visionMode || 'auto');
  return { status: missing.length || unsupported.length ? 'blocked' : components.every(c => c.version) ? 'supported-api' : 'capability-only',
    node: process.versions.node, apiFamily: 'DSH 0.2.1-rc.1 .. <0.3.0', components, missing, unsupported, capabilities, model,
    catalogAvailable, catalogCount: models.length,
    adaptations: { execution: config.allowBackground !== false && capabilities.backgroundJobs ? 'native-background' : 'foreground-with-deadline',
      samples: capabilities.nativeImages ? 'native-images' : 'absolute-file-links',
      approval: capabilities.nativeQuestions ? 'native-human-answer' : 'blocked-no-native-human-channel',
      referenceUnderstanding: model.vision === true ? 'current-model-vision' : model.vision === false ? 'local-reconstruction-or-user-description' : 'vision-unknown-use-local-reconstruction-or-description' },
    limits: ['自动适配服务有无和已知 API 差异；未知主版本不会假称兼容，也不会自动升级宿主。',
      '模型身份或视觉能力未公开时保持未知；不读取凭据、不创建新模型连接、不产生额外模型调用。',
      '这是本地能力声明，不代表真实 DSH、Blender 或 GPU 链路已经跑通。'] };
}

export function requireCompatible(report) {
  if (report.status === 'blocked') throw new Error(`DSH 接口不能安全执行制作：${[...report.missing, ...report.unsupported].join('、')}。需要 ${report.apiFamily}；请保留原 profile，选择对应版本的插件，不自动修改宿主。`);
}

export function requireQuestions(ctx) {
  if (typeof service(ctx, 'userQuestions')?.ask !== 'function') throw new Error('当前 DSH 没有原生用户问答服务；无法可靠确认用户意图，已保留项目。请在当前 profile 启用官方 userQuestions 服务后继续，不接受模型自填 approved。');
}

export async function imageResult(ctx, files) {
  const attachments = service(ctx, 'attachments');
  const images = [];
  if (typeof attachments?.saveImage === 'function') {
    for (const file of files) images.push(await attachments.saveImage({ data: await fs.readFile(file),
      mediaType: /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : /\.gif$/i.test(file) ? 'image/gif' : 'image/jpeg', name: path.basename(file) }));
  }
  return { images, display: files.map(file => `![样例](<${path.resolve(file).replaceAll('\\', '/')}>)`).join('\n'),
    displayMode: images.length ? 'native-images' : 'absolute-file-links' };
}
