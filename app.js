// DeltaWing DW-R5 inspection viewer (three.js r170, WebXR).
// Scene units: metres, 1:1.  glTF axes: x = CAD X (aft), y = CAD Z (up), z = −CAD Y.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const MODEL = new URLSearchParams(location.search).get('model') || 'DW-R5-11210303.glb';
const SYSTEM_ORDER = ['frame', 'controls', 'engine', 'fuel', 'avionics', 'recovery', 'harness', 'payload'];
const AUTO_FOCUS = new Set(['engine', 'avionics']);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.localClippingEnabled = true;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9ddd9);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
scene.environmentIntensity = 0.85;
// Key light low and long: its highlight runs along the fuselage and across the wing,
// which shows the curvature of the whole skin in the main view.
const key = new THREE.DirectionalLight(0xfff6ec, 2.8); key.position.set(-2.5, 2.2, 3.2); scene.add(key);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.8); rim.position.set(3, 1.2, -2.5); scene.add(rim);

const camera = new THREE.PerspectiveCamera(32, 1, 0.004, 80);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.09; controls.zoomToCursor = true;
controls.minDistance = 0.05; controls.maxDistance = 14;

const root = new THREE.Group(); scene.add(root);

// soft contact shadow under the aircraft (CAD Z −205 mm)
{
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grd.addColorStop(0, 'rgba(30,40,35,0.42)'); grd.addColorStop(1, 'rgba(30,40,35,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.0), new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false}));
  m.rotation.x = -Math.PI / 2; m.position.set(0.8, -0.212, 0); m.name = 'contact-shadow'; root.add(m);
}

// ------------------------------------------------------------------ state
const state = {skin: true, ghost: false, section: 'none', secX: 0.89, system: 'all', selected: null};
const parts = [];                  // {obj, meta, meshes, system, row}
const partByMesh = new Map();
const hidden = new Set();
let exterior, interior, model;

// ------------------------------------------------------------------ clipping + section caps
const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
const localPlane = new THREE.Plane();
function updatePlane() {
  if (state.section === 'long') localPlane.set(new THREE.Vector3(0, 0, -1), 0);          // keeps CAD Y ≥ 0 (starboard half)
  else localPlane.set(new THREE.Vector3(1, 0, 0), -state.secX);                         // keeps the part aft of X
  root.updateMatrixWorld(); plane.copy(localPlane).applyMatrix4(root.matrixWorld);
}
const capUniform = {value: new THREE.Color(0xc4562a)};
function patch(material, {cap = true} = {}) {
  material.onBeforeCompile = shader => {
    shader.uniforms.capColor = capUniform;
    shader.fragmentShader = 'uniform vec3 capColor;\n' + shader.fragmentShader.replace('#include <opaque_fragment>', `
      #if NUM_CLIPPING_PLANES > 0
        ${cap ? 'if (!gl_FrontFacing) { outgoingLight = capColor * (0.55 + 0.45 * diffuseColor.rgb); }' : ''}
        float dCut = abs(dot(vClipPosition, clippingPlanes[0].xyz) - clippingPlanes[0].w);
        float edge = 1.0 - smoothstep(0.5, 1.8, dCut / max(fwidth(dCut), 1e-7));
        outgoingLight = mix(outgoingLight, vec3(0.62, 0.17, 0.05), edge);
      #endif
      #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => (cap ? 'cap' : 'nocap');
  material.needsUpdate = true;
}
function allMaterials(fn) { model?.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => fn(m, o)); }); }

// ------------------------------------------------------------------ loading
const loader = new GLTFLoader();
loader.load(MODEL, gltf => {
  model = gltf.scene; root.add(model);
  exterior = model.getObjectByName('EXTERIOR'); interior = model.getObjectByName('INTERIOR');
  const seen = new Set();
  model.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (seen.has(m)) return; seen.add(m);
      const isSkin = m.name === 'skin' || m.name === 'elevon';
      if (!m.transparent) m.side = isSkin ? THREE.DoubleSide : THREE.DoubleSide;
      patch(m, {cap: !isSkin});
      m.userData.base = {emissive: m.emissive.clone(), ei: m.emissiveIntensity};
    });
  });
  model.traverse(o => {
    if (!o.userData?.dw_part) return;
    const meshes = []; o.traverse(m => m.isMesh && meshes.push(m));
    const rec = {obj: o, meta: o.userData, meshes, system: o.userData.system};
    meshes.forEach(m => partByMesh.set(m, rec)); parts.push(rec);
  });
  // skin material for the ghost outline
  exterior.traverse(o => { if (o.isMesh) { o.userData.solidMat = o.material; o.userData.ghostMat = ghostMaterial(o.material); } });
  buildUI(); applyView('hero', false); refresh(); setupAssembly();
  $('status').textContent = `${parts.length} деталей · ${countTris()} тыс. треугольников`;
  window.__dw = {ready: true, parts: parts.length};
}, ev => { if (ev.total) $('status').textContent = `Загрузка ${(ev.loaded / ev.total * 100).toFixed(0)} %`; },
err => { $('status').textContent = 'Не удалось загрузить модель: ' + err.message; });

function ghostMaterial(base) {
  const m = new THREE.MeshStandardMaterial({color: 0x6f9c8a, transparent: true, opacity: 0.24, depthWrite: false, roughness: 0.25, metalness: 0, side: THREE.FrontSide, emissive: 0x23453a, emissiveIntensity: 0.35});
  m.name = base.name + '-ghost'; return m;
}
function countTris() { let n = 0; model.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return Math.round(n / 1000); }

// ------------------------------------------------------------------ UI
const SYSTEM_TITLES = {};
function buildUI() {
  const sysNode = interior.children.map(c => c.userData).filter(u => u.dw_system);
  sysNode.forEach(u => SYSTEM_TITLES[u.system] = u.title);
  SYSTEM_TITLES.exterior = 'Обшивка';
  const chips = $('systems');
  const mk = (key, title) => { const b = document.createElement('button'); b.textContent = title; b.dataset.sys = key; b.onclick = () => chooseSystem(key); chips.append(b); };
  mk('all', 'Все системы'); mk('exterior', 'Обшивка');
  SYSTEM_ORDER.filter(k => SYSTEM_TITLES[k]).forEach(k => mk(k, SYSTEM_TITLES[k]));
  renderList();
  $('btn-skin').onclick = () => setSkin(!state.skin);
  $('btn-ghost').onclick = () => { state.ghost = !state.ghost; refresh(); };
  document.querySelectorAll('#seg-section button').forEach(b => b.onclick = () => setSection(b.dataset.sec));
  $('sec-x').oninput = e => { state.secX = +e.target.value / 1000; $('sec-x-out').textContent = `${e.target.value} мм`; refresh(); };
  document.querySelectorAll('#views button').forEach(b => b.onclick = () => applyView(b.dataset.view));
  $('btn-hide').onclick = () => state.selected && hidePart(state.selected);
  $('btn-focus').onclick = () => state.selected && focusOn(state.selected.obj, 0.85);
  $('btn-showall').onclick = () => { hidden.clear(); refresh(); };
  $('btn-reset').onclick = resetAll;
  // exploded view and assembly animation (only on pages that have the controls, e.g. index_r5.html)
  const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
  on('btn-explode', () => setExploded(!exploded));
  on('btn-assembly', () => startAssembly());
  on('pl-play', () => togglePlay());
  on('pl-next', () => stepTo(anim.stage + 1));
  on('pl-prev', () => stepTo(anim.stage - 1));
  on('pl-restart', () => stepTo(0, true));
  on('pl-close', () => stopAssembly());
  document.querySelectorAll('#pl-speed button').forEach(b => b.onclick = () => {
    anim.speed = +b.dataset.s; document.querySelectorAll('#pl-speed button').forEach(q => q.classList.toggle('on', q === b));
  });
  addEventListener('keydown', e => {
    if (!anim.on || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
    if (e.code === 'Space') { if (e.target.closest?.('button, a')) return; e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') stepTo(anim.stage + 1);
    else if (e.code === 'ArrowLeft') stepTo(anim.stage - 1);
    else if (e.code === 'Escape') stopAssembly();
  });
}
function renderList() {
  const box = $('parts'); box.innerHTML = '';
  const list = parts.filter(p => state.system === 'all' || p.system === state.system);
  let group = null;
  list.forEach(p => {
    const g = p.meta.group || SYSTEM_TITLES[p.system];
    if (g !== group) { group = g; const d = document.createElement('div'); d.className = 'grp'; d.textContent = g; box.append(d); }
    const b = document.createElement('button'); b.textContent = p.meta.title;
    b.onclick = () => select(p, true); p.row = b; box.append(b);
  });
  syncList();
}
function syncList() {
  parts.forEach(p => { if (!p.row) return; p.row.classList.toggle('sel', p === state.selected); p.row.classList.toggle('hidden-part', hidden.has(p)); });
  document.querySelectorAll('#systems button').forEach(b => b.classList.toggle('on', b.dataset.sys === state.system));
}

function setSkin(on) { state.skin = on; if (on) state.ghost = false; refresh(); }
function setSection(s) {
  if (s !== 'none' && anim.on) stopAssembly();
  if (s !== 'none' && displaced()) setExploded(false, false);
  state.section = s;
  document.querySelectorAll('#seg-section button').forEach(b => b.classList.toggle('on', b.dataset.sec === s));
  $('sec-pos').hidden = s !== 'trans';
  if (s === 'long') applyView('section-long'); if (s === 'trans') applyView('section-trans');
  refresh();
}
function chooseSystem(key) {
  state.system = key;
  if (key !== 'all' && key !== 'exterior') state.skin = false;
  if (key === 'exterior') state.skin = true;
  renderList(); refresh();
  if (key === 'all') applyView('hero');
  else {
    const objs = parts.filter(p => p.system === key && !hidden.has(p)).map(p => p.obj);
    if (key === 'engine') applyView('engine-cover'); else focusOn(objs, 1.15);
  }
}
function hidePart(p) { hidden.add(p); if (state.selected === p) select(null); refresh(); }

function refresh() {
  const sectionOn = state.section !== 'none';
  if (sectionOn) updatePlane();
  allMaterials(m => { m.clippingPlanes = sectionOn ? [plane] : []; });
  // exterior
  exterior.traverse(o => { if (o.isMesh && !o.userData.animOrig && !o.userData.origMat) o.material = state.ghost && !state.skin ? o.userData.ghostMat : o.userData.solidMat; });
  exterior.visible = state.skin || state.ghost || state.system === 'exterior';
  // rev S3: the interior is always drawn. With the skin on, the bridle lug clevises, the hook pin in its pocket, the launch
  // shoe, the pitot and every bay opened by hiding its cover are seen from outside
  const interiorNeeded = true;
  parts.forEach(p => {
    const sysOK = state.system === 'all' || p.system === state.system || (state.system === 'engine' && !!p.meta.mountedOnEngine);
    // the engine and propeller protrude through the supplied outer surface: always drawn
    const external = p.system === 'engine' || !!p.meta.mountedOnEngine;
    p.obj.visible = Boolean(!hidden.has(p) && !animHidden.has(p) && sysOK && (p.system === 'exterior' || external ? true : interiorNeeded));
  });
  if (state.system !== 'all' && state.system !== 'exterior') exterior.visible = state.ghost;
  $('btn-skin').textContent = state.skin ? 'Снять обшивку' : 'Вернуть обшивку';
  $('btn-skin').classList.toggle('primary', state.skin);
  $('btn-ghost').disabled = state.skin; $('btn-ghost').classList.toggle('on', state.ghost && !state.skin);
  syncList(); xrPanel?.draw();
}

// ------------------------------------------------------------------ selection
function highlight(p, on) {
  p.meshes.forEach(m => {
    if (on) {
      m.userData.origMat = m.material;
      const c = m.material.clone(); patch(c, {cap: !(c.name === 'skin' || c.name === 'elevon')});
      c.emissive = new THREE.Color(0xff7a2e); c.emissiveIntensity = 0.28; c.clippingPlanes = m.material.clippingPlanes;
      m.material = c;
    } else if (m.userData.origMat) { m.material.dispose(); m.material = m.userData.origMat; delete m.userData.origMat; }
  });
}
function select(p, fromList = false) {
  if (anim.on && p) { anim.playing = false; untint(p); syncPlayer(); }
  if (state.selected) highlight(state.selected, false);
  state.selected = p;
  if (!p) { select.prevSys = null; $('card').hidden = true; syncList(); xrPanel?.draw(); return; }
  highlight(p, true);
  const m = p.meta;
  $('card').hidden = false;
  $('card-sys').textContent = SYSTEM_TITLES[p.system] || '';
  $('card-title').textContent = m.title;
  $('card-purpose').textContent = m.purpose || '—';
  $('card-origin').textContent = m.origin || '—';
  $('card-finish').textContent = (m.finishes || []).join('; ') || '—';
  if (m.boundsMM) { const [a, b] = m.boundsMM; $('card-size').textContent = `${(b[0]-a[0]).toFixed(0)} × ${(b[1]-a[1]).toFixed(0)} × ${(b[2]-a[2]).toFixed(0)} мм (X × Y × Z)`; }
  $('card-ref').hidden = $('card-ref-dt').hidden = !m.reference; $('card-ref').textContent = m.reference || '';
  if (p.system !== 'exterior' && state.skin && state.section === 'none') { state.skin = false; refresh(); }
  const prevSys = select.prevSys; select.prevSys = p.system;
  if (p.system === 'engine' && prevSys !== 'engine') {
    // first pick on the engine: frame the whole T-550E so it fills most of the window
    focusOn(parts.filter(q => q.system === 'engine' && q.meta.id !== 'PROP' && isShown(q.obj)).map(q => q.obj), 1.15);
  } else if (AUTO_FOCUS.has(p.system) || fromList) focusOn(p.obj, 0.85);
  if (renderer.xr.isPresenting) bringToHand(p.obj);
  syncList(); xrPanel?.draw();
  p.row?.scrollIntoView({block: 'nearest'});
}

// picking (mouse / touch): ignore drags
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2(); let down = null, lastTap = 0;
canvas.addEventListener('pointerdown', e => { down = {x: e.clientX, y: e.clientY}; });
canvas.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  const r = canvas.getBoundingClientRect();
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = pick(ray);
  const now = performance.now();
  if (hit) { if (hit === state.selected && now - lastTap < 350) focusOn(hit.obj, 0.85); else select(hit); }
  else if (now - lastTap < 350) select(null);
  lastTap = now;
});
function pick(raycaster) {
  const targets = []; parts.forEach(p => { if (isShown(p.obj)) targets.push(...p.meshes); });
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    if (state.section !== 'none' && plane.distanceToPoint(h.point) < 0) continue;
    const p = partByMesh.get(h.object);
    if (p.system === 'exterior' && state.ghost && !state.skin) continue;
    if (h.object.material.transparent && h.object.material.opacity < 0.3 && hits.length > 1) continue;
    return p;
  }
  return null;
}
function isShown(o) { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; }

// ------------------------------------------------------------------ camera
let tween = null;
function flyTo(pos, target, fov, ms = 650) {
  const p0 = camera.position.clone(), t0 = controls.target.clone(), f0 = camera.fov, start = performance.now();
  tween = now => {
    const k = Math.min(1, (now - start) / ms), e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2) / 2;
    camera.position.lerpVectors(p0, pos, e); controls.target.lerpVectors(t0, target, e);
    if (fov) { camera.fov = f0 + (fov - f0) * e; camera.updateProjectionMatrix(); }
    if (k >= 1) tween = null;
  };
}
function boxOf(objs) {
  const b = new THREE.Box3(); [objs].flat().forEach(o => o.traverse(m => { if (m.isMesh && isShown(m)) b.expandByObject(m); })); return b;
}
function focusOn(objs, fill = 0.75, dir = null) {
  const b = boxOf(objs); if (b.isEmpty()) return;
  const s = b.getBoundingSphere(new THREE.Sphere());
  const d = (dir ? dir.clone() : camera.position.clone().sub(controls.target)).normalize();
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = s.radius / Math.tan(Math.min(vfov, hfov) / 2) / fill;
  flyTo(s.center.clone().add(d.multiplyScalar(dist)), s.center.clone());
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function applyView(name, animate = true) {
  const views = {   // direction from target to camera, fill
    hero: [V(-0.62, 0.36, 0.70), 1.45],
    top: [V(0.0001, 1, 0.0002), 1.2],
    side: [V(0, 0.02, 1), 1.25],
    'section-long': [V(0.10, 0.22, 1), 1.9],
    'section-trans': [V(-0.80, 0.30, 0.42), 1.9],
  };
  if (name === 'engine-cover') {
    state.skin = false; state.system = 'engine'; renderList();
    const prop = parts.find(p => p.meta.id === 'PROP'); if (prop) hidden.add(prop);
    refresh();
    // same direction as the cover photo of the manual: port side, slightly aft and above
    focusOn(parts.filter(p => p.system === 'engine' && p.meta.id !== 'PROP').map(p => p.obj), 1.3, V(0.62, 0.16, 0.62));
    return;
  }
  if (name === 'structure') {
    state.skin = false; state.system = 'frame'; renderList(); refresh();
    focusOn(parts.filter(p => p.system === 'frame').map(p => p.obj), 1.2, V(-0.55, 0.62, 0.70));
    return;
  }
  if (name === 'avionics') {
    state.skin = false; state.system = 'avionics'; renderList(); refresh();
    focusOn(parts.filter(p => p.system === 'avionics' && p.obj.userData.boundsMM[1][0] < 0).map(p => p.obj), 1.15, V(-0.30, 0.55, 0.85));
    return;
  }
  const [dir, fill] = views[name];
  if (!animate) { camera.position.set(-1, 1, 3); controls.target.set(0.8, 0, 0); }
  focusOn(exterior, fill, dir);
  if (!animate && tween) { tween(performance.now() + 1e6); }
}
function resetAll() {
  if (anim.on) stopAssembly(); if (displaced()) setExploded(false, false);
  hidden.clear(); select(null); state.system = 'all'; state.ghost = false; state.skin = true;
  setSection('none'); renderList(); refresh(); applyView('hero');
}

// ------------------------------------------------------------------ exploded view and assembly animation
// assembly_r5.json (cad/assembly5.py): the build stages in the order of build/assembly_sequence_r5_s3.md, and for
// every part the direction it is installed from, its attachment text and the parts it touches (exact contact graph,
// qa5). Positions are offsets of the part nodes; their parents are unrotated and unscaled, so an offset is in metres
// of the model (root) frame. Boxes are kept in the root frame too, so VR placement does not disturb them.
let asm = null, exploded = false;
const animHidden = new Set();                     // parts not yet installed in the assembly animation
const tints = new Set();                          // parts with a temporary highlight
const fx = [];                                    // position tweens {p, from, to, t0, ms, clock, done}
const anim = {on: false, playing: false, stage: 0, speed: 1, clock: 0, last: 0, events: [], landed: new Set(), finished: false,
              cur: null, manual: false};
const partById = new Map();
const asmReady = () => !!setupAssembly.done;
if ($('player')) fetch('assembly_r5.json?v=' + encodeURIComponent(MODEL)).then(r => r.ok ? r.json() : null)
  .then(d => { asm = d; setupAssembly(); }).catch(() => {});

// mm in CAD axes (X aft, Y right, Z up) for a part centred at c. spread = false gives the pure installation path (the
// assembly animation flies along it); spread = true adds a separation of neighbours for the exploded view.
function cadOffset(dir, c, spread = true) {
  const s = Math.sign(c.y) || 1, wing = Math.abs(c.y) >= 530, k = spread ? 1 : 0, sx = (c.x - 800) * k, sy = c.y * k;
  if (Array.isArray(dir)) return [dir[0], dir[1] * s, dir[2]];
  switch (dir) {
    case 'shell_down': return [0, wing ? s * 140 : 0, -650];
    case 'shell_up': return [0, wing ? s * 140 : 0, 1150];
    case 'top': return [sx * 0.15, sy * 0.3, 1420];
    case 'caps_up': return [sx * 0.2, sy * 0.4, 840];
    case 'belly': return [sx * 0.2, wing ? s * 150 : sy * 0.3, -1050];
    case 'down': return [0, s * 150, -820];
    case 'fwd': return [-650, 0, 0];
    case 'aft': return [650, sy * 0.3, 0];
    case 'engine': return [850 + (c.x - 1960) * 0.9 * k, sy * 1.3, (c.z + 20) * 1.4 * k];
    case 'engine_core': return spread ? [850 + (c.x - 1960) * 0.9, sy * 1.3, (c.z + 20) * 1.4] : [900, 0, 0];
    case 'prop': return [1500, 0, 0];
    case 'outaft': return [380, s * 320, 0];
    case 'winglet': return [0, s * 700, 280];
    case 'sys_up': return wing ? [0, s * 450, 460] : [sx * 0.3, sy * 0.6, 720];
    default: return wing ? [0, s * (600 + (Math.abs(c.y) - 530) * 0.15), 230] : [sx * 0.35, sy * 0.6, 420];
  }
}
function setupAssembly() {
  if (!asm || !parts.length || setupAssembly.done || !$('player')) return;
  const stageOf = new Map(); asm.stages.forEach((st, i) => st.parts.forEach(id => stageOf.set(id, i)));
  const unknown = parts.filter(p => !stageOf.has(p.meta.id));
  if (unknown.length) {                            // parts the data does not know: a trailing stage of their own
    console.warn('assembly_r5.json: no stage for', unknown.map(p => p.meta.id));
    asm.stages.push({title: 'Прочие детали', note: 'Детали, которых нет в данных сборки (assembly_r5.json).', parts: unknown.map(p => p.meta.id)});
    unknown.forEach(p => stageOf.set(p.meta.id, asm.stages.length - 1));
  }
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  parts.forEach(p => {
    partById.set(p.meta.id, p);
    p.home = p.obj.position.clone(); p.t = 0;
    p.asm = asm.parts[p.meta.id] || {dir: 'struct', how: '', to: []};
    p.stage = stageOf.get(p.meta.id);
    const b = p.meta.boundsMM, c = b ? {x: (b[0][0] + b[1][0]) / 2, y: (b[0][1] + b[1][1]) / 2, z: (b[0][2] + b[1][2]) / 2} : {x: 800, y: 0, z: 0};
    const [dx, dy, dz] = cadOffset(p.asm.dir, c), [ex, ey, ez] = cadOffset(p.asm.dir, c, false);
    p.off = new THREE.Vector3(dx / 1000, dz / 1000, -dy / 1000);      // glTF: (X, Z, -Y); exploded view
    p.path = new THREE.Vector3(ex / 1000, ez / 1000, -ey / 1000);     // assembly animation: straight installation path
    p.box0 = new THREE.Box3().setFromObject(p.obj).applyMatrix4(toRoot);
  });
  setupAssembly.done = true;
  $('btn-explode').disabled = false; $('btn-assembly').disabled = false;
  xrPanel?.draw();
}
function place(p) { p.obj.position.copy(p.home).addScaledVector(anim.on ? p.path : p.off, p.t); }
const displaced = () => parts.some(p => p.t !== undefined && p.t !== 0);
function dropTween(p) { for (let i = fx.length - 1; i >= 0; i--) if (fx[i].p === p) fx.splice(i, 1); }
function tweenPart(p, to, ms, delay = 0, done = null, clock = 'real') {
  dropTween(p);
  const now = clock === 'anim' ? anim.clock : performance.now();
  if (ms <= 0) { p.t = to; place(p); done?.(); return; }
  fx.push({p, from: p.t, to, t0: now + delay, ms, clock, done});
}
function animTick(now) {
  const dt = anim.last ? Math.min(100, now - anim.last) : 0; anim.last = now;
  if (anim.on && anim.playing && !anim.manual) anim.clock += dt * anim.speed;
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; if (!f) continue;
    const tnow = f.clock === 'anim' ? anim.clock : now;
    const k = Math.min(1, Math.max(0, (tnow - f.t0) / f.ms)), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    f.p.t = f.from + (f.to - f.from) * e; place(f.p);
    if (k >= 1) { fx.splice(fx.indexOf(f), 1); f.done?.(); }
  }
  if (anim.on && anim.playing) {
    anim.events.sort((a, b) => a.at - b.at);
    while (anim.events.length && anim.events[0].at <= anim.clock) anim.events.shift().fn();
  }
}
function later(ms, fn) { anim.events.push({at: anim.clock + ms, fn}); }
function advance(ms) { anim.clock += ms * anim.speed; animTick(anim.last || performance.now()); }   // video recording (anim.manual)

// temporary highlight of a part (orange = being installed, teal = what it is attached to)
function tint(p, color, k) {
  untint(p);
  p.meshes.forEach(m => {
    if (m.userData.origMat) return;
    m.userData.animOrig = m.material;
    const c = m.material.clone(); patch(c, {cap: !(c.name === 'skin' || c.name === 'elevon')});
    c.emissive = new THREE.Color(color); c.emissiveIntensity = k; c.clippingPlanes = m.material.clippingPlanes;
    m.material = c;
  });
  tints.add(p);
}
function untint(p) {
  if (!tints.has(p)) return;
  p.meshes.forEach(m => { if (m.userData.animOrig) { m.material.dispose(); m.material = m.userData.animOrig; delete m.userData.animOrig; } });
  tints.delete(p);
}
function clearTints() { [...tints].forEach(untint); }

// box of the parts at explode fraction t, in the root frame (which = all parts, or only those drawn now)
function kitBox(t, which = 'all') {
  const b = new THREE.Box3(), o = new THREE.Vector3();
  const use = p => p.box0 && !p.box0.isEmpty() && (which === 'all' ? !hidden.has(p) : isShown(p.obj));
  let list = parts.filter(use); if (!list.length) list = parts.filter(p => p.box0 && !p.box0.isEmpty());
  list.forEach(p => { o.copy(anim.on ? p.path : p.off).multiplyScalar(t); b.union(p.box0.clone().translate(o)); });
  return b;
}
function frameBox(bLocal, fill = 1.0, dir = V(-0.62, 0.42, 0.70), liftPx = 0) {
  if (renderer.xr.isPresenting || bLocal.isEmpty()) return;
  root.updateMatrixWorld(true);
  const b = bLocal.clone().applyMatrix4(root.matrixWorld);
  const sph = b.getBoundingSphere(new THREE.Sphere()), d = dir.clone().normalize();
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = sph.radius / Math.tan(Math.min(vfov, hfov) / 2) / fill;
  const pos = sph.center.clone().add(d.clone().multiplyScalar(dist)), tgt = sph.center.clone();
  if (liftPx) {                                     // shift the image up so a panel over the bottom does not hide it
    const h = canvas.clientHeight || 1, k = liftPx / (h / 2) * dist * Math.tan(vfov / 2);
    const fwd = d.clone().negate(), up = V(0, 1, 0).sub(fwd.clone().multiplyScalar(fwd.y)).normalize();
    pos.addScaledVector(up, -k); tgt.addScaledVector(up, -k);
  }
  flyTo(pos, tgt, null, 900);
}
function playerLift() { const e = $('player'); return e && !e.hidden && getComputedStyle(e).position === 'absolute' ? e.offsetHeight * 0.55 : 0; }

// VR: parts thrown below the root would end up under the floor; lift the root while displaced, put it back afterwards
function xrLift(on) {
  if (!renderer.xr.isPresenting) return;
  if (on && !root.userData.xrPose) {
    root.userData.xrPose = {p: root.position.clone(), q: root.quaternion.clone()};
    root.updateMatrixWorld(true);
    const minY = kitBox(1).applyMatrix4(root.matrixWorld).min.y;
    if (minY < 0.05) root.position.y += 0.05 - minY;
  } else if (!on && root.userData.xrPose) {
    root.position.copy(root.userData.xrPose.p); root.quaternion.copy(root.userData.xrPose.q); delete root.userData.xrPose;
  }
}

// "Разнести детали": every part moves out along the direction it is installed from (last installed leaves first)
function setExploded(on, animate = true) {
  if (!asmReady()) return;
  if (anim.on) stopAssembly();
  if (on && state.section !== 'none') setSection('none');
  exploded = on;
  const n = asm.stages.length;
  if (on) xrLift(true);
  parts.forEach(p => tweenPart(p, on ? 1 : 0, animate ? 950 : 0, animate ? (on ? n - 1 - p.stage : p.stage) * 45 : 0));
  clearTimeout(setExploded.timer);
  if (!on) setExploded.timer = setTimeout(() => { if (!exploded && !anim.on) xrLift(false); }, animate ? n * 45 + 1000 : 0);
  $('btn-explode').textContent = on ? 'Собрать детали' : 'Разнести детали';
  $('btn-explode').classList.toggle('on', on);
  if (animate) frameBox(on ? kitBox(1, 'shown') : kitBox(0, 'shown'), on ? 1.05 : 1.45);
  xrPanel?.draw();
}

// "Как собирается": stage by stage the parts fly in from their exploded positions, one at a time (symmetric right and
// left parts together). When a part lands, the parts it is attached to light up and the caption says how it is attached.
const FLY = 800;
const dwellOf = beat => Math.min(2200, Math.max(900, 700 + 9 * Math.max(...beat.map(p => (p.asm.how || '').length), 0)));
function beatsOf(i) {
  const ids = asm.stages[i].parts, list = ids.map(id => partById.get(id)).filter(Boolean);
  const key = id => id.replace(/^(PNL_SHL)_[RL]_/, '$1__').replace(/_[RL](\d?)$/, '_$1').replace(/_[RL](\d)(?=_|$)/, '_$1');
  const m = new Map();
  list.forEach(p => { const k = key(p.meta.id); if (!m.has(k)) m.set(k, []); m.get(k).push(p); });
  return [...m.values()];
}
function restoreView() {                          // the animation shows the whole aircraft with its skin
  if (!state.skin || state.system !== 'all' || state.ghost || hidden.size) {
    state.skin = true; state.system = 'all'; state.ghost = false; hidden.clear(); renderList();
  }
}
function startAssembly() {
  if (!asmReady()) return;
  if (anim.on) { stepTo(0, true); return; }
  select(null); restoreView();
  if (state.section !== 'none') setSection('none');
  exploded = false; $('btn-explode').textContent = 'Разнести детали'; $('btn-explode').classList.remove('on');
  fx.length = 0;
  Object.assign(anim, {on: true, playing: true, finished: false, clock: 0, events: []});
  $('player').hidden = false; $('toolbar').hidden = true;
  resize(); xrLift(true);
  frameBox(kitBox(0.22), 1.12, undefined, playerLift());
  stepTo(0, true);
}
function stopAssembly() {
  if (!anim.on) return;
  anim.on = false; anim.playing = false; anim.events = []; anim.cur = null; anim.manual = false;
  fx.length = 0; clearTints(); animHidden.clear();
  parts.forEach(p => { p.t = 0; place(p); });
  if ($('player')) { $('player').hidden = true; $('toolbar').hidden = false; }
  xrLift(false); resize();
  refresh(); xrPanel?.draw();
}
function togglePlay() {
  if (!asmReady()) return;
  if (!anim.on) { startAssembly(); return; }
  if (anim.finished) { stepTo(0, true); return; }
  anim.playing = !anim.playing;
  if (anim.playing) {                             // resume: drop the inspection state made while paused
    select(null); restoreView(); refresh();
    beatsOf(anim.stage).flat().forEach(p => { if (!anim.landed.has(p) && p.t > 0 && !tints.has(p)) tint(p, 0xff7a2e, 0.4); });
  }
  syncPlayer(); xrPanel?.draw();
}
function stepTo(i, play = null) {
  if (!anim.on || !asm) return;
  if (i < 0 || i >= asm.stages.length) return;
  if (anim.finished && i > anim.stage) return;
  if (play !== null) anim.playing = play;
  anim.events = []; anim.finished = false; anim.cur = null; anim.landed.clear();
  fx.length = 0; clearTints(); select(null); restoreView();
  anim.stage = i;
  parts.forEach(p => {
    if (p.stage < i) { p.t = 0; animHidden.delete(p); } else { p.t = 1; animHidden.add(p); }
    place(p);
  });
  const beats = beatsOf(i);
  beats.flat().forEach(p => animHidden.delete(p));
  refresh();
  beats.flat().forEach(p => tint(p, 0xff7a2e, 0.4));
  caption();
  let t = 900;                                   // stage title first, then one beat after another
  beats.forEach(beat => {
    later(t, () => { anim.cur = beat; caption(); beat.forEach((p, k) => tweenPart(p, 0, FLY, 0, k ? null : () => land(beat), 'anim')); });
    t += FLY + dwellOf(beat);
  });
  later(t + 500, () => {
    if (i + 1 < asm.stages.length) stepTo(i + 1);
    else { anim.finished = true; anim.playing = false; anim.cur = null; clearTints(); caption(); syncPlayer(); xrPanel?.draw(); }
  });
  syncPlayer(); xrPanel?.draw();
}
function land(beat) {
  beat.forEach(p => { anim.landed.add(p); untint(p); });
  const mates = [...new Set(beat.flatMap(installedMates))].filter(q => !beat.includes(q)).slice(0, 10);
  mates.forEach(q => { if (!tints.has(q)) tint(q, 0x1f9d84, 0.55); });
  later(dwellOf(beat), () => mates.forEach(q => { if (q.stage !== anim.stage || anim.landed.has(q)) untint(q); }));
}
function installedMates(p) {
  return (p.asm.to || []).map(id => partById.get(id))
    .filter(q => q && !hidden.has(q) && (q.stage < anim.stage || anim.landed.has(q)));
}
const SIDE = /,?\s*(правый|левый|правая|левая|правое|левое|правые|левые)(?=$|[\s,.;)])/g;   // no \b: it is ASCII-only
const shortTitle = t => t.replace(/\s*\([^)]*\)\s*$/, '').replace(/,\s*(правый|левый|правая|левая|правое|левое)$/, ' $1');
function beatTitle(beat) {
  return beat.length > 1 && beat[0].asm.pair ? beat[0].asm.pair : shortTitle(beat[0].meta.title);
}
function captionText() {
  if (!anim.on || !asm) return null;
  const st = asm.stages[anim.stage], n = asm.stages.length;
  if (anim.finished) return {step: `Готово · ${n} этапов, ${parts.length} деталей`, title: 'Самолёт собран', note: 'Нажмите «С начала», чтобы посмотреть ещё раз, или «Закрыть», чтобы вернуться к осмотру.', part: null};
  const beat = anim.cur;
  let part = null;
  if (beat) {
    const mates = [...new Set(beat.flatMap(installedMates).filter(q => !beat.includes(q)).map(q => shortTitle(q.meta.title).replace(SIDE, '').replace(/\s+/g, ' ').trim()))];
    part = {title: beatTitle(beat), to: mates.length ? mates.slice(0, 4).join(', ') + (mates.length > 4 ? ` и ещё ${mates.length - 4}` : '') : '',
            how: beat[0].asm.how || ''};
  }
  return {step: `Этап ${anim.stage + 1} из ${n}`, title: st.title, note: st.note, part};
}
function caption() {
  const c = captionText(); if (!c || !$('player')) return;
  $('pl-step').textContent = c.step; $('pl-title').textContent = c.title; $('pl-note').textContent = c.note;
  const box = $('pl-part'); box.textContent = '';
  if (c.part) {
    const b = document.createElement('b'); b.textContent = c.part.title; box.append(b);
    if (c.part.to) box.append(document.createTextNode(' → крепится к: ' + c.part.to));
    if (c.part.how) { const h = document.createElement('span'); h.className = 'how'; h.textContent = 'Как: ' + c.part.how; box.append(h); }
  }
  const n = asm.stages.length;
  $('pl-bar').style.width = (anim.finished ? 100 : (anim.stage + 0.5) / n * 100) + '%';
  xrPanel?.draw();
}
function syncPlayer() {
  const b = $('pl-play'); if (!b) return;
  b.textContent = anim.finished ? 'С начала' : (anim.playing ? 'Пауза' : 'Дальше');
  b.title = anim.finished ? 'С начала' : (anim.playing ? 'Пауза (пробел)' : 'Дальше (пробел)');
  $('pl-prev').disabled = !anim.on || anim.stage <= 0;
  $('pl-next').disabled = !anim.on || anim.finished || anim.stage >= (asm?.stages.length || 1) - 1;
}

// ------------------------------------------------------------------ resize / loop
function resize() {
  if (renderer.xr.isPresenting) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(canvas);
renderer.setAnimationLoop(now => {
  if (tween) tween(now);
  animTick(now);
  if (!renderer.xr.isPresenting) controls.update();
  if (state.section !== 'none') updatePlane();
  xrTick();
  renderer.render(scene, camera);
});

// ------------------------------------------------------------------ WebXR
let xrPanel = null, xrSession = null, grabbing = null;
const xrBtn = $('btn-xr');
(async () => {
  if (!navigator.xr) { $('xr-note').textContent = 'WebXR недоступен в этом браузере. Откройте страницу в браузере шлема (Meta Quest Browser и аналоги).'; return; }
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  xrBtn.disabled = !ok;
  $('xr-note').textContent = ok ? 'Шлем найден: модель откроется в масштабе 1:1.' : 'Устройство VR не найдено. На обычном экране управление мышью и касанием.';
})();
xrBtn.onclick = async () => {
  if (xrSession) { xrSession.end(); return; }
  xrSession = await navigator.xr.requestSession('immersive-vr', {optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']});
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(xrSession);
  root.userData.desktop = {p: root.position.clone(), q: root.quaternion.clone()};
  root.position.set(-0.8, 1.0, -2.1); root.quaternion.identity();     // 1:1, broadside, centre 2.1 m ahead
  scene.background = new THREE.Color(0x5d6662);
  xrPanel = xrPanel || makePanel(); xrPanel.mesh.visible = true; xrPanel.draw();
  xrBtn.textContent = 'Выйти из VR';
  xrSession.addEventListener('end', () => {
    xrSession = null; xrBtn.textContent = 'Открыть в VR-шлеме · 1:1';
    root.position.copy(root.userData.desktop.p); root.quaternion.copy(root.userData.desktop.q);
    scene.background = new THREE.Color(0xd9ddd9); xrPanel.mesh.visible = false; resize();
  });
};
const controllers = [0, 1].map(i => {
  const c = renderer.xr.getController(i); scene.add(c);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0, 0, -1)]), new THREE.LineBasicMaterial({color: 0xffa040}));
  line.scale.z = 4; c.add(line); c.userData.line = line;
  c.addEventListener('connected', e => { c.userData.hand = e.data.handedness; if (e.data.handedness === 'left' && xrPanel) c.add(xrPanel.mesh); });
  c.addEventListener('selectstart', () => onXRSelect(c));
  c.addEventListener('squeezestart', () => { grabbing = c; c.attach(root); });
  c.addEventListener('squeezeend', () => { if (grabbing === c) { scene.attach(root); grabbing = null; } });
  return c;
});
const xrRay = new THREE.Raycaster();
function controllerRay(c) {
  const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
  xrRay.ray.origin.setFromMatrixPosition(c.matrixWorld); xrRay.ray.direction.set(0, 0, -1).applyMatrix4(m); return xrRay;
}
function onXRSelect(c) {
  const r = controllerRay(c);
  if (xrPanel?.mesh.visible) { const h = r.intersectObject(xrPanel.mesh, false)[0]; if (h) { xrPanel.click(h.uv); return; } }
  const p = pick(r); select(p);
}
function bringToHand(obj) {
  // move the whole model so the chosen part sits ~0.55 m in front of the eyes (arm's length)
  const cam = renderer.xr.getCamera(); const eye = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = V(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0; fwd.normalize();
  const b = boxOf(obj); if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3());
  root.position.add(eye.clone().add(fwd.multiplyScalar(0.55)).sub(c));
}
function xrTick() {
  if (!renderer.xr.isPresenting) return;
  controllers.forEach(c => {
    if (!c.userData.line) return;
    const r = controllerRay(c); let d = 4;
    const ph = xrPanel?.mesh.visible ? r.intersectObject(xrPanel.mesh, false)[0] : null;
    if (ph) d = ph.distance; c.userData.line.scale.z = d;
  });
  if (xrPanel && !xrPanel.mesh.parent) {   // no left controller: float the panel
    scene.add(xrPanel.mesh); xrPanel.mesh.position.set(-0.45, 1.25, -0.6); xrPanel.mesh.rotation.set(-0.2, 0.45, 0);
  }
}

// in-headset panel (canvas texture)
function makePanel() {
  const W = 1024, H = 940, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32 * H / W), new THREE.MeshBasicMaterial({map: tex, toneMapped: false, transparent: true}));
  mesh.position.set(0, 0.06, -0.12); mesh.rotation.x = -0.75;
  const systems = ['all', ...SYSTEM_ORDER.filter(k => SYSTEM_TITLES[k])];
  const buttons = [
    {t: () => state.skin ? 'Снять обшивку' : 'Вернуть обшивку', f: () => setSkin(!state.skin)},
    {t: () => 'Контур обшивки', f: () => { if (!state.skin) { state.ghost = !state.ghost; refresh(); } }, on: () => state.ghost},
    {t: () => ({none: 'Разрез: нет', long: 'Разрез: продольный', trans: 'Разрез: поперечный'})[state.section], f: () => setSection({none: 'long', long: 'trans', trans: 'none'}[state.section])},
    {t: () => 'Система: ' + (state.system === 'all' ? 'все' : SYSTEM_TITLES[state.system]), f: () => { const i = systems.indexOf(state.system); chooseSystem(systems[(i + 1) % systems.length]); }},
    {t: () => 'Подвести деталь', f: () => state.selected && bringToHand(state.selected.obj)},
    {t: () => 'Скрыть деталь', f: () => state.selected && hidePart(state.selected)},
    {t: () => 'Показать всё', f: () => { hidden.clear(); refresh(); }},
    {t: () => 'Вернуть сборку', f: () => { resetAll(); root.position.set(-0.8, 1.0, -2.1); root.quaternion.identity(); }},
    {t: () => exploded ? 'Собрать детали' : 'Разнести детали', f: () => setExploded(!exploded), on: () => exploded, ok: asmReady},
    {t: () => !anim.on ? 'Как собирается ▶' : (anim.finished ? 'Сборка: с начала' : (anim.playing ? 'Сборка: пауза' : 'Сборка: дальше')), f: () => togglePlay(), on: () => anim.on, ok: asmReady},
    {t: () => 'Следующий этап ▶▶', f: () => anim.on ? (!anim.finished && stepTo(anim.stage + 1)) : startAssembly(), ok: asmReady},
    {t: () => 'Закрыть сборку', f: () => stopAssembly(), ok: () => anim.on},
  ];
  const cell = (i) => ({x: 24 + (i % 2) * 496, y: 210 + Math.floor(i / 2) * 120, w: 480, h: 104});
  function wrap(text, x, y, maxW, lh, maxLines) {
    const words = (text || '').split(' '); let line = '', n = 0;
    for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y + n * lh); line = w; if (++n >= maxLines) return; } else line = t; }
    g.fillText(line, x, y + n * lh);
  }
  function draw() {
    g.fillStyle = 'rgba(241,243,239,0.96)'; g.fillRect(0, 0, W, H);
    const cap = captionText();
    if (cap && (!state.selected || anim.playing)) {
      g.fillStyle = '#c4562a'; g.font = '600 26px system-ui'; g.fillText(cap.step + ' · ' + cap.title, 28, 46);
      g.fillStyle = '#1d2622'; g.font = '600 32px system-ui';
      wrap(cap.part ? cap.part.title + (cap.part.to ? ' → ' + cap.part.to : '') : cap.note, 28, 92, 968, 38, 1);
      g.fillStyle = '#4b5852'; g.font = '24px system-ui'; wrap(cap.part ? (cap.part.how ? 'Как: ' + cap.part.how : cap.note) : '', 28, 138, 968, 30, 2);
    } else {
      g.fillStyle = '#c4562a'; g.font = '600 26px system-ui'; g.fillText(state.selected ? (SYSTEM_TITLES[state.selected.system] || '') : 'DeltaWing DW-R5 · 1:1', 28, 46);
      g.fillStyle = '#1d2622'; g.font = '600 36px system-ui'; wrap(state.selected ? state.selected.meta.title : 'Наведите луч и нажмите курок, чтобы выбрать деталь', 28, 92, 968, 40, 1);
      g.fillStyle = '#4b5852'; g.font = '24px system-ui'; wrap(state.selected?.meta.purpose || 'Рукоять — взять и повернуть модель. Кнопки ниже: обшивка, разрез, системы, разнос деталей и анимация сборки.', 28, 138, 968, 30, 2);
    }
    buttons.forEach((b, i) => { const c = cell(i); const on = b.on?.();
      const ok = b.ok ? b.ok() : true;
      g.fillStyle = on ? '#24533f' : '#ffffff'; g.strokeStyle = '#9fb0a6'; g.lineWidth = 3; g.beginPath(); g.roundRect(c.x, c.y, c.w, c.h, 14); g.fill(); g.stroke();
      g.fillStyle = on ? '#fff' : (ok ? '#1d2622' : '#a9b2ad'); g.font = '600 30px system-ui'; g.fillText(b.t(), c.x + 22, c.y + 62); });
    tex.needsUpdate = true;
  }
  function click(uv) { const x = uv.x * W, y = (1 - uv.y) * H; buttons.forEach((b, i) => { const c = cell(i); if (x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h && (!b.ok || b.ok())) { b.f(); draw(); } }); }
  const left = controllers.find(c => c.userData.hand === 'left'); if (left) left.add(mesh);
  return {mesh, draw, click};
}
function renderNow() { if (tween) tween(performance.now() + 1e6); controls.update(); if (state.section !== 'none') updatePlane(); renderer.render(scene, camera); }
async function snap(name, w = 2400, h = 1500) {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  renderNow();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const ok = await fetch('/save?name=' + encodeURIComponent(name), {method: 'POST', body: blob}).then(r => r.ok).catch(() => false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); resize(); renderNow();
  return ok;
}
function setCam(p, t, fov) { tween = null; camera.position.set(...p); controls.target.set(...t); if (fov) camera.fov = fov; camera.updateProjectionMatrix(); controls.update(); }
function camState() { return [camera.position.toArray(), controls.target.toArray(), camera.fov]; }
window.__dwApi = {setCam, camState, renderNow, snap, camera, controls, root, THREE, applyView, setSkin, setSection, chooseSystem, select, focusOn, hidePart, resetAll, parts, state, refresh,
  setExploded, startAssembly, stopAssembly, stepTo, togglePlay, anim, kitBox, frameBox, advance, captionText, renderer,
  byId: id => parts.find(p => p.meta.id === id)};
