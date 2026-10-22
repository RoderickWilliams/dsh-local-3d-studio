// Three.js / glTF 模型读写 worker。
// 由 src/three.mjs 以子进程方式调用：stdin 传入 JSON 请求，stdout 最后一行输出 __RESULT__ + JSON。
// 只在 node 环境运行，不启动浏览器、不联网。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

globalThis.self ??= globalThis;
// three 的 GLTFExporter 在 Node 里需要 FileReader（只用来把 Blob 转 ArrayBuffer/DataURL）。
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.(); this.onload?.(); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onloadend?.(); this.onload?.();
    });
  }
};

const depsRoot = process.env.STUDIO_NODE_DEPS;
if (!depsRoot) throw new Error('缺少 STUDIO_NODE_DEPS 环境变量（node 依赖目录）。');
const require = createRequire(path.join(depsRoot, 'package.json'));
const importResolved = async id => {
  const file = require.resolve(id);
  const mod = await import(pathToFileURL(file).href);
  return mod.default && mod.default.Mesh ? { ...mod.default, ...mod } : { ...mod, default: mod.default };
};

async function loadDeps() {
  const threeMod = await importResolved('three');
  const THREE = threeMod.default?.Mesh ? threeMod.default : threeMod;
  const gltfCore = await importResolved('@gltf-transform/core');
  const gltfExt = await importResolved('@gltf-transform/extensions');
  const gltfFns = await importResolved('@gltf-transform/functions');
  return { THREE, ...gltfCore, ...gltfExt, ...gltfFns };
}

function hexToLinear(hex) {
  const value = String(hex).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`颜色必须是 #RRGGBB：${hex}`);
  const srgb = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
  return srgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

function eulerToQuaternion(THREE, rotation) {
  const [x = 0, y = 0, z = 0] = rotation || [];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

function namedNodes(doc, name) {
  const nodes = doc.getRoot().listNodes().filter(n => n.getName() === name);
  if (!nodes.length) throw new Error(`找不到节点：${name}`);
  return nodes;
}

function nodeInfo(doc) {
  const root = doc.getRoot();
  return {
    nodes: root.listNodes().map(n => ({ name: n.getName(), mesh: n.getMesh()?.getName() || null, children: n.listChildren().length })),
    meshes: root.listMeshes().map(m => ({
      name: m.getName(),
      primitives: m.listPrimitives().map(p => ({
        mode: p.getMode(),
        indices: p.getIndices()?.getCount() || 0,
        attributes: p.listAttributes().map(a => ({ name: a.getName(), count: a.getCount(), type: a.getType() })),
      })),
    })),
    materials: root.listMaterials().map(m => ({
      name: m.getName(),
      baseColor: m.getBaseColorFactor(),
      metallic: m.getMetallicFactor(), roughness: m.getRoughnessFactor(),
      alpha: m.getAlpha(), doubleSided: m.getDoubleSided(),
    })),
    textures: root.listTextures().length,
    animations: root.listAnimations().map(a => a.getName()),
    scenes: root.listScenes().map(s => s.getName()),
  };
}

async function bounds(doc, getBounds) {
  const box = getBounds(doc.getRoot().listScenes()[0] || doc.getRoot().listNodes()[0]);
  const round = v => Math.round(v * 10000) / 10000;
  return {
    min: box.min.map(round), max: box.max.map(round),
    size: box.max.map((v, i) => round(v - box.min[i])),
  };
}

async function demoSave(deps, outPath) {
  const { THREE } = deps;
  let GLTFExporter;
  try { ({ GLTFExporter } = await importResolved('three/examples/jsm/exporters/GLTFExporter.js')); }
  catch (e) { throw new Error(`无法加载 Three.js GLTFExporter：${e.message}`); }
  const scene = new THREE.Scene();
  scene.name = 'StudioDemo';
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.35, metalness: 0.15 }));
  cube.name = 'DemoCube'; cube.position.set(0, 0.5, 0);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 16), new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.5 }));
  sphere.name = 'DemoSphere'; sphere.position.set(1.2, 0.35, 0);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.05, 4), new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.9 }));
  floor.name = 'DemoFloor'; floor.position.set(0, -0.025, 0);
  scene.add(cube, sphere, floor);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
  const buffer = Buffer.from(result instanceof ArrayBuffer ? result : result.buffer);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buffer);
  return { bytes: buffer.length, nodes: ['DemoCube', 'DemoSphere', 'DemoFloor'] };
}

function primitiveMesh(THREE, item, index) {
  const type = String(item.type || 'box').toLowerCase();
  const size = Array.isArray(item.size) ? item.size.map(Number) : null;
  const seg = Math.max(6, Math.round(Number(item.segments || 32)));
  let geometry;
  if (type === 'box') geometry = new THREE.BoxGeometry(...(size && size.length >= 3 ? size.slice(0, 3) : [1, 1, 1]));
  else if (type === 'sphere') geometry = new THREE.SphereGeometry(Number(item.radius ?? (size ? size[0] / 2 : 0.5)), seg, Math.max(6, Math.round(seg / 2)));
  else if (type === 'cylinder') {
    const r = Number(item.radius ?? 0.5);
    geometry = new THREE.CylinderGeometry(
      Number(item.radiusTop ?? (size ? size[0] / 2 : r)), Number(item.radiusBottom ?? (size ? size[0] / 2 : r)),
      Number(item.height ?? (size ? size[1] : 1)), seg);
  }
  else if (type === 'cone') geometry = new THREE.ConeGeometry(Number(item.radius ?? (size ? size[0] / 2 : 0.5)), Number(item.height ?? (size ? size[1] : 1)), seg);
  else if (type === 'torus') geometry = new THREE.TorusGeometry(Number(item.radius ?? 0.5), Number(item.tube ?? 0.15), Math.max(6, Math.round(seg / 2)), seg * 2);
  else if (type === 'plane') geometry = new THREE.PlaneGeometry(...(size && size.length >= 2 ? size.slice(0, 2) : [10, 10]));
  else throw new Error(`不支持的图元：${type}（可用 box / sphere / cylinder / cone / torus / plane）`);
  const opacity = item.opacity != null ? Number(item.opacity) : 1;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(String(item.color || '#b8c4d6')),
    metalness: Number(item.metalness ?? 0.1), roughness: Number(item.roughness ?? 0.55),
    transparent: opacity < 1, opacity,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = String(item.name || `${type}-${index + 1}`);
  mesh.position.set(...(Array.isArray(item.position) ? item.position : [0, 0, 0]).slice(0, 3).map(Number));
  mesh.rotation.set(...(Array.isArray(item.rotation) ? item.rotation : [0, 0, 0]).slice(0, 3).map(Number));
  mesh.scale.set(...(Array.isArray(item.scale) ? item.scale : [1, 1, 1]).slice(0, 3).map(Number));
  return mesh;
}

async function specSave(deps, spec, outPath) {
  const { THREE } = deps;
  let GLTFExporter;
  try { ({ GLTFExporter } = await importResolved('three/examples/jsm/exporters/GLTFExporter.js')); }
  catch (e) { throw new Error(`无法加载 Three.js GLTFExporter：${e.message}`); }
  const objects = Array.isArray(spec?.objects) ? spec.objects : [];
  if (!objects.length) throw new Error('generate 需要 spec.objects 数组（至少一个图元）。');
  const scene = new THREE.Scene();
  scene.name = String(spec.name || 'StudioGenerated');
  const meshes = objects.map((item, index) => primitiveMesh(THREE, item, index));
  scene.add(...meshes);
  if (spec.ground !== false) {
    const modelBox = new THREE.Box3().setFromObject(scene);
    const modelSize = modelBox.getSize(new THREE.Vector3());
    const span = Math.max(modelSize.x, modelSize.z, 1);
    const groundSize = Number(spec.groundSize || Math.max(4, span * 2.4));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(String(spec.groundColor || '#242a33')), roughness: 0.95, metalness: 0 }));
    floor.name = 'Ground'; floor.rotation.x = -Math.PI / 2; floor.position.y = Number(spec.groundY ?? 0) - 0.001;
    scene.add(floor);
  }
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
  const buffer = Buffer.from(result instanceof ArrayBuffer ? result : result.buffer);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buffer);
  return { bytes: buffer.length, nodes: meshes.map(m => m.name) };
}

function rootNodesOf(doc) {
  const root = doc.getRoot();
  const scenes = root.listScenes();
  if (scenes.length) return scenes.flatMap(s => s.listChildren());
  return root.listNodes().filter(n => !n.getParent());
}

function modelBounds(doc, getBounds) {
  const root = doc.getRoot();
  const target = root.listScenes()[0] || root.listNodes()[0];
  if (!target) throw new Error('模型没有可用的场景或节点。');
  return getBounds(target);
}

function applyOps(doc, ops, THREE, getBounds) {
  const changes = [];
  for (const raw of ops) {
    const op = raw && typeof raw === 'object' ? raw.op : null;
    if (op === 'transform') {
      const nodes = namedNodes(doc, raw.node);
      for (const node of nodes) {
        if (raw.translation) node.setTranslation(raw.translation.map(Number));
        if (raw.rotation) node.setRotation(eulerToQuaternion(THREE, raw.rotation));
        if (raw.scale !== undefined) {
          const s = Array.isArray(raw.scale) ? raw.scale.map(Number) : [raw.scale, raw.scale, raw.scale].map(Number);
          node.setScale(s);
        }
      }
      changes.push({ op, node: raw.node });
    } else if (op === 'material') {
      const materials = doc.getRoot().listMaterials();
      const target = typeof raw.material === 'number'
        ? (materials[raw.material] ? [materials[raw.material]] : [])
        : materials.filter(m => m.getName() === raw.material);
      if (!target.length) throw new Error(`找不到材质：${raw.material}（也可以用从 0 开始的序号）`);
      for (const material of target) {
        if (raw.baseColor) material.setBaseColorFactor([...hexToLinear(raw.baseColor), raw.alpha ?? material.getAlpha() ?? 1]);
        if (raw.metallic !== undefined) material.setMetallicFactor(Number(raw.metallic));
        if (raw.roughness !== undefined) material.setRoughnessFactor(Number(raw.roughness));
        if (raw.alpha !== undefined) material.setAlpha(Number(raw.alpha));
        if (raw.emissive) material.setEmissiveFactor(hexToLinear(raw.emissive));
        if (raw.doubleSided !== undefined) material.setDoubleSided(raw.doubleSided === true);
      }
      changes.push({ op, material: raw.material });
    } else if (op === 'rename') {
      for (const node of namedNodes(doc, raw.node)) node.setName(String(raw.to || '').trim() || node.getName());
      changes.push({ op, node: raw.node, to: raw.to });
    } else if (op === 'remove') {
      for (const node of namedNodes(doc, raw.node)) node.dispose();
      changes.push({ op, node: raw.node });
    } else if (op === 'duplicate') {
      const source = namedNodes(doc, raw.node);
      for (const node of source) {
        const parent = node.getParentNode() || doc.getRoot().listScenes()[0];
        if (!parent || typeof parent.addChild !== 'function') throw new Error('只能复制场景中的节点。');
        const copy = doc.createNode(String(raw.name || `${node.getName()}_copy`))
          .setMesh(node.getMesh()).setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
        if (raw.translation) copy.setTranslation(raw.translation.map(Number));
        parent.addChild(copy);
        changes.push({ op, node: raw.node, note: '复制节点、网格引用与自身变换；子节点/蒙皮不复制。' });
      }
      changes.push({ op, node: raw.node });
    } else if (op === 'scaleTo') {
      const size = Number(raw.size);
      if (!(size > 0)) throw new Error('scaleTo 需要正数 size。');
      const box = modelBounds(doc, getBounds);
      const current = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
      if (!(current > 0)) throw new Error('模型尺寸为 0，无法缩放。');
      const factor = size / current;
      for (const node of rootNodesOf(doc)) {
        node.setScale(node.getScale().map(v => v * factor));
        node.setTranslation(node.getTranslation().map(v => v * factor));
      }
      changes.push({ op, size, factor: Math.round(factor * 10000) / 10000 });
    } else if (op === 'center') {
      const axis = raw.axis || 'all';
      if (!['x', 'y', 'z', 'all'].includes(axis)) throw new Error('center.axis 只能为 x、y、z 或 all。');
      const box = modelBounds(doc, getBounds);
      const shift = [0, 1, 2].map(i => {
        if (axis === 'all' || axis === 'xyz'[i]) return -((box.min[i] + box.max[i]) / 2);
        return 0;
      });
      for (const node of rootNodesOf(doc)) node.setTranslation(node.getTranslation().map((v, i) => v + shift[i]));
      changes.push({ op, axis, shift: shift.map(v => Math.round(v * 10000) / 10000) });
    } else {
      throw new Error(`不支持的修改操作：${op}`);
    }
  }
  return changes;
}

let viewerRuntimeCache = null;
async function viewerRuntime() {
  if (!viewerRuntimeCache) viewerRuntimeCache = await fs.readFile(new URL('../assets/viewer-runtime.js', import.meta.url), 'utf8');
  return viewerRuntimeCache;
}

function viewerHtml(runtime, base64, title, fileName) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#11151b;color:#dfe6f3;font:14px/1.5 system-ui}canvas{display:block}#hud{position:fixed;left:14px;top:12px;background:#101820cc;padding:10px 14px;border-radius:10px;border:1px solid #2c3644}#hud b{color:#8ab4ff}</style>
</head><body>
<div id="hud"><b>${title}</b><br>${fileName} · 拖动旋转 · 滚轮缩放</div>
<script>${runtime}</script>
<script>
const { THREE, OrbitControls, GLTFLoader } = STUDIO_THREE;
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'iso';
const shot = params.get('shot') === '1';
document.getElementById('hud').style.display = shot ? 'none' : 'block';
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x11151b);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(shot ? 1 : devicePixelRatio); document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1b2029, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0x9fb8ff, 0.8); fill.position.set(-4, 2, -3); scene.add(fill);
const grid = new THREE.GridHelper(20, 20, 0x2b3442, 0x1d242e); scene.add(grid);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = !shot;
const bytes = Uint8Array.from(atob('${base64}'), c => c.charCodeAt(0));
const dirs = { front: [0, 0.18, 1], back: [0, 0.18, -1], left: [-1, 0.18, 0], right: [1, 0.18, 0], top: [0, 1, 0.0001], iso: [1, 0.72, 1] };
new GLTFLoader().parse(bytes.buffer, '', gltf => {
  const root = gltf.scene || gltf.scenes?.[0] || gltf;
  scene.add(root);
  root.updateMatrixWorld(true);
  let box = new THREE.Box3(), hasModel = false;
  root.traverse(obj => {
    if (obj.isMesh && obj.name !== 'Ground') {
      obj.geometry.computeBoundingBox();
      box.union(obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld));
      hasModel = true;
    }
  });
  if (!hasModel) box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 1;
  const d = dirs[view] || dirs.iso;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(d[0] * r * 1.6, d[1] * r * 1.6 + (view === 'top' ? 0 : r * 0.15), d[2] * r * 1.6));
  if (view === 'top') camera.up.set(0, 0, -1);
  camera.lookAt(center); controls.update();
  grid.position.set(center.x, box.min.y, center.z);
  window.__studioReady = true;
}, err => { document.getElementById('hud').textContent = '模型加载失败：' + err; window.__studioError = String(err); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
</script></body></html>`;
}

async function readDocument(io, modelPath) {
  const ext = path.extname(modelPath).toLowerCase();
  if (ext === '.gltf') {
    const json = JSON.parse(await fs.readFile(modelPath, 'utf8'));
    return await io.readJSON({ json, resources: {} });
  }
  const bytes = new Uint8Array(await fs.readFile(modelPath));
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return await io.readBinary(bytes);
  return await io.readBinary(bytes);
}

async function writeDocument(io, doc, outputPath) {
  const ext = path.extname(outputPath).toLowerCase();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (ext === '.gltf') {
    const { json } = await io.writeJSON(doc, { format: 'gltf' });
    await fs.writeFile(outputPath, JSON.stringify(json, null, 2), 'utf8');
    return;
  }
  await fs.writeFile(outputPath, Buffer.from(await io.writeBinary(doc)));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const action = request.action || 'inspect';
  const deps = await loadDeps();
  const { WebIO, getBounds } = deps;
  const io = new WebIO().registerExtensions(deps.ALL_EXTENSIONS || []);

  if (action === 'demo') {
    const outPath = request.outputPath;
    if (!outPath) throw new Error('demo 需要 outputPath。');
    const info = await demoSave(deps, outPath);
    return { ok: true, action, output: outPath, ...info, three: 'three@0.181.0 GLTFExporter' };
  }

  if (action === 'generate') {
    const outPath = request.outputPath;
    if (!outPath) throw new Error('generate 需要 outputPath。');
    const saved = await specSave(deps, request.spec || {}, outPath);
    const generated = await readDocument(io, outPath);
    return { ok: true, action, output: outPath, ...saved, ...nodeInfo(generated), bounds: await bounds(generated, getBounds), three: 'three@0.181.0 GLTFExporter' };
  }

  if (!request.modelPath) throw new Error('需要 modelPath。');
  const doc = await readDocument(io, request.modelPath);
  const root = doc.getRoot();
  const info = { ...nodeInfo(doc), bounds: await bounds(doc, getBounds) };

  if (action === 'inspect') return { ok: true, action, modelPath: request.modelPath, ...info };

  if (action === 'viewer') {
    const output = request.outputPath;
    if (!output) throw new Error('viewer 需要 outputPath（.html）。');
    const buffer = await fs.readFile(request.modelPath);
    const base64 = buffer.toString('base64');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const runtime = await viewerRuntime();
    await fs.writeFile(output, viewerHtml(runtime, base64, request.title || '三维模型预览', path.basename(request.modelPath)), 'utf8');
    return { ok: true, action, viewer: output, bytes: Buffer.byteLength(base64), note: 'HTML 内嵌模型；打开时需要联网加载 three.js（CDN）。' };
  }

  if (action === 'edit') {
    const ops = Array.isArray(request.ops) ? request.ops : [];
    const changes = applyOps(doc, ops, deps.THREE, getBounds);
    const output = request.outputPath;
    if (!output) throw new Error('edit 需要 outputPath。');
    await writeDocument(io, doc, output);
    const after = await readDocument(io, output);
    return { ok: true, action, output, bytes: (await fs.stat(output)).size, changes, ...nodeInfo(after), bounds: await bounds(after, getBounds) };
  }

  throw new Error(`未知 action：${action}`);
}

try {
  const result = await main();
  process.stdout.write(`__RESULT__${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`__RESULT__${JSON.stringify({ ok: false, error: error.message, stack: error.stack?.split('\n').slice(0, 6) })}\n`);
  process.exitCode = 1;
}
