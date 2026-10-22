import fs from 'node:fs/promises';
import path from 'node:path';
import * as DshTools from '@deepseek-ai/dsh-tools';
import { configuration } from './src/config.mjs';
import { discover } from './src/hardware.mjs';
import { Store, digest, fileDigest, writeJson } from './src/store.mjs';
import { validatePlan, locations, approvalFingerprint, busyStates, questionAnswers } from './src/plan.mjs';
import { inventory, provision, upstreams } from './src/dependencies.mjs';
import { BlenderBridge } from './src/blender.mjs';
import { Engine } from './src/engine.mjs';
import { askRound, confirmRequirements, interviewGuide } from './src/interview.mjs';
import { videoFrames } from './src/media.mjs';
import { compatibility, requireCompatible, requireQuestions, imageResult } from './src/compatibility.mjs';
import { workflowStatus } from './src/workflow.mjs';
import { provision as provisionNodeDeps, runWorker, validateOps, validateSpec, generateModel, generatedOutputFor, resolveModelPath, viewerPathFor, defaultOutputFor, nodeDepsDir } from './src/three.mjs';
import { probe as probeRuntimes } from './src/detect.mjs';
import { renderViews, normalizeViews } from './src/render.mjs';

export const name = 'local-3d-studio';
export const inject = ['tools', 'systemPrompt'];

export async function apply(ctx, input = {}) {
  const config = configuration(input), defineTool = DshTools.defineTool;
  const hostAtLoad = await compatibility(ctx, DshTools, config);
  if (!hostAtLoad.capabilities.defineTool || !hostAtLoad.capabilities.register) requireCompatible(hostAtLoad);
  let hardware = null, installing = false;
  const owner = exec => { if (!exec.agent) throw new Error('此工作室需要在用户对话中调用。'); return exec.agent.id; };
  const hardwareReport = async signal => hardware = await discover(config, signal);
  const projectArg = { type: 'string', required: true, description: 'studio_create 返回的项目编号' };
  function tool(toolName, description, parameters, execute) {
    ctx.tools.register(defineTool({ name: toolName, description, parameters,
      timeoutMs: config.taskTimeoutMinutes * 60000,
      output: { schema: { type: 'json' }, render: (_args, value) => {
        const { images = [], ...data } = value;
        return [{ type: 'text', text: JSON.stringify(data) }, ...images.map(attachment => ({ type: 'image', attachment }))];
      } }, execute: async (args, exec) => JSON.parse(JSON.stringify(await execute(args, exec))) }));
  }

  const hostReport = exec => compatibility(ctx, DshTools, config, exec);
  tool('studio_compatibility', '自动读取 DSH 本地组件版本、宿主服务与当前模型已公开的能力；报告兼容降级，不联网、不读取 Key、不升级宿主。', {}, async (_args, exec) => {
    owner(exec); return hostReport(exec);
  });
  if (hostAtLoad.status === 'blocked') {
    ctx.systemPrompt?.section?.({ name: 'local3d:compatibility', order: 1800, interpolate: false,
      text: '本地三维工作室检测到不兼容的宿主接口，仅开放 studio_compatibility 诊断；不能声称可执行完整制作。' });
    return;
  }
  const store = new Store(config), blender = new BlenderBridge(ctx, config);
  const engine = new Engine(ctx, config, store, blender);

  const guide = await fs.readFile(new URL('./recipes/orchestrator.md', import.meta.url), 'utf8');
  ctx.systemPrompt.section({ name: 'local3d:workflow', order: 1800, interpolate: false, text: `${guide}\n${interviewGuide}` });
  ctx.systemPrompt.section({ name: 'local3d:probe', order: 1799, interpolate: false, text: [
    '## 先探测，再选路线（本地三维工作室）',
    '开始任何建模、重建或生成之前，先调用 studio_probe。它每次实测本机：Blender、COLMAP、FFmpeg、Python 的真实路径与版本，以及 ComfyUI 服务是否可达。',
    '- Blender 可用 → 建模、动画、渲染走 studio_catalog / studio_plan / studio_run（Blenderwright）。',
    '- Blender 不可用 → 用 studio_three action=generate 以 Three.js 图元程序化生成 GLB（先和用户确认尺寸与结构），再用 action=render 渲出多个视角的 PNG；不要声称这是 Blender 渲染。',
    '- 多视图重建需要 COLMAP；ComfyUI 不可达时 AI 生成路线不可用，不悄悄改用云端收费服务。',
    '- 用户机器状态会变，不要缓存探测结论；每次新任务重新探测一次，并在交付里说明这次实际用了哪条路线。',
    '查看或修改已有 GLB/GLTF：直接用 studio_three 的 inspect / edit / viewer / render，不必要求安装 Blender。',
  ].join('\n') });
  ctx.systemPrompt.section({ name: 'local3d:three', order: 1801, interpolate: false, text: [
    '## Three.js 模型通道',
    '有现成 GLB/GLTF/OBJ 模型需要「看一下」「改尺寸/位置/材质」「出一份能在浏览器里转着看的预览」时，直接用 studio_three，不要要求安装 Blender：',
    '- action=inspect 报告节点、图元、材质、贴图数量与包围盒；',
    '- action=edit 载入模型后按 ops 依次改写并导出 GLB（transform / material / rename / remove / duplicate / scaleTo / center），默认再生成 .viewer.html；',
    '- action=viewer 只生成预览页（模型内嵌 base64，浏览器联网加载 three.js CDN）；',
    '- action=demo 用 Three.js 现场生成一个示例 GLB，可用来验通道；',
    '- action=setup 首次使用前安装 three 与 @gltf-transform/* 到 <dataRoot>/_dependencies/nodejs（本机、隔离、不写用户环境）。',
    '改写会生成新文件，默认不覆盖原模型；预览页需要用户自己在浏览器打开，不要声称已经渲染或截图。',
  ].join('\n') });

  tool('studio_hardware', '识别本机显卡、独立显存、内存和已安装工具，生成保守的定制方案；可刷新指定项目的硬件记录，不运行渲染或安装。', { projectId: { type: 'string' } }, async (args, exec) => {
    owner(exec); const result = await hardwareReport(exec.signal);
    if (args.projectId) await store.update(args.projectId, exec.agent.id, p => {
      if (busyStates.has(p.state)) throw new Error('制作中不能替换硬件记录。');
      p.hardware = result; p.approval = null; if (p.state === 'approved') p.state = 'awaiting_review'; return p;
    });
    return result;
  });
  tool('studio_three', '用 Three.js 与 glTF 读写现成模型：查看节点/材质/包围盒，改尺寸、位置、材质，删改复制节点，导出新 GLB 并生成可在浏览器旋转查看的预览页；不依赖 Blender，不覆盖原模型。', {
    action: { type: 'string', required: true, enum: ['setup', 'demo', 'generate', 'inspect', 'edit', 'viewer', 'render'] },
    spec: { type: 'json', description: 'generate 用的场景描述：{ name?, ground?, objects: [{ type, size, position, rotation, scale, color, metalness, roughness, opacity, radius, height, tube, name }] }；type 支持 box / sphere / cylinder / cone / torus / plane。' },
    views: { type: 'json', description: 'render 用的视角数组，默认 front/right/back/iso；可用 front back left right top iso。' },
    modelPath: { type: 'string', description: 'GLB/GLTF 模型路径；相对路径按工作区解析。' },
    outputPath: { type: 'string', description: '输出路径；edit 默认 <模型名>.edited.glb。' },
    ops: { type: 'json', description: '修改操作数组：transform / material / rename / remove / duplicate / scaleTo / center。' },
    title: { type: 'string', description: '预览页标题。' },
    viewer: { type: 'boolean', description: 'edit/demo 后是否生成 HTML 预览页，默认 true。' },
  }, async (args, exec) => {
    owner(exec);
    if (args.action === 'setup') return { action: 'setup', ...await provisionNodeDeps(config, { signal: exec.signal }), dependencies: nodeDepsDir(config) };
    if (args.action === 'generate') {
      const spec = validateSpec(args.spec || {});
      const output = args.outputPath ? path.resolve(config.projectRoots[0] || process.cwd(), args.outputPath) : generatedOutputFor(config, spec.name || 'generated');
      const model = await generateModel(config, spec, output, { signal: exec.signal });
      const viewer = args.viewer === false ? null : await runWorker(config, { action: 'viewer', modelPath: output, outputPath: viewerPathFor(output), title: args.title || '程序化生成模型' }, { signal: exec.signal });
      return { action: 'generate', modelPath: output, ...model, viewer: viewer?.viewer || null, dependencies: nodeDepsDir(config) };
    }
    if (args.action === 'render') {
      const source = await resolveModelPath(config, args.modelPath);
      const views = normalizeViews(args.views);
      const viewerHtml = args.outputPath && String(args.outputPath).toLowerCase().endsWith('.html')
        ? path.resolve(config.projectRoots[0] || process.cwd(), args.outputPath)
        : viewerPathFor(source);
      await runWorker(config, { action: 'viewer', modelPath: source, outputPath: viewerHtml, title: args.title || '模型预览' }, { signal: exec.signal });
      const outDir = path.join(path.dirname(viewerHtml), `${path.basename(viewerHtml, '.viewer.html')}-views`);
      const rendered = await renderViews(config, viewerHtml, outDir, views, { signal: exec.signal });
      return { action: 'render', modelPath: source, viewer: viewerHtml, ...rendered };
    }
    if (args.action === 'demo') {
      const output = args.outputPath ? path.resolve(config.projectRoots[0] || process.cwd(), args.outputPath) : path.join(config.dataRoot, '_samples', `three-demo-${Date.now()}.glb`);
      const model = await runWorker(config, { action: 'demo', outputPath: output }, { signal: exec.signal });
      const viewer = args.viewer === false ? null : await runWorker(config, { action: 'viewer', modelPath: output, outputPath: viewerPathFor(output), title: args.title || 'Three.js 示例模型' }, { signal: exec.signal });
      return { action: 'demo', modelPath: output, model, viewer: viewer?.viewer || null };
    }
    const modelPath = await resolveModelPath(config, args.modelPath);
    if (args.action === 'inspect') return { action: 'inspect', ...await runWorker(config, { action: 'inspect', modelPath }, { signal: exec.signal }) };
    if (args.action === 'viewer') {
      const target = args.outputPath ? path.resolve(config.projectRoots[0] || process.cwd(), args.outputPath) : viewerPathFor(modelPath);
      return { action: 'viewer', ...await runWorker(config, { action: 'viewer', modelPath, outputPath: target, title: args.title }, { signal: exec.signal }) };
    }
    const ops = validateOps(args.ops || []);
    if (!ops.length) throw new Error('edit 需要至少一个 ops 操作。');
    const output = args.outputPath ? path.resolve(config.projectRoots[0] || process.cwd(), args.outputPath) : defaultOutputFor(modelPath);
    const edited = await runWorker(config, { action: 'edit', modelPath, outputPath: output, ops }, { signal: exec.signal });
    const viewer = args.viewer === false ? null : await runWorker(config, { action: 'viewer', modelPath: output, outputPath: viewerPathFor(output), title: args.title || '模型修改预览' }, { signal: exec.signal });
    return { action: 'edit', source: modelPath, ...edited, viewer: viewer?.viewer || null, dependencies: nodeDepsDir(config) };
  });
  tool('studio_probe', '实测本机运行环境：Blender、COLMAP、FFmpeg、Python 的真实路径与版本，ComfyUI 服务是否可达，并给出本次可执行的建模/重建/生成路线。不安装、不下载、不猜。每次调用都重新探测。', {}, async (_args, exec) => {
    owner(exec); return probeRuntimes(config, { signal: exec.signal });
  });
  tool('studio_discover', '优先发现用户指定和已有的本地三维项目、适配声明，再报告缺少的官方项目；不执行仓库代码。', {}, async (_a, exec) => {
    owner(exec); return inventory(config);
  });
  tool('studio_setup', '用户选择一个具体能力后，复用本地项目或克隆登记的官方项目，隔离安装；下载权重另明确选择。不会运行测试或改动用户环境。', {
    backend: { type: 'string', required: true, enum: ['blenderwright', 'triposr', 'hunyuan', 'comfyui', 'media'] },
    localRoot: { type: 'string', description: '优先使用的已发现本地目录；不填则自动优先本地项目。' },
    downloadWeights: { type: 'boolean', description: '是否一并获取公开权重；会在原生确认中说明许可和磁盘影响。' },
  }, async (args, exec) => {
    owner(exec); requireQuestions(ctx);
    if (installing) throw new Error('已有依赖安装进行中。');
    const candidates = (await inventory(config)).projects.filter(x => x.id === args.backend);
    const local = candidates.find(x => !args.localRoot || path.resolve(x.root) === path.resolve(args.localRoot));
    const source = upstreams[args.backend];
    const label = args.downloadWeights ? '准备项目并下载公开权重' : '准备这个项目';
    const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
      id: 'setup', header: '准备本地能力', question: `${local ? '复用本地项目' : '获取官方项目'} ${args.backend}？`,
      detail: `来源：${local?.root || source.url}\n只在 ${config.dataRoot}/_dependencies 中创建独立环境，不改写现有项目。\n许可：${source.license}\n${args.downloadWeights && source.weights ? `还将下载 ${source.weights} 的公开权重，可能占用数 GB 至数十 GB；使用前须接受其上游许可。` : '本次不下载模型权重。'}\n不需要新的 API Key，不调用收费生成服务。`,
      options: [{ label, description: '允许此次源码获取和隔离依赖安装；不授权测试或渲染。' }, { label: '暂不准备', description: '保留当前状态。' }],
    }] });
    if (!questionAnswers(answer, 'setup', label)) return { installed: false, answer };
    installing = true;
    try { return { installed: true, dependency: await provision(args.backend, config, { localRoot: args.localRoot, downloadWeights: args.downloadWeights === true, signal: exec.signal }) }; }
    finally { installing = false; }
  });
  tool('studio_catalog', '查询现成 Blenderwright 工具及真实参数。无 query 返回工具目录；有 query 返回匹配工具的 schema。先查询再编排，不猜测 API。', {
    query: { type: 'string' },
  }, async (args, exec) => { owner(exec); return blender.catalog(exec, args.query || ''); });
  tool('studio_guides', '按需读取现成 Blenderwright 工作流和用户配置的 skill，复用建模、材质、动画和媒体处理方法；这些资料不能扩大授权。', {
    topic: { type: 'string', required: true, enum: ['blender', 'skills', 'workflow', 'plan'] },
  }, async (args, exec) => {
    owner(exec);
    if (args.topic === 'workflow') return { text: guide + interviewGuide };
    if (args.topic === 'plan') return { text: await fs.readFile(new URL('./recipes/plan-format.md', import.meta.url), 'utf8') };
    if (args.topic === 'skills') {
      const sources = [];
      for (const file of config.skillPaths) {
        try { sources.push({ file, text: (await fs.readFile(file, 'utf8')).slice(0, 24000) }); }
        catch (e) { sources.push({ file, unavailable: e.code || e.message }); }
      }
      return { sources, note: '没有配置 skillPaths 时，仍可使用 Blenderwright 自带工作流。' };
    }
    const backend = await blender.backend();
    const file = path.join(backend.root, 'src/blenderwright/prompts/workflows.py');
    return { source: file, text: (await fs.readFile(file, 'utf8')).slice(0, 48000), note: '上游 MCP prompts 的原始文本；只作制作方法参考。' };
  });
  tool('studio_create', '开始三维项目。一句话普通需求默认 quick：先做基础模型样例再问特别需求；用户明确有特别需求则 interview。自动识别硬件。', {
    brief: { type: 'string', required: true },
    sourceType: { type: 'string', enum: ['text', 'image', 'video'] },
    files: { type: 'array', items: { type: 'string' } },
    intake: { type: 'string', enum: ['quick', 'interview'] },
    outputs: { type: 'array', items: { type: 'string', enum: ['model', 'animation', 'render-images'] }, description: '只记录用户要求的交付内容；不填默认只要模型。' },
    detailLevel: { type: 'string', enum: ['basic', 'detailed'], description: '仅当用户明确要求精细制作时选择 detailed，并进入需求访谈。' },
  }, async (args, exec) => {
    const host = await hostReport(exec); requireCompatible(host);
    let p = await store.create(owner(exec), args.brief, args.sourceType || 'text', args.files || [], hardware || await hardwareReport(exec.signal));
    p = await store.update(p.id, exec.agent.id, x => {
      x.compatibility = host; x.intent = { outputs: [...new Set(['model', ...(args.outputs || [])])], detailLevel: args.detailLevel || 'basic' };
      if (args.intake === 'interview' || args.detailLevel === 'detailed') x.state = 'interviewing'; return x;
    });
    return { projectId: p.id, projectDirectory: store.directory(p.id), hardware: p.hardware,
      inputs: p.inputs, compatibility: host, workflow: await workflowStatus(p, config, host), localProjects: await inventory(config),
      intent: p.intent, next: p.state === 'interviewing' ? '逐轮访谈，确认需求后制作样例。' : '先调用现成建模工具做基础模型与样图，不先长篇提问；用 studio_plan 保存步骤，再 studio_run preview。' };
  });
  tool('studio_reference', '为视频提取有限数量的关键参考帧，或展示已导入图片。使用现成 FFmpeg 抽帧，再交由当前 DeepSeek 视觉理解。', {
    projectId: projectArg, inputIndex: { type: 'integer' }, count: { type: 'integer' },
  }, async (args, exec) => {
    const p = await store.load(args.projectId, owner(exec)), inputFile = p.inputs[args.inputIndex || 0];
    if (!inputFile) throw new Error('没有对应参考文件。');
    let files = [inputFile.path];
    if (p.sourceType === 'video') {
      const out = path.join(store.directory(p.id), `reference-frames-${Date.now()}`);
      files = await videoFrames(inputFile.path, out, p, config, { signal: exec.signal }, args.count || 8);
      await store.update(p.id, exec.agent.id, current => { current.referenceFrames = files; return current; });
    }
    const host = await hostReport(exec);
    return { projectId: p.id, files, ...await imageResult(ctx, files.slice(0, 6)), modelVision: host.model.vision,
      interpretation: host.model.vision !== true ? '不能确认当前模型能读图；仍向用户展示参考。优先直接调用纯本地图生模型或静态重建，语义细节请用户描述或接入其已有本地视觉项目，不假装已看懂。'
        : p.sourceType === 'video' ? '静态环绕可选 COLMAP；动态对象需明确标为场景/动作近似复刻，不能假称精确重建。' : '先理解主体、轮廓、材质和不可见区域，再规划。' };
  });
  tool('studio_interview', '有特别需求时进行 grill-me 式逐轮访谈；每轮 1—3 问，记录答案，不重复询问已确认事实。', {
    projectId: projectArg, questions: { type: 'json', required: true, description: '原生问题数组：[{id, question, detail?, options?:[{label,description?}]}]' },
  }, async (args, exec) => { owner(exec); return askRound(ctx, store, args.projectId, exec, args.questions); });
  tool('studio_note_requirements', '记录用户已明确给出的需求或主动更正，避免再次盘问。facts 只包含有 evidence 原话支持的事实，不把模型推测当作用户决定。', {
    projectId: projectArg, facts: { type: 'json', required: true }, evidence: { type: 'string', required: true, description: '当前用户消息中支持这些需求的原话。' },
  }, async (args, exec) => {
    owner(exec);
    if (!args.facts || typeof args.facts !== 'object' || Array.isArray(args.facts) || !args.evidence.trim()) throw new Error('需要需求事实对象和对应用户原话。');
    if (JSON.stringify(args.facts).length > 16000) throw new Error('本次需求记录过长，请保留影响结果的事实。');
    const p = await store.update(args.projectId, exec.agent.id, current => {
      if (busyStates.has(current.state)) throw new Error('制作期间不能改变需求，请先取消。');
      Object.assign(current.requirements, args.facts); current.approval = null; current.requirementsConfirmed = false;
      if (Array.isArray(args.facts.outputs)) {
        if (!args.facts.outputs.every(v => ['model', 'animation', 'render-images'].includes(v))) throw new Error('outputs 只接受 model、animation、render-images。');
        current.intent ||= { detailLevel: 'basic' }; current.intent.outputs = [...new Set(['model', ...args.facts.outputs])];
      }
      if (current.revision > 0) current.state = 'interviewing';
      current.interview.push({ facts: args.facts, evidence: args.evidence, at: new Date().toISOString() });
      return current;
    });
    return { requirements: p.requirements, next: '保留已给事实，只追问尚未解决的关键问题。' };
  });
  tool('studio_confirm_requirements', '访谈决策树的关键问题已解决后，向用户展示需求摘要并确认；这不批准正式制作。', {
    projectId: projectArg, summary: { type: 'string', required: true },
  }, async (args, exec) => { owner(exec); return confirmRequirements(ctx, store, args.projectId, args.summary, exec); });
  tool('studio_plan', '保存现成工具/适配器的样例步骤与正式步骤。修改产生新修订版，使旧样例批准失效。只保存方案，不执行。', {
    projectId: projectArg, plan: { type: 'json', required: true, description: '格式见 recipes/plan-format.md；复用 studio_catalog 里的真实工具。' },
  }, async (args, exec) => {
    const plan = validatePlan(args.plan, config);
    const p = await store.update(args.projectId, owner(exec), current => {
      if (busyStates.has(current.state)) throw new Error('制作中不能修改方案。');
      if (current.state === 'interviewing' && !current.requirementsConfirmed) throw new Error('先确认特别需求，再写制作方案。');
      if (current.intent?.outputs?.includes('animation') && (!plan.artifacts.video || plan.render.frames < 2)) throw new Error('用户要求动画，方案必须包含真实视频交付物和多帧制作，不能只交静态模型。');
      if (current.intent?.outputs?.includes('render-images') && !plan.artifacts.renders?.length) throw new Error('用户要求正式渲染图，方案必须声明 renders；低分辨率样例不能替代正式渲染交付。');
      if (current.revision > 0) {
        current.history ||= [];
        current.history.push({ revision: current.revision, previewScene: current.previewScene, samples: current.samples, summary: current.plan?.summary });
      }
      current.revision++; current.plan = plan; current.approval = null; current.samples = []; current.previewArtifacts = [];
      current.previewScene = null; current.state = 'planned'; return current;
    });
    const dirs = locations(store, p);
    await writeJson(path.join(dirs.revisionDir, 'plan.json'), plan);
    return { projectId: p.id, revision: p.revision, directories: dirs, previousVersions: p.history || [], next: '执行 preview，展示真实样例后才允许批准 build。可以用 open_file 从旧版本工程继续，输出必须保存到当前修订版。' };
  });
  tool('studio_run', '执行当前方案的 preview 或已人工批准的 build；所有步骤复用现成插件/本地项目，后台任务可取消。', {
    projectId: projectArg, phase: { type: 'string', required: true, enum: ['preview', 'build'] },
  }, async (args, exec) => { owner(exec); requireCompatible(await hostReport(exec)); if (args.phase === 'build') requireQuestions(ctx); return engine.start(args.projectId, args.phase, exec); });
  tool('studio_samples', '展示当前修订版真实样图。没有成功生成时明确报错，不把草图或占位图冒充完成的三维模型。', {
    projectId: projectArg,
  }, async (args, exec) => {
    const p = await store.load(args.projectId, owner(exec));
    if (!p.samples.length) throw new Error('当前修订版尚无成功生成的样例。');
    const files = await Promise.all(p.samples.map(s => store.ownFile(p.id, s.path)));
    return { projectId: p.id, revision: p.revision, summary: p.plan.summary, samples: p.samples, ...await imageResult(ctx, files),
      next: '立即调用 studio_review，让用户选择特别需求或精细化；不要自行进入正式制作。' };
  });
  tool('studio_review', '展示具体样例修订版并询问特别需求、是否精细化。正式批准必须来自原生用户回答，不能由模型传入布尔值。', {
    projectId: projectArg,
  }, async (args, exec) => {
    requireQuestions(ctx);
    const p = await store.load(args.projectId, owner(exec));
    if (p.state !== 'awaiting_review') throw new Error('当前项目不在样例选择阶段。');
    const fingerprint = await approvalFingerprint(store, p), label = '按当前样例完成制作';
    const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
      id: 'sample', header: '样例与需求', question: '这是基础模型样例。你有特别需求，或希望继续精细建模吗？',
      detail: `项目：${p.plan.title}，修订 ${p.revision}\n${p.plan.summary}\n${p.samples.map(s => `![样例](<${s.path.replaceAll('\\', '/')}>)`).join('\n')}\n正式输出：${p.plan.render.width}×${p.plan.render.height}，${p.plan.render.frames} 帧，${p.plan.render.fps}fps。\n${p.plan.limitations?.join('\n') || ''}\n将按本地方案交付模型、工程${p.plan.artifacts.video ? '和视频' : ''}，不新增云端服务费用。`,
      options: [{ label, description: '批准当前修订版正式制作一次。' }, { label: '继续精细建模', description: '先进一步问清细节要求，再生成调整样例。' }, { label: '我有特别需求或想修改', description: '进入需求访谈，保留已完成的基础模型。' }],
    }] });
    const accepted = questionAnswers(answer, 'sample', label);
    const latest = await store.load(p.id, exec.agent.id);
    if (latest.revision !== p.revision || await approvalFingerprint(store, latest) !== fingerprint) throw new Error('等待期间样例或方案已变化，旧批准未生效。');
    await store.update(p.id, exec.agent.id, async current => {
      if (current.state !== 'awaiting_review' || current.revision !== p.revision || await approvalFingerprint(store, current) !== fingerprint) throw new Error('样例已变化，不能应用旧回答。');
      current.state = accepted ? 'approved' : 'interviewing'; current.requirementsConfirmed = accepted;
      current.approval = accepted ? { revision: p.revision, fingerprint, at: new Date().toISOString() } : null;
      current.interview.push({ question: '样例后的特别需求与精细化选择', answer }); return current;
    });
    return { approved: accepted, answer, next: accepted ? '允许执行 build 一次。' : '根据用户选择逐轮追问需求，不直接猜测并开工。' };
  });
  tool('studio_workflow', '读取当前项目从需求到模型、动画、交付各阶段的能力与缺项，返回准备步骤；不启动检查、渲染、下载或外部请求。', { projectId: projectArg }, async (args, exec) => {
    const p = await store.load(args.projectId, owner(exec)); return workflowStatus(p, config, await hostReport(exec));
  });
  tool('studio_status', '读取项目状态、已完成步骤、错误和交付物；不自动启动检查或重跑。', { projectId: projectArg }, async (args, exec) => {
    const p = await store.load(args.projectId, owner(exec));
    return { projectId: p.id, state: p.state, revision: p.revision, phase: p.phase || null, step: p.step || 0,
      activeJob: p.activeJob, error: p.error || null, samples: p.samples, deliverables: p.deliverables || [], requirements: p.requirements, intent: p.intent || null,
      acceptance: p.state === 'completed' ? '声明的产物已生成，未自动进行质量验收。' : '尚未完成正式交付。', previousVersions: p.history || [] };
  });
  tool('studio_cancel', '取消本插件当前项目任务，只停止其专属进程，保留已生成文件。', { projectId: projectArg }, async (args, exec) => engine.cancel(args.projectId, owner(exec)));
  tool('studio_recover', '应用异常退出后恢复非运行项目，保留文件并清除过期批准；不会自动继续渲染。', { projectId: projectArg }, async (args, exec) => {
    owner(exec); if (engine.active.has(args.projectId)) throw new Error('此任务仍在当前进程运行，应先取消。');
    await store.releaseStaleLock(args.projectId, exec.agent.id);
    const p = await store.update(args.projectId, exec.agent.id, current => { current.state = 'draft'; current.activeJob = null; current.approval = null; return current; });
    return { projectId: p.id, state: p.state, next: '读取已有产物并制定续接步骤；正式制作仍需当前样例批准。' };
  });
}
