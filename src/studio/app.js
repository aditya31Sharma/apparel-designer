import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SurfaceIndex, buildDecalGeometry } from './decal.js';
import { optimizeGLB } from './vendor/draco-export.js';
import { CREW_FABRICS, crewSheen } from './crew.js';
import { ACID_MASK, ACID_REPEAT, ACID_CM_REF, ACID_DEFAULT, ACID_PRESETS, ACID_CREW_SHEEN, acidPixels, acidSwatch } from './acid.js';
import { StorePreview, describe } from './preview.js';

const $ = (id) => document.getElementById(id);

// Inside Tenzen Studio this page runs in a frame next to the Artwork tab. The page
// around it owns the menu bar (so it routes Cmd Z / S / O / 0 / B here), the native
// save dialog, and the artwork that "Current artwork" places on the garment.
function hostWindow() {
  try { return window.parent !== window && window.parent.App ? window.parent : null; } catch (e) { return null; }
}
const HOST = hostWindow();
const DESKTOP = HOST && HOST.desktop ? HOST.desktop : null;
if (HOST) document.body.classList.add('embedded');
const SHOPIFY_LIMIT = 15 * 1024 * 1024;
const PREVIEW_MAX = 2048;
const SOURCE_MAX = 4096;
const SNAP_PX = 9;

// Camera-facing print planes. right/up are the print's own axes as seen from that side.
const FACES = {
  front: { normal: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0) },
  back: { normal: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(-1, 0, 0) },
  left: { normal: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 0, -1) },
  right: { normal: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(0, 0, 1) },
};
const UP = new THREE.Vector3(0, 1, 0);

const FABRICS = {
  plain: { label: 'Plain' },
  jersey: { label: 'Jersey', normal: 'fabrics/jersey_normal.jpg', repeat: 2.0, strength: 0.55 },
  ...CREW_FABRICS,
  fleece: { label: 'Fleece', normal: 'fabrics/fleece_normal.jpg', repeat: 0.55, strength: 0.35 },
  heather: { label: 'Heather', normal: 'fabrics/fleece_normal.jpg', repeat: 0.55, strength: 0.3, mask: 'fabrics/heather_mask.png', maskRepeat: 1.0, maskAmount: 0.55 },
  waffle: { label: 'Waffle', normal: 'fabrics/waffle_normal.png', repeat: 1.2, strength: 0.7 },
  ribbed: { label: 'Ribbed', normal: 'fabrics/ribbed_normal.png', repeat: 1.6, strength: 0.7 },
};
const SWATCHES = ['#141414', '#2b2b2b', '#5a5a5a', '#8a8a8a', '#d9d9d6', '#f2f0ec', '#ffffff',
  '#1f2a44', '#2f4a32', '#1e3b2a', '#5b3a29', '#8b6f4e', '#c8102e', '#e8b7c4'];

// ---------------- renderer ----------------
const canvas = $('view');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
keyLight.position.set(2, 3, 4);
scene.add(keyLight);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

const garmentRoot = new THREE.Group();
const decalRoot = new THREE.Group();
const zoneRoot = new THREE.Group();
scene.add(garmentRoot, zoneRoot, decalRoot);

const gltfLoader = new GLTFLoader().setDRACOLoader(
  new DRACOLoader().setDecoderPath('./vendor/addons/libs/draco/').setDecoderConfig({ type: 'wasm' }));
const imgCache = new Map();

// ---------------- state ----------------
const state = {
  manifest: null,
  garment: null,
  meshes: [],        // garment part meshes
  index: null,       // SurfaceIndex
  parts: {},         // name -> { color, fabric }
  strength: 1, texScale: 1, contrast: 1,
  images: new Map(), // id -> { name, preview, source, thumb, aspect }
  decals: [],        // see newDecal()
  selected: null,
  showZones: false,   // print areas are guides only: hidden unless asked for, never a limit
  magnet: true,
  guides: [],
};
let nextId = 1;

// ---------------- utils ----------------
function toast(msg, warn = false, ms = 3600) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (warn ? ' warn' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function setStatus(msg) { $('status').textContent = msg; }
function cm(units) { return (units * (state.garment?.cmPerUnit || 45)).toFixed(1) + ' cm'; }
function loadImage(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }));
  }
  return imgCache.get(url);
}

function resize() {
  const r = $('stage').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  overlay.width = r.width * devicePixelRatio;
  overlay.height = r.height * devicePixelRatio;
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------- fabric materials ----------------
const normalTexCache = new Map();
async function normalTexture(url) {
  if (!normalTexCache.has(url)) {
    normalTexCache.set(url, loadImage(url).then((img) => {
      const t = new THREE.Texture(img);
      // glTF's orientation, so the saved file can carry this exact image (see sourceBytes)
      t.flipY = false;
      t.name = url;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 8;
      t.userData.mimeType = url.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
      t.needsUpdate = true;
      return t;
    }));
  }
  return normalTexCache.get(url);
}
const sourceCache = new Map();
function sourceBytes(url) {
  if (!sourceCache.has(url)) {
    sourceCache.set(url, fetch(url).then(async (r) => ({ bytes: new Uint8Array(await r.arrayBuffer()), mime: url.endsWith('.png') ? 'image/png' : 'image/jpeg' })));
  }
  return sourceCache.get(url);
}

const maskCanvasCache = new Map();
async function maskTexture(url, hex, amount, acid = false) {
  const key = `${url}|${hex}|${amount.toFixed(3)}|${acid}`;
  if (maskCanvasCache.has(key)) return maskCanvasCache.get(key);
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  if (acid) {
    acidPixels(d.data, hex, amount);
  } else {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // mask 0.5 = chosen color; above lightens toward white, below darkens toward black
    for (let i = 0; i < d.data.length; i += 4) {
      const m = (d.data[i] / 255 - 0.5) * 2 * amount;
      for (let k = 0; k < 3; k++) {
        const c0 = rgb[k];
        d.data[i + k] = m >= 0 ? c0 + (255 - c0) * Math.min(m, 1) : c0 * (1 + Math.max(m, -1));
      }
    }
  }
  ctx.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.mimeType = 'image/jpeg';
  if (maskCanvasCache.size > 24) maskCanvasCache.clear();
  maskCanvasCache.set(key, t);
  return t;
}

async function applyFabric(mesh, part) {
  const fab = FABRICS[part.fabric] || FABRICS.plain;
  const sheen = !fab.sheen ? null : part.acid ? ACID_CREW_SHEEN[fab.sheen] : crewSheen(part.color, fab.sheen);
  const mat = sheen
    ? new THREE.MeshPhysicalMaterial({ roughness: sheen.roughness, metalness: 0, side: THREE.DoubleSide, name: mesh.userData.part,
      specularColor: new THREE.Color(sheen.specular, sheen.specular, sheen.specular) })
    : new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0, side: THREE.DoubleSide, name: mesh.userData.part });
  // acid wash is a layer over the fabric: the fabric keeps its normal map, the wash
  // takes the colour (over heather too, whose own mottle it replaces)
  if (part.acid) {
    const t = (await maskTexture(ACID_MASK, part.color, (part.acidAmount ?? ACID_DEFAULT) * state.contrast, true)).clone();
    const r = ACID_REPEAT * state.garment.cmPerUnit / ACID_CM_REF;
    t.repeat.set(r, r);
    t.needsUpdate = true;
    mat.map = t;
    mat.color.set(0xffffff);
  } else if (fab.mask) {
    const t = (await maskTexture(fab.mask, part.color, fab.maskAmount)).clone();
    t.repeat.set(fab.maskRepeat, fab.maskRepeat);
    t.needsUpdate = true;
    mat.map = t;
    mat.color.set(0xffffff);
  } else {
    mat.color.setStyle(part.color, THREE.SRGBColorSpace);
  }
  if (fab.normal && state.strength > 0) {
    const t = (await normalTexture(fab.normal)).clone();
    const r = fab.repeat * state.texScale * (fab.cmRef ? state.garment.cmPerUnit / fab.cmRef : 1);
    t.repeat.set(r, fab.flipV ? -r : r);
    t.needsUpdate = true;
    mat.normalMap = t;
    const s = fab.strength * state.strength;
    // y negated as three's GLTFLoader does for a glTF normal map without tangents,
    // which is how the store will draw it
    mat.normalScale.set(s, -s);
  }
  const old = mesh.material;
  mesh.material = mat;
  if (old && old !== mat) old.dispose();
}

let fabricQueue = Promise.resolve();
function refreshFabrics() {
  fabricQueue = fabricQueue.then(() => Promise.all(state.meshes.map((m) => applyFabric(m, state.parts[m.userData.part]))));
  changed();
  return fabricQueue;
}
// the store preview rebuilds after any edit (or next time it opens)
let preview = null;
function changed() { if (preview) preview.stale(); }

// ---------------- garments ----------------
async function loadGarment(id) {
  const g = state.manifest.garments.find((x) => x.id === id);
  setStatus(`Loading ${g.label}…`);
  const gltf = await gltfLoader.loadAsync(g.file);
  garmentRoot.clear();
  for (const m of state.meshes) m.material.dispose();
  state.meshes = [];
  // three sanitizes node names ("Outer tee" -> "Outer_tee"); the material keeps the part name
  gltf.scene.traverse((o) => { if (o.isMesh) { o.userData.part = o.material.name; state.meshes.push(o); } });
  garmentRoot.add(gltf.scene);
  state.garment = g;
  $('garment').value = id;
  const prevParts = state.parts;
  state.parts = {};
  for (const name of g.parts) {
    state.parts[name] = prevParts[name] && state.keepColors ? prevParts[name]
      : { color: g.defaultColors[name] || '#808080', fabric: (g.defaultFabrics || {})[name] || 'jersey', acid: false, acidAmount: ACID_DEFAULT };
  }
  state.index = new SurfaceIndex(state.meshes);
  await refreshFabrics();
  renderParts();
  renderAddButtons();
  buildZoneOutlines();
  for (const d of state.decals) {
    if (d.mode === 'free') reprojectFree(d);
    rebuildDecal(d);
  }
  frameCamera('front');
  renderDecalList();
  renderInspector();
  setStatus(`${g.label} · ${state.index.triCount.toLocaleString()} triangles`);
}

function frameCamera(view) {
  const b = state.garment.bounds;
  const ctr = new THREE.Vector3((b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2);
  const size = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
  const dist = size / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.25;
  const dirs = { front: [0, 0.08, 1], back: [0, 0.08, -1], left: [1, 0.08, 0], right: [-1, 0.08, 0], top: [0, 1.4, 0.6] };
  const dv = new THREE.Vector3(...dirs[view]).normalize();
  controls.target.copy(ctr);
  camera.position.copy(ctr).addScaledVector(dv, dist);
  camera.near = dist / 100; camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

// ---------------- surface queries ----------------
// Ray against the garment via the triangle grid. Returns nearest hit along dir.
function raycastSurface(origin, dir, maxT = 20) {
  const idx = state.index;
  const tp = idx.tp;
  const b = state.garment.bounds;
  // clip the segment to the garment box (padded) so the grid march stays short
  const box = new THREE.Box3(new THREE.Vector3(...b[0]).subScalar(0.1), new THREE.Vector3(...b[1]).addScalar(0.1));
  const ray = new THREE.Ray(origin, dir);
  const enter = ray.intersectBox(box, new THREE.Vector3());
  if (!enter) return null;
  const t0 = Math.max(0, enter.clone().sub(origin).dot(dir) - 0.01);
  const exitRay = new THREE.Ray(origin.clone().addScaledVector(dir, maxT), dir.clone().negate());
  const exitP = exitRay.intersectBox(box, new THREE.Vector3());
  const t1 = exitP ? exitP.clone().sub(origin).dot(dir) + 0.01 : maxT;
  const c = idx.cell;
  const keys = new Set();
  for (let t = t0; t <= t1; t += c * 0.5) {
    const px = origin.x + dir.x * t, py = origin.y + dir.y * t, pz = origin.z + dir.z * t;
    const cx = Math.floor(px / c), cy = Math.floor(py / c), cz = Math.floor(pz / c);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      keys.add(((cx + i + 512) * 1024 + (cy + j + 512)) * 1024 + (cz + k + 512));
    }
  }
  let best = null, bestT = Infinity;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
  for (const key of keys) {
    const arr = idx.grid.get(key);
    if (!arr) continue;
    for (const tri of arr) {
      const o = tri * 9;
      e1.set(tp[o + 3] - tp[o], tp[o + 4] - tp[o + 1], tp[o + 5] - tp[o + 2]);
      e2.set(tp[o + 6] - tp[o], tp[o + 7] - tp[o + 1], tp[o + 8] - tp[o + 2]);
      pv.crossVectors(dir, e2);
      const det = e1.dot(pv);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      tv.set(origin.x - tp[o], origin.y - tp[o + 1], origin.z - tp[o + 2]);
      const u = tv.dot(pv) * inv;
      if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, e1);
      const v = dir.dot(qv) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = e2.dot(qv) * inv;
      if (t > 1e-5 && t < bestT) { bestT = t; best = tri; }
    }
  }
  if (best === null) return null;
  const fn = new THREE.Vector3(idx.fn[best * 3], idx.fn[best * 3 + 1], idx.fn[best * 3 + 2]);
  if (fn.dot(dir) > 0) fn.negate();
  return { point: origin.clone().addScaledVector(dir, bestT), normal: fn, tri: best, t: bestT };
}

function faceBasis(face) {
  const F = FACES[face];
  return { normal: F.normal, right: F.right, up: UP };
}
function planeCoords(face, p) {
  const B = faceBasis(face);
  return { a: p.dot(B.right), b: p.dot(B.up) };
}
function facePoint(face, a, b) {
  const B = faceBasis(face);
  return new THREE.Vector3().addScaledVector(B.right, a).addScaledVector(B.up, b);
}
// outermost surface point seen from that side at plane coords (a, b)
function surfaceOnFace(face, a, b) {
  const B = faceBasis(face);
  const origin = facePoint(face, a, b).addScaledVector(B.normal, 4);
  return raycastSurface(origin, B.normal.clone().negate(), 8);
}

function surfaceUnderRect(face, a, b, size) {
  const N = FACES[face].normal;
  let best = null;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const h = surfaceOnFace(face, a + (i / 6 - 0.5) * size, b + (j / 6 - 0.5) * size);
    if (h && (!best || h.point.dot(N) > best.point.dot(N))) best = h;
  }
  return best;
}

// ---------------- designs ----------------
async function readDesign(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageEl(url);
    return makeImageRecord(img, file.name.replace(/\.[a-z]+$/i, ''));
  } finally {
    URL.revokeObjectURL(url);
  }
}
function loadImageEl(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read image')); i.src = url; });
}
function drawScaled(img, sx, sy, sw, sh, maxSide) {
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function makeImageRecord(img, name) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  // trim transparent padding so snapping aligns to the visible art
  const probe = drawScaled(img, 0, 0, iw, ih, 512);
  const pd = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height).data;
  let x0 = probe.width, y0 = probe.height, x1 = -1, y1 = -1;
  for (let y = 0; y < probe.height; y++) for (let x = 0; x < probe.width; x++) {
    if (pd[(y * probe.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error(`${name}: image is fully transparent`);
  const kx = iw / probe.width, ky = ih / probe.height;
  const sx = Math.max(0, Math.floor((x0 - 1) * kx)), sy = Math.max(0, Math.floor((y0 - 1) * ky));
  const sw = Math.min(iw - sx, Math.ceil((x1 - x0 + 3) * kx)), sh = Math.min(ih - sy, Math.ceil((y1 - y0 + 3) * ky));
  const source = drawScaled(img, sx, sy, sw, sh, SOURCE_MAX);
  const preview = drawScaled(source, 0, 0, source.width, source.height, PREVIEW_MAX);
  const thumb = drawScaled(source, 0, 0, source.width, source.height, 96).toDataURL();
  const id = `img${nextId++}`;
  const rec = { id, name, source, preview, thumb, aspect: source.width / source.height };
  state.images.set(id, rec);
  return rec;
}

function zonesFor(face) { return (state.garment.zones || []).filter((z) => z.face === face); }
function zoneById(id) { return (state.garment.zones || []).find((z) => z.id === id); }

function newDecal(img, opts) {
  const d = {
    id: nextId++, img: img.id, name: img.name,
    mode: opts.mode, zone: opts.zone || null,
    a: opts.a ?? 0, b: opts.b ?? 0,
    point: opts.point ? opts.point.clone() : null,
    normal: opts.normal ? opts.normal.clone() : null,
    upHint: opts.upHint ? opts.upHint.clone() : UP.clone(),
    width: opts.width, rotation: 0, wrap: 1,
    mesh: null, frame: null,
  };
  const mat = new THREE.MeshStandardMaterial({
    map: designTexture(img), transparent: true, depthWrite: false, roughness: 0.8, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  d.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  d.mesh.userData.decalId = d.id;
  decalRoot.add(d.mesh);
  state.decals.push(d);
  rebuildDecal(d);
  return d;
}
function designTexture(img) {
  const t = new THREE.CanvasTexture(img.preview);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

function decalFrame(d) {
  const img = state.images.get(d.img);
  const w = d.width, h = d.width / img.aspect;
  let origin, N, U;
  if (d.mode === 'free') {
    if (!d.point) return null;
    origin = d.point.clone();
    N = state.index.smoothNormal(origin, d.normal, THREE.MathUtils.clamp(Math.min(w, h) * 0.3, 0.02, 0.12));
    U = d.upHint.clone().addScaledVector(N, -d.upHint.dot(N));
    if (U.lengthSq() < 0.04) U = new THREE.Vector3(0, 0, -1).addScaledVector(N, N.z);
    U.normalize();
  } else {
    // A print may hang off the garment; it is simply cut where the fabric ends. Its
    // depth comes from the fabric under its centre or, when the centre is past the
    // edge, from the outermost fabric anywhere under the print.
    const hit = surfaceOnFace(d.mode, d.a, d.b) || surfaceUnderRect(d.mode, d.a, d.b, Math.max(w, h));
    if (!hit) return null;
    N = FACES[d.mode].normal.clone();
    origin = facePoint(d.mode, d.a, d.b).addScaledVector(N, hit.point.dot(N));
    U = UP.clone();
  }
  let R = new THREE.Vector3().crossVectors(U, N).normalize();
  U = new THREE.Vector3().crossVectors(N, R).normalize();
  if (d.rotation) {
    const r = THREE.MathUtils.degToRad(d.rotation);
    const R2 = R.clone().multiplyScalar(Math.cos(r)).addScaledVector(U, Math.sin(r));
    const U2 = U.clone().multiplyScalar(Math.cos(r)).addScaledVector(R, -Math.sin(r));
    R = R2; U = U2;
  }
  return { origin, right: R, up: U, normal: N, w, h, depth: Math.max(0.05, 0.5 * Math.max(w, h) * d.wrap) };
}

function rebuildDecal(d) {
  const f = decalFrame(d);
  d.frame = f;
  const old = d.mesh.geometry;
  d.mesh.geometry = f ? buildDecalGeometry(state.index, f, f.w, f.h, f.depth) : new THREE.BufferGeometry();
  old.dispose();
  d.mesh.visible = !!f && d.mesh.geometry.attributes.position?.count > 0;
  d.mesh.renderOrder = 10 + state.decals.indexOf(d);
}

function reprojectFree(d) {
  if (!d.point) return;
  const hit = raycastSurface(d.point.clone().addScaledVector(d.normal, 1.5), d.normal.clone().negate(), 4);
  if (hit) { d.point = hit.point; d.normal = hit.normal; }
}

// convert a decal between placement modes without moving it on screen
function setMode(d, mode) {
  if (d.mode === mode) return;
  const f = d.frame;
  if (mode === 'free') {
    if (f) { d.point = f.origin.clone(); d.normal = f.normal.clone(); }
    else { const h = surfaceOnFace('front', 0, 0); d.point = h?.point; d.normal = h?.normal; }
    d.zone = null;
  } else {
    const p = f ? f.origin : new THREE.Vector3();
    const pc = planeCoords(mode, p);
    d.a = pc.a; d.b = pc.b;
    const zs = zonesFor(mode);
    d.zone = zs.length ? nearestZone(zs, pc).id : null;
    if (!surfaceOnFace(mode, d.a, d.b) && d.zone) { const z = zoneById(d.zone); d.a = z.cx; d.b = z.cy; }
  }
  d.mode = mode;
  rebuildDecal(d);
}
function nearestZone(zs, pc) {
  return zs.reduce((best, z) => (Math.hypot(z.cx - pc.a, z.cy - pc.b) < Math.hypot(best.cx - pc.a, best.cy - pc.b) ? z : best));
}

function placeInZone(img, zone) {
  const fitW = Math.min(zone.w * 0.9, zone.h * 0.9 * img.aspect);
  return newDecal(img, { mode: zone.face, zone: zone.id, a: zone.cx, b: zone.cy, width: fitW });
}

async function addFiles(files, target) {
  const recs = [];
  for (const f of files) {
    try { recs.push(await readDesign(f)); } catch (e) { toast(e.message, true); }
  }
  let last = null;
  for (const img of recs) {
    if (target?.zone) last = placeInZone(img, target.zone);
    else if (target?.hit) last = placeAtHit(img, target.hit);
    else {
      const z = zonesFor('front')[0];
      last = z ? placeInZone(img, z) : newDecal(img, { mode: 'front', a: 0, b: 0, width: 0.5 });
    }
  }
  if (last) { select(last); pushHistory(); }
  renderDecalList();
}

// The Artwork tab's current design, effects and all, rasterised from its SVG.
async function artworkImage() {
  const App = HOST && HOST.App;
  const L = App && App.selected && App.selected();
  if (!L) return null;
  const svg = App.svgText(false);
  const vb = /viewBox="([-\d.e]+)[ ,]+([-\d.e]+)[ ,]+([\d.e]+)[ ,]+([\d.e]+)"/.exec(svg);
  const vw = vb ? parseFloat(vb[3]) : 1024, vh = vb ? parseFloat(vb[4]) : 1024;
  const k = SOURCE_MAX / Math.max(vw, vh);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await loadImageEl(url);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vw * k)); c.height = Math.max(1, Math.round(vh * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return makeImageRecord(c, (L.name || 'artwork').replace(/\.[a-z]+$/i, ''));
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function addArtwork() {
  let img = null;
  try { img = await artworkImage(); } catch (e) { toast(`Could not use the artwork: ${e.message}`, true); return; }
  if (!img) { toast('Nothing is open in the Artwork tab yet. Open a design there first.'); return; }
  const z = zonesFor('front')[0];
  const d = z ? placeInZone(img, z) : newDecal(img, { mode: 'front', a: 0, b: 0, width: 0.5 });
  select(d); pushHistory(); renderDecalList();
}

function placeAtHit(img, hit) {
  const n = hit.normal;
  let face = null, best = 0.75;
  for (const [k, F] of Object.entries(FACES)) { const s = n.dot(F.normal); if (s > best) { best = s; face = k; } }
  const width = 0.3;
  if (face) {
    const pc = planeCoords(face, hit.point);
    const zs = zonesFor(face);
    return newDecal(img, { mode: face, a: pc.a, b: pc.b, width, zone: zs.length ? nearestZone(zs, pc).id : null });
  }
  return newDecal(img, { mode: 'free', point: hit.point, normal: n, width, upHint: upHintForNormal(n, hit.point) });
}
function upHintForNormal(n, point) {
  if (Math.abs(n.y) < 0.8) return UP.clone();
  // near-horizontal surfaces (brim, shoulders, hood top): the print's top points at
  // the garment's vertical axis, so brim text runs along the brim and reads from the front
  const b = state.garment.bounds;
  if (point) {
    const toAxis = new THREE.Vector3((b[0][0] + b[1][0]) / 2 - point.x, 0, (b[0][2] + b[1][2]) / 2 - point.z);
    if (toAxis.lengthSq() > 1e-4) return toAxis.addScaledVector(n, -toAxis.dot(n)).normalize();
  }
  return new THREE.Vector3(0, 0, -1);
}

function deleteDecal(d) {
  decalRoot.remove(d.mesh);
  d.mesh.geometry.dispose();
  d.mesh.material.map.dispose();
  d.mesh.material.dispose();
  state.decals = state.decals.filter((x) => x !== d);
  if (state.selected === d) state.selected = null;
  state.decals.forEach((x) => { x.mesh.renderOrder = 10 + state.decals.indexOf(x); });
  pushHistory();
  renderDecalList(); renderInspector();
}
function duplicateDecal(d) {
  const img = state.images.get(d.img);
  const c = newDecal(img, { mode: d.mode, zone: d.zone, a: d.a + 0.05, b: d.b - 0.05, point: d.point, normal: d.normal, upHint: d.upHint, width: d.width });
  c.rotation = d.rotation; c.wrap = d.wrap;
  rebuildDecal(c);
  select(c); pushHistory(); renderDecalList();
}

// ---------------- snapping ----------------
function worldPerPixel(p) {
  const dist = camera.position.distanceTo(p);
  return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / ($('stage').clientHeight || 1);
}
function snapTargets(d) {
  const img = state.images.get(d.img);
  const w = d.width, h = d.width / img.aspect;
  const ta = [{ v: 0, label: 'center line' }], tb = [];
  const z = d.zone ? zoneById(d.zone) : null;
  if (z) {
    ta.push({ v: z.cx, label: 'area center' }, { v: z.cx - z.w / 2 + w / 2, label: 'area left' }, { v: z.cx + z.w / 2 - w / 2, label: 'area right' });
    tb.push({ v: z.cy, label: 'area middle' }, { v: z.cy + z.h / 2 - h / 2, label: 'area top' }, { v: z.cy - z.h / 2 + h / 2, label: 'area bottom' });
  }
  for (const o of state.decals) {
    if (o === d || o.mode !== d.mode) continue;
    ta.push({ v: o.a, label: o.name }); tb.push({ v: o.b, label: o.name });
  }
  return { ta, tb };
}
function applyMagnet(d) {
  state.guides = [];
  if (!state.magnet || d.mode === 'free') return;
  const thr = SNAP_PX * worldPerPixel(d.frame?.origin || new THREE.Vector3());
  const { ta, tb } = snapTargets(d);
  const pick = (val, list) => list.reduce((best, t) => (Math.abs(t.v - val) < thr && (!best || Math.abs(t.v - val) < Math.abs(best.v - val)) ? t : best), null);
  const sa = pick(d.a, ta), sb = pick(d.b, tb);
  if (sa) { d.a = sa.v; state.guides.push({ axis: 'a', v: sa.v }); }
  if (sb) { d.b = sb.v; state.guides.push({ axis: 'b', v: sb.v }); }
}
function snap(d, kind) {
  if (d.mode === 'free') { toast('Snapping works in Front, Back and side placement. Switch "Placement" to use it.'); return; }
  const img = state.images.get(d.img);
  const h = d.width / img.aspect;
  const z = d.zone ? zoneById(d.zone) : null;
  if (kind === 'garment') { d.a = 0; }
  else if (!z) { toast('This side has no print area for this model.'); return; }
  else if (kind === 'hcenter') d.a = z.cx;
  else if (kind === 'left') d.a = z.cx - z.w / 2 + d.width / 2;
  else if (kind === 'right') d.a = z.cx + z.w / 2 - d.width / 2;
  else if (kind === 'vcenter') d.b = z.cy;
  else if (kind === 'top') d.b = z.cy + z.h / 2 - h / 2;
  else if (kind === 'bottom') d.b = z.cy - z.h / 2 + h / 2;
  else if (kind === 'fit') { d.width = Math.min(z.w, z.h * img.aspect); d.a = z.cx; d.b = z.cy; }
  rebuildDecal(d); pushHistory(); renderInspector();
}

// ---------------- print areas ----------------
// Canvas drawing takes colours from the same tokens as the CSS: the selection
// box in the accent, snap guides in the snap pink, exactly as on the Artwork tab.
function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function outlineTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.globalAlpha = 0.04;
  g.fillStyle = token('--accent');
  g.fillRect(0, 0, 512, 512);
  g.globalAlpha = 0.9;
  g.strokeStyle = token('--accent');
  g.lineWidth = 6;
  g.setLineDash([22, 14]);
  g.strokeRect(5, 5, 502, 502);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function buildZoneOutlines() {
  zoneRoot.children.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
  zoneRoot.clear();
  for (const z of state.garment.zones || []) {
    const hit = surfaceOnFace(z.face, z.cx, z.cy);
    if (!hit) continue;
    const N = FACES[z.face].normal.clone();
    const R = new THREE.Vector3().crossVectors(UP, N).normalize();
    const frame = { origin: hit.point, right: R, up: UP.clone(), normal: N };
    const geo = buildDecalGeometry(state.index, frame, z.w, z.h, Math.max(0.08, 0.5 * Math.max(z.w, z.h)), 0.002);
    const mat = new THREE.MeshBasicMaterial({ map: outlineTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const m = new THREE.Mesh(geo, mat);
    m.userData.zone = z;
    m.renderOrder = 5;
    zoneRoot.add(m);
  }
  updateZoneVisibility();
}
function updateZoneVisibility() {
  const d = state.selected;
  for (const m of zoneRoot.children) {
    const z = m.userData.zone;
    m.visible = state.showZones && (!d || d.mode === 'free' || z.face === d.mode);
    m.material.opacity = d && d.zone === z.id ? 1 : 0.55;
  }
}

// ---------------- pointer interaction ----------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;
function pointerRay(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function hitDecal(ev) {
  pointerRay(ev);
  const hits = raycaster.intersectObjects(state.decals.filter((d) => d.mesh.visible).map((d) => d.mesh), false);
  if (!hits.length) return null;
  // topmost print wins when several overlap
  hits.sort((x, y) => (Math.abs(x.distance - y.distance) < 0.004 ? y.object.renderOrder - x.object.renderOrder : x.distance - y.distance));
  const d = state.decals.find((x) => x.mesh === hits[0].object);
  return d ? { decal: d, point: hits[0].point } : null;
}
// where the pointer is on a face print's own plane (used past the garment's edge)
function onFacePlane(ray, face, depth) {
  const N = FACES[face].normal;
  const den = ray.direction.dot(N);
  if (Math.abs(den) < 1e-6) return null;
  const t = (depth - ray.origin.dot(N)) / den;
  return t > 0 ? ray.origin.clone().addScaledVector(ray.direction, t) : null;
}
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const grabbed = hitDecal(ev);
  drag = { x: ev.clientX, y: ev.clientY, moved: false, decal: null };
  if (!grabbed) return;
  const d = grabbed.decal;
  select(d);
  drag.decal = d;
  if (d.mode !== 'free') {
    const pc = planeCoords(d.mode, grabbed.point);
    drag.offA = d.a - pc.a; drag.offB = d.b - pc.b;
    drag.depth = (d.frame ? d.frame.origin : grabbed.point).dot(FACES[d.mode].normal);
  }
  controls.enabled = false;
  canvas.setPointerCapture(ev.pointerId);
});
let pendingMove = null;
canvas.addEventListener('pointermove', (ev) => {
  if (!drag?.decal) return;
  if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 2) drag.moved = true;
  pendingMove = { clientX: ev.clientX, clientY: ev.clientY };
});
function processMove() {
  if (!pendingMove || !drag?.decal) return;
  const ev = pendingMove; pendingMove = null;
  const d = drag.decal;
  const ray = pointerRay(ev);
  const hit = raycastSurface(ray.origin.clone(), ray.direction.clone());
  if (d.mode === 'free') {
    if (!hit) return;   // a free print follows the surface, so it stops at the edge
    d.point = hit.point; d.normal = hit.normal;
    d.upHint = upHintForNormal(hit.normal, hit.point);
  } else {
    const p = hit ? hit.point : onFacePlane(ray, d.mode, drag.depth);
    if (!p) return;
    const pc = planeCoords(d.mode, p);
    d.a = pc.a + drag.offA; d.b = pc.b + drag.offB;
    applyMagnet(d);
  }
  rebuildDecal(d);
  renderInspectorPos();
}
canvas.addEventListener('pointerup', (ev) => {
  if (drag?.decal && drag.moved) pushHistory();
  if (drag && !drag.decal && !drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 3) select(null);
  drag = null;
  state.guides = [];
  controls.enabled = true;
});

// drag & drop files onto the model
const stage = $('stage');
stage.addEventListener('dragover', (ev) => { ev.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (ev) => {
  ev.preventDefault();
  stage.classList.remove('dragover');
  const files = [...ev.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const ray = pointerRay(ev);
  const hit = raycastSurface(ray.origin.clone(), ray.direction.clone());
  addFiles(files, hit ? { hit } : null);
});

// ---------------- keyboard ----------------
window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input[type=text], input[type=number], select, textarea')) return;
  const mod = ev.metaKey || ev.ctrlKey;
  const k = ev.key.toLowerCase();
  // In the desktop app these come through the menu bar (the page around this one
  // routes them here), so handling them again would undo twice.
  if (mod && !DESKTOP) {
    if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if (k === 's') { ev.preventDefault(); exportGLB(); return; }
    if (k === 'o') { ev.preventDefault(); pickFiles(null); return; }
    if (k === '0') { ev.preventDefault(); frameCamera('front'); return; }
  }
  if (!mod && k === 'p') { preview.setMode(preview.visible ? 'edit' : (preview.lastStage || 'page')); return; }
  const d = state.selected;
  if (!d) return;
  if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateDecal(d); return; }
  if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); deleteDecal(d); return; }
  if (ev.key === 'Escape') { select(null); return; }
  if (ev.key === '[' || ev.key === ']') {
    d.width = Math.max(0.02, d.width * (ev.key === ']' ? 1.02 : 1 / 1.02));
    rebuildDecal(d); renderInspector(); historyDebounced(); return;
  }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (!dirs[ev.key]) return;
  ev.preventDefault();
  const px = (ev.shiftKey ? 10 : 1) * worldPerPixel(d.frame?.origin || controls.target);
  const [dx, dy] = dirs[ev.key];
  nudge(d, dx * px, dy * px);
  historyDebounced();
});
function nudge(d, dx, dy) {
  if (d.mode === 'free') {
    const f = d.frame;
    if (!f) return;
    const p = f.origin.clone().addScaledVector(f.right, dx).addScaledVector(f.up, dy);
    const hit = raycastSurface(p.clone().addScaledVector(f.normal, 0.5), f.normal.clone().negate(), 1.5);
    if (hit) { d.point = hit.point; d.normal = hit.normal; }
  } else {
    d.a += dx; d.b += dy;
  }
  rebuildDecal(d);
  renderInspectorPos();
}

// ---------------- undo ----------------
const history = { stack: [], pos: -1 };
function snapshot() {
  return JSON.stringify({
    decals: state.decals.map((d) => ({
      id: d.id, img: d.img, name: d.name, mode: d.mode, zone: d.zone, a: d.a, b: d.b,
      point: d.point?.toArray(), normal: d.normal?.toArray(), upHint: d.upHint.toArray(),
      width: d.width, rotation: d.rotation, wrap: d.wrap,
    })),
    selected: state.selected?.id ?? null,
  });
}
function pushHistory() {
  const s = snapshot();
  if (history.stack[history.pos] === s) return;
  history.stack = history.stack.slice(0, history.pos + 1);
  history.stack.push(s);
  if (history.stack.length > 120) history.stack.shift();
  history.pos = history.stack.length - 1;
  changed();
}
let histTimer = null;
function historyDebounced() { clearTimeout(histTimer); histTimer = setTimeout(pushHistory, 350); }
function restore(s) {
  const data = JSON.parse(s);
  const keep = new Map(state.decals.map((d) => [d.id, d]));
  const next = [];
  for (const sd of data.decals) {
    let d = keep.get(sd.id);
    if (!d) {
      const img = state.images.get(sd.img);
      d = newDecal(img, { mode: sd.mode, width: sd.width });
      state.decals.pop();
      d.id = sd.id; d.mesh.userData.decalId = sd.id;
    }
    keep.delete(sd.id);
    Object.assign(d, {
      mode: sd.mode, zone: sd.zone, a: sd.a, b: sd.b, width: sd.width, rotation: sd.rotation, wrap: sd.wrap,
      point: sd.point ? new THREE.Vector3(...sd.point) : null, normal: sd.normal ? new THREE.Vector3(...sd.normal) : null,
      upHint: new THREE.Vector3(...sd.upHint),
    });
    next.push(d);
  }
  for (const d of keep.values()) { decalRoot.remove(d.mesh); d.mesh.geometry.dispose(); }
  state.decals = next;
  next.forEach(rebuildDecal);
  state.selected = next.find((d) => d.id === data.selected) || null;
  renderDecalList(); renderInspector(); updateZoneVisibility();
  changed();
}
function undo() { if (history.pos > 0) { history.pos--; restore(history.stack[history.pos]); } }
function redo() { if (history.pos < history.stack.length - 1) { history.pos++; restore(history.stack[history.pos]); } }

// ---------------- UI rendering ----------------
function select(d) {
  state.selected = d;
  renderDecalList(); renderInspector(); updateZoneVisibility();
}

function renderParts() {
  const host = $('parts');
  host.innerHTML = '';
  for (const [name, p] of Object.entries(state.parts)) {
    const row = document.createElement('div');
    row.className = 'part';
    row.innerHTML = `<div class="part-name">${name}</div>
      <div class="color-cell"><input type="color" value="${p.color}" aria-label="${name} color"><input class="hex" value="${p.color}" aria-label="${name} hex" spellcheck="false">
      <select aria-label="${name} fabric">${Object.entries(FABRICS).map(([k, f]) => `<option value="${k}" ${k === p.fabric ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
      <div class="swatches solid">${SWATCHES.map((c) => `<button style="background:${c}" data-c="${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div>
      <div class="acid-row">
        <label class="toggle" title="Acid wash over the fabric, in this colour"><input type="checkbox" class="acid-on" ${p.acid ? 'checked' : ''}> Acid wash</label>
        <div class="swatches acid">${ACID_PRESETS.map((a, i) => `<button data-acid="${i}" title="${a.name} (${a.from})" aria-label="${a.name}"></button>`).join('')}</div>
      </div>`;
    const [colorIn, hexIn] = row.querySelectorAll('.color-cell input');
    const fabSel = row.querySelector('select');
    const acidOn = row.querySelector('.acid-on');
    const acidBtns = [...row.querySelectorAll('[data-acid]')];
    const markAcid = () => acidBtns.forEach((b) => {
      const a = ACID_PRESETS[b.dataset.acid];
      b.classList.toggle('on', p.acid && p.color === a.hex && p.acidAmount === a.amount);
    });
    const setColor = (c) => { p.color = c; colorIn.value = c; hexIn.value = c; markAcid(); refreshFabrics(); };
    colorIn.addEventListener('input', () => setColor(colorIn.value));
    hexIn.addEventListener('change', () => { const v = hexIn.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) setColor(v.startsWith('#') ? v : '#' + v); else hexIn.value = p.color; });
    fabSel.addEventListener('change', () => { p.fabric = fabSel.value; refreshFabrics(); });
    row.querySelectorAll('.swatches.solid button').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.c)));
    acidOn.addEventListener('change', () => { p.acid = acidOn.checked; markAcid(); refreshFabrics(); updateContrastRow(); });
    // an acid colour is the colour and the wash together
    acidBtns.forEach((b) => b.addEventListener('click', () => {
      const a = ACID_PRESETS[b.dataset.acid];
      p.acid = true; p.acidAmount = a.amount; acidOn.checked = true;
      setColor(a.hex);
      updateContrastRow();
    }));
    acidSwatchImages().then((urls) => acidBtns.forEach((b) => { b.style.backgroundImage = `url(${urls[b.dataset.acid]})`; }));
    markAcid();
    host.appendChild(row);
  }
  updateContrastRow();
}
let acidSwatchCache = null;
function acidSwatchImages() {
  if (!acidSwatchCache) acidSwatchCache = loadImage(ACID_MASK).then((img) => ACID_PRESETS.map((a) => acidSwatch(img, a)));
  return acidSwatchCache;
}
function updateContrastRow() {
  $('contrastRow').hidden = !Object.values(state.parts).some((p) => p.acid);
}

function renderAddButtons() {
  const host = $('addGrid');
  host.innerHTML = '';
  if (HOST) {
    const art = document.createElement('button');
    art.className = 'wide art';
    art.textContent = '+ Current artwork (from the Artwork tab)';
    art.addEventListener('click', addArtwork);
    host.appendChild(art);
  }
  const zones = state.garment.zones || [];
  for (const z of zones) {
    const b = document.createElement('button');
    b.textContent = `+ ${z.label}`;
    b.addEventListener('click', () => pickFiles({ zone: z }));
    host.appendChild(b);
  }
  const any = document.createElement('button');
  any.className = 'wide';
  any.textContent = '+ Anywhere (drag it after)';
  any.addEventListener('click', () => pickFiles(null));
  host.appendChild(any);
}
let pickTarget = null;
function pickFiles(target) { pickTarget = target; $('fileInput').value = ''; $('fileInput').click(); }
$('fileInput').addEventListener('change', () => { addFiles([...$('fileInput').files], pickTarget); });

const MODE_LABEL = { front: 'Front', back: 'Back', left: 'Left side', right: 'Right side', free: 'Anywhere' };
function renderDecalList() {
  const host = $('decalList');
  host.innerHTML = '';
  $('decalEmpty').hidden = state.decals.length > 0;
  for (const d of [...state.decals].reverse()) {
    const img = state.images.get(d.img);
    const li = document.createElement('li');
    if (d === state.selected) li.className = 'sel';
    const z = d.zone ? zoneById(d.zone) : null;
    li.innerHTML = `<img src="${img.thumb}" alt=""><div class="meta"><div class="name">${d.name}</div><div class="sub">${MODE_LABEL[d.mode]}${z ? ' · ' + z.label : ''}${d.mesh.visible ? '' : ' · not on model'}</div></div>`;
    li.addEventListener('click', () => select(d));
    host.appendChild(li);
  }
}

function renderInspector() {
  const d = state.selected;
  $('noSel').hidden = !!d;
  $('selControls').hidden = !d;
  if (!d) return;
  $('mode').value = d.mode;
  const zs = d.mode === 'free' ? [] : zonesFor(d.mode);
  $('zoneRow').hidden = !zs.length;
  $('zone').innerHTML = zs.map((z) => `<option value="${z.id}" ${z.id === d.zone ? 'selected' : ''}>${z.label}</option>`).join('');
  $('snapBox').style.opacity = d.mode === 'free' ? 0.45 : 1;
  ['width', 'rotation', 'wrap'].forEach(id => numericControls[id].show());
  renderInspectorPos();
}
function renderInspectorPos() {
  const d = state.selected;
  if (!d) return;
  if (d.mode === 'free') $('posOut').textContent = d.mesh.visible ? 'Following the surface' : 'Not on the model, drag it back on';
  else $('posOut').textContent = `x ${cm(d.a)} · y ${cm(d.b)}${d.mesh.visible ? '' : ' · off the model'}`;
  numericControls.width.show();
}

// inspector controls
$('mode').addEventListener('change', () => { const d = state.selected; setMode(d, $('mode').value); pushHistory(); renderInspector(); renderDecalList(); updateZoneVisibility(); });
$('zone').addEventListener('change', () => { const d = state.selected; d.zone = $('zone').value; const z = zoneById(d.zone); d.a = z.cx; d.b = z.cy; rebuildDecal(d); pushHistory(); renderInspector(); renderDecalList(); updateZoneVisibility(); });
$('snapBox').addEventListener('click', (ev) => { const k = ev.target.dataset?.snap; if (k && state.selected) snap(state.selected, k); });
$('magnet').addEventListener('change', () => { state.magnet = $('magnet').checked; });
const numericControls = {};
function numberControl(id, outId, options) {
  numericControls[id] = window.NumericControl.bind($(id), $(outId), options);
}
for (const def of [
  { id: 'width', out: 'widthOut', label: 'Width', min: 0.02, rangeMax: 1.6, step: 0.001,
    format: v => window.NumericControl.format(v * (state.garment?.cmPerUnit || 45)) + ' cm',
    parse: text => window.NumericControl.read(text, state.garment?.cmPerUnit || 45, 'cm') },
  { id: 'rotation', out: 'rotOut', label: 'Rotation', min: -180, max: 180, step: 1, unit: '°',
    format: v => window.NumericControl.format(v) + '°' },
  { id: 'wrap', out: 'wrapOut', label: 'Wrap around curves', min: 20, max: 250, step: 5, unit: '%',
    format: v => window.NumericControl.format(v) + '%' }
]) {
  numberControl(def.id, def.out, { ...def,
    get: () => state.selected ? state.selected[def.id] * (def.id === 'wrap' ? 100 : 1) : undefined,
    set: v => { const d = state.selected; if (!d) return; d[def.id] = v / (def.id === 'wrap' ? 100 : 1); rebuildDecal(d); renderInspector(); },
    commit: pushHistory,
  });
}
$('dupBtn').addEventListener('click', () => state.selected && duplicateDecal(state.selected));
$('delBtn').addEventListener('click', () => state.selected && deleteDecal(state.selected));
function reorder(delta) {
  const d = state.selected; if (!d) return;
  const i = state.decals.indexOf(d), j = THREE.MathUtils.clamp(i + delta, 0, state.decals.length - 1);
  state.decals.splice(i, 1); state.decals.splice(j, 0, d);
  state.decals.forEach((x, k) => { x.mesh.renderOrder = 10 + k; });
  pushHistory(); renderDecalList();
}
$('upBtn').addEventListener('click', () => reorder(1));
$('downBtn').addEventListener('click', () => reorder(-1));

// Fabric values are editable in the same units shown beside each slider.
for (const def of [
  { id: 'strength', out: 'strengthOut', label: 'Texture strength', max: 200, unit: '%' },
  { id: 'texScale', out: 'scaleOut', label: 'Texture scale', min: 25, max: 300, step: 25, unit: 'x',
    format: v => window.NumericControl.format(v / 100) + 'x', parse: text => window.NumericControl.read(text, 0.01, 'x') },
  { id: 'contrast', out: 'contrastOut', label: 'Wash contrast', max: 250, unit: '%' }
]) {
  numberControl(def.id, def.out, { min: 0, step: 1, format: v => window.NumericControl.format(v) + '%', ...def,
    get: () => state[def.id] * 100, set: v => { state[def.id] = v / 100; }, commit: refreshFabrics,
  });
}
$('showZones').addEventListener('change', () => { state.showZones = $('showZones').checked; updateZoneVisibility(); });
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => (preview.visible ? preview.orbit(b.dataset.view) : frameCamera(b.dataset.view))));
$('exportRes').addEventListener('change', changed);
$('garment').addEventListener('change', () => { state.keepColors = false; loadGarment($('garment').value); });

// ---------------- overlay (selection box + snap guides) ----------------
function project(p) {
  const v = p.clone().project(camera);
  return [(v.x + 1) / 2 * overlay.width, (1 - v.y) / 2 * overlay.height];
}
function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const d = state.selected;
  if (!d?.frame) return;
  const f = d.frame;
  // skip when the print faces away from the camera (box would draw through the garment)
  if (f.normal.dot(camera.position.clone().sub(f.origin)) <= 0) return;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
    project(f.origin.clone().addScaledVector(f.right, sx * f.w / 2).addScaledVector(f.up, sy * f.h / 2).addScaledVector(f.normal, 0.01)));
  const accent = token('--accent');
  octx.strokeStyle = accent;
  octx.lineWidth = 1.5 * devicePixelRatio;
  octx.setLineDash([]);
  octx.beginPath();
  corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
  octx.closePath();
  octx.stroke();
  octx.fillStyle = accent;
  for (const [x, y] of corners) octx.fillRect(x - 3 * devicePixelRatio, y - 3 * devicePixelRatio, 6 * devicePixelRatio, 6 * devicePixelRatio);
  if (d.mode === 'free') return;
  const B = faceBasis(d.mode);
  const depth = f.origin.dot(B.normal) + 0.02;
  octx.strokeStyle = token('--snap');
  octx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  const bb = state.garment.bounds;
  const span = Math.max(bb[1][1] - bb[0][1], bb[1][0] - bb[0][0]);
  for (const g of state.guides) {
    const p0 = g.axis === 'a' ? facePoint(d.mode, g.v, d.b - span) : facePoint(d.mode, d.a - span, g.v);
    const p1 = g.axis === 'a' ? facePoint(d.mode, g.v, d.b + span) : facePoint(d.mode, d.a + span, g.v);
    p0.addScaledVector(B.normal, depth); p1.addScaledVector(B.normal, depth);
    const [x0, y0] = project(p0), [x1, y1] = project(p1);
    octx.beginPath(); octx.moveTo(x0, y0); octx.lineTo(x1, y1); octx.stroke();
  }
}

// ---------------- export ----------------
function scaledTexture(img, maxSide) {
  const c = drawScaled(img.source, 0, 0, img.source.width, img.source.height, maxSide);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.userData.mimeType = 'image/png';
  return t;
}
/* The Shopify file, the same for Download and the Store preview: garment and
 * prints in metres (so AR shows the real size), prints as WebP, Draco geometry,
 * and the print size stepped down until the file is under 15 MB. Builds run one
 * at a time. */
let buildQueue = Promise.resolve();
function buildShopifyFile(onStep) {
  const job = buildQueue.then(async () => {
    await fabricQueue;
    const choice = $('exportRes').value;
    const ladder = choice === 'auto' ? [4096, 3072, 2560, 2048, 1536, 1024] : [parseInt(choice, 10)];
    let out = null, res = 0;
    for (res of ladder) {
      if (onStep) onStep(res);
      out = await buildGLB(res);
      if (out.glb.byteLength <= SHOPIFY_LIMIT * 0.97) break;
    }
    const b = state.garment.bounds;
    return { ...out, res, garment: state.garment.id, heightCm: (b[1][1] - b[0][1]) * state.garment.cmPerUnit };
  });
  buildQueue = job.catch(() => {});
  return job;
}

function reportToast(verb, built) {
  const d = describe(built.report, built);
  if (built.report.bytes > SHOPIFY_LIMIT) toast(`${verb}, ${d.size}. Over Shopify's 15 MB limit even with prints at ${built.res} px: use fewer or smaller designs.`, true, 9000);
  else toast(`${verb}, ${d.size}: Draco compressed (${d.was} before), under 15 MB. ${d.line}.`, false, 6000);
}

async function saveShopifyFile(built) {
  const out = built.glb;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `${built.garment}-${stamp}.glb`;
  let verb;
  if (DESKTOP && HOST.Mockup && HOST.Mockup.saveBinary) {
    const saved = await HOST.Mockup.saveBinary(name, out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    if (!saved) return false;   // the save dialog was cancelled
    verb = 'Saved';
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'model/gltf-binary' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    verb = 'Downloaded';
  }
  reportToast(verb, built);
  return true;
}

async function exportGLB({ download = true } = {}) {
  const btn = $('exportBtn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Building…';
  try {
    // what the Store preview is showing, when nothing changed since, is the file
    const built = (preview && preview.fresh()) || await buildShopifyFile((res) => { btn.textContent = `Building ${res}px…`; });
    if (download) await saveShopifyFile(built);
    else reportToast('Built', built);
    return built.glb;
  } catch (e) {
    console.error(e);
    toast(`Export failed: ${e.message}`, true, 9000);
    throw e;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function buildGLB(res) {
  const group = new THREE.Group();
  group.name = `tenzen-${state.garment.id}`;
  group.scale.setScalar(state.garment.cmPerUnit / 100);
  for (const m of state.meshes) {
    const c = new THREE.Mesh(m.geometry, m.material);
    c.name = m.userData.part;
    m.updateWorldMatrix(true, false);
    c.applyMatrix4(m.matrixWorld);
    group.add(c);
  }
  const temp = [];
  state.decals.forEach((d, i) => {
    if (!d.mesh.visible) return;
    const img = state.images.get(d.img);
    const tex = scaledTexture(img, res);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, metalness: 0, name: `Print ${i + 1}` });
    temp.push(tex, mat);
    const m = new THREE.Mesh(d.mesh.geometry, mat);
    m.name = `Print ${i + 1} - ${d.name}`;
    group.add(m);
  });
  try {
    const raw = await new GLTFExporter().parseAsync(group, { binary: true, maxTextureSize: 4096 });
    const normalSources = {};
    for (const m of state.meshes) {
      const url = m.material.normalMap?.name;
      if (url) normalSources[m.material.name] = await sourceBytes(url);
    }
    return await optimizeGLB(raw, { wasmUrl: './vendor/draco_encoder.wasm', normalSources });
  } finally {
    temp.forEach((x) => x.dispose());
  }
}
$('exportBtn').addEventListener('click', () => exportGLB());

const BACKDROPS = ['light', 'mid', 'dark'];
function cycleBackdrop() {
  const stageEl = $('stage');
  const i = Math.max(0, BACKDROPS.findIndex((b) => stageEl.classList.contains('bd-' + b)));   // none set = light
  BACKDROPS.forEach((b) => stageEl.classList.remove('bd-' + b));
  stageEl.classList.add('bd-' + BACKDROPS[(i + 1) % BACKDROPS.length]);
}

// ---------------- loop + boot ----------------
function tick() {
  processMove();
  if (!preview.visible) {   // the store preview has its own renderer; the editor rests
    controls.update();
    renderer.render(scene, camera);
    drawOverlay();
  }
  requestAnimationFrame(tick);
}

preview = new StorePreview($('stage'), {
  build: () => buildShopifyFile(),
  download: saveShopifyFile,
  limit: SHOPIFY_LIMIT,
  onMode: (mode) => {
    document.querySelectorAll('[data-vm]').forEach((b) => b.classList.toggle('on', b.dataset.vm === mode));
    $('stage').classList.toggle('previewing', mode !== 'edit');
  },
});
document.querySelectorAll('[data-vm]').forEach((b) => b.addEventListener('click', () => preview.setMode(b.dataset.vm)));

async function boot() {
  resize();
  state.manifest = await (await fetch('bases/manifest.json', { cache: 'no-store' })).json();
  const zones = await (await fetch('zones.json', { cache: 'no-store' })).json();
  for (const g of state.manifest.garments) g.zones = zones[g.id] || [];
  $('garment').innerHTML = state.manifest.garments.map((g) => `<option value="${g.id}">${g.label}</option>`).join('');
  const startId = new URLSearchParams(location.search).get('garment') || state.manifest.garments[0].id;
  $('garment').value = startId;
  await loadGarment(startId);
  pushHistory();
  tick();
}
boot().catch((e) => { console.error(e); setStatus(`Failed to start: ${e.message}`); });

// test/automation hook
// What the page around this one calls (menu routing), plus the test harness hooks.
window.studio = {
  state, camera, loadGarment, exportGLB, frameCamera, snap, setMode, rebuildDecal, refreshFabrics, renderParts,
  undo, redo, addArtwork, cycleBackdrop, preview, buildShopifyFile, acidPresets: ACID_PRESETS,
  save: () => exportGLB(),
  addAnywhere: () => pickFiles(null),
  fit: () => frameCamera('front'),
  async addFromURL(url, zoneId) {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], url.split('/').pop(), { type: blob.type });
    const zone = zoneId ? zoneById(zoneId) : null;
    await addFiles([file], zone ? { zone } : null);
    return state.selected;
  },
};
