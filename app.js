import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Dataset (curated + GAIA DR3 + NASA Exoplanet Archive) is streamed in
// after the scene is up so the first paint isn't blocked by ~1300 sprites.
let STARS = [];

// ─── coordinate conversions ──────────────────────────────────────────────
// Equatorial (J2000) → Galactic (l, b)
const DEG = Math.PI / 180;
const NGP_RA  = 192.85948 * DEG;
const NGP_DEC =  27.12825 * DEG;
const L_NCP   = 122.93192 * DEG;

function eqToGal(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const sb = Math.sin(NGP_DEC) * Math.sin(dec)
           + Math.cos(NGP_DEC) * Math.cos(dec) * Math.cos(ra - NGP_RA);
  const b = Math.asin(sb);
  const y = Math.cos(dec) * Math.sin(ra - NGP_RA);
  const x = Math.cos(NGP_DEC) * Math.sin(dec)
          - Math.sin(NGP_DEC) * Math.cos(dec) * Math.cos(ra - NGP_RA);
  let l = L_NCP - Math.atan2(y, x);
  l = ((l % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { l, b };
}

// Galactic (l, b, d) → scene XYZ.
// Scene basis: +X toward galactic center, +Z toward NGP. We flip Y so
// galactic rotation appears anticlockwise when viewed from +Z (as requested).
function galToXYZ(l, b, d) {
  return {
    x:  d * Math.cos(b) * Math.cos(l),
    y: -d * Math.cos(b) * Math.sin(l),
    z:  d * Math.sin(b),
  };
}

// ─── star color from spectral type ───────────────────────────────────────
// Approximate RGB for OBAFGKM and special classes; tuned to look right on black.
const SPEC_COLORS = {
  O: [0.61, 0.71, 1.00],
  B: [0.70, 0.80, 1.00],
  A: [0.85, 0.89, 1.00],
  F: [1.00, 0.99, 0.95],
  G: [1.00, 0.95, 0.78],
  K: [1.00, 0.78, 0.55],
  M: [1.00, 0.55, 0.36],
  L: [0.85, 0.40, 0.30],
  T: [0.55, 0.30, 0.40],
  D: [0.88, 0.94, 1.00],   // white dwarfs — bluish-white default
};
function colorForSpType(sp) {
  if (!sp) return SPEC_COLORS.G;
  return SPEC_COLORS[sp[0].toUpperCase()] || SPEC_COLORS.G;
}

// GAIA-only stars don't carry a spectral type, but they do carry BP-RP color.
// Piecewise-linear approximation of (bp_rp → RGB) tuned for additive blending.
const BP_RP_STOPS = [
  [-0.5, [0.55, 0.70, 1.00]],
  [ 0.0, [0.82, 0.88, 1.00]],
  [ 0.5, [1.00, 1.00, 0.95]],
  [ 1.0, [1.00, 0.92, 0.72]],
  [ 1.5, [1.00, 0.82, 0.55]],
  [ 2.5, [1.00, 0.62, 0.40]],
  [ 4.0, [1.00, 0.45, 0.30]],
];
function colorForBpRp(bp_rp) {
  if (bp_rp == null || isNaN(bp_rp)) return [0.90, 0.92, 1.00];
  for (let i = 1; i < BP_RP_STOPS.length; i++) {
    const [x0, c0] = BP_RP_STOPS[i - 1];
    const [x1, c1] = BP_RP_STOPS[i];
    if (bp_rp <= x1) {
      const t = Math.max(0, Math.min(1, (bp_rp - x0) / (x1 - x0)));
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
      ];
    }
  }
  return BP_RP_STOPS[BP_RP_STOPS.length - 1][1];
}

function colorForStar(s) {
  if (s.isCurated && s.sp) return colorForSpType(s.sp);
  if (s.bp_rp != null)     return colorForBpRp(s.bp_rp);
  if (s.sp)                return colorForSpType(s.sp);
  return [0.85, 0.90, 1.00];
}

// ─── star sprite size from absolute magnitude ────────────────────────────
function absMagFor(vmag, distLy) {
  const distPc = distLy / 3.26156;
  return vmag - 5 * (Math.log10(distPc) - 1);
}

// Used at sprite creation time (initial scale before the first per-frame update).
function sizeForMag(vmag, distLy, { dim = false } = {}) {
  return sizeForAppMag(absMagFor(vmag, distLy), dim);
}

// Brightness from the camera POV: re-derive apparent magnitude using the
// current camera-to-star distance. The size encodes intrinsic luminosity;
// Three.js's perspective projection supplies the geometric 1/r factor, so
// the on-screen flux ends up ∝ L / r² (correct R⁻² fall-off for the viewer).
function sizeForAppMag(appMag, dim = false) {
  const t = Math.min(Math.max((16 - appMag) / 22, 0), 1);
  const base  = dim ? 0.04 : 0.08;
  const range = dim ? 0.45 : 1.25;
  let sz = base + t * range;
  if (appMag < 0) sz *= 1 + Math.min(-appMag, 25) * 0.05;   // boost very bright
  return Math.min(sz, 4.0);
}

// ─── exoplanet classification ────────────────────────────────────────────
// Class by radius (R⊕), falling back to mass (M⊕). Super-Earths are split
// into "super-earth" / "super-earth-hz" depending on habitable-zone fit.
const PLANET_COLORS = {
  'rocky':            0xfacc15,  // yellow         — rocky, < 1.5 R⊕
  'rocky-hz':         0xa3e635,  // yellow-green   — rocky in HZ (Earth-class)
  'super-earth':      0x4ade80,  // green          — super-Earth, outside HZ
  'super-earth-hz':   0x15803d,  // dark green  — super-Earth in HZ (a touch
                                 //                brighter than green-800 so
                                 //                additive blending still shows)
  'neptune':          0x3b82f6,  // blue        — Neptune-class
  'gas-giant':        0xf97316,  // orange      — gas giants
  'super-jupiter':    0xef4444,  // red         — super-Jupiters / borderline BDs
  'unknown':          0x9ca3af,  // grey        — no radius/mass info
};

// Habitable-zone test. Prefer the archive's equilibrium temperature (it bakes
// in albedo + orbital geometry); fall back to optimistic Kopparapu-style HZ
// computed from semi-major axis + host luminosity (V-band proxy).
function isInHabitableZone(p, hostAbsMag) {
  if (p.eqt_k != null && Number.isFinite(p.eqt_k)) {
    return p.eqt_k >= 175 && p.eqt_k <= 320;
  }
  if (p.sma_au == null || hostAbsMag == null) return false;
  const L = Math.pow(10, -0.4 * (hostAbsMag - 4.83));   // L/L_sun (rough)
  const innerAU = 0.75 * Math.sqrt(L);
  const outerAU = 1.77 * Math.sqrt(L);
  return p.sma_au >= innerAU && p.sma_au <= outerAU;
}

function planetClass(p, hostAbsMag) {
  const r = p.radius_e, m = p.mass_e;
  let base;
  if (r != null && Number.isFinite(r)) {
    if (r < 1.5)        base = 'rocky';
    else if (r < 2.5)   base = 'super-earth';
    else if (r < 6)     base = 'neptune';
    else if (r < 15)    base = 'gas-giant';
    else                base = 'super-jupiter';
  } else if (m != null && Number.isFinite(m)) {
    if (m < 2)          base = 'rocky';
    else if (m < 10)    base = 'super-earth';
    else if (m < 50)    base = 'neptune';
    else if (m < 300)   base = 'gas-giant';
    else                base = 'super-jupiter';
  } else {
    base = 'unknown';
  }
  if (isInHabitableZone(p, hostAbsMag)) {
    if (base === 'rocky')       return 'rocky-hz';
    if (base === 'super-earth') return 'super-earth-hz';
  }
  return base;
}

// ─── procedural star glow texture ────────────────────────────────────────
function makeStarTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.10, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.30, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.70, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── scene ───────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000007);

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.01, 100000
);
camera.up.set(0, 0, 1);              // galactic NGP is "up" in the scene
const HOME_POS    = new THREE.Vector3(2.5, -3.5, 22);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(HOME_POS);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance   = 0.05;
controls.maxDistance   = 5000;
controls.target.copy(HOME_TARGET);

// ─── Milky Way skybox (ESO Brunier panorama, in galactic coords) ─────────
// We deliberately do NOT use random background stars — the panorama IS the
// real night sky. After STARS are loaded, we paint over the curated bright
// stars in the panorama so they aren't visible twice (once in 3D, once flat).
const SKY_RADIUS = 8000;
// Dim the panorama by tinting the material color — keeps it as ambient
// context, not as a competing light source over the 3D-rendered stars.
const SKY_DIM = 0x4a4a55;
const skyMat = new THREE.MeshBasicMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  color: 0x202028,           // placeholder until the JPG arrives
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 32), skyMat);
// Align: image equator (b=0) → scene z=0 plane (galactic plane).
// Image center (l=0, galactic centre) → scene +X (where +X points).
sky.rotation.x = Math.PI / 2;
sky.rotation.z = Math.PI;
sky.frustumCulled = false;
scene.add(sky);

let skyImage = null;
const _skyImg = new Image();
_skyImg.crossOrigin = 'anonymous';
_skyImg.onload = () => {
  skyImage = _skyImg;
  // Show unmasked panorama immediately; later replaced with masked version
  // once star data has arrived (see applyMaskedSky()).
  const tex = new THREE.Texture(_skyImg);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  skyMat.map = tex;
  skyMat.color.setHex(SKY_DIM);
  skyMat.needsUpdate = true;
  applyMaskedSky();
};
_skyImg.onerror = () => console.warn('milky_way.jpg failed to load');
_skyImg.src = './data/milky_way.jpg';

// Paint dark disks over curated star positions so 3D-rendered stars aren't
// duplicated in the panorama. Called when both the image and STARS are ready.
let _skyMaskApplied = false;
function applyMaskedSky() {
  if (_skyMaskApplied || !skyImage || STARS.length === 0) return;
  _skyMaskApplied = true;
  const W = skyImage.naturalWidth;
  const H = skyImage.naturalHeight;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  ctx.drawImage(skyImage, 0, 0);

  // Only mask the genuinely-bright curated stars that actually appear as
  // distinct glows in the panorama (V < 5). Dim M dwarfs (Proxima, Wolf 359,
  // etc.) are invisible in any photo so they don't need masking.
  // Use a 'multiply' blend with a dark gradient that fades to white at the
  // edges — this *dims* the star instead of punching a black hole.
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  for (const s of STARS) {
    if (s.vmag == null || s.vmag > 5 || !s.isCurated) continue;
    const { l, b } = eqToGal(s.ra, s.dec);
    let u = (((0.5 - l / (2 * Math.PI)) % 1) + 1) % 1;
    let v = 0.5 - b / Math.PI;
    const x = u * W;
    const y = v * H;
    // Tight radius — bright-star halo in a 6000-wide panorama is only ~6–12 px.
    const r = Math.max(4, 12 - s.vmag * 1.4);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0.0, 'rgb(20, 26, 40)');     // dim ~10% at the centre
    grad.addColorStop(0.5, 'rgb(110, 115, 130)');  // partial dim halfway out
    grad.addColorStop(1.0, 'rgb(255, 255, 255)');  // untouched at the edge
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  const masked = new THREE.CanvasTexture(cvs);
  masked.colorSpace = THREE.SRGBColorSpace;
  skyMat.map = masked;
  skyMat.needsUpdate = true;
}

// ─── Sun ─────────────────────────────────────────────────────────────────
const SUN_ABS_MAG = 4.83;
const starTex = makeStarTexture();
const sun = new THREE.Sprite(new THREE.SpriteMaterial({
  map: starTex, color: 0xfff1c8,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
sun.scale.set(0.9, 0.9, 0.9);
sun.userData = { name: 'Sol (the Sun)', distLy: 0, vmag: -26.74, sp: 'G2V', gx:0, gy:0, gz:0, isSun: true };
scene.add(sun);

// faint hint that the Sun is at the centre — a small billboarded ring
const sunHaloMat = new THREE.SpriteMaterial({
  map: starTex, color: 0xffe18c,
  transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const sunHalo = new THREE.Sprite(sunHaloMat);
sunHalo.scale.set(2.4, 2.4, 2.4);
scene.add(sunHalo);

// ─── nearby stars (streamed in by loadStars()) ───────────────────────────
// `starSprites` is sorted ascending by heliocentric distance after load so
// the slider can show "the N closest" by simply slicing a prefix.
const starSprites = [];
// Synced with the slider once its DOM is parsed (see sliderToCount, below).
// 25000 matches the previous fixed-cutoff dataset count.
let visibleStarCount = 25000;
const planetHostRings = new THREE.Group();
planetHostRings.visible = false;
scene.add(planetHostRings);

// Rings are LineLoops with FIXED world-radius in light-years. LineBasicMaterial
// renders at 1 px regardless of distance, so the stroke width is naturally
// capped in screen-space — solving the old "donut at close range" bug without
// shrinking the ring (which made it fall into the host star). Per frame we
// only billboard each ring to face the camera.
const RING_BASE_WORLD   = 0.35;   // ly  — innermost ring radius
const RING_STEP_WORLD   = 0.14;   // ly  — added per outer planet
const MAX_RINGS_PER_HOST = 6;
const RING_SEGMENTS     = 96;
const _ringCircle = (() => {
  const pts = new Float32Array((RING_SEGMENTS + 1) * 3);
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    pts[i * 3]     = Math.cos(a);
    pts[i * 3 + 1] = Math.sin(a);
    pts[i * 3 + 2] = 0;
  }
  return pts;
})();
function makeRingGeometry(radius) {
  const arr = new Float32Array(_ringCircle.length);
  for (let i = 0; i < _ringCircle.length; i++) arr[i] = _ringCircle[i] * radius;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return g;
}

function addStarSprite(s) {
  const { l, b } = eqToGal(s.ra, s.dec);
  const p = galToXYZ(l, b, s.distLy);
  const [r, g, bl] = colorForStar(s);
  const curated = s.isCurated;
  // Curated and GAIA stars are rendered identically — they're all real stars.
  // Previously curated got a 5×-flux boost (bigger sprites + full opacity),
  // which lit up the cluster of named stars around the Sun against the GAIA
  // fill. Hover still labels named stars; nothing visual marks them.
  const mat = new THREE.SpriteMaterial({
    map: starTex,
    color: new THREE.Color(r, g, bl),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.7,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(p.x, p.y, p.z);
  const absMag = absMagFor(s.vmag ?? 99, s.distLy);
  const sz = sizeForMag(s.vmag ?? 99, s.distLy, { dim: true }) * brightnessMul;
  sprite.scale.set(sz, sz, sz);
  sprite.userData = { ...s, gx: p.x, gy: p.y, gz: p.z, absMag };
  // Stars are added in distance order; hide ones past the slider position at
  // creation time so a 100k load doesn't flash all sprites visible mid-stream.
  sprite.visible = starSprites.length < visibleStarCount;
  scene.add(sprite);
  starSprites.push(sprite);
  _hoverTargets.push(sprite);

  // One concentric ring per planet, colored by classification. The dataset
  // lists planets in NASA-Archive discovery order; sort by semi-major axis
  // (fall back to orbital period, since P² ∝ a³ preserves the same order)
  // so ring N actually corresponds to the N-th-closest planet.
  if (s.planets && s.planets.length > 0) {
    const orbitKey = (pl) => (
      pl.sma_au   != null ? pl.sma_au :
      pl.period_d != null ? Math.cbrt(pl.period_d * pl.period_d) :  // ∝ a in solar-mass units
      Infinity
    );
    const ordered = [...s.planets].sort((a, b) => orbitKey(a) - orbitKey(b));
    const shown = Math.min(ordered.length, MAX_RINGS_PER_HOST);
    for (let i = 0; i < shown; i++) {
      const cls    = planetClass(ordered[i], absMag);
      const color  = PLANET_COLORS[cls] ?? PLANET_COLORS.unknown;
      const radius = RING_BASE_WORLD + RING_STEP_WORLD * i;
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ring = new THREE.LineLoop(makeRingGeometry(radius), mat);
      ring.position.set(p.x, p.y, p.z);
      ring.userData = { host: sprite, ringIndex: i, cls };
      ring.visible = sprite.visible;
      planetHostRings.add(ring);
    }
  }
}

// ─── Sun→star sightlines (toggle) ────────────────────────────────────────
// Built incrementally by loadStars() as sprites arrive. Hidden by default.
const sunLines = new THREE.Group();
sunLines.visible = false;
scene.add(sunLines);

const LINE_OPACITY_MAX = 0.45;
const LINE_FADE_NEAR = 1.5;   // fully invisible when the closest point is < 1.5 ly
const LINE_FADE_FAR  = 12;    // fully visible when ≥ 12 ly

function addSunLineForSprite(sprite) {
  const c = sprite.material.color;
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(c.r * 0.7 + 0.15, c.g * 0.7 + 0.15, c.b * 0.7 + 0.20),
    transparent: true, opacity: LINE_OPACITY_MAX,
  });
  const endpoint = sprite.position.clone();
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    endpoint,
  ]);
  const line = new THREE.Line(geo, mat);
  line.userData = { endpoint };
  sunLines.add(line);
}

// Fade each sightline by the camera's distance to the *nearest point on that
// line segment*. Close to either end (Sun or star) → line fades to keep it
// visually thin next to nearby star sprites. Far away → full 0.45 opacity.
function updateSunLineOpacities() {
  if (!sunLines.visible) return;
  const cam = camera.position;
  for (const line of sunLines.children) {
    const S = line.userData.endpoint;
    const sLenSq = S.lengthSq();
    let t = sLenSq > 0 ? (cam.x*S.x + cam.y*S.y + cam.z*S.z) / sLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = cam.x - t * S.x;
    const dy = cam.y - t * S.y;
    const dz = cam.z - t * S.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    let a = (dist - LINE_FADE_NEAR) / (LINE_FADE_FAR - LINE_FADE_NEAR);
    a = Math.max(0, Math.min(1, a));
    line.material.opacity = a * LINE_OPACITY_MAX;
  }
}

// ─── Sun-centered radial grid on galactic plane (toggle) ────────────────
// Concentric circles every 20 ly out to 200 ly (400 ly diameter) + 12 radial
// spokes. Brighter green for visibility against the dense star field.
const galPlane = new THREE.Group();
galPlane.visible = false;
scene.add(galPlane);
{
  const ringMat  = new THREE.LineBasicMaterial({ color: 0x3ec070, transparent: true, opacity: 0.80 });
  const spokeMat = new THREE.LineBasicMaterial({ color: 0x3ec070, transparent: true, opacity: 0.50 });
  const ringRadii = [20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
  for (const r of ringRadii) {
    const pts = [];
    const segs = 128;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0));
    }
    galPlane.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }
  const outerR = ringRadii[ringRadii.length - 1];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(outerR * Math.cos(a), outerR * Math.sin(a), 0),
    ]);
    galPlane.add(new THREE.Line(geo, spokeMat));
  }
}

// ─── compass: "→ galactic center" tick on the +X axis ────────────────────
(function buildGcMarker() {
  const mat = new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.45 });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(20, 0, 0),
  ]);
  scene.add(new THREE.Line(geo, mat));
})();

// ─── info panel ──────────────────────────────────────────────────────────
const infoEl    = document.getElementById('info');
const infoHead  = document.getElementById('info-head');
const infoTitle = document.getElementById('info-title');
const infoBody  = document.getElementById('info-body');
const infoUnpin = document.getElementById('info-unpin');

let summaryTitle = 'Loading…';
let summaryBody  = 'fetching star catalog';
let pinnedSprite = null;

function buildStarBody(d) {
  const lines = [];
  if (d.isSun) {
    lines.push(`our home star`);
    lines.push(`apparent mag: ${d.vmag} · type: ${d.sp}`);
    return lines.join('<br>');
  }
  lines.push(`distance: ${d.distLy.toFixed(3)} ly  (${(d.distLy/3.26156).toFixed(3)} pc)`);
  const magLabel = d.isCurated ? 'V mag' : 'G mag';
  const sp = d.sp || '—';
  const bp = (d.bp_rp != null) ? ` · BP–RP ${d.bp_rp.toFixed(2)}` : '';
  lines.push(`${magLabel}: ${d.vmag.toFixed(2)} · type: ${sp}${bp}`);
  lines.push(`gal. XYZ: ${d.gx.toFixed(2)}, ${d.gy.toFixed(2)}, ${d.gz.toFixed(2)} ly`);
  lines.push(`RA/Dec: ${d.ra.toFixed(3)}°, ${d.dec.toFixed(3)}°`);
  if (d.planets && d.planets.length > 0) {
    lines.push(`<span style="color:#6fe6c8">━ ${d.planets.length} planet${d.planets.length>1?'s':''} ━</span>`);
    const orbitKey = (pl) => (
      pl.sma_au   != null ? pl.sma_au :
      pl.period_d != null ? Math.cbrt(pl.period_d * pl.period_d) :
      Infinity
    );
    const ordered = [...d.planets].sort((a, b) => orbitKey(a) - orbitKey(b));
    for (const p of ordered.slice(0, 8)) {
      const r  = p.radius_e != null ? `${p.radius_e.toFixed(2)} R⊕` : null;
      const m  = p.mass_e   != null ? `${p.mass_e.toFixed(2)} M⊕`   : null;
      const a  = p.sma_au   != null ? `${p.sma_au.toFixed(3)} AU`   : null;
      const T  = p.period_d != null ? `${p.period_d.toFixed(p.period_d<10?2:1)} d` : null;
      const Te = p.eqt_k    != null ? `${Math.round(p.eqt_k)} K`     : null;
      const bits = [r, m, a, T, Te].filter(Boolean).join(' · ');
      lines.push(`  ${p.name}${bits ? ' — ' + bits : ''}`);
    }
    if (d.planets.length > 8) lines.push(`  …+${d.planets.length - 8} more`);
  }
  return lines.join('<br>');
}

function renderInfoPanel() {
  if (pinnedSprite) {
    infoTitle.textContent = pinnedSprite.userData.name;
    infoBody.innerHTML = buildStarBody(pinnedSprite.userData);
    infoUnpin.hidden = false;
  } else {
    infoTitle.textContent = summaryTitle;
    infoBody.innerHTML = summaryBody;
    infoUnpin.hidden = true;
  }
}
function setSummary(title, body) {
  summaryTitle = title;
  summaryBody = body;
  if (!pinnedSprite) renderInfoPanel();
}
function pinStar(sprite) { pinnedSprite = sprite; renderInfoPanel(); }
function unpinStar()     { pinnedSprite = null;   renderInfoPanel(); }

infoHead.addEventListener('click', () => infoEl.classList.toggle('collapsed'));
infoUnpin.addEventListener('click', (e) => { e.stopPropagation(); unpinStar(); });

renderInfoPanel();

async function loadStars() {
  let data;
  try {
    data = await fetch('./data/stars.json?v=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
  } catch (e) {
    setSummary('Failed to load catalog', e.message);
    return;
  }
  STARS = data;
  // Sort ascending by distance so the slider can slice "the N closest"
  // straight from starSprites. Curated stars naturally land near the front
  // because they're physically nearby; tie-break keeps named ones first.
  data.sort((a, b) => {
    if (a.distLy !== b.distLy) return a.distLy - b.distLy;
    return (b.isCurated ? 1 : 0) - (a.isCurated ? 1 : 0);
  });

  const CHUNK = 500;
  for (let i = 0; i < data.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, data.length);
    for (let j = i; j < end; j++) addStarSprite(data[j]);
    setSummary('Loading…', `${end.toLocaleString()} / ${data.length.toLocaleString()} stars`);
    // Yield to the browser so each chunk is visible during load.
    await new Promise(r => requestAnimationFrame(r));
  }

  // Sun→star sightlines: 50 closest. starSprites is already distance-sorted.
  for (let i = 0; i < Math.min(50, starSprites.length); i++) {
    addSunLineForSprite(starSprites[i]);
  }

  applyVisibleCount(visibleStarCount);
  refreshCountLabel(visibleStarCount);

  // And paint over duplicates in the Milky Way panorama (if it's loaded by now).
  applyMaskedSky();

  const nCurated = data.filter(s => s.isCurated).length;
  const nGaia    = data.length - nCurated;
  const nHosts   = data.filter(s => s.planets && s.planets.length).length;
  const nPlanets = data.reduce((a, s) => a + (s.planets?.length || 0), 0);
  const maxDist  = data[data.length - 1].distLy;
  setSummary(
    'Solar Neighborhood',
    `${data.length.toLocaleString()} stars within ~${Math.round(maxDist)} ly ` +
    `(${nCurated} curated + ${nGaia.toLocaleString()} from GAIA DR3)<br>` +
    `${nPlanets} confirmed exoplanets around ${nHosts} hosts.`,
  );
}

// ─── slider: show the N closest stars ────────────────────────────────────
// All sprites are built once and toggled via .visible. Per-frame loops in
// updateStarsForCamera()/raycasting skip invisible ones, so high counts only
// cost draw-call setup (which Three.js already culls when .visible=false).
function applyVisibleCount(n) {
  // Don't clamp to starSprites.length — load may still be streaming. New
  // sprites read visibleStarCount in addStarSprite() and inherit visibility.
  visibleStarCount = Math.max(0, n);
  for (let i = 0; i < starSprites.length; i++) {
    starSprites[i].visible = i < visibleStarCount;
  }
  // Rings belong to a host sprite; hide a ring when its host is hidden.
  for (const ring of planetHostRings.children) {
    ring.visible = ring.userData.host?.visible !== false;
  }
  // Newly-visible sprites might have been created when brightnessMul was a
  // different value (or before the slider initialised); reapply.
  applyStarSizes();
}

// ─── hover with raycasting ───────────────────────────────────────────────
const hover  = document.getElementById('hover');
const raycaster = new THREE.Raycaster();
raycaster.params.Sprite = { threshold: 0 };
const mouse = new THREE.Vector2();
let lastMouse = null;
// Reused each frame instead of re-spreading [sun, ...starSprites] (allocates
// 100k refs every frame at full slider).
const _hoverTargets = [sun];

renderer.domElement.addEventListener('mousemove', (e) => {
  lastMouse = e;
  mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
renderer.domElement.addEventListener('mouseleave', () => { lastMouse = null; hover.style.display = 'none'; });

function pickSprite(clientX, clientY) {
  mouse.x =  (clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(_hoverTargets, false);
  return hits.length > 0 ? hits[0].object : null;
}

function updateHover() {
  if (!lastMouse) { hover.style.display = 'none'; return; }
  raycaster.setFromCamera(mouse, camera);
  // Raycaster skips objects with .visible === false, so slider-hidden
  // stars are excluded automatically. _hoverTargets is kept in sync inside
  // addStarSprite() / applyVisibleCount() — never reallocated per frame.
  const hits = raycaster.intersectObjects(_hoverTargets, false);
  if (hits.length === 0) { hover.style.display = 'none'; return; }
  const d = hits[0].object.userData;
  hover.innerHTML = `<b>${d.name}</b><br>` + buildStarBody(d);
  hover.style.display = 'block';
  hover.style.left = (lastMouse.clientX + 14) + 'px';
  hover.style.top  = (lastMouse.clientY + 14) + 'px';
}

// ─── click-to-pin star info ──────────────────────────────────────────────
// Track pointerdown vs pointerup delta to distinguish a click from an
// OrbitControls drag — only treat near-stationary releases as picks.
let _pointerDownAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  _pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !_pointerDownAt) return;
  const dx = e.clientX - _pointerDownAt.x;
  const dy = e.clientY - _pointerDownAt.y;
  const dt = performance.now() - _pointerDownAt.t;
  _pointerDownAt = null;
  if (dx*dx + dy*dy > 25 || dt > 500) return;  // drag, not click
  const hit = pickSprite(e.clientX, e.clientY);
  if (hit) pinStar(hit);
});

// ─── home button (smooth easing back to start) ───────────────────────────
function animateCameraTo(pos, target, duration = 800) {
  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();
  const t0 = performance.now();
  function step() {
    const t = Math.min((performance.now() - t0) / duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    camera.position.lerpVectors(startPos, pos, e);
    controls.target.lerpVectors(startTarget, target, e);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  step();
}
document.getElementById('home').addEventListener('click', () => {
  animateCameraTo(HOME_POS, HOME_TARGET, 700);
});

const linesBtn = document.getElementById('lines');
linesBtn.addEventListener('click', () => {
  sunLines.visible = !sunLines.visible;
  linesBtn.classList.toggle('active', sunLines.visible);
});

const planeBtn = document.getElementById('plane');
planeBtn.addEventListener('click', () => {
  galPlane.visible = !galPlane.visible;
  planeBtn.classList.toggle('active', galPlane.visible);
});

const planetsBtn = document.getElementById('planets');
const legendEl = document.getElementById('legend');
planetsBtn.addEventListener('click', () => {
  planetHostRings.visible = !planetHostRings.visible;
  planetsBtn.classList.toggle('active', planetHostRings.visible);
  legendEl.hidden = !planetHostRings.visible;
});

const fsBtn = document.getElementById('fullscreen');
fsBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  fsBtn.classList.toggle('active', !!document.fullscreenElement);
});

// ─── visible-count slider (log-scale 100 → 100,000, default 25,000) ──────
const countSlider = document.getElementById('countSlider');
const countLabel  = document.getElementById('countLabel');
const rangeLabel  = document.getElementById('rangeLabel');
const COUNT_MIN = 100, COUNT_MAX = 100000;
const LOG_MIN = Math.log10(COUNT_MIN), LOG_MAX = Math.log10(COUNT_MAX);
function sliderToCount(pos) {
  const t = pos / 1000;
  return Math.round(Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN)));
}
function refreshCountLabel(n) {
  const eff = Math.min(n, starSprites.length || n);
  countLabel.textContent = eff.toLocaleString();
  // Show the radius of the visible-set in light-years (max distLy among shown).
  if (starSprites.length > 0 && eff > 0) {
    const sp = starSprites[Math.min(eff, starSprites.length) - 1];
    rangeLabel.textContent = fmtLy(sp.userData.distLy);
  } else {
    rangeLabel.textContent = '— ly';
  }
}
countSlider.addEventListener('input', () => {
  const n = sliderToCount(+countSlider.value);
  applyVisibleCount(n);
  refreshCountLabel(n);
});
// Initial label + sync visibleStarCount to whatever the slider parsed as.
visibleStarCount = sliderToCount(+countSlider.value);
refreshCountLabel(visibleStarCount);

// ─── brightness multiplier slider (0.5× → 5×, default 1×) ────────────────
// Slider stores ×100 (integer steps) to avoid float weirdness — 50..500.
// Additive blending makes sprite area ≈ perceived flux, so a size scalar IS
// a brightness scalar. Sizes only change when this value changes — see
// applyStarSizes().
let brightnessMul = 1.0;
const brightSlider = document.getElementById('brightSlider');
const brightLabel  = document.getElementById('brightLabel');
function applyBrightness(v) {
  brightnessMul = Math.max(0.5, Math.min(5, v));
  brightLabel.textContent = brightnessMul.toFixed(brightnessMul < 1 ? 2 : 1);
  applyStarSizes();
}
brightSlider.addEventListener('input', () => {
  applyBrightness(+brightSlider.value / 100);
});
applyBrightness(+brightSlider.value / 100);

// ─── resize ──────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── readout ─────────────────────────────────────────────────────────────
const viewdistEl = document.getElementById('viewdist');
function fmtLy(ly) {
  if (ly < 1)       return (ly * 63241).toFixed(0) + ' au';
  if (ly < 100)     return ly.toFixed(2) + ' ly';
  if (ly < 100000)  return ly.toFixed(0) + ' ly';
  return (ly / 1000).toFixed(1) + ' kly';
}

// ─── per-frame ring sizing (stars are camera-independent now) ────────────
const _camPos = new THREE.Vector3();
// World-space sprite size encodes INTRINSIC luminosity (absMag). Three.js's
// perspective projection then applies the geometric 1/r factor, so on-screen
// flux ends up ∝ L / r² — the correct apparent-magnitude fall-off. Because
// nothing here depends on camera position, sizes only need to be re-applied
// when the brightness slider changes (or when new sprites enter the visible
// set via the count slider) — not every frame.
function applyStarSizes() {
  for (let i = 0; i < starSprites.length; i++) {
    const sp = starSprites[i];
    if (!sp.visible) continue;
    const sz = sizeForAppMag(sp.userData.absMag, /* dim */ true) * brightnessMul;
    sp.scale.set(sz, sz, sz);
  }
  const sunSz = sizeForAppMag(SUN_ABS_MAG, false) * brightnessMul;
  sun.scale.set(sunSz, sunSz, sunSz);
  sunHalo.scale.set(sunSz * 2.6, sunSz * 2.6, sunSz * 2.6);
}

function updateStarsForCamera() {
  _camPos.copy(camera.position);

  // Billboard each ring to face the camera. World-radius stays fixed (in ly),
  // so rings grow on screen as the camera approaches — the host sprite no
  // longer overtakes them. Line width stays at ~1 px via LineBasicMaterial,
  // so the ring reads as a thin circle at any zoom (no more donuts).
  for (const ring of planetHostRings.children) {
    ring.quaternion.copy(camera.quaternion);
  }
}

// ─── main loop ───────────────────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  controls.update();
  sunHalo.position.copy(sun.position); // halo follows sun (here, origin)
  updateStarsForCamera();
  updateSunLineOpacities();
  updateHover();
  viewdistEl.textContent = fmtLy(camera.position.distanceTo(controls.target));
  renderer.render(scene, camera);
}
loop();

// Kick off streaming load after the first frame is rendered.
loadStars();
