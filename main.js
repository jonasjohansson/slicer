import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Pane } from 'tweakpane';
import earcut from 'earcut';
import * as Tone from 'tone';

// ---- renderer ----
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

// ---- scene ----
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0a0a');

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex;

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 0.5, 6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ---- lights ----
const ambient = new THREE.AmbientLight(0xffffff, 0.12);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(4, 6, 4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0008;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 6;
keyLight.shadow.blurSamples = 16;
const sc = keyLight.shadow.camera;
sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3;
sc.near = 0.1; sc.far = 30;
sc.updateProjectionMatrix();
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x9fb4ff, 0.6);
fillLight.position.set(-5, 2, -1);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffd8a8, 1.4);
rimLight.position.set(-2, 3, -6);
scene.add(rimLight);

// ---- backdrop: photo-studio cyclorama (curved floor → back wall) ----
function buildCycGeometry() {
  const w = 24, d = 24, h = 12;     // width along X, depth along Z, back-wall height
  const curveD = 3, curveH = 3;     // curve span in Z and Y
  const segC = 24, segX = 48;

  // profile in (z, y), from front floor edge to top of back wall
  const profile = [[d / 2, 0], [-d / 2 + curveD, 0]];
  for (let i = 1; i <= segC; i++) {
    const t = i / segC;
    profile.push([
      -d / 2 + curveD * (1 - Math.sin(t * Math.PI / 2)),
      curveH * (1 - Math.cos(t * Math.PI / 2)),
    ]);
  }
  profile.push([-d / 2, h]);

  const positions = [], indices = [];
  const Np = profile.length;
  for (let xi = 0; xi <= segX; xi++) {
    const x = (xi / segX - 0.5) * w;
    for (const [z, y] of profile) positions.push(x, y, z);
  }
  for (let xi = 0; xi < segX; xi++) {
    for (let pi = 0; pi < Np - 1; pi++) {
      const a = xi * Np + pi;
      const b = xi * Np + (pi + 1);
      const c = (xi + 1) * Np + (pi + 1);
      const dI = (xi + 1) * Np + pi;
      indices.push(a, b, c, a, c, dI);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const cycMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95, metalness: 0.0 });
const ground = new THREE.Mesh(buildCycGeometry(), cycMat);
ground.position.y = -1.05;
ground.receiveShadow = true;
scene.add(ground);

// ---- state ----
const sliceGroup = new THREE.Group();
scene.add(sliceGroup);
let baseGeometry = null;
let bbox = null;
let slices = [];
let prevDispl = [];

const params = {
  // slicing
  slices: 60,
  sliceAxis: 'y',
  fill: 'shell',
  // animation
  pattern: 'noise',
  amp: 0.55,
  speed: 0.8,
  freq: 2.0,
  axis: 'x',
  rotate: false,
  // look
  material: 'standard',
  meshColor: '#e9e6df',
  ramp: false,
  colorA: '#e9c8a3',
  colorB: '#7aa8d8',
  bgColor: '#0a0a0a',
  exposure: 1.0,
  shadows: true,
  groundY: -1.05,
  respond: true,
  respondAmt: 0.5,
  // sound
  sound: false,
  synth: 'pad',
  scale: 'pentMinor',
  root: 'A',
  octaves: 3,
  volume: -10,
  reverb: 0.45,
  filterHz: 2200,
  threshold: 0.15,
  skip: 3,
  noteDur: '8n',
  // orientation
  orient: 'y',
  spinY: 0,
  // visual gap between adjacent slices (fraction of band height, 0–0.5)
  gap: 0.04,
};

// ---- file load ----
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('drop');
const statusEl = document.getElementById('status');
function setStatus(msg, isErr = false) { statusEl.textContent = msg; statusEl.classList.toggle('err', !!isErr); }

fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

async function loadFile(file) {
  setStatus(`Loading ${file.name}…`);
  const ext = file.name.toLowerCase().split('.').pop();
  const url = URL.createObjectURL(file);
  try {
    await loadFromUrl(url, ext);
    setStatus(`Loaded ${file.name} · ${slices.length} slices`);
  } catch (err) {
    console.error(err);
    setStatus('Load failed: ' + err.message, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader);

let rawObject = null;  // last-loaded scene root, before orientation

async function loadFromUrl(url, ext) {
  let object;
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await gltfLoader.loadAsync(url);
    object = gltf.scene;
  } else if (ext === 'obj') {
    object = await new OBJLoader().loadAsync(url);
  } else if (ext === 'stl') {
    const geom = await new STLLoader().loadAsync(url);
    geom.computeVertexNormals();
    object = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  } else {
    throw new Error('Unsupported format: ' + ext);
  }
  rawObject = object;
  reorient();
}

function applyUpAxis(object, up, spinDeg = 0) {
  // tilt first to bring the model right-side-up, then spin around world Y
  const tilt = new THREE.Euler(0, 0, 0);
  if (up === 'y-down')      tilt.x = Math.PI;
  else if (up === 'z')      tilt.x = -Math.PI / 2;
  else if (up === 'z-down') tilt.x =  Math.PI / 2;
  else if (up === 'x')      tilt.z = -Math.PI / 2;
  else if (up === 'x-down') tilt.z =  Math.PI / 2;
  const qTilt = new THREE.Quaternion().setFromEuler(tilt);
  const qSpin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spinDeg * Math.PI / 180);
  object.quaternion.copy(qSpin).multiply(qTilt);
}

function reorient() {
  if (!rawObject) return;
  applyUpAxis(rawObject, params.orient, params.spinY);
  ingestModel(rawObject);
  persistOrientation();
}

function persistOrientation() {
  const name = presetState && presetState.which;
  if (name && presets[name]) {
    presets[name].up = params.orient;
    presets[name].spinY = params.spinY;
  }
}

function ingestModel(object) {
  const geoms = [];
  object.updateMatrixWorld(true);
  object.traverse(child => {
    if (child.isMesh && child.geometry) {
      let g = child.geometry.clone();
      if (g.index !== null) g = g.toNonIndexed();
      const keep = ['position', 'normal'];
      for (const name of Object.keys(g.attributes)) {
        if (!keep.includes(name)) g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(child.matrixWorld);
      geoms.push(g);
    }
  });
  if (geoms.length === 0) { setStatus('No mesh found in file.', true); return; }

  const merged = mergeGeometries(geoms);
  merged.computeBoundingBox();
  const b = merged.boundingBox;
  const size = new THREE.Vector3(); b.getSize(size);
  const center = new THREE.Vector3(); b.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 2.0 / maxDim;
  merged.translate(-center.x, -center.y, -center.z);
  merged.scale(scale, scale, scale);
  merged.computeBoundingBox();
  bbox = merged.boundingBox.clone();
  baseGeometry = merged;

  rebuildSlices();
  fitCamera();
}

function mergeGeometries(geoms) {
  let posCount = 0;
  for (const g of geoms) posCount += g.attributes.position.count;
  const positions = new Float32Array(posCount * 3);
  const normals = new Float32Array(posCount * 3);
  let p = 0;
  for (const g of geoms) {
    positions.set(g.attributes.position.array, p * 3);
    if (g.attributes.normal) normals.set(g.attributes.normal.array, p * 3);
    p += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return out;
}

// ---- slicing ----
function clearSlices() {
  for (const s of slices) {
    if (s.shell) {
      s.shell.material.dispose();
      // shell shares baseGeometry — don't dispose that
    }
    if (s.caps) {
      s.caps.material.dispose();
      s.caps.geometry.dispose();
    }
  }
  while (sliceGroup.children.length) sliceGroup.remove(sliceGroup.children[0]);
  slices = [];
  prevDispl = [];
}

function colorForSlice(norm) {
  if (!params.ramp) return new THREE.Color(params.meshColor);
  return new THREE.Color(params.colorA).lerp(new THREE.Color(params.colorB), norm);
}

function buildMaterial(colorOverride) {
  const col = colorOverride || new THREE.Color(params.meshColor);
  const mode = params.material;
  let mat;
  if (mode === 'matte') mat = new THREE.MeshLambertMaterial({ color: col });
  else if (mode === 'clay') mat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.85, metalness: 0.0, clearcoat: 0.0, sheen: 0.6, sheenRoughness: 0.9, sheenColor: 0xffffff });
  else if (mode === 'porcelain') mat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.25, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.2, transmission: 0.05, ior: 1.45 });
  else if (mode === 'metal') mat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.25, metalness: 0.95 });
  else if (mode === 'normal') mat = new THREE.MeshNormalMaterial({ flatShading: false });
  else mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.05 });
  mat.side = THREE.DoubleSide;
  mat.clipShadows = true;
  return mat;
}

function applyMaterial() {
  if (!bbox || !slices.length) return;
  const ai = slices[0].axisIndex;
  const span = bbox.max.getComponent(ai) - bbox.min.getComponent(ai);
  for (const s of slices) {
    const norm = (s.sliceCenter - bbox.min.getComponent(ai)) / span;
    const col = colorForSlice(norm);
    s.baseColor = col.clone();

    const shellMat = buildMaterial(col);
    shellMat.clippingPlanes = [s.planeMin, s.planeMax];
    s.shell.material.dispose();
    s.shell.material = shellMat;

    if (s.caps) {
      const capsMat = buildMaterial(col);
      s.caps.material.dispose();
      s.caps.material = capsMat;
    }
  }
}

function rebuildSlices() {
  if (!baseGeometry) return;
  clearSlices();

  const n = parseInt(params.slices, 10);
  const axis = params.sliceAxis;
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const min = bbox.min.getComponent(axisIndex);
  const max = bbox.max.getComponent(axisIndex);
  const span = max - min;
  const step = span / n;

  const normalVec = new THREE.Vector3();

  // shrink each band slightly so adjacent slices don't share clip planes / cap planes,
  // which avoids Z-fighting and "noisy" seams at the boundary
  const half = step * 0.5 * (1 - Math.min(0.95, Math.max(0, params.gap)));

  for (let i = 0; i < n; i++) {
    const center = min + (i + 0.5) * step;
    const a = center - half;
    const b = center + half;
    const norm = (i + 0.5) / n;
    const color = colorForSlice(norm);
    let mesh, planeMin = null, planeMax = null;

    normalVec.set(0, 0, 0).setComponent(axisIndex, 1);
    planeMin = new THREE.Plane(normalVec.clone(), -a);
    normalVec.set(0, 0, 0).setComponent(axisIndex, -1);
    planeMax = new THREE.Plane(normalVec.clone(), b);

    // shell — the original mesh clipped to this band (preserves surface detail)
    const shellMat = buildMaterial(color);
    shellMat.clippingPlanes = [planeMin, planeMax];
    const shell = new THREE.Mesh(baseGeometry, shellMat);
    shell.castShadow = true;
    shell.receiveShadow = true;

    if (params.fill === 'filled') {
      // caps — flat triangulated cross-section at top and bottom Y of band
      const capsGeom = buildCapsGeometry(baseGeometry, axisIndex, a, b);
      if (capsGeom) {
        const capsMat = buildMaterial(color);
        const caps = new THREE.Mesh(capsGeom, capsMat);
        caps.castShadow = true;
        caps.receiveShadow = true;
        const group = new THREE.Group();
        group.add(shell);
        group.add(caps);
        sliceGroup.add(group);
        mesh = group;
      } else {
        sliceGroup.add(shell);
        mesh = shell;
      }
    } else {
      sliceGroup.add(shell);
      mesh = shell;
    }

    slices.push({
      mesh, shell, caps: (mesh !== shell) ? mesh.children[1] : null,
      planeMin, planeMax,
      axisIndex,
      baseColor: color.clone(),
      energy: 0,
      sliceCenter: (a + b) * 0.5,
      sliceMin: a,
      sliceMax: b,
    });
    prevDispl.push(0);
  }
}

// ---- cross-section cap builder ----
// Returns top+bottom cap polygons at the band's Y extents. The original
// mesh surface fills the space between, so we don't generate side walls.
function buildCapsGeometry(geom, axisIndex, aAxis, bAxis) {
  const midAxis = (aAxis + bAxis) * 0.5;
  const pos = geom.attributes.position.array;
  const [uIdx, vIdx] = axisIndex === 0 ? [1, 2] : axisIndex === 1 ? [0, 2] : [0, 1];

  const segments = [];
  for (let i = 0; i < pos.length; i += 9) {
    const a = [pos[i], pos[i + 1], pos[i + 2]];
    const b = [pos[i + 3], pos[i + 4], pos[i + 5]];
    const c = [pos[i + 6], pos[i + 7], pos[i + 8]];
    const pts = [];
    const tryEdge = (p, q) => {
      const sp = p[axisIndex] - midAxis, sq = q[axisIndex] - midAxis;
      if (sp === 0 && sq === 0) return;
      if (sp * sq < 0) {
        const t = sp / (sp - sq);
        pts.push([p[uIdx] + t * (q[uIdx] - p[uIdx]), p[vIdx] + t * (q[vIdx] - p[vIdx])]);
      } else if (sp === 0) {
        pts.push([p[uIdx], p[vIdx]]);
      }
    };
    tryEdge(a, b); tryEdge(b, c); tryEdge(c, a);
    if (pts.length >= 2) segments.push([pts[0], pts[1]]);
  }
  if (segments.length === 0) return null;

  const loops = stitchLoops(segments);
  if (loops.length === 0) return null;

  const positions = [];
  const yTop = bAxis, yBot = aAxis;
  const make3 = (u, v, axisVal) => {
    const p = [0, 0, 0]; p[uIdx] = u; p[vIdx] = v; p[axisIndex] = axisVal; return p;
  };

  for (let loop of loops) {
    if (loop.length < 3) continue;
    if (signedArea(loop) < 0) loop = loop.slice().reverse();

    const flat = [];
    for (const p of loop) flat.push(p[0], p[1]);
    const tris = earcut(flat);
    if (tris.length === 0) continue;

    for (let i = 0; i < tris.length; i += 3) {
      const p0 = loop[tris[i]], p1 = loop[tris[i + 1]], p2 = loop[tris[i + 2]];
      positions.push(...make3(p0[0], p0[1], yTop), ...make3(p1[0], p1[1], yTop), ...make3(p2[0], p2[1], yTop));
    }
    for (let i = 0; i < tris.length; i += 3) {
      const p0 = loop[tris[i]], p1 = loop[tris[i + 1]], p2 = loop[tris[i + 2]];
      positions.push(...make3(p0[0], p0[1], yBot), ...make3(p2[0], p2[1], yBot), ...make3(p1[0], p1[1], yBot));
    }
    // side walls removed — the shell mesh provides the model's curving surface
  }
  if (positions.length === 0) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.computeVertexNormals();
  return g;
}

function stitchLoops(segments, eps = 1e-4) {
  const inv = 1 / eps;
  const key = (p) => `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)}`;
  const endpointToSeg = new Map();
  for (let i = 0; i < segments.length; i++) {
    for (let e = 0; e < 2; e++) {
      const k = key(segments[i][e]);
      if (!endpointToSeg.has(k)) endpointToSeg.set(k, []);
      endpointToSeg.get(k).push([i, e]);
    }
  }

  const used = new Array(segments.length).fill(false);
  const loops = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    const loop = [];
    let curIdx = start, curEnd = 0;
    let safety = segments.length + 1;
    while (safety-- > 0 && !used[curIdx]) {
      used[curIdx] = true;
      loop.push(segments[curIdx][curEnd]);
      const tip = segments[curIdx][1 - curEnd];
      const matches = endpointToSeg.get(key(tip)) || [];
      let next = null;
      for (const [si, se] of matches) if (!used[si]) { next = [si, se]; break; }
      if (!next) break;
      curIdx = next[0]; curEnd = next[1];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    a += loop[i][0] * loop[j][1] - loop[j][0] * loop[i][1];
  }
  return a * 0.5;
}

function setShadowsEnabled(on) {
  renderer.shadowMap.enabled = on;
  keyLight.castShadow = on;
  for (const s of slices) s.mesh.material.needsUpdate = true;
}

// ---- camera fit ----
function fitCamera() {
  if (!bbox) return;
  const sphere = new THREE.Sphere();
  bbox.getBoundingSphere(sphere);
  const dist = sphere.radius / Math.sin((camera.fov * Math.PI / 180) / 2);
  const dir = new THREE.Vector3(0.3, 0.15, 1).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, dist * 1.4);
  controls.target.copy(sphere.center);
  camera.near = Math.max(0.001, dist * 0.01);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  ground.position.y = bbox.min.y - 0.05;
  params.groundY = ground.position.y;
  if (paneReady) pane.refresh();
  const r = sphere.radius * 2.2;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
  sc.far = Math.max(30, dist * 8);
  sc.updateProjectionMatrix();
  controls.update();
}

// ---- audio (Tone.js) ----
const scales = {
  pentMinor: [0, 3, 5, 7, 10],
  pentMajor: [0, 2, 4, 7, 9],
  major:     [0, 2, 4, 5, 7, 9, 11],
  minor:     [0, 2, 3, 5, 7, 8, 10],
  lydian:    [0, 2, 4, 6, 7, 9, 11],
  phrygian:  [0, 1, 3, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
};
// MIDI numbers in octave 3 (so default A = A3 = 57)
const rootMidi = { C: 48, 'C#': 49, D: 50, 'D#': 51, E: 52, F: 53, 'F#': 54, G: 55, 'G#': 56, A: 57, 'A#': 58, B: 59 };

let synth = null, filter = null, reverb = null, toneStarted = false;

function buildAudio() {
  reverb = new Tone.Reverb({ decay: 5, wet: params.reverb }).toDestination();
  filter = new Tone.Filter(params.filterHz, 'lowpass').connect(reverb);

  if (params.synth === 'pluck') {
    synth = new Tone.PolySynth(Tone.PluckSynth).connect(filter);
  } else if (params.synth === 'bell') {
    synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 8, modulationIndex: 2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 1.6 },
    }).connect(filter);
  } else if (params.synth === 'marimba') {
    synth = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.6 },
    }).connect(filter);
  } else {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.06, decay: 0.4, sustain: 0.2, release: 1.5 },
    }).connect(filter);
  }
  synth.maxPolyphony = 32;
  synth.volume.value = params.volume;
}

function disposeAudio() {
  if (synth) { try { synth.releaseAll(); } catch (e) {} synth.dispose(); synth = null; }
  if (filter) { filter.dispose(); filter = null; }
  if (reverb) { reverb.dispose(); reverb = null; }
}

async function enableSound() {
  if (toneStarted) return;
  try {
    await Tone.start();
    buildAudio();
    toneStarted = true;
    // sound check — play one note so user knows audio is wired
    setTimeout(() => {
      if (!synth || !slices.length) return;
      try {
        const f = noteForSlice(Math.floor(slices.length / 2), slices.length);
        synth.triggerAttackRelease(f, '2n', undefined, 0.6);
      } catch (e) {}
    }, 200);
    setStatus('Sound on');
  } catch (err) {
    console.error('Audio init failed:', err);
    setStatus('Audio failed: ' + err.message, true);
    params.sound = false;
    if (paneReady) pane.refresh();
  }
}

function disableSound() {
  disposeAudio();
  toneStarted = false;
}

function rebuildAudio() {
  if (!toneStarted) return;
  disposeAudio();
  buildAudio();
}

function noteForSlice(i, n) {
  const scale = scales[params.scale];
  const total = scale.length * params.octaves;
  const k = Math.min(total - 1, Math.floor((i / Math.max(1, n - 1)) * total));
  const midi = rootMidi[params.root] + Math.floor(k / scale.length) * 12 + scale[k % scale.length];
  return Tone.Midi(midi).toFrequency();
}

// ---- animation ----
function smoothNoise(x) {
  return (
    Math.sin(x) +
    Math.sin(x * 2.13 + 1.7) * 0.5 +
    Math.sin(x * 4.27 + 3.1) * 0.25
  ) / 1.75;
}

const clock = new THREE.Clock();
let triggerBudget = 0; // limit concurrent triggers per frame

function tick() {
  const t = clock.getElapsedTime();
  if (params.rotate) sliceGroup.rotation.y = t * 0.2;

  triggerBudget = 4; // up to 4 new notes per frame to avoid mud

  if (slices.length) {
    const amp = params.amp, speed = params.speed, freq = params.freq;
    const pattern = params.pattern, axisMode = params.axis;
    const span = bbox.max.getComponent(slices[0].axisIndex) - bbox.min.getComponent(slices[0].axisIndex);
    const audioOn = params.sound && toneStarted && synth;
    const threshold = params.threshold;

    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const norm = (s.sliceCenter - bbox.min.getComponent(s.axisIndex)) / span;
      let offX = 0, offZ = 0, offY = 0;
      const phase = t * speed + norm * freq * Math.PI * 2;

      if (pattern === 'sine') {
        offX = Math.sin(phase) * amp;
        offZ = Math.cos(phase * 0.7) * amp;
      } else if (pattern === 'noise') {
        offX = smoothNoise(phase) * amp;
        offZ = smoothNoise(phase + 11.3) * amp;
      } else if (pattern === 'jitter') {
        const seed = Math.floor(t * speed * 4 + i * 7);
        offX = ((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 2 * amp;
        offZ = ((Math.sin(seed * 78.233) * 12345.678) % 1) * 2 * amp;
      } else if (pattern === 'cascade') {
        const wave = Math.sin(phase) * 0.5 + 0.5;
        offX = (norm - 0.5) * 2 * amp * wave;
        offZ = Math.sin(phase * 1.3) * amp * 0.4;
      } else if (pattern === 'explode') {
        const k = (Math.sin(t * speed) * 0.5 + 0.5);
        offY = (norm - 0.5) * amp * k * 2;
        offX = smoothNoise(phase) * amp * 0.3;
      }

      if (axisMode === 'z') { offZ = offX; offX = 0; }
      else if (axisMode === 'x') { offZ = (pattern === 'noise' || pattern === 'sine') ? offZ * 0.4 : 0; }

      s.mesh.position.set(offX, offY, offZ);

      // rising-edge peak detection — drives both audio + visual response
      const displ = Math.abs(offX) + Math.abs(offZ) + Math.abs(offY);
      const peaked = (i % params.skip === 0) && displ > threshold && prevDispl[i] <= threshold;
      if (peaked) {
        s.energy = 1;
        if (audioOn && triggerBudget > 0) {
          const freq = noteForSlice(i, slices.length);
          const vel = Math.min(1, 0.3 + displ * 0.5);
          try { synth.triggerAttackRelease(freq, params.noteDur, undefined, vel); } catch (e) {}
          triggerBudget--;
        }
      }
      prevDispl[i] = displ;

      // decay + apply visual response (scale pop + emissive glow)
      if (params.respond) {
        s.energy *= 0.9;
        const k = 1 + s.energy * 0.05 * params.respondAmt * 2;
        s.mesh.scale.set(k, k, k);
        if (s.baseColor) {
          const glow = s.energy * params.respondAmt;
          if (s.shell && s.shell.material.emissive) s.shell.material.emissive.copy(s.baseColor).multiplyScalar(glow);
          if (s.caps && s.caps.material.emissive)  s.caps.material.emissive.copy(s.baseColor).multiplyScalar(glow);
        }
      } else if (s.mesh.scale.x !== 1) {
        s.mesh.scale.set(1, 1, 1);
        if (s.shell && s.shell.material.emissive) s.shell.material.emissive.setScalar(0);
        if (s.caps && s.caps.material.emissive)  s.caps.material.emissive.setScalar(0);
      }
    }
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let paneReady = false;

// ---- placeholder ----
function placeholder() {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * (0.7 + 0.3 * Math.sin(y * 2.0)));
    pos.setY(i, y * 1.5);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  baseGeometry = g;
  bbox = g.boundingBox.clone();
  rebuildSlices();
  fitCamera();
}

// ---- presets ----
// up: 'y' (default), 'y-down' (flip), 'z' (Z-up scan), 'z-down', 'x', 'x-down'
const presets = {
  'Head (Lee Perry-Smith)': { url: 'models/lee-perry-smith.glb', ext: 'glb', up: 'y' },
  'Sleeping Venus':         { url: 'models/sleeping-venus.glb',  ext: 'glb', up: 'z' },
};

async function loadPreset(name) {
  const p = presets[name];
  if (!p) return;
  setStatus(`Loading ${name}…`);
  try {
    params.orient = p.up || 'y';
    params.spinY = p.spinY || 0;
    if (paneReady) pane.refresh();
    await loadFromUrl(p.url, p.ext);
    setStatus(`Loaded ${name} · ${slices.length} slices`);
  } catch (err) {
    console.error(err);
    setStatus('Preset load failed: ' + err.message, true);
  }
}

// ---- tweakpane UI ----
const pane = new Pane({ title: 'Slicer', expanded: true });
paneReady = true;

const fSlice = pane.addFolder({ title: 'Slicing' });
fSlice.addBinding(params, 'slices', { min: 2, max: 200, step: 1 }).on('change', rebuildSlices);
fSlice.addBinding(params, 'sliceAxis', { options: { Y_horizontal: 'y', X_vertical: 'x', Z_depth: 'z' } }).on('change', rebuildSlices);
fSlice.addBinding(params, 'fill', { options: { Shell: 'shell', Filled: 'filled' } }).on('change', rebuildSlices);
fSlice.addBinding(params, 'gap', { label: 'gap', min: 0, max: 0.6, step: 0.005 }).on('change', rebuildSlices);
fSlice.addBinding(params, 'orient', {
  label: 'up axis',
  options: { 'Y up': 'y', 'Y down': 'y-down', 'Z up': 'z', 'Z down': 'z-down', 'X up': 'x', 'X down': 'x-down' },
}).on('change', reorient);
fSlice.addBinding(params, 'spinY', { label: 'spin Y°', min: -180, max: 180, step: 1 }).on('change', reorient);

const fAnim = pane.addFolder({ title: 'Animation' });
fAnim.addBinding(params, 'pattern', { options: { Sine: 'sine', Noise: 'noise', Jitter: 'jitter', Cascade: 'cascade', 'Explode Y': 'explode' } });
fAnim.addBinding(params, 'amp', { label: 'amplitude', min: 0, max: 3, step: 0.01 });
fAnim.addBinding(params, 'speed', { min: 0, max: 3, step: 0.01 });
fAnim.addBinding(params, 'freq', { label: 'frequency', min: 0.1, max: 10, step: 0.01 });
fAnim.addBinding(params, 'axis', { label: 'displace', options: { X: 'x', Z: 'z', 'X + Z': 'xz' } });
fAnim.addBinding(params, 'rotate', { label: 'auto-rotate' });

const fLook = pane.addFolder({ title: 'Look' });
fLook.addBinding(params, 'material', { options: { Standard: 'standard', Matte: 'matte', Clay: 'clay', Porcelain: 'porcelain', Metal: 'metal', Normals: 'normal' } }).on('change', applyMaterial);
fLook.addBinding(params, 'meshColor', { label: 'model' }).on('change', applyMaterial);
fLook.addBinding(params, 'ramp', { label: 'color ramp' }).on('change', applyMaterial);
fLook.addBinding(params, 'colorA', { label: '↳ low' }).on('change', applyMaterial);
fLook.addBinding(params, 'colorB', { label: '↳ high' }).on('change', applyMaterial);
fLook.addBinding(params, 'respond', { label: 'react to triggers' });
fLook.addBinding(params, 'respondAmt', { label: '↳ amount', min: 0, max: 1, step: 0.01 });
fLook.addBinding(params, 'bgColor', { label: 'background' }).on('change', () => {
  scene.background = new THREE.Color(params.bgColor);
  cycMat.color.set(params.bgColor);
});
fLook.addBinding(params, 'exposure', { min: 0.2, max: 2.5, step: 0.01 }).on('change', () => renderer.toneMappingExposure = params.exposure);
fLook.addBinding(params, 'shadows').on('change', () => setShadowsEnabled(params.shadows));
fLook.addBinding(params, 'groundY', { label: 'ground Y', min: -3, max: 1, step: 0.01 }).on('change', () => ground.position.y = params.groundY);

const fSound = pane.addFolder({ title: 'Sound', expanded: false });
fSound.addBinding(params, 'sound', { label: 'enable' }).on('change', async (ev) => {
  if (ev.value) await enableSound(); else disableSound();
});
fSound.addBinding(params, 'synth', { options: { Pad: 'pad', Pluck: 'pluck', Bell: 'bell', Marimba: 'marimba' } }).on('change', rebuildAudio);
fSound.addBinding(params, 'scale', { options: { 'Penta minor': 'pentMinor', 'Penta major': 'pentMajor', Major: 'major', Minor: 'minor', Lydian: 'lydian', Phrygian: 'phrygian', 'Whole tone': 'wholeTone' } });
fSound.addBinding(params, 'root', { options: Object.fromEntries(Object.keys(rootMidi).map(k => [k, k])) });
fSound.addBinding(params, 'octaves', { min: 1, max: 5, step: 1 });
fSound.addBinding(params, 'volume', { label: 'volume dB', min: -40, max: 0, step: 1 }).on('change', () => { if (synth) synth.volume.value = params.volume; });
fSound.addBinding(params, 'reverb', { min: 0, max: 1, step: 0.01 }).on('change', () => { if (reverb) reverb.wet.value = params.reverb; });
fSound.addBinding(params, 'filterHz', { label: 'filter Hz', min: 200, max: 8000, step: 10 }).on('change', () => { if (filter) filter.frequency.rampTo(params.filterHz, 0.1); });
fSound.addBinding(params, 'threshold', { min: 0.01, max: 2, step: 0.01 });
fSound.addBinding(params, 'skip', { label: 'every Nth slice', min: 1, max: 10, step: 1 });
fSound.addBinding(params, 'noteDur', { label: 'note', options: { '64n': '64n', '32n': '32n', '16n': '16n', '8n': '8n', '4n': '4n' } });

pane.addButton({ title: 'Reset view' }).on('click', fitCamera);
pane.addButton({ title: 'Screenshot' }).on('click', screenshot);
pane.addButton({ title: 'Copy permalink' }).on('click', copyPermalink);

// ---- permalink + screenshot ----
function screenshot() {
  renderer.render(scene, camera);  // ensure latest frame
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slicer-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Screenshot saved');
  }, 'image/png');
}

function encodeParams() {
  const o = { ...params };
  delete o.sound;            // don't autoplay on open
  return btoa(JSON.stringify(o)).replace(/=+$/, '');
}

function decodeParams(hash) {
  try {
    const s = atob(hash.replace(/^#/, '') + '==='.slice(0, (4 - hash.length % 4) % 4));
    return JSON.parse(s);
  } catch (e) { return null; }
}

function applyParamsFromHash() {
  if (!location.hash || location.hash.length < 4) return false;
  const o = decodeParams(location.hash);
  if (!o) return false;
  for (const k of Object.keys(o)) if (k in params) params[k] = o[k];
  return true;
}

function copyPermalink() {
  const hash = '#' + encodeParams();
  const url = location.origin + location.pathname + hash;
  navigator.clipboard.writeText(url).then(
    () => setStatus('Permalink copied'),
    () => setStatus('Copy failed — ' + url.slice(0, 60) + '…', true),
  );
  history.replaceState(null, '', hash);
}

// presets folder (load on selection — no separate Load button)
const presetNames = Object.keys(presets);
const DEFAULT_PRESET = 'Head (Lee Perry-Smith)';
const presetState = { which: DEFAULT_PRESET };
const fPresets = pane.addFolder({ title: 'Presets', expanded: true });
fPresets.addBinding(presetState, 'which', {
  label: 'model',
  options: Object.fromEntries(presetNames.map(k => [k, k])),
}).on('change', (ev) => loadPreset(ev.value));

// apply permalink params (if any) before loading the default model
const hadHash = applyParamsFromHash();
if (hadHash) {
  pane.refresh();
  scene.background = new THREE.Color(params.bgColor);
  cycMat.color.set(params.bgColor);
  renderer.toneMappingExposure = params.exposure;
  setShadowsEnabled(params.shadows);
}

// default model on startup — fall back to placeholder if it fails
loadPreset(DEFAULT_PRESET).catch(() => placeholder());
