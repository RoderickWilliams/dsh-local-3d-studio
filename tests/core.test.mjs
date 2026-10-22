import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configuration } from '../src/config.mjs';
import { parseNvidia, recommend } from '../src/hardware.mjs';
import { Store, writeJson } from '../src/store.mjs';
import { approvalFingerprint, validatePlan, questionAnswers, expand, validateToolPaths } from '../src/plan.mjs';
import { validateAdapter, inventory } from '../src/dependencies.mjs';
import { askRound } from '../src/interview.mjs';
import { Engine } from '../src/engine.mjs';
import { supportedApi, selectModel, compatibility, imageResult } from '../src/compatibility.mjs';
import { validateOps, validateSpec } from '../src/three.mjs';
import { normalizeViews } from '../src/render.mjs';

const testBase = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
async function temporary(t, prefix) {
  await fs.mkdir(testBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(testBase, prefix));
  const relative = path.relative(testBase, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝清理测试目录之外的路径。');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function plan() {
  return { title: '测试模型', summary: '状态机测试使用的虚构工具，不调用 Blender。',
    render: { width: 1280, height: 720, fps: 24, frames: 1 },
    previewSteps: [{ kind: 'blender', tool: 'create_object', args: { type: 'CUBE' } }],
    buildSteps: [{ kind: 'blender', tool: 'save_file', args: { filepath: '{buildDir}/final.blend' } }],
    artifacts: { previews: ['{previewDir}/front.png'], previewScene: '{previewDir}/sample.blend', scene: '{buildDir}/final.blend', models: ['{buildDir}/model.glb'] } };
}
async function fixture(t) {
  const root = await temporary(t, 'local3d-test-');
  const config = configuration({ dataRoot: path.join(root, 'projects'), inputRoots: [root], projectRoots: [root] }, root);
  const store = new Store(config);
  const p = await store.create('owner', '模型', 'text', [], { tools: {}, recommendation: { usableMiB: null } });
  const sample = path.join(store.directory(p.id), 'sample.png');
  await fs.writeFile(sample, 'unit-test fixture, not a rendered image');
  const current = await store.update(p.id, 'owner', x => { x.plan = plan(); x.revision = 1; x.samples = [{ path: sample }]; x.state = 'awaiting_review'; return x; });
  return { root, config, store, p: current, sample };
}

test('显存未知保持 null，使用保守路线', () => {
  const r = recommend({ gpus: [] }, {});
  assert.equal(r.dedicatedMiB, null); assert.equal(r.defaultBackend, 'blenderwright'); assert.deepEqual(r.optionalBackends, []);
});
test('按可用显存选择显卡，不被最大总显存误导', () => {
  const gpus = parseNvidia('GPU A, 24576, 1000\nGPU B, 12288, 11000');
  const r = recommend({ gpus }, {});
  assert.equal(r.gpuName, 'GPU B'); assert.ok(r.optionalBackends.includes('hunyuan'));
});
test('CSV 支持带逗号的显卡名与不可用容量', () => {
  const g = parseNvidia('"GPU, sample", 8192, 7000\nGPU unavailable, [N/A], [N/A]');
  assert.equal(g[0].name, 'GPU, sample'); assert.equal(g[1].dedicatedMiB, null);
});
test('配置拒绝外部付费端点与不合法时限', () => {
  assert.throws(() => configuration({ comfyuiUrl: 'https://example.com' }));
  assert.throws(() => configuration({ taskTimeoutMinutes: 0 }));
});
test('拒绝原始 Python 工具及超过帧数上限的方案', () => {
  const c = configuration(); const p = plan(); p.previewSteps[0].tool = 'execute_blender_code';
  assert.throws(() => validatePlan(p, c)); p.previewSteps[0].tool = 'create_object'; p.render.frames = c.maxFrames + 1;
  assert.throws(() => validatePlan(p, c));
});
test('格式名称不被误当成路径，但导出路径不能越界', () => {
  const root = path.resolve('example-project');
  validateToolPaths({ output_format: 'PNG', format: 'GLTF', curve_name: 'Route' }, root);
  assert.throws(() => validateToolPaths({ filepath: path.resolve('outside/model.glb') }, root));
});
test('模型自行传入 true 或自由文本均不等于原生批准', () => {
  assert.equal(questionAnswers({ approved: true }, 'q', '制作'), false);
  assert.equal(questionAnswers({ answers: [{ id: 'q', selected: [], custom: '制作' }] }, 'q', '制作'), false);
  assert.equal(questionAnswers({ answers: [{ id: 'q', selected: ['制作'] }] }, 'q', '制作'), true);
});
test('项目按对话归属隔离', async t => {
  const { store, p } = await fixture(t);
  await assert.rejects(store.load(p.id, 'other-owner'));
  assert.throws(() => store.directory('../../secret'));
});
test('改变样图、方案或预览工程会改变批准指纹', async t => {
  const { store, p, sample } = await fixture(t);
  const first = await approvalFingerprint(store, p);
  await fs.writeFile(sample, 'modified sample');
  assert.notEqual(await approvalFingerprint(store, p), first);
  p.plan.summary = '新的需求'; const second = await approvalFingerprint(store, p);
  const scene = path.join(store.directory(p.id), 'preview.blend'); await fs.writeFile(scene, 'scene'); p.previewArtifacts = [scene];
  assert.notEqual(await approvalFingerprint(store, p), second);
});
test('素材不在允许目录时拒绝复制', async t => {
  const { store, p } = await fixture(t);
  const outside = await temporary(t, 'local3d-outside-');
  const file = path.join(outside, 'reference.png'); await fs.writeFile(file, 'fixture');
  await assert.rejects(store.input(file, path.join(store.directory(p.id), 'copy')));
});
test('路径占位符不能执行代码，缺少参考输入时拒绝', async t => {
  const { store, p } = await fixture(t);
  assert.equal(expand('{buildDir}/model.glb', store, p), path.join(store.directory(p.id), 'revision-1/build/model.glb'));
  assert.throws(() => expand('{input:99}', store, p));
});
test('自定义适配器输出不能越界，也不能覆盖官方 id', () => {
  const base = path.resolve('repo');
  const a = { schemaVersion: 1, localOnly: true, id: 'my-project', kind: 'command', command: '{python}', args: ['run.py'], capabilities: ['image-to-3d'], outputs: [{ path: '../model.glb' }] };
  assert.throws(() => validateAdapter(a, base));
  a.outputs[0].path = 'model.glb'; a.id = 'blenderwright'; assert.throws(() => validateAdapter(a, base));
});
test('发现优先本地适配声明，扫描不执行项目入口', async t => {
  const { root, config } = await fixture(t);
  const repo = path.join(root, 'my-reconstructor'); await fs.mkdir(repo);
  await writeJson(path.join(repo, 'local-3d.adapter.json'), { schemaVersion: 1, localOnly: true, id: 'my-model', kind: 'command', command: 'never-run.exe', args: [], capabilities: ['image-to-3d'], outputs: [{ path: 'mesh.glb' }] });
  const result = await inventory({ ...config, preferredProjects: [repo] });
  assert.equal(result.projects[0].id, 'my-model');
});
test('访谈保存答案并清除旧需求确认，不重复问已回答问题', async t => {
  const { store, p } = await fixture(t);
  const ctx = { userQuestions: { ask: async () => ({ answers: [{ id: 'purpose', selected: ['近景展示'] }] }) } };
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal };
  await askRound(ctx, store, p.id, exec, [{ id: 'purpose', question: '用途是什么？' }]);
  const next = await store.load(p.id, 'owner'); assert.deepEqual(next.requirements.purpose, ['近景展示']); assert.equal(next.requirementsConfirmed, false);
  await assert.rejects(askRound(ctx, store, p.id, exec, [{ id: 'purpose', question: '重复问题？' }]));
});
test('未批准或批准后样图变化时，正式制作不会启动任何工具', async t => {
  const { store, config, p, sample } = await fixture(t);
  let starts = 0;
  const ctx = { effect() {}, get() { return undefined; } };
  const bridge = { launch() { starts++; }, stop: async () => {} };
  const engine = new Engine(ctx, config, store, bridge);
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal };
  await assert.rejects(engine.start(p.id, 'build', exec));
  await store.update(p.id, 'owner', async x => { x.approval = { fingerprint: await approvalFingerprint(store, x) }; x.state = 'approved'; return x; });
  await fs.writeFile(sample, 'changed'); await assert.rejects(engine.start(p.id, 'build', exec)); assert.equal(starts, 0);
});
test('后台登记在执行前拒绝时，同一次批准只以前台执行一次', async t => {
  const { store, config, p } = await fixture(t);
  await store.update(p.id, 'owner', async x => { x.approval = { fingerprint: await approvalFingerprint(store, x) }; x.state = 'approved'; return x; });
  const ctx = { effect() {}, get() { return { start() { throw new Error('no job controller'); } }; } };
  let calls = 0;
  const bridge = { connect: async () => {}, launch: async () => {}, stop: async () => {}, call: async step => {
    calls++; await fs.writeFile(step.args.filepath, 'mock scene, not a real Blender file');
    await fs.writeFile(path.join(path.dirname(step.args.filepath), 'model.glb'), 'mock mesh');
  } };
  const engine = new Engine(ctx, config, store, bridge);
  const result = await engine.start(p.id, 'build', { agent: { id: 'owner' }, signal: new AbortController().signal });
  const latest = await store.load(p.id, 'owner'); assert.equal(result.status, 'completed'); assert.equal(calls, 1);
  assert.equal(latest.state, 'completed'); assert.equal(latest.approval, null);
});

test('已知 API 版本可识别，旧版和未知主版本不能冒充兼容', () => {
  assert.equal(supportedApi('0.2.1-rc.2'), true); assert.equal(supportedApi('0.2.1'), true);
  assert.equal(supportedApi('0.2.0'), false); assert.equal(supportedApi('0.3.0'), false); assert.equal(supportedApi(null), null);
});
test('模型视觉能力只来自精确路由声明，不按 Flash 名称猜测', () => {
  const catalog = [{ id: 'flash', provider: 'a', inputModalities: ['text'] }, { id: 'flash', provider: 'b', inputModalities: ['text', 'image'] }];
  assert.equal(selectModel(catalog, { model: 'flash', provider: 'a' }).vision, false);
  assert.equal(selectModel(catalog, { model: 'flash', provider: null }).vision, null);
  assert.equal(selectModel(catalog, { model: null, provider: null }).vision, null);
});
test('宿主可选服务缺失时，前台与文件链接降级且不伪造人工批准', async () => {
  const ctx = { tools: { register() {}, schemas() {}, execute() {}, guard() {} }, effect() {}, on() {}, plugin() {}, systemPrompt: { section() {} } };
  const report = await compatibility(ctx, { defineTool() {} });
  assert.equal(report.adaptations.execution, 'foreground-with-deadline');
  assert.equal(report.adaptations.samples, 'absolute-file-links'); assert.equal(report.adaptations.approval, 'blocked-no-native-human-channel');
  const shown = await imageResult(ctx, [path.resolve('sample.png')]); assert.deepEqual(shown.images, []); assert.match(shown.display, /sample\.png/);
});
test('只有概念图而没有真实预览工程的方案不能进入制作', () => {
  const p = plan(); delete p.artifacts.previewScene; assert.throws(() => validatePlan(p, configuration()));
});
test('three 模型通道的参数校验不猜错', () => {
  const ops = validateOps([
    { op: 'transform', node: 'Cube', translation: [0, 1, 0], rotation: [0, 90, 0] },
    { op: 'material', material: 0, baseColor: '#ff3355', roughness: 0.2, metallic: 0.6 },
    { op: 'scaleTo', size: 2 },
    { op: 'center', axis: 'y' },
  ]);
  assert.equal(ops.length, 4);
  assert.equal(ops[1].baseColor, '#ff3355');
  assert.throws(() => validateOps([{ op: 'explode' }]), /不支持/);
  assert.throws(() => validateOps([{ op: 'transform' }]), /需要 node/);
  assert.throws(() => validateOps([{ op: 'material', material: 0, baseColor: 'red' }]), /#RRGGBB/);
  assert.throws(() => validateOps([{ op: 'scaleTo', size: 0 }]), /正数/);
  assert.throws(() => validateOps('x'), /数组/);
});

test('程序化生成的 spec 校验不猜错', () => {
  const spec = validateSpec({ name: 'shelf', objects: [
    { type: 'box', size: [1, 2, 0.3], position: [0, 1, 0], color: '#b9834f' },
    { type: 'cylinder', radius: 0.2, height: 1.4, color: '#4f7fd9', metalness: 0.4 },
  ] });
  assert.equal(spec.objects.length, 2);
  assert.throws(() => validateSpec({ objects: [] }), /非空数组/);
  assert.throws(() => validateSpec({ objects: [{ type: 'torusKnot' }] }), /类型不支持/);
  assert.throws(() => validateSpec({ objects: [{ type: 'box', size: [1, -1, 1] }] }), /正数/);
  assert.throws(() => validateSpec({ objects: [{ type: 'sphere', color: 'blue' }] }), /#RRGGBB/);
  assert.throws(() => validateSpec({ objects: [{ type: 'sphere', opacity: 2 }] }), /opacity/);
});

test('渲染视角只接受已知机位', () => {
  assert.deepEqual(normalizeViews(undefined), ['front', 'right', 'back', 'iso']);
  assert.deepEqual(normalizeViews(['iso', 'TOP']), ['iso', 'top']);
  assert.throws(() => normalizeViews(['bird']), /不支持的视角/);
  assert.throws(() => normalizeViews([]), /非空数组/);
});
