// DeltaWing DW-R5 inspection viewer (three.js r170, WebXR).
// Scene units: metres, 1:1.  glTF axes: x = CAD X (aft), y = CAD Z (up), z = −CAD Y.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const MODEL = new URLSearchParams(location.search).get('model') || 'DW-R5-11210128.glb';
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
  buildUI(); applyView('hero', false); refresh();
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
  exterior.traverse(o => { if (o.isMesh) o.material = state.ghost && !state.skin ? o.userData.ghostMat : o.userData.solidMat; });
  exterior.visible = state.skin || state.ghost || state.system === 'exterior';
  // rev S3: the interior is always drawn. With the skin on, the bridle lug clevises, the hook pin in its pocket, the launch
  // shoe, the pitot and every bay opened by hiding its cover are seen from outside
  const interiorNeeded = true;
  parts.forEach(p => {
    const sysOK = state.system === 'all' || p.system === state.system || (state.system === 'engine' && !!p.meta.mountedOnEngine);
    // the engine and propeller protrude through the supplied outer surface: always drawn
    const external = p.system === 'engine' || !!p.meta.mountedOnEngine;
    p.obj.visible = Boolean(!hidden.has(p) && sysOK && (p.system === 'exterior' || external ? true : interiorNeeded));
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
  hidden.clear(); select(null); state.system = 'all'; state.ghost = false; state.skin = true;
  setSection('none'); renderList(); refresh(); applyView('hero');
}

// ------------------------------------------------------------------ resize / loop
function resize() {
  if (renderer.xr.isPresenting) return;
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
renderer.setAnimationLoop(now => {
  if (tween) tween(now);
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
  const c = boxOf(obj).getCenter(new THREE.Vector3());
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
  const W = 1024, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.225), new THREE.MeshBasicMaterial({map: tex, toneMapped: false, transparent: true}));
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
  ];
  const cell = (i) => ({x: 24 + (i % 2) * 496, y: 210 + Math.floor(i / 2) * 120, w: 480, h: 104});
  function wrap(text, x, y, maxW, lh, maxLines) {
    const words = (text || '').split(' '); let line = '', n = 0;
    for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y + n * lh); line = w; if (++n >= maxLines) return; } else line = t; }
    g.fillText(line, x, y + n * lh);
  }
  function draw() {
    g.fillStyle = 'rgba(241,243,239,0.96)'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c4562a'; g.font = '600 26px system-ui'; g.fillText(state.selected ? (SYSTEM_TITLES[state.selected.system] || '') : 'DeltaWing DW-R4 · 1:1', 28, 46);
    g.fillStyle = '#1d2622'; g.font = '600 36px system-ui'; wrap(state.selected ? state.selected.meta.title : 'Наведите луч и нажмите курок, чтобы выбрать деталь', 28, 92, 968, 40, 1);
    g.fillStyle = '#4b5852'; g.font = '24px system-ui'; wrap(state.selected?.meta.purpose || 'Рукоять — взять и повернуть модель. Кнопки ниже управляют обшивкой, разрезом и системами.', 28, 138, 968, 30, 2);
    buttons.forEach((b, i) => { const c = cell(i); const on = b.on?.();
      g.fillStyle = on ? '#24533f' : '#ffffff'; g.strokeStyle = '#9fb0a6'; g.lineWidth = 3; g.beginPath(); g.roundRect(c.x, c.y, c.w, c.h, 14); g.fill(); g.stroke();
      g.fillStyle = on ? '#fff' : '#1d2622'; g.font = '600 30px system-ui'; g.fillText(b.t(), c.x + 22, c.y + 62); });
    tex.needsUpdate = true;
  }
  function click(uv) { const x = uv.x * W, y = (1 - uv.y) * H; buttons.forEach((b, i) => { const c = cell(i); if (x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h) { b.f(); draw(); } }); }
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
  byId: id => parts.find(p => p.meta.id === id)};
