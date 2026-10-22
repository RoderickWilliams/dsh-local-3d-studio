import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, executable } from './process.mjs';
import { inventory } from './dependencies.mjs';
import { inside, writeJson } from './store.mjs';
import { reconstructVideo } from './media.mjs';

function substitute(value, vars) {
  if (Array.isArray(value)) return value.map(v => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  if (typeof value !== 'string') return value;
  if (/^\{\w+\}$/.test(value) && Object.hasOwn(vars, value.slice(1, -1))) return vars[value.slice(1, -1)];
  return value.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(vars, key) ? String(vars[key]) : match);
}

async function comfyui(workflowPath, vars, config, { signal, onOutput }) {
  const base = new URL(config.comfyuiUrl);
  const workflow = substitute(JSON.parse(await fs.readFile(workflowPath, 'utf8')), vars);
  const prompt = workflow.prompt || workflow;
  for (const [id, node] of Object.entries(prompt)) {
    if (/(?:OpenAI|Meshy|Rodin|Replicate|Runway|Kling|TencentCloud|CloudAPI|RemoteAPI)/i.test(node.class_type || '')) throw new Error(`工作流节点 ${id} 包含云端生成能力；请选择纯本地工作流。`);
    const serialized = JSON.stringify(node.inputs || {});
    if (/"(?:api_key|access_token|authorization|secret_key)"\s*:/i.test(serialized)) throw new Error(`工作流节点 ${id} 包含认证字段，不作为免外部 Key 的默认方案执行。`);
  }
  const clientId = crypto.randomUUID();
  const wsUrl = new URL('/ws', base); wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'; wsUrl.searchParams.set('clientId', clientId);
  const socket = new WebSocket(wsUrl);
  let timer, abort, promptId;
  const completed = new Promise((resolve, reject) => {
    socket.addEventListener('message', e => {
      if (typeof e.data !== 'string') return;
      let message; try { message = JSON.parse(e.data); } catch { return; }
      if (message.data?.prompt_id !== promptId) return;
      if (message.type === 'executing' && message.data.node === null) resolve();
      if (message.type === 'execution_error' || message.type === 'execution_interrupted') reject(new Error(`ComfyUI：${message.data.exception_message || '任务已中断'}`));
      if (message.type === 'progress') onOutput(`ComfyUI ${message.data.value}/${message.data.max}\n`);
    });
    socket.addEventListener('error', () => reject(new Error('无法连接本机 ComfyUI WebSocket。请启动现有 ComfyUI。')));
    socket.addEventListener('close', () => reject(new Error('本机 ComfyUI 连接已关闭。')));
    timer = setTimeout(() => reject(new Error('ComfyUI 超过本次任务时间上限。')), config.taskTimeoutMinutes * 60000);
    abort = () => reject(signal.reason || new Error('ComfyUI 等待已取消。'));
    signal.addEventListener('abort', abort, { once: true });
  });
  // 先绑定拒绝处理，避免连接在 HTTP 请求之前失败时出现未处理拒绝。
  completed.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      const timeout = setTimeout(() => reject(new Error('ComfyUI 未启动。')), 8000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('ComfyUI 未启动。')); }, { once: true });
    });
    if (vars.input) {
      const form = new FormData();
      form.set('image', new Blob([await fs.readFile(vars.input)]), path.basename(vars.input));
      const uploaded = await fetch(new URL('/upload/image', base), { method: 'POST', body: form, signal });
      if (!uploaded.ok) throw new Error('ComfyUI 接收参考图片失败。');
      const receipt = await uploaded.json();
      vars.inputImage = receipt.subfolder ? `${receipt.subfolder}/${receipt.name}` : receipt.name;
      Object.assign(prompt, substitute(workflow.prompt || workflow, vars));
    }
    const response = await fetch(new URL('/prompt', base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }), signal });
    if (!response.ok) throw new Error(`ComfyUI 拒绝工作流：${(await response.text()).slice(0, 1500)}`);
    promptId = (await response.json()).prompt_id;
    if (!promptId) throw new Error('ComfyUI 没有返回任务编号。');
    // 小工作流可能在 POST 返回前结束；先读取一次历史，再等待事件，不做无限轮询。
    let history = await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, base), { signal }).then(r => r.json());
    if (!history[promptId]?.outputs) { await completed; history = await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, base), { signal }).then(r => r.json()); }
    const result = [];
    for (const output of Object.values(history[promptId]?.outputs || {})) {
      for (const item of [...(output.images || []), ...(output.gifs || []), ...(output.files || [])]) {
        const url = new URL('/view', base);
        for (const key of ['filename', 'subfolder', 'type']) if (item[key]) url.searchParams.set(key, item[key]);
        const data = await fetch(url, { signal }); if (!data.ok) throw new Error('无法读取 ComfyUI 的任务产物。');
        const filename = `${result.length}-${path.basename(item.filename)}`;
        const target = path.join(vars.output, filename);
        const handle = await fs.open(target, 'wx');
        let bytes = 0;
        try {
          for await (const chunk of data.body) {
            bytes += chunk.byteLength;
            if (bytes > config.maxInputMiB * 1048576) throw new Error('ComfyUI 产物超过配置大小上限；部分文件已保留。');
            await handle.write(chunk);
          }
        } finally { await handle.close(); }
        result.push(target);
      }
    }
    if (!result.length) throw new Error('ComfyUI 工作流没有返回可下载文件；请在本地适配声明中使用支持输出文件的 API 工作流。');
    return result;
  } catch (error) {
    const failure = new Error(error.message || String(error));
    if (promptId) {
      try {
        const cancelled = await fetch(new URL(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, base), { method: 'POST', signal: AbortSignal.timeout(5000) });
        if (!cancelled.ok) failure.message += '；ComfyUI 未提供可用的单任务取消接口，请在其界面确认此任务状态。插件没有中断其他任务。';
      } catch { failure.message += '；无法确认 ComfyUI 单任务是否停止，请在其界面查看；插件不会中断用户的其他服务。'; }
    }
    throw failure;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.close(); }
}

export async function invokeAdapter(step, project, config, context) {
  const { signal, onOutput } = context;
  const output = path.resolve(step.output);
  const projectRoot = path.join(config.dataRoot, project.id);
  if (!inside(projectRoot, output)) throw new Error('适配器输出必须位于当前项目目录。');
  if (step.input && !inside(projectRoot, path.resolve(step.input))) throw new Error('适配器只读取当前项目的素材。');
  await fs.mkdir(output, { recursive: true });
  if (step.adapterId === 'colmap') return reconstructVideo(step, project, config, context);
  const records = (await inventory(config)).projects;
  const adapter = records.find(r => r.id === step.adapterId && !r.invalid);
  if (!adapter) throw new Error(`缺少 ${step.adapterId}；请先发现或获取该项目。`);
  const vram = project.hardware.recommendation.usableMiB;
  if (adapter.minVramMiB && (vram === null || vram < adapter.minVramMiB)) throw new Error(`${adapter.id} 的显存要求未满足或无法确认；请选择已适配的本地项目或 Blender 路线。`);
  const vars = { input: step.input || '', output, prompt: step.prompt || project.brief, negativePrompt: step.negativePrompt || '',
    seed: step.seed ?? 42, width: step.width ?? 512, height: step.height ?? 512 };
  const options = { signal, onOutput, timeoutMs: config.taskTimeoutMinutes * 60000, cwd: adapter.root };
  if (adapter.kind === 'comfyui') {
    const generated = await comfyui(path.resolve(adapter.root, adapter.workflow), vars, config, context);
    const result = [];
    if (generated.length < adapter.outputs.length) throw new Error('工作流返回的文件少于适配声明。');
    for (let i = 0; i < adapter.outputs.length; i++) {
      const target = path.resolve(output, adapter.outputs[i].path);
      if (!inside(output, target)) throw new Error('工作流输出路径越界。');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(generated[i], target, 1); result.push(target);
    }
    return result;
  }
  if (adapter.kind === 'command') {
    const command = adapter.command === '{python}' ? config.aiPython
      : path.isAbsolute(adapter.command) ? adapter.command : path.resolve(adapter.root, adapter.command);
    const binary = await executable(command); if (!binary) throw new Error(`本地适配器入口不存在：${command}`);
    await run(binary, substitute(adapter.args, vars), options);
    return Promise.all(adapter.outputs.map(async item => {
      const file = path.resolve(output, item.path); if (!inside(output, file) || !(await fs.stat(file)).isFile()) throw new Error('本地适配器没有生成声明的产物。'); return file;
    }));
  }
  const python = adapter.pythonPath || config.aiPython;
  if (adapter.id === 'triposr') {
    const weights = config.triposrWeights || adapter.weightsPath;
    if (!weights) throw new Error('TripoSR 权重尚未准备；在 studio_setup 中明确选择下载，或配置已有本地权重。');
    await run(python, [path.join(adapter.root, 'run.py'), vars.input, '--pretrained-model-name-or-path', weights,
      '--output-dir', output, '--model-save-format', 'glb', '--no-remove-bg', '--bake-texture'], options);
    return [path.join(output, '0', 'mesh.glb')];
  }
  if (adapter.id === 'hunyuan') {
    if (config.hunyuanPaint && (vram === null || vram < 29696)) throw new Error('默认混元完整 PBR 链路需要更大显存；请关闭 hunyuanPaint，或使用用户已适配的低显存工作流。');
    const weights = config.hunyuanWeights || adapter.weightsPath;
    if (!weights) throw new Error('混元权重尚未准备；请选择下载或配置已有权重。');
    const request = path.join(output, 'request.json');
    await writeJson(request, { repo: adapter.root, weights, input: vars.input, output: path.join(output, 'mesh.glb'), paint: config.hunyuanPaint });
    await run(python, [fileURLToPath(new URL('../workers/hunyuan_bridge.py', import.meta.url)), request], options);
    return [path.join(output, 'mesh.glb')];
  }
  if (adapter.id === 'comfyui') {
    if (!config.comfyuiWorkflow) throw new Error('请配置已有 ComfyUI API 工作流，或添加 local-3d.adapter.json；插件不猜测用户安装的节点。');
    return comfyui(config.comfyuiWorkflow, vars, config, context);
  }
  throw new Error('该项目没有登记可调用的生成入口。');
}
