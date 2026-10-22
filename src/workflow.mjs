import path from 'node:path';
import { inventory } from './dependencies.mjs';

function stage(id, state, detail, action = null) { return { id, state, detail, action }; }

export async function workflowStatus(project, config, host) {
  const found = await inventory(config), records = found.projects.filter(p => !p.invalid);
  const tools = project.hardware?.tools || {}, recommendation = project.hardware?.recommendation || {};
  const steps = [...(project.plan?.previewSteps || []), ...(project.plan?.buildSteps || [])];
  const needed = [...new Set(steps.filter(s => s.kind === 'adapter').map(s => s.adapterId))];
  const stages = [];
  stages.push(stage('host', host.status === 'blocked' ? 'blocked' : 'declared', `${host.status}；接口声明与实际执行结果分开记录。`, host.status === 'blocked' ? 'studio_compatibility' : null));
  stages.push(stage('hardware', project.hardware ? 'declared' : 'missing', recommendation.summary || '显存未知时采用保守的 Blender 路线。', project.hardware ? null : 'studio_hardware'));
  const bw = records.find(p => p.id === 'blenderwright');
  const bwReady = !!(bw && (config.blenderwrightPython || bw.pythonPath));
  stages.push(stage('modeling-and-rendering', tools.blender && bwReady && host.capabilities.mcpClient ? 'declared' : 'missing',
    !host.capabilities.mcpClient ? '当前宿主缺少官方 MCP 客户端；需要与 DSH 版本匹配的组件。' : !tools.blender ? '缺少 Blender 可执行文件；支持配置已有安装或便携版。' : !bwReady ? '需要准备 Blenderwright 源码及隔离 Python 环境。' : '已发现 Blender 与 Blenderwright；尚不等于已经验证可渲染。',
    !host.capabilities.mcpClient ? '启用与宿主版本一致的官方 dsh-mcp-client' : !bwReady ? 'studio_setup(blenderwright)' : !tools.blender ? '配置 blender 后重新 studio_hardware(projectId)' : null));
  if (project.sourceType !== 'text') stages.push(stage('reference-understanding', host.model.vision === true ? 'declared' : 'limited',
    host.model.vision === true ? '宿主声明当前模型可读取图片；视频先使用 FFmpeg 抽帧。' : '当前模型视觉能力不可用或未公开；可直接调用本地图生模型，语义调整需用户描述或用户已有本地视觉项目。', 'studio_reference'));
  if (project.sourceType === 'video') stages.push(stage('video-reconstruction', tools.ffmpeg && tools.ffprobe ? 'limited' : 'missing',
    '静态环绕可使用已有 COLMAP；动态视频只承诺可编辑场景和动作的近似复刻，不承诺任意视频的精确恢复。', !tools.ffmpeg || !tools.ffprobe ? '配置 FFmpeg / FFprobe' : tools.colmap ? '选择静态重建或动态近似路线' : '配置 COLMAP，或选择现有本地重建项目'));
  for (const id of needed) {
    if (id === 'colmap') { stages.push(stage(`adapter:${id}`, tools.colmap ? 'declared' : 'missing', 'COLMAP 需要现成编译版；插件不进行系统级 CUDA 安装。', tools.colmap ? null : '配置 colmap')); continue; }
    const adapter = records.find(p => p.id === id);
    let ready = !!adapter, detail = adapter ? `优先复用 ${adapter.root}` : `缺少 ${id} 源码或本地适配声明。`, action = adapter ? null : `studio_setup(${id})`;
    if (adapter && ['triposr', 'hunyuan'].includes(id)) {
      const weights = config[`${id}Weights`] || adapter.weightsPath;
      if (!weights) { ready = false; detail += '；缺少本地权重。'; action = `studio_setup(${id}, downloadWeights:true)`; }
      if (!adapter.pythonPath && !config.aiPython) { ready = false; detail += '；缺少 Python 环境。'; }
    }
    if (adapter?.minVramMiB && (recommendation.usableMiB == null || recommendation.usableMiB < adapter.minVramMiB)) { ready = false; detail += '；当前可用显存不足或无法确认。'; action = '选择 Blender 或已适配低显存的用户本地项目'; }
    if (id === 'comfyui' || adapter?.kind === 'comfyui') {
      if (!(adapter?.workflow || config.comfyuiWorkflow)) { ready = false; detail += '；缺少现成 API 工作流，不能仅凭源码完成生成。'; action = '接入已有纯本地工作流及其节点、权重'; }
      else detail += '；本报告不启动或探测本机服务，节点、权重与服务状态需在执行时确认。';
    }
    stages.push(stage(`adapter:${id}`, ready ? 'declared' : 'missing', detail, action));
  }
  if (steps.some(s => s.kind === 'music_beats')) {
    const media = records.find(p => p.id === 'media');
    stages.push(stage('music', tools.ffmpeg && (media?.pythonPath || config.mediaPython) ? 'declared' : 'missing', '复用 FFmpeg 与 librosa 分析候选拍点；已有 aiPython 也可配置 mediaPython。', !tools.ffmpeg ? '配置 FFmpeg' : !media?.pythonPath && !config.mediaPython ? 'studio_setup(media)' : null));
  }
  if (steps.some(s => s.kind === 'ffmpeg') || project.plan?.artifacts.video) stages.push(stage('video-output', tools.ffmpeg ? 'declared' : 'missing', '渲染帧或动画后由现成 FFmpeg 合成；方案必须声明 video 交付物。', tools.ffmpeg ? null : '配置 FFmpeg'));
  stages.push(stage('human-approval', host.capabilities.nativeQuestions ? 'declared' : 'blocked', '正式制作只接受当前修订版的原生用户选择。', host.capabilities.nativeQuestions ? null : '启用 DSH 原生 userQuestions'));
  const delivery = project.plan?.artifacts;
  stages.push(stage('deliverables', project.state === 'completed' ? 'generated-unreviewed' : delivery ? 'planned' : 'pending',
    project.state === 'completed' ? '声明的文件已经生成；尚未自动进行视觉质量或几何验收。' : delivery ? `可编辑工程：${path.basename(delivery.scene)}；模型 ${delivery.models.length} 个${delivery.video ? '；包含视频' : ''}。` : '先保存包含样例工程、模型导出和所需动画的完整方案。', project.plan ? null : 'studio_plan'));
  return { projectId: project.id, state: project.state, readiness: stages.some(s => ['missing', 'blocked'].includes(s.state)) ? 'needs-preparation' : 'declared-capabilities-only',
    stages, nextActions: [...new Set(stages.filter(s => ['missing', 'blocked'].includes(s.state) && s.action).map(s => s.action))],
    localCandidates: records.map(p => ({ id: p.id, root: p.root, source: p.source, capabilities: p.capabilities || [] })),
    promise: '协助完成需求、样例、调整、批准、制作和交付；不把能力声明或文件生成等同于精细度与参考还原已验收。' };
}
