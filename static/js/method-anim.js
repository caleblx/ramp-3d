// "How RAMP-3D works": a scripted WebGL walkthrough built from one real multi-view capture.
// cameras -> RGB-D -> back-projection to a point cloud -> per-point pickup / putdown
// probabilities -> top-5 candidates -> thresholded masks -> action.
// Everything is a pure function of the timeline time t, so chapters can seek.
import * as THREE from "./vendor/three.module.min.js";

const root = document.getElementById("method-anim");
const BASE = "static/method/";

// ---------------------------------------------------------------- timeline (seconds)
const W = {
  rig: [0.3, 2.5],     // ring draws itself, cameras snap in along it
  capture: [2.5, 3.7], // shutter sweep around the ring
  focus: [3.7, 7.6],   // one camera: its colour image, then its depth map, in a card
  fly: [7.6, 12.8],    // that camera's pixels back-project first, then the other 29
  goal: [13.0, 14.0],  // goal appears
  heatP: [13.8, 16.0], // pickup probability sweeps over the cloud
  cand: [16.0, 17.0],  // top-5 candidates labelled
  thrP: [17.0, 18.8],  // threshold rises -> pickup mask
  heatD: [19.2, 21.0], // putdown probabilities
  thrD: [21.0, 22.6],  // threshold -> putdown mask
  arc: [23.0, 24.3],   // pickup -> putdown line
  end: 27.6,
};
const CHAPTERS = [
  { t: 0, title: "RGB-D views", text: "30 calibrated cameras on a ring around the scene record color and depth." },
  { t: W.fly[0], title: "Point cloud", text: "Each pixel is back-projected using its depth and camera pose, and the 30 views are merged into one point cloud." },
  { t: W.goal[0], title: "Per-point scores", text: "Given the goal, the mask decoder predicts for every point the probability that it belongs to the box to pick up." },
  { t: W.cand[0], title: "Pickup mask", text: "The 5 highest-scoring pickup candidates are kept. Thresholding the selected one gives the pickup mask." },
  { t: W.heatD[0], title: "Putdown mask", text: "A second mask, paired with the first, gives the putdown region. In this step it is a free cell on a pallet." },
  { t: W.arc[0], title: "Action", text: "The two masks are converted to a pick-and-place action. After it is executed, the scene is observed again for the next step." },
];

const clamp01 = x => Math.min(1, Math.max(0, x));
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const easeOut = x => 1 - Math.pow(1 - clamp01(x), 3);
const prog = (t, [a, b]) => clamp01((t - a) / (b - a));

// ---------------------------------------------------------------- DOM
const stage = root.querySelector(".mx-stage");
const canvas = root.querySelector("canvas");
const $ = s => root.querySelector(s);
const kickerEl = $(".mx-kicker"), titleEl = $(".mx-title"), textEl = $(".mx-text"), capEl = $(".mx-caption");
const goalEl = $(".mx-goal"), goalText = $(".mx-goal span"), legend = $(".mx-legend"), legendName = $(".mx-legend b");
const labelsEl = $(".mx-labels"), playBtn = $(".mx-play"), chaptersEl = $(".mx-chapters");
const card = $(".mx-view"), cardDepth = $(".mx-view .d"), cardTag = $(".mx-view-tag b"), cardNum = $(".mx-view-tag span");

const chapterBtns = CHAPTERS.map((c, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = `<span class="mx-bar"><i></i></span><span class="mx-num">${String(i + 1).padStart(2, "0")}</span>${c.title}`;
  b.addEventListener("click", () => { seek(c.t + 0.001); play(); });
  chaptersEl.appendChild(b);
  return b;
});
const chapterBars = chapterBtns.map(b => b.querySelector(".mx-bar i"));

// ---------------------------------------------------------------- three.js setup
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
} catch (e) {
  root.classList.add("failed");     // no WebGL: the poster image stays
  throw e;
}
renderer.setClearColor(0x0b0d10, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 100);
camera.up.set(0, 0, 1);

const grid = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, uniforms: { uOpacity: { value: 1 } },
  vertexShader: `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec2 vP; uniform float uOpacity;
    void main() {
      vec2 q = vP / 0.5, g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
      float line = 1.0 - min(min(g.x, g.y), 1.0);
      float fade = 1.0 - smoothstep(2.5, 7.5, length(vP));
      gl_FragColor = vec4(0.62, 0.68, 0.80, line * 0.16 * fade * uOpacity);
    }`,
}));
scene.add(grid);

let pts = null, frusta = [], arc = null, info = null, ring = null, focus = 0, camMats = [];
const PLANE = 0.42;
const labels = [];

function label(cls, html) {
  const el = document.createElement("span");
  el.className = `mx-pill ${cls}`;
  el.innerHTML = html;
  labelsEl.appendChild(el);
  const l = { el, pos: new THREE.Vector3(), shown: 0 };
  labels.push(l);
  return l;
}

const POINT_VS = /* glsl */`
  attribute vec3 aStart; attribute vec3 aRGB; attribute vec4 aData; // cam/30, pPick, pPut, kind
  attribute float aRand;
  uniform float uFocus;
  uniform float uFly, uScale, uWaveP, uHeatP, uThrP, uThrOnP, uWaveD, uHeatD, uThrD, uThrOnD, uFinal, uMove, uLift;
  uniform vec3 uMoveBy;
  varying vec3 vColor; varying float vGlow; varying float vFloor;
  vec3 rampP(float p) {
    p = pow(p, 1.35);
    vec3 a = vec3(0.010, 0.013, 0.024), b = vec3(0.035, 0.16, 0.78), c = vec3(0.55, 0.82, 1.0);
    return p < 0.55 ? mix(a, b, p / 0.55) : mix(b, c, (p - 0.55) / 0.45);
  }
  vec3 rampD(float p) {
    p = pow(p, 1.35);
    vec3 a = vec3(0.010, 0.018, 0.015), b = vec3(0.03, 0.50, 0.17), c = vec3(0.60, 1.0, 0.68);
    return p < 0.55 ? mix(a, b, p / 0.55) : mix(b, c, (p - 0.55) / 0.45);
  }
  void main() {
    float cam = aData.x, pp = aData.y, pd = aData.z, kind = aData.w;
    float isPick = step(5.5, kind) * step(kind, 6.5), isPut = step(6.5, kind);
    // fly out of the source camera's image plane: the featured camera first, then the rest of the ring
    float rd = abs(cam - uFocus); rd = min(rd, 1.0 - rd) * 2.0;
    float d = rd < 0.01 ? aRand * 0.14 : 0.48 + rd * 0.5 + aRand * 0.15;
    float f = clamp((uFly - d) / 0.3, 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    vec3 pos = mix(aStart, position, f);
    pos.z += sin(f * 3.14159) * 0.35 * (0.5 + aRand);
    // the picked box teleports to its putdown cell
    float m = isPick * uMove;
    pos += uMoveBy * step(0.5, m);
    float pop = isPick * (1.0 - abs(uMove * 2.0 - 1.0));     // shrink -> grow around the jump
    vec3 rgb = aRGB;
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    vec3 dimc = vec3(0.012, 0.015, 0.022) + lum * 0.07;
    float r = length(position.xy);
    float wP = clamp((uWaveP * 9.5 - r) / 1.2, 0.0, 1.0);
    float wD = clamp((uWaveD * 9.5 - r) / 1.2, 0.0, 1.0);
    vec3 c = mix(rgb, rampP(pp), uHeatP * wP);
    float keepP = smoothstep(uThrP - 0.04, uThrP + 0.02, pp);
    c = mix(c, mix(dimc, c, keepP), uThrOnP);
    vec3 pickCol = vec3(0.42, 0.72, 1.0);
    // putdown stage: the pickup mask stays lit, everything else shows p(putdown)
    vec3 cd = mix(c, rampD(pd), uHeatD * wD);
    float keepD = smoothstep(uThrD - 0.04, uThrD + 0.02, pd);
    cd = mix(cd, mix(dimc, cd, keepD), uThrOnD);
    c = mix(cd, mix(cd, pickCol, uHeatD), isPick);
    // final: back to colour, masks tinted
    vec3 fin = rgb * 0.8 + vec3(0.01);
    fin = mix(fin, mix(rgb, vec3(0.05, 0.30, 1.0), 0.62) + 0.015, isPick);
    fin = mix(fin, mix(rgb, vec3(0.04, 0.80, 0.26), 0.66) + 0.015, isPut);
    c = mix(c, fin, uFinal);
    vColor = c;
    vGlow = max(isPick * max(uThrOnP, uFinal), isPut * max(uThrOnD, uFinal));
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    float size = (kind < 0.5 ? 0.068 : 0.034) * (1.0 + 0.3 * vGlow);
    vFloor = kind < 0.5 ? 1.0 : 0.0;
    size *= f * (1.0 - pop);
    gl_PointSize = max(size * uScale / -mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
    // not launched yet: drop it (a 0-size point is still drawn as 1 px by most GPUs)
    if (f <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`;
const POINT_FS = /* glsl */`
  varying vec3 vColor; varying float vGlow; varying float vFloor;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = dot(q, q);
    if (d > 0.25) discard;
    float shade = 1.0 - d * 0.5 * (1.0 - vFloor);   // floor flat, objects slightly rounded
    gl_FragColor = vec4(vColor * shade, 1.0);
    #include <colorspace_fragment>
  }`;

const FRUSTUM_FS = /* glsl */`
  uniform sampler2D uRGB, uDepth; uniform float uMix, uOpacity, uFlash; varying vec2 vUv;
  void main() {
    vec3 c = mix(texture2D(uRGB, vUv).rgb, texture2D(uDepth, vUv).rgb, uMix);
    c = mix(c, vec3(1.0), uFlash * 0.75);
    gl_FragColor = vec4(c, uOpacity);
    #include <colorspace_fragment>
  }`;
const FRUSTUM_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

async function load() {
  const [sc, buf] = await Promise.all([
    fetch(BASE + "scene.json").then(r => r.json()),
    fetch(BASE + "points.bin").then(r => r.arrayBuffer()),
  ]);
  info = sc;
  const texLoader = new THREE.TextureLoader();
  const [rgbTex, depthTex] = await Promise.all([BASE + "views.jpg", BASE + "depth.jpg"].map(u => texLoader.loadAsync(u)));
  for (const t of [rgbTex, depthTex]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; }

  // cameras / frustums. The image sits on the side facing the camera's own centre, so it is
  // readable (not mirrored) only from behind the camera: draw it front-side only.
  const { cols, rows } = sc.atlas;
  camMats = sc.cameras.map(c => new THREE.Matrix4().set(...c.m));
  sc.cameras.forEach((c, i) => {
    const h = 2 * PLANE * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2), w = h * c.aspect;
    const outer = new THREE.Group();
    outer.matrixAutoUpdate = false; outer.matrix.copy(camMats[i]);
    const g = new THREE.Group(); outer.add(g);
    const plane = new THREE.PlaneGeometry(w, h);
    const uv = plane.attributes.uv, col = i % cols, row = Math.floor(i / cols);
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (col + uv.getX(k)) / cols, 1 - (row + 1 - uv.getY(k)) / rows);
    const qm = new THREE.ShaderMaterial({
      uniforms: { uRGB: { value: rgbTex }, uDepth: { value: depthTex }, uMix: { value: 0 }, uOpacity: { value: 1 }, uFlash: { value: 0 } },
      vertexShader: FRUSTUM_VS, fragmentShader: FRUSTUM_FS, transparent: true, side: THREE.FrontSide, depthWrite: false,
    });
    const quad = new THREE.Mesh(plane, qm); quad.position.z = -PLANE; g.add(quad);
    const lm = new THREE.LineBasicMaterial({ color: 0xe6ebf5, transparent: true, opacity: 0.5, depthWrite: false });
    const x = w / 2, y = h / 2, z = -PLANE;
    const lv = [0, 0, 0, x, y, z, 0, 0, 0, -x, y, z, 0, 0, 0, x, -y, z, 0, 0, 0, -x, -y, z,
      x, y, z, -x, y, z, -x, y, z, -x, -y, z, -x, -y, z, x, -y, z, x, -y, z, x, y, z];
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(lv, 3));
    g.add(new THREE.LineSegments(lg, lm));
    scene.add(outer);
    frusta.push({ g, w, h, qm, lm });
  });

  // the ring the cameras sit on, drawn progressively
  const R = sc.cameras.reduce((a, c) => a + Math.hypot(c.m[3], c.m[7]), 0) / sc.cameras.length;
  const Z = sc.cameras.reduce((a, c) => a + c.m[11], 0) / sc.cameras.length;
  const a0 = Math.atan2(sc.cameras[0].m[7], sc.cameras[0].m[3]);
  const a1 = Math.atan2(sc.cameras[1].m[7], sc.cameras[1].m[3]);
  const dir = Math.sign(Math.sin(a1 - a0)) || 1;
  const rp = [];
  for (let k = 0; k <= 256; k++) { const a = a0 + dir * 2 * Math.PI * k / 256; rp.push(R * Math.cos(a), R * Math.sin(a), Z); }
  const rg = new THREE.BufferGeometry(); rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
  ring = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
  scene.add(ring);

  // the camera shown up close: the one looking most along our view direction (image reads naturally)
  camera.aspect = Math.max(0.5, stage.clientWidth / Math.max(1, stage.clientHeight));
  camAt((W.focus[0] + W.focus[1]) / 2);
  const vd = camera.getWorldDirection(new THREE.Vector3());
  let best = -2;
  sc.cameras.forEach((c, i) => {
    const d = -(c.m[2] * vd.x + c.m[6] * vd.y + c.m[10] * vd.z);
    if (d > best) { best = d; focus = i; }
  });
  const col = focus % cols, row = Math.floor(focus / cols);
  const bp = `${(100 * col / (cols - 1)).toFixed(4)}% ${(100 * row / (rows - 1 || 1)).toFixed(4)}%`;
  card.querySelectorAll("i").forEach((el, k) => {
    el.style.backgroundImage = `url(${BASE}${k ? "depth" : "views"}.jpg)`;
    el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
    el.style.backgroundPosition = bp;
  });
  cardNum.textContent = `View ${focus + 1} of ${sc.cameras.length}`;
  // accent outline around the featured camera's image
  { const f = frusta[focus], x = f.w / 2 * 1.1, y = f.h / 2 * 1.1;
    const hg = new THREE.BufferGeometry().setFromPoints([[x, y], [-x, y], [-x, -y], [x, -y]].map(([a, b]) => new THREE.Vector3(a, b, -PLANE)));
    f.hl = new THREE.LineLoop(hg, new THREE.LineBasicMaterial({ color: 0x4d9bff, transparent: true, opacity: 0, depthWrite: false }));
    f.g.add(f.hl); }

  // points
  const n = sc.count, S = sc.stride, dv = new DataView(buf);
  const pos = new Float32Array(n * 3), start = new Float32Array(n * 3), rgb = new Float32Array(n * 3);
  const data = new Float32Array(n * 4), rnd = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0, o = 0; i < n; i++, o += S) {
    pos[i * 3] = dv.getInt16(o, true) / 1000; pos[i * 3 + 1] = dv.getInt16(o + 2, true) / 1000; pos[i * 3 + 2] = dv.getInt16(o + 4, true) / 1000;
    rgb[i * 3] = dv.getUint8(o + 6) / 255; rgb[i * 3 + 1] = dv.getUint8(o + 7) / 255; rgb[i * 3 + 2] = dv.getUint8(o + 8) / 255;
    const cam = dv.getUint8(o + 9), u = dv.getUint16(o + 10, true) / 65535, vv = dv.getUint16(o + 12, true) / 65535;
    data[i * 4] = cam / sc.cameras.length; data[i * 4 + 1] = dv.getUint8(o + 14) / 255; data[i * 4 + 2] = dv.getUint8(o + 15) / 255;
    data[i * 4 + 3] = dv.getUint8(o + 16);
    const f = frusta[cam];
    v.set((u - 0.5) * f.w, (0.5 - vv) * f.h, -PLANE).applyMatrix4(camMats[cam]);
    start[i * 3] = v.x; start[i * 3 + 1] = v.y; start[i * 3 + 2] = v.z;
    rnd[i] = Math.random();
  }
  // point colours arrive in sRGB; the shader works in linear and converts on output
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.pow(rgb[i], 2.2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aStart", new THREE.BufferAttribute(start, 3));
  geo.setAttribute("aRGB", new THREE.BufferAttribute(rgb, 3));
  geo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rnd, 1));
  const U = {};
  for (const k of ["uFly", "uScale", "uWaveP", "uHeatP", "uThrP", "uThrOnP", "uWaveD", "uHeatD", "uThrD", "uThrOnD", "uFinal", "uMove", "uLift"]) U[k] = { value: 0 };
  U.uMoveBy = { value: new THREE.Vector3(...sc.move_by) };
  U.uFocus = { value: focus / sc.cameras.length };
  pts = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: U, vertexShader: POINT_VS, fragmentShader: POINT_FS }));
  pts.frustumCulled = false;
  scene.add(pts);

  // pickup -> putdown arc (tube drawn progressively)
  const a = new THREE.Vector3(...sc.pick.top), b = new THREE.Vector3(...sc.put.top);
  const mid = a.clone().lerp(b, 0.5); mid.z += Math.max(0.9, a.distanceTo(b) * 0.35);
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  const tube = new THREE.TubeGeometry(curve, 96, 0.03, 10, false);
  const tc = new Float32Array(tube.attributes.position.count * 3), ca = new THREE.Color(0x5aa2ff), cb = new THREE.Color(0x3ddc84);
  for (let i = 0; i < tube.attributes.position.count; i++) {
    const s = Math.floor(i / 11) / 96, c = ca.clone().lerp(cb, s);
    tc[i * 3] = c.r; tc[i * 3 + 1] = c.g; tc[i * 3 + 2] = c.b;
  }
  tube.setAttribute("color", new THREE.BufferAttribute(tc, 3));
  arc = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true }));
  arc.userData.total = tube.index.count;
  scene.add(arc);

  // labels
  sc.candidates.forEach((c, i) => {
    const l = label("mx-cand", `<i></i>${c.p.toFixed(2)}`);
    l.pos.set(c.center[0], c.center[1], c.center[2] + 0.42); l.p = c.p; l.best = i === 0;
  });
  labels.pick = label("mx-pick", "<i></i>Pickup");
  labels.pick.pos.set(...sc.pick.top).add(new THREE.Vector3(0, 0, 0.42));
  labels.put = label("mx-put", "<i></i>Putdown");
  labels.put.pos.set(...sc.put.top).add(new THREE.Vector3(0, 0, 0.42));
  goalText.textContent = sc.goal;
}

// ---------------------------------------------------------------- camera path
// [time, azimuth deg, elevation deg, distance, target x, y, z]
const KEYS = [
  [0.0, 200, 52, 24.0, 0.0, 0.0, 3.3],
  [W.focus[0], 208, 50, 25.0, 0.0, 0.0, 3.0],
  [W.fly[0], 220, 47, 20.0, 0.0, 0.1, 1.8],
  [W.fly[1], 248, 50, 14.0, 0.4, 0.6, 0.0],
  [W.cand[0], 262, 54, 12.8, 0.3, 0.5, 0.0],
  [W.heatD[1], 272, 54, 12.8, 0.5, 0.6, 0.0],
  [W.arc[1], 282, 50, 12.6, 0.4, 0.5, 0.0],
  [W.end, 290, 48, 13.0, 0.3, 0.5, 0.0],
];
function camAt(t) {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1][0]) i++;
  const k0 = KEYS[Math.max(0, i - 1)], k1 = KEYS[i], k2 = KEYS[i + 1], k3 = KEYS[Math.min(KEYS.length - 1, i + 2)];
  const s = clamp01((t - k1[0]) / (k2[0] - k1[0]));
  const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
  const q = [1, 2, 3, 4, 5, 6].map(j => cr(k0[j], k1[j], k2[j], k3[j]));
  const az = THREE.MathUtils.degToRad(q[0]), el = THREE.MathUtils.degToRad(q[1]);
  q[2] *= camera.aspect < 1.2 ? 1.45 : 1;          // portrait (phones): pull back to keep the layout in frame
  camera.position.set(q[3] + q[2] * Math.cos(el) * Math.cos(az), q[4] + q[2] * Math.cos(el) * Math.sin(az), q[5] + q[2] * Math.sin(el));
  camera.lookAt(q[3], q[4], q[5]);
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------- state at time t
let lastChapter = -1;
const tmp = new THREE.Vector3();
function apply(t) {
  camAt(t);
  // while the view card is up, slide the scene left to make room for it
  const k = ease(prog(t, [W.focus[0] + 0.1, W.focus[0] + 0.9])) * (1 - ease(prog(t, [W.fly[0] - 0.5, W.fly[0] + 0.3])));
  const sw = stage.clientWidth, sh = stage.clientHeight, portrait = sw / sh < 1.2;
  if (k > 0 && !portrait) camera.setViewOffset(sw, sh, 0.15 * sw * k, 0, sw, sh); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  const U = pts.material.uniforms;
  // cameras: ring draws, cameras snap in behind its tip, shutter sweep, one featured camera
  const n = frusta.length, rigP = ease(prog(t, W.rig));
  ring.geometry.setDrawRange(0, Math.ceil(rigP * 257));
  const fade = 1 - ease(prog(t, [W.fly[0] + 1.8, W.fly[1] - 0.4]));
  ring.material.opacity = 0.28 * fade * (1 - 0.6 * k); ring.visible = fade > 0;
  const cap = prog(t, W.capture) * (n + 5);
  const fk = ease(prog(t, [W.focus[0], W.focus[0] + 0.5])) * fade;
  frusta.forEach((f, i) => {
    const pop = clamp01((rigP * n - i) / 2.2);
    const flash = Math.max(0, 1 - Math.abs(cap - i - 2) / 2.2);
    const me = i === focus;
    let s = (1 + 0.18 * Math.sin(Math.PI * clamp01(pop * 1.25)) * (1 - pop)) * easeOut(pop) * fade;  // gentle overshoot
    s *= 1 + 0.22 * flash + (me ? 0.75 * fk : 0);
    f.g.scale.setScalar(Math.max(1e-4, s)); f.g.visible = s > 0.002;
    f.qm.uniforms.uFlash.value = flash;
    // no picture until this camera's shutter fires: it appears with the flash
    const shot = clamp01((cap - i - 1.2) / 1.2);
    f.qm.uniforms.uOpacity.value = shot * (0.82 - (me ? 0 : 0.62 * fk));
    f.lm.opacity = (0.45 + 0.4 * flash) * (me ? 1 : 1 - 0.65 * fk);
    f.lm.color.setHex(me && fk > 0.01 ? 0x6aaeff : 0xe6ebf5);
    if (f.hl) f.hl.material.opacity = fk;
  });
  grid.material.uniforms.uOpacity.value = 1 - ease(prog(t, [W.fly[0] + 2, W.fly[1]]));
  grid.visible = grid.material.uniforms.uOpacity.value > 0.01;

  // view card: grows out of the featured camera's image plane, shows colour then depth, folds back
  const cIn = ease(prog(t, [W.focus[0] + 0.35, W.focus[0] + 1.15]));
  const cOut = ease(prog(t, [W.fly[0] - 0.55, W.fly[0] + 0.15]));
  const ck = cIn * (1 - cOut);
  if (ck > 0.001) {
    tmp.set(0, 0, -PLANE).applyMatrix4(camMats[focus]).project(camera);
    const fx = (tmp.x * 0.5 + 0.5) * sw, fy = (-tmp.y * 0.5 + 0.5) * sh;
    const cw = portrait ? sw * 0.78 : Math.min(sw * 0.36, 440);
    const tx = portrait ? sw / 2 : sw - 28 - cw / 2, ty = portrait ? sh * 0.6 : sh * 0.54;
    const s0 = 0.1;                       // starts about the size of the frustum image on screen
    card.style.width = `${cw}px`;
    const x = fx + (tx - fx) * ck, y = fy + (ty - fy) * ck, sc = s0 + (1 - s0) * ck;
    card.style.transform = `translate(${(x - cw / 2).toFixed(1)}px, ${(y - cw * 0.375).toFixed(1)}px) scale(${sc.toFixed(4)})`;
    card.style.opacity = clamp01(ck * 2.2).toFixed(3);
    card.style.visibility = "visible";
  } else card.style.visibility = "hidden";
  const dm = ease(prog(t, [W.focus[0] + 2.0, W.focus[0] + 2.6]));
  cardDepth.style.opacity = dm.toFixed(3);
  card.classList.toggle("depth", dm > 0.5);
  cardTag.textContent = dm > 0.5 ? "Depth" : "Color";
  // reconstruction + masks
  U.uFly.value = prog(t, W.fly) * 1.42;
  U.uHeatP.value = ease(prog(t, [W.heatP[0], W.heatP[0] + 0.4]));
  U.uWaveP.value = ease(prog(t, W.heatP));
  U.uThrOnP.value = ease(prog(t, [W.thrP[0], W.thrP[0] + 0.3]));
  U.uThrP.value = 0.9 * easeOut(prog(t, W.thrP));
  U.uHeatD.value = ease(prog(t, [W.heatD[0], W.heatD[0] + 0.4]));
  U.uWaveD.value = ease(prog(t, W.heatD));
  U.uThrOnD.value = ease(prog(t, [W.thrD[0], W.thrD[0] + 0.3]));
  U.uThrD.value = 0.88 * easeOut(prog(t, W.thrD));
  U.uFinal.value = ease(prog(t, [W.arc[0] - 0.4, W.arc[0] + 0.4]));
  U.uMove.value = 0;
  // arc
  const ap = easeOut(prog(t, W.arc)), aOut = 1 - ease(prog(t, [W.end - 0.7, W.end - 0.2]));
  arc.geometry.setDrawRange(0, Math.floor(ap * arc.userData.total / 3) * 3);
  arc.visible = ap > 0 && aOut > 0; arc.material.opacity = aOut;

  // HUD
  let ch = 0;
  CHAPTERS.forEach((c, i) => { if (t >= c.t) ch = i; });
  if (ch !== lastChapter) {
    lastChapter = ch;
    kickerEl.textContent = String(ch + 1).padStart(2, "0");
    titleEl.textContent = CHAPTERS[ch].title; textEl.textContent = CHAPTERS[ch].text;
    capEl.classList.remove("in"); void capEl.offsetWidth; capEl.classList.add("in");
    chapterBtns.forEach((b, i) => { b.setAttribute("aria-current", String(i === ch)); b.classList.toggle("done", i < ch); });
  }
  chapterBtns.forEach((b, i) => {
    const a = CHAPTERS[i].t, z = i + 1 < CHAPTERS.length ? CHAPTERS[i + 1].t : W.end;
    chapterBars[i].style.transform = `scaleX(${clamp01((t - a) / (z - a)).toFixed(4)})`;
  });
  goalEl.classList.toggle("on", t >= W.goal[0]);
  const showP = t >= W.heatP[0] && t < W.heatD[0], showD = t >= W.heatD[0] && t < W.arc[0];
  legend.classList.toggle("on", showP || showD);
  legend.classList.toggle("put", showD);
  legendName.textContent = showD ? "p(putdown)" : "p(pickup)";

  // labels
  const thr = U.uThrP.value;
  labels.forEach(l => {
    let on = 0;
    if (l === labels.pick) on = t >= W.thrP[1] - 0.25 && t < W.end - 0.6 ? 1 : 0;
    else if (l === labels.put) on = t >= W.thrD[1] - 0.25 && t < W.end - 0.6 ? 1 : 0;
    else on = t >= W.cand[0] + (l.best ? 0 : 0.12 * labels.indexOf(l)) && t < W.thrP[1] - 0.25 && (l.best || thr < l.p - 0.02) ? 1 : 0;
    const p = l.pos;
    tmp.copy(p).project(camera);
    const x = (tmp.x * 0.5 + 0.5) * stage.clientWidth, y = (-tmp.y * 0.5 + 0.5) * stage.clientHeight;
    l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    l.el.classList.toggle("on", !!on);
  });
  stage.classList.toggle("fading", t > W.end - 0.6);
}

// ---------------------------------------------------------------- playback
let t = 0, playing = false, last = 0, visible = false, raf = 0;
function frame(now) {
  raf = 0;
  if (playing) {
    t += Math.min(0.05, (now - last) / 1000);
    if (t >= W.end) t = 0;
  }
  last = now;
  render();
  if (playing && visible) raf = requestAnimationFrame(frame);
}
function render() {
  if (!pts) return;
  resize();
  apply(t);
  renderer.render(scene, camera);
}
function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
function play() { playing = true; root.classList.remove("paused"); playBtn.setAttribute("aria-label", "Pause"); kick(); }
function pause() { playing = false; root.classList.add("paused"); playBtn.setAttribute("aria-label", "Play"); }
function seek(s) { t = s; kick(); }
playBtn.addEventListener("click", () => (playing ? pause() : play()));

let lastW = 0, lastH = 0;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep the whole scene in frame on narrow screens
  camera.fov = w / h < 1.2 ? 40 : 34;
  camera.updateProjectionMatrix();
  if (pts) pts.material.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
new ResizeObserver(() => { lastW = 0; if (!playing) kick(); }).observe(stage);

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const dbg = /mx-t=([\d.]+)/.exec(location.hash);
load().then(() => {
  root.classList.add("ready");
  if (dbg) window.__mx = { frusta, get t() { return t; } };
  if (dbg) { t = parseFloat(dbg[1]); pause(); visible = true; kick(); return; }
  if (reduce) { t = W.arc[1] + 0.5; pause(); }
  new IntersectionObserver(es => {
    visible = es[0].isIntersecting;
    if (visible && !reduce && !root.dataset.started) { root.dataset.started = "1"; play(); }
    if (visible) kick();
  }, { threshold: 0.35 }).observe(stage);
}).catch(err => { console.error(err); root.classList.add("failed"); });
