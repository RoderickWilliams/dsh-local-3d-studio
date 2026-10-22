import fs from 'node:fs/promises';
import path from 'node:path';
import { approvalFingerprint, busyStates, expand, locations, validateToolPaths } from './plan.mjs';
import { invokeAdapter } from './adapters.mjs';
import { ffmpegStep, musicBeats, videoFrames } from './media.mjs';

export class Engine {
  constructor(ctx, config, store, blender) {
    this.ctx = ctx; this.config = config; this.store = store; this.blender = blender; this.active = new Map();
    ctx.effect(() => () => { for (const controller of this.active.values()) controller.abort(new Error('工作室插件已停止，项目中间产物已保留。')); }, 'local3d.active-tasks');
  }
  async start(id, phase, exec) {
    if (!['preview', 'build'].includes(phase)) throw new Error('阶段只能为 preview 或 build。');
    if (this.active.size) throw new Error('本地工作室已有任务运行；请等待或取消，避免多个任务争用同一 Blender 和显存。');
    let p = await this.store.load(id, exec.agent.id);
    if (!p.plan) throw new Error('先提交制作方案。');
    if (busyStates.has(p.state)) throw new Error('此项目有未结束任务。');
    if (phase === 'build' && (p.state !== 'approved' || p.approval?.fingerprint !== await approvalFingerprint(this.store, p))) throw new Error('正式制作需要当前样例的人工批准；样例或方案改变后需重新批准。');
    if (phase === 'preview' && p.state === 'interviewing' && !p.requirementsConfirmed) throw new Error('特别需求尚未确认，请先完成需求访谈。');
    exec.signal.throwIfAborted();
    p = await this.store.update(id, exec.agent.id, async current => {
      if (current.revision !== p.revision || busyStates.has(current.state)) throw new Error('项目状态已变化。');
      if (phase === 'build' && (current.state !== 'approved' || !current.approval || current.approval.fingerprint !== await approvalFingerprint(this.store, current))) throw new Error('等待期间批准已变化，正式制作没有启动。');
      current.state = phase === 'preview' ? 'previewing' : 'building'; current.phase = phase; current.step = 0;
      if (phase === 'build') { current.consumedApproval = current.approval; current.approval = null; }
      else { current.samples = []; current.approval = null; current.previewArtifacts = []; current.previewScene = null; }
      return current;
    });
    const work = async (signal, job) => {
      const places = locations(this.store, p);
      const logPath = path.join(places.revisionDir, `${phase}.log`);
      let log = null, logWrites = Promise.resolve();
      const output = (text, channel = 'stdout') => { if (log) logWrites = logWrites.then(() => log.appendFile(text)).catch(() => {}); job?.append(text, { channel }); };
      const artifacts = [];
      try {
        for (const dir of Object.values(places)) await fs.mkdir(dir, { recursive: true });
        log = await fs.open(logPath, 'a');
        const steps = phase === 'preview' ? p.plan.previewSteps : p.plan.buildSteps;
        if (steps.some(s => s.kind === 'blender')) {
          await this.blender.connect(exec);
          await this.blender.launch(this.store, p, phase, { signal, onOutput: output });
        }
        for (let i = 0; i < steps.length; i++) {
          signal.throwIfAborted();
          const step = expand(steps[i], this.store, p);
          const label = `${phase === 'preview' ? '样例' : '正式制作'} ${i + 1}/${steps.length}：${step.reason || step.tool || step.kind}`;
          job?.updateProgress(label); output(`${label}\n`);
          const context = { signal, onOutput: output, timeoutMs: this.config.taskTimeoutMinutes * 60000 };
          if (step.kind === 'blender') {
            validateToolPaths(step.args, places.projectDir, p.inputs.map(x => x.path));
            if (/(?:^|__)(?:save_file|export_file|render_image|render_animation|render_sequencer)$/.test(step.tool)) {
              const destination = step.args.filepath || step.args.file_path || step.args.output_path;
              if (!destination) throw new Error('保存、导出和渲染步骤必须明确声明输出路径，不能覆盖当前打开的旧工程。');
              validateToolPaths({ output_path: destination }, places.revisionDir);
              await fs.mkdir(path.dirname(destination), { recursive: true });
            }
            await this.blender.call(step, exec, signal);
          } else if (step.kind === 'adapter') {
            artifacts.push(...await invokeAdapter(step, p, this.config, context));
          } else if (step.kind === 'ffmpeg') {
            artifacts.push(...await ffmpegStep(step.args, p, places.projectDir, context));
          } else if (step.kind === 'video_frames') {
            if (!step.input || !step.output) throw new Error('抽帧步骤缺少 input / output。');
            validateToolPaths({ input_path: step.input, output_path: step.output }, places.projectDir);
            artifacts.push(...await videoFrames(step.input, step.output, p, this.config, context, step.count || 8));
          } else if (step.kind === 'music_beats') {
            validateToolPaths({ input_path: step.input, output_path: step.output }, places.projectDir);
            artifacts.push(...await musicBeats(step.input, step.output, p, this.config, context));
          }
          await this.store.update(id, exec.agent.id, current => { current.step = i + 1; return current; });
        }
        const declaration = expand(p.plan.artifacts, this.store, p);
        const samples = phase === 'preview' ? await Promise.all(declaration.previews.map(async file => ({ path: await this.store.ownFile(id, file), kind: 'sample' }))) : p.samples;
        const files = phase === 'build' ? [declaration.scene, ...declaration.models, ...(declaration.renders || []), ...(declaration.video ? [declaration.video] : [])] : [];
        for (const file of files) await this.store.ownFile(id, file);
        if (phase === 'preview' && declaration.previewScene) { await this.store.ownFile(id, declaration.previewScene); artifacts.push(declaration.previewScene); }
        await this.store.update(id, exec.agent.id, current => {
          current.state = phase === 'preview' ? 'awaiting_review' : 'completed'; current.activeJob = null; current.error = null;
          if (phase === 'preview') { current.samples = samples; current.previewScene = declaration.previewScene || null; current.previewArtifacts = [...new Set(artifacts)]; }
          else current.deliverables = files;
          return current;
        });
        return { status: 'completed', detail: phase === 'preview' ? '样例已生成，等待用户选择需求与精细化方向。' : '模型与声明的动画产物已生成。', result: JSON.stringify({ projectId: id, phase, samples, files }) };
      } catch (error) {
        await this.store.update(id, exec.agent.id, current => { current.state = signal.aborted ? 'cancelled' : 'failed'; current.error = error.message; current.activeJob = null; current.approval = null; return current; }).catch(() => {});
        return { status: signal.aborted ? 'killed' : 'failed', detail: error.message };
      } finally { await this.blender.stop(); await logWrites; await log?.close(); this.active.delete(id); }
    };
    const foreground = async () => {
      const controller = new AbortController(); this.active.set(id, controller);
      const deadline = setTimeout(() => controller.abort(new Error('本次制作超过配置的总时限。')), this.config.taskTimeoutMinutes * 60000);
      try { return await work(AbortSignal.any([exec.signal, controller.signal])); }
      finally { clearTimeout(deadline); }
    };
    const jobs = this.ctx.get?.('jobs');
    if (typeof jobs?.start === 'function' && this.config.allowBackground) {
      const controller = new AbortController(); this.active.set(id, controller);
      let jobId, started = false, running;
      try {
        jobId = jobs.start({ kind: 'local3d', label: `${p.plan.title} · ${phase}`, owner: exec.agent.id,
          run: job => {
            started = true;
            const deadline = setTimeout(() => controller.abort(new Error('本次制作超过配置的总时限。')), this.config.taskTimeoutMinutes * 60000);
            const done = work(controller.signal, job).catch(e => ({ status: 'failed', detail: e.message })).finally(() => { clearTimeout(deadline); this.active.delete(id); });
            running = done;
            return { cancel: reason => controller.abort(new Error(reason || '用户取消制作。')), done };
          } });
      } catch (e) {
        if (started) { controller.abort(e); if (running) await running; throw e; }
        this.active.delete(id);
        // Admission failed before any work began. Keep this same authorized
        // attempt and run it in the foreground; never execute a second build.
        return foreground();
      }
      await this.store.update(id, exec.agent.id, current => { if (busyStates.has(current.state)) current.activeJob = jobId; return current; }).catch(() => {});
      return { kind: 'background', jobId, projectId: id, phase, next: '任务由 Harness 后台作业服务管理；完成通知后调用 studio_samples 或 studio_status。不要无限轮询。' };
    }
    return foreground();
  }
  async cancel(id, owner) {
    await this.store.load(id, owner);
    const controller = this.active.get(id);
    if (!controller) return { cancelled: false, message: '当前进程没有此项目的运行任务；若上次程序异常退出，请恢复项目。' };
    controller.abort(new Error('用户取消制作。'));
    return { cancelled: true, message: '已请求取消；等待进程退出后保留中间文件。' };
  }
}
