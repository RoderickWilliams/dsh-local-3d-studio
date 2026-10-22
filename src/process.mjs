import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function localEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/i.test(key)));
  return { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1', PYTHONUNBUFFERED: '1', ...extra };
}

export async function executable(command, fallbacks = []) {
  const candidates = [command, ...fallbacks].filter(Boolean);
  for (const item of candidates) {
    const dirs = path.isAbsolute(item) || item.includes(path.sep) ? [''] : (process.env.PATH || '').split(path.delimiter);
    const extensions = process.platform === 'win32' && !path.extname(item) ? ['', '.exe'] : [''];
    for (const dir of dirs) for (const ext of extensions) {
      const candidate = path.resolve(dir, item + ext);
      try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* next candidate */ }
    }
  }
  return null;
}

export function run(command, args, { cwd, signal, timeoutMs = 0, onOutput = () => {}, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const proc = spawn(command, args, { cwd, env: localEnvironment(env), shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', failure = null, timer;
    let stopping = false;
    const stop = reason => {
      if (stopping) return;
      stopping = true;
      failure = reason instanceof Error ? reason : new Error(String(reason || '任务已取消。'));
      if (!proc.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => proc.kill());
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
        timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already closed */ } }, 3000);
        timer.unref();
      }
    };
    const onAbort = () => stop(signal.reason || new Error('任务已取消。'));
    const deadline = timeoutMs > 0 ? setTimeout(() => stop(new Error('本地任务超过配置的时间上限；中间产物已保留。')), timeoutMs) : null;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    proc.stdout.on('data', b => { const s = b.toString(); out = (out + s).slice(-262144); onOutput(s, 'stdout'); });
    proc.stderr.on('data', b => { const s = b.toString(); err = (err + s).slice(-262144); onOutput(s, 'stderr'); });
    const cleanup = () => { clearTimeout(deadline); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    proc.on('error', e => { failure = new Error(`无法启动 ${path.basename(command)}：${e.code || e.message}`); });
    proc.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${path.basename(command)} 退出码 ${code}。${(err || out).slice(-3500)}`));
      else resolve({ stdout: out, stderr: err, code });
    });
  });
}
