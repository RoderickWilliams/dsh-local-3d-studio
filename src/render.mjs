// 无头 Chrome 截图：把 Three.js 预览页按固定机位渲成 PNG。
// 只用于「没有 Blender 时的预览」；明确不冒充 Blender 渲染。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const VIEWS = ['front', 'back', 'left', 'right', 'top', 'iso'];

function candidateModuleDirs(config) {
  return [
    config.rendererModules,
    process.env.STUDIO_PLAYWRIGHT_MODULES,
    path.join(config.dataRoot, '_dependencies', 'nodejs', 'node_modules'),
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'runtimes', 'skills', 'node', 'node_modules'),
  ].filter(Boolean);
}

async function loadPlaywright(config) {
  const normalize = (mod) => (mod && mod.chromium ? mod : mod?.default || mod);
  try {
    const mod = normalize(await import('playwright'));
    if (mod?.chromium) return mod;
  }
  catch { /* 插件自己的 node_modules 里没有，继续找配置目录 */ }
  for (const dir of candidateModuleDirs(config)) {
    try { await fs.access(path.join(dir, 'playwright', 'package.json')); }
    catch { continue; }
    try {
      const require = createRequire(path.join(dir, 'noop.js'));
      const resolved = require.resolve('playwright');
      const mod = normalize(await import(pathToFileURL(resolved).href));
      if (mod?.chromium) return mod;
    } catch { /* 继续找下一个目录 */ }
  }
  throw new Error('找不到 Playwright，无法自动渲染预览图。可以安装 playwright，或把插件配置 rendererModules 指向含 playwright 的 node_modules；没有它仍可用 action=viewer 生成网页手动查看。');
}

export function normalizeViews(views) {
  if (views === undefined) return ['front', 'right', 'back', 'iso'];
  if (!Array.isArray(views) || !views.length) throw new Error('views 必须是非空数组。');
  if (views.length > 6) throw new Error('一次最多渲染 6 个视角。');
  return views.map((raw) => {
    const view = String(raw).toLowerCase();
    if (!VIEWS.includes(view)) throw new Error(`不支持的视角：${view}；可用 ${VIEWS.join('、')}。`);
    return view;
  });
}

export async function renderViews(config, viewerPath, outDir, views, { signal } = {}) {
  const { chromium } = await loadPlaywright(config);
  const channel = process.env.STUDIO_CHROME_CHANNEL || 'chrome';
  let browser;
  try {
    browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch (error) {
    throw new Error(`启动无头 Chrome 失败（channel=${channel}）：${error.message}。可设置 STUDIO_CHROME_CHANNEL=msedge 或安装 Chrome。`);
  }
  const onAbort = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const files = [];
  try {
    await fs.mkdir(outDir, { recursive: true });
    for (const view of views) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      const target = pathToFileURL(viewerPath);
      target.searchParams.set('view', view);
      target.searchParams.set('shot', '1');
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      try {
        await page.goto(target.href, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => window.__studioReady === true || window.__studioError, null, { timeout: 45000 });
        const failure = await page.evaluate(() => window.__studioError || '');
        if (failure) throw new Error(`预览页报告加载失败：${failure}`);
        await page.waitForTimeout(500);
        const file = path.join(outDir, `view-${view}.png`);
        await page.screenshot({ path: file });
        const stat = await fs.stat(file);
        files.push({ view, file, bytes: stat.size });
      } catch (error) {
        const detail = errors.length ? `；页面错误：${errors.slice(0, 2).join(' | ')}` : '';
        throw new Error(`渲染视角 ${view} 失败：${error.message}${detail}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    return { ok: true, renderer: 'headless-chrome', viewer: viewerPath, outDir, files };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
