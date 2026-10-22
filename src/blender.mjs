import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inventory } from './dependencies.mjs';
import { localEnvironment } from './process.mjs';
import { writeJson } from './store.mjs';

const prefix = 'mcp__local3d__';
export class BlenderBridge {
  constructor(ctx, config) {
    this.ctx = ctx; this.config = config; this.permits = new Set(); this.process = null; this.mounting = null;
    ctx.tools.guard(exec => exec.name.startsWith(prefix) && !this.permits.has(exec.parent)
      ? '请通过 studio_run 执行已登记的制作方案；不能绕过样例批准直接操作工作室 Blender。' : undefined);
    ctx.effect(() => () => this.stop(), 'local3d.blender-process');
  }
  async backend() {
    const { projects } = await inventory(this.config);
    const selected = projects.find(p => p.id === 'blenderwright' && !p.invalid);
    if (!selected) throw new Error('未找到 Blenderwright。先调用 studio_setup，插件会优先复用本地项目，缺失时获取官方仓库。');
    const python = this.config.blenderwrightPython || selected.pythonPath;
    if (!python) throw new Error('Blenderwright 缺少可用的隔离环境；先执行 studio_setup。');
    return { ...selected, pythonPath: python };
  }
  async connect(exec) {
    if (this.ctx.tools.schemas(exec.agent).some(s => s.name.startsWith(prefix))) return;
    if (this.mounting) return this.mounting;
    this.mounting = (async () => {
      const backend = await this.backend();
      let McpClient;
      try { McpClient = await import('@deepseek-ai/dsh-mcp-client'); }
      catch { throw new Error('当前 DSH 没有可加载的官方 dsh-mcp-client。保留原 profile 并启用与宿主版本一致的 MCP 客户端；插件不会自动升级宿主。'); }
      if (typeof McpClient.apply !== 'function') throw new Error('当前官方 MCP 客户端没有兼容的 apply 接口，请查看 studio_compatibility。');
      let off, timer;
      const ready = new Promise((resolve, reject) => {
        const changed = () => { if (this.ctx.tools.schemas(exec.agent).some(s => s.name.startsWith(prefix))) resolve(); };
        off = this.ctx.on('tools/change', changed);
        timer = setTimeout(() => reject(new Error('Blenderwright 工具注册超时；查看 Harness 插件日志后重试。')), 20000);
      });
      ready.catch(() => {});
      try {
        this.ctx.plugin(McpClient, { serverName: 'local3d', transport: 'stdio', command: backend.pythonPath,
          args: [fileURLToPath(new URL('../workers/blenderwright_entry.py', import.meta.url)), '--repo', backend.root, '--port', String(this.config.blenderPort)],
          cwd: backend.root, env: { PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
          toolCallTimeoutMs: this.config.taskTimeoutMinutes * 60000, failOnStartupError: true });
        if (!this.ctx.tools.schemas(exec.agent).some(s => s.name.startsWith(prefix))) await ready;
      } finally { clearTimeout(timer); off?.(); }
    })();
    try { await this.mounting; } catch (e) { this.mounting = null; throw e; }
  }
  async catalog(exec, query = '') {
    await this.connect(exec);
    const all = this.ctx.tools.schemas(exec.agent).filter(s => s.name.startsWith(prefix));
    const selected = query ? all.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())) : all;
    return { total: all.length, tools: selected.slice(0, query ? 30 : 200).map(s => query ? s : { name: s.name, description: s.description?.slice(0, 180) }),
      note: '先按工具名查询实际参数，再编排。不要猜测字段；不使用原始 Python 工具。' };
  }
  async launch(store, project, phase, { signal, onOutput }) {
    await this.stop();
    const binary = project.hardware.tools.blender;
    if (!binary) throw new Error('未找到 Blender 可执行文件。请安装 Blender 或配置 blender 路径，再重新识别硬件。');
    const backend = await this.backend();
    const optionsFile = path.join(store.directory(project.id), 'blender-session.json');
    await writeJson(optionsFile, { repo: backend.root, port: this.config.blenderPort, resume: phase === 'build' && !!project.previewScene,
      phase, render: project.plan.render, previewSize: this.config.previewSize });
    const args = ['--factory-startup'];
    if (phase === 'build' && project.previewScene) args.push(await store.ownFile(project.id, project.previewScene));
    args.push('--python', fileURLToPath(new URL('../workers/blender_bootstrap.py', import.meta.url)), '--', optionsFile);
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { shell: false, windowsHide: true, env: localEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      this.process = child;
      let text = '', settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
      const aborted = () => { void this.stop(); finish(signal.reason || new Error('已取消 Blender 启动。')); };
      const timer = setTimeout(() => { void this.stop(); finish(new Error('专用 Blender 实例启动超时；已停止该实例。')); }, 45000);
      signal.addEventListener('abort', aborted, { once: true });
      child.stdout.on('data', b => { const s = b.toString(); text = (text + s).slice(-8192); onOutput(s); if (text.includes('LOCAL3D_BLENDER_READY')) finish(); });
      child.stderr.on('data', b => onOutput(b.toString(), 'stderr'));
      child.on('error', e => finish(e));
      child.on('close', code => { if (this.process === child) this.process = null; finish(new Error(`Blender 在就绪前退出：${code}`)); });
    });
  }
  async call(step, exec, signal) {
    const name = step.tool.startsWith(prefix) ? step.tool : prefix + step.tool;
    if (!this.ctx.tools.schemas(exec.agent).some(s => s.name === name)) throw new Error(`上游没有工具 ${name}；请使用 studio_catalog 获取真实工具定义。`);
    this.permits.add(exec.token);
    try {
      const result = await this.ctx.tools.execute({ callId: `${exec.callId}:local3d:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        rootCallId: exec.rootCallId || exec.callId, parent: exec.token, name, arguments: step.args, agent: exec.agent, signal });
      if (result.isError) throw new Error(result.error?.message || result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || 'Blender 工具执行失败。');
      for (const context of result.additionalContexts || []) exec.deferContext(context);
      return result.value;
    } finally { this.permits.delete(exec.token); }
  }
  async stop() {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.process = null;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGTERM');
    });
  }
}
