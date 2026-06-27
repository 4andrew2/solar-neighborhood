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
// sRGB chromaticity of the class-midpoint blackbody temperature, from
// Mitchell Charity's D58-illuminant lookup table (Lo01/Lhi values normalized
// so the brightest channel hits 1.0). Verified against Stellarium/Celestia.
//   O ~30000 K | B ~20000 K | A  ~9000 K | F  ~6700 K | G  ~5800 K
//   K  ~4500 K | M  ~3000 K
const SPEC_COLORS = {
  O: [0.61, 0.71, 1.00],
  B: [0.70, 0.80, 1.00],
  A: [0.84, 0.88, 1.00],
  F: [1.00, 0.98, 0.95],
  G: [1.00, 0.95, 0.88],
  K: [1.00, 0.78, 0.55],
  M: [1.00, 0.57, 0.30],
  L: [0.92, 0.45, 0.28],   // late-M / L brown dwarf, ~2200 K
  T: [0.78, 0.30, 0.35],   // T brown dwarf, ~1200 K — methane-band dimming
  D: [0.92, 0.95, 1.00],   // white dwarfs default to ~12000 K continuum
};
function colorForSpType(sp) {
  if (!sp) return SPEC_COLORS.G;
  return SPEC_COLORS[sp[0].toUpperCase()] || SPEC_COLORS.G;
}

// GAIA-only stars don't carry a spectral type, but they do carry BP-RP color.
// Piecewise-linear (bp_rp → sRGB), stops chosen so each color index lands on
// the canonical SPEC_COLORS entry for its temperature: 0 → A (~9000 K),
// 0.5 → F (~6700 K), 0.82 ≈ Sun, 1.0 → G/early-K, 1.5 → K, 2.5 → M.
const BP_RP_STOPS = [
  [-0.5, [0.55, 0.70, 1.00]],
  [ 0.0, [0.84, 0.88, 1.00]],
  [ 0.5, [1.00, 0.98, 0.95]],
  [ 1.0, [1.00, 0.95, 0.88]],
  [ 1.5, [1.00, 0.78, 0.55]],
  [ 2.5, [1.00, 0.57, 0.30]],
  [ 4.0, [1.00, 0.40, 0.22]],
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

// True L/r² rendering:
//   L (solar) = 10^(-0.4·(M − M_sun))     → √L = 10^(0.2·(M_sun − M))
//   world_size  = REF_SIZE · √L
//   on-screen   = world_size / r   (perspective projection)
//   so on-screen flux ∝ size² / r² ∝ L / r²  ✓
// REF_SIZE is the size for an M = M_sun (G2V) star; nudged so the Sun reads
// as a small but visible disc at the home distance (≈22 ly camera target).
// VIS_FLOOR keeps the dimmest M dwarfs as a sub-pixel dot rather than
// vanishing entirely. MAX_SIZE caps blue giants so they don't fill the view.
const REF_SIZE  = 0.12;
const VIS_FLOOR = 0.012;
const MAX_SIZE  = 3.0;

function sizeForAbsMag(absMag) {
  const sz = REF_SIZE * Math.pow(10, 0.2 * (4.83 - absMag));
  return Math.max(VIS_FLOOR, Math.min(sz, MAX_SIZE));
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
// Image center (l=0, galactic centre) → scene +X. The default sphere
// already places u=0.5 at local +X; rotating π/2 around X just lifts the
// north pole from +Y to +Z. A previous Math.PI Z-rotation was flipping the
// panorama 180° so the bright Sagittarius bulge ended up at -X (where the
// "anti-GC" label was) — that's been removed.
sky.rotation.x = Math.PI / 2;
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
// Sun absolute V-mag 4.83 (G2V). Color from the 5778 K blackbody chromaticity
// (Charity D58 sRGB table) — not the eyeballed warm yellow it had before,
// which was ~5200 K (border G/K).
const SUN_ABS_MAG = 4.83;
const starTex = makeStarTexture();
const sun = new THREE.Sprite(new THREE.SpriteMaterial({
  map: starTex, color: 0xfff2e0,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  opacity: 0.7,
}));
sun.userData = { name: 'Sol (the Sun)', distLy: 0, vmag: -26.74, sp: 'G2V', gx:0, gy:0, gz:0, isSun: true };
scene.add(sun);

// Faint "you are here" glow. Sized in proportion to the Sun sprite (which is
// now scaled like any other G2V star), so the halo reads as a marker rather
// than overwhelming the actual stellar disc.
const sunHaloMat = new THREE.SpriteMaterial({
  map: starTex, color: 0xffe6a8,
  transparent: true, opacity: 0.22,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const sunHalo = new THREE.Sprite(sunHaloMat);
scene.add(sunHalo);

// ─── nearby stars: one THREE.Points, one draw call ──────────────────────
// 100 k Sprite objects = 100 k matrix updates + frustum checks + draw calls
// per frame, which made rotation choppy when the whole cloud was on screen.
// Pack everything into a single Points geometry instead: per-vertex position,
// color, and size attributes; the shader does world-size → pixel projection
// itself. `starData` keeps the per-star metadata in parallel index order for
// hover/pin lookups.
const STAR_CAP = 110000;                       // matches build_dataset.py MAX_KEEP
const starPositions = new Float32Array(STAR_CAP * 3);
const starColorsBuf = new Float32Array(STAR_CAP * 3);
const starSizes     = new Float32Array(STAR_CAP);
const starIndices   = new Float32Array(STAR_CAP);   // 0..N for visibility cull
const starData      = [];
let starCount = 0;

const starGeom = new THREE.BufferGeometry();
starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
starGeom.setAttribute('aColor',   new THREE.BufferAttribute(starColorsBuf, 3));
starGeom.setAttribute('aSize',    new THREE.BufferAttribute(starSizes, 1));
starGeom.setAttribute('aIndex',   new THREE.BufferAttribute(starIndices, 1));
starGeom.setDrawRange(0, 0);
// Skip frustum culling — we never compute a tight bbox, and at this scale a
// false-cull would hide the entire cloud.
starGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

function makePxScale() {
  const h = renderer.domElement.height;
  return h * 0.5 / Math.tan(camera.fov * Math.PI / 360);
}

const starMat = new THREE.ShaderMaterial({
  uniforms: {
    uMap:          { value: starTex },
    uPxScale:      { value: makePxScale() },
    uVisibleCount: { value: 25000.0 },
    uBrightMul:    { value: 1.0 },
  },
  vertexShader: /* glsl */`
    attribute vec3  aColor;
    attribute float aSize;
    attribute float aIndex;
    uniform float uPxScale;
    uniform float uVisibleCount;
    uniform float uBrightMul;
    varying vec3  vColor;
    varying float vFlux;
    void main() {
      vColor = aColor;
      vFlux  = 1.0;
      // Slider-hidden stars get pushed outside clip space + zero size.
      if (aIndex >= uVisibleCount) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float depth = max(-mv.z, 0.01);
      // World-size → pixel-size: aSize * (renderH/2) / (tan(fov/2) * depth).
      float pxRaw = aSize * uBrightMul * uPxScale / depth;

      // Soft-knee compression: bright giants were blooming into giant
      // diffuse discs because √L sizing scales without bound. Beyond a
      // 6-px threshold, asymptote toward ~22 px, then boost per-pixel
      // intensity by the squared area ratio so integrated flux (and
      // therefore perceived brightness) is preserved. Pixels that go
      // over 1.0 just clamp at the framebuffer — exactly how a bright
      // star reads in a real photo: tight saturated core, colored halo.
      const float kneeStart = 6.0;
      const float kneeMax   = 22.0;
      float pxOut = pxRaw;
      if (pxRaw > kneeStart) {
        float k = (kneeMax - kneeStart);
        pxOut = kneeStart + k * (1.0 - exp(-(pxRaw - kneeStart) / k));
        vFlux = (pxRaw * pxRaw) / (pxOut * pxOut);
      }
      gl_PointSize = clamp(pxOut, 1.0, 64.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D uMap;
    varying vec3  vColor;
    varying float vFlux;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      gl_FragColor = vec4(vColor * t.rgb * vFlux * 0.7, t.a);   // 0.7 matches old sprite opacity
    }
  `,
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const starPoints = new THREE.Points(starGeom, starMat);
scene.add(starPoints);

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

function addStar(s) {
  const { l, b } = eqToGal(s.ra, s.dec);
  const p = galToXYZ(l, b, s.distLy);
  const [r, g, bl] = colorForStar(s);
  const absMag = absMagFor(s.vmag ?? 99, s.distLy);
  const sz = sizeForAbsMag(absMag);
  const i = starCount;
  starPositions[i*3  ] = p.x;
  starPositions[i*3+1] = p.y;
  starPositions[i*3+2] = p.z;
  starColorsBuf[i*3  ] = r;
  starColorsBuf[i*3+1] = g;
  starColorsBuf[i*3+2] = bl;
  starSizes[i]   = sz;
  starIndices[i] = i;
  starData.push({ ...s, gx: p.x, gy: p.y, gz: p.z, absMag, idx: i });
  starCount++;

  // One concentric ring per planet, colored by classification. The dataset
  // lists planets in NASA-Archive discovery order; sort by semi-major axis
  // (fall back to orbital period, since P² ∝ a³ preserves the same order)
  // so ring N actually corresponds to the N-th-closest planet.
  if (s.planets && s.planets.length > 0) {
    const orbitKey = (pl) => (
      pl.sma_au   != null ? pl.sma_au :
      pl.period_d != null ? Math.cbrt(pl.period_d * pl.period_d) :
      Infinity
    );
    const ordered = [...s.planets].sort((a, b) => orbitKey(a) - orbitKey(b));
    const shown = Math.min(ordered.length, MAX_RINGS_PER_HOST);
    for (let j = 0; j < shown; j++) {
      const cls    = planetClass(ordered[j], absMag);
      const color  = PLANET_COLORS[cls] ?? PLANET_COLORS.unknown;
      const radius = RING_BASE_WORLD + RING_STEP_WORLD * j;
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ring = new THREE.LineLoop(makeRingGeometry(radius), mat);
      ring.position.set(p.x, p.y, p.z);
      ring.userData = { starIdx: i, ringIndex: j, cls };
      ring.visible = i < visibleStarCount;
      planetHostRings.add(ring);
    }
  }
}

// Commit a streamed-in chunk to the GPU. Cheaper than uploading the full
// buffer every chunk: bump the draw range and mark only what changed.
function commitStars() {
  starGeom.setDrawRange(0, starCount);
  starGeom.attributes.position.needsUpdate = true;
  starGeom.attributes.aColor.needsUpdate   = true;
  starGeom.attributes.aSize.needsUpdate    = true;
  starGeom.attributes.aIndex.needsUpdate   = true;
}

// ─── Sun→star sightlines (toggle) ────────────────────────────────────────
// Built incrementally by loadStars() as sprites arrive. Hidden by default.
const sunLines = new THREE.Group();
sunLines.visible = false;
scene.add(sunLines);

const LINE_OPACITY_MAX = 0.45;
const LINE_FADE_NEAR = 1.5;   // fully invisible when the closest point is < 1.5 ly
const LINE_FADE_FAR  = 12;    // fully visible when ≥ 12 ly

function addSunLineForStar(idx) {
  const r  = starColorsBuf[idx*3  ];
  const g  = starColorsBuf[idx*3+1];
  const bl = starColorsBuf[idx*3+2];
  const endpoint = new THREE.Vector3(
    starPositions[idx*3], starPositions[idx*3+1], starPositions[idx*3+2],
  );
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(r * 0.7 + 0.15, g * 0.7 + 0.15, bl * 0.7 + 0.20),
    transparent: true, opacity: LINE_OPACITY_MAX,
  });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), endpoint,
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
// spokes + numeric labels along the +X (galactic-center) axis and galactic
// longitude labels around the outer ring.
function makeTextSprite(text, { color = '#7ee5a8', fontPx = 28, screenPx = 16 } = {}) {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const font = `${fontPx}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.font = font;
  const pad = 6;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad;
  cvs.width = w; cvs.height = h;
  // Re-set context state after canvas-size change wipes it
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  // Actual world scale is updated each frame by updateLabelScales so the
  // sprite reads at a constant pixel height regardless of camera distance.
  sprite.userData = { isLabel: true, aspect: w / h, screenPx };
  return sprite;
}

// Per-frame label resizing — keeps plane scale ticks at a constant pixel
// height. A Sprite at world position p projects to screen with
//   screen_h = world_h * renderH / (2·tan(fov/2)·dist)
// so to hold screen_h fixed, world_h must scale with dist.
function updateLabelScales() {
  if (!galPlane.visible) return;
  const renderH = renderer.domElement.height;
  const pxFactor = 2 * Math.tan(camera.fov * Math.PI / 360) / renderH;
  const cam = camera.position;
  for (const child of galPlane.children) {
    const ud = child.userData;
    if (!ud || !ud.isLabel) continue;
    const dist = cam.distanceTo(child.position);
    const wH = ud.screenPx * pxFactor * dist;
    child.scale.set(wH * ud.aspect, wH, 1);
  }
}

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
  // Radial scale on the +X axis (toward galactic center), every 40 ly.
  for (const r of [40, 80, 120, 160, 200]) {
    const lbl = makeTextSprite(`${r} ly`, { color: '#5ad99a', fontPx: 32, screenPx: 23 });
    lbl.position.set(r, 6, 0.1);
    galPlane.add(lbl);
  }
  // Galactic-longitude ticks at 30° increments, on a circle just outside the
  // outermost ring. l=0 is +X (galactic centre); l grows counterclockwise
  // when viewed from +Z (NGP), which in scene coords is the -Y direction.
  const labelR = 218;
  for (let deg = 0; deg < 360; deg += 30) {
    const a = deg * Math.PI / 180;
    const text = deg === 0 ? '0° (GC)' : deg === 180 ? '180° (anti-GC)' : `${deg}°`;
    const lbl = makeTextSprite(text, { color: '#7ee5a8', fontPx: 28, screenPx: 19 });
    lbl.position.set(labelR * Math.cos(a), -labelR * Math.sin(a), 0.1);
    galPlane.add(lbl);
  }
}

// ─── projection of a pinned star onto the galactic plane ────────────────
// Drawn only when the plane is enabled AND a star is pinned. Shows a dashed
// vertical drop from the star to the plane (visualises galactic latitude /
// height above the plane) + a radial line from the Sun to the projection.
const starProjection = new THREE.Group();
scene.add(starProjection);

function clearStarProjection() {
  for (const child of starProjection.children) {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
  starProjection.clear();
}

function updateStarProjection() {
  clearStarProjection();
  if (!galPlane.visible || !pinnedStar || pinnedStar.isSun) return;
  const x = pinnedStar.gx, y = pinnedStar.gy, z = pinnedStar.gz;
  // Vertical drop: star → its perpendicular foot on the galactic plane.
  const dropMat = new THREE.LineBasicMaterial({
    color: 0x5ad99a, transparent: true, opacity: 0.85,
  });
  const dropGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, y, z),
    new THREE.Vector3(x, y, 0),
  ]);
  starProjection.add(new THREE.Line(dropGeo, dropMat));
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
let pinnedStar   = null;

function _row(k, v) {
  return `<div class="k">${k}</div><div class="v">${v}</div>`;
}
function buildStarBody(d) {
  let html = '<div class="star-card">';
  if (d.isSun) {
    html += _row('Type',       d.sp);
    html += _row('App. mag',   d.vmag);
    html += _row('Note',       'our home star');
    return html + '</div>';
  }
  html += _row('Distance', `${d.distLy.toFixed(3)} ly  ·  ${(d.distLy/3.26156).toFixed(3)} pc`);
  html += _row(d.isCurated ? 'V mag' : 'G mag', d.vmag.toFixed(2));
  html += _row('Type',      d.sp || '—');
  if (d.bp_rp != null) html += _row('BP–RP', d.bp_rp.toFixed(2));
  html += _row('Gal. XYZ',  `${d.gx.toFixed(2)}, ${d.gy.toFixed(2)}, ${d.gz.toFixed(2)} ly`);
  html += _row('RA / Dec',  `${d.ra.toFixed(3)}°, ${d.dec.toFixed(3)}°`);
  if (d.planets && d.planets.length > 0) {
    html += `<div class="section">Planet System <span class="count">· ${d.planets.length}</span></div>`;
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
      const bits = [r, m, a, T, Te].filter(Boolean).join(' · ') || '—';
      html += `<div class="pname">${p.name}</div><div class="pdetail">${bits}</div>`;
    }
    if (d.planets.length > 8) {
      html += `<div class="more">…+${d.planets.length - 8} more</div>`;
    }
  }
  return html + '</div>';
}

function renderInfoPanel() {
  if (pinnedStar) {
    infoTitle.textContent = pinnedStar.name;
    infoBody.innerHTML = buildStarBody(pinnedStar);
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
  if (!pinnedStar) renderInfoPanel();
}
function pinStar(d)  { pinnedStar = d;    renderInfoPanel(); updateStarProjection(); }
function unpinStar() { pinnedStar = null; renderInfoPanel(); updateStarProjection(); }

infoHead.addEventListener('click', () => infoEl.classList.toggle('collapsed'));
infoUnpin.addEventListener('click', (e) => { e.stopPropagation(); unpinStar(); });

renderInfoPanel();

// Great-circle angular separation between two RA/Dec points, in degrees.
function angSepDeg(ra1, dec1, ra2, dec2) {
  const D = Math.PI / 180;
  const d1 = dec1 * D, d2 = dec2 * D;
  const dRa  = (ra2 - ra1) * D;
  const dDec = d2 - d1;
  const a = Math.sin(dDec/2)**2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dRa/2)**2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / D;
}

// Merge each Gaia DR3 orphan that's the same star as a curated entry into
// that curated entry: take the more recent (J2016) GAIA position, fill in
// bp_rp / gaia_id, and move planets across. Match window is wide on the sky
// (≤ 0.06° ≈ 216″ — covers Barnard's 16-yr proper motion) but tight on
// distance (Δ < 0.02 ly), so unrelated stars never trip it.
function dedupCuratedGaiaOrphans(stars) {
  const drop = new Set();
  let merged = 0, plMoved = 0;
  for (const c of stars) {
    if (!c.isCurated || c.distLy == null) continue;
    for (const g of stars) {
      if (g === c || g.isCurated || drop.has(g)) continue;
      if (typeof g.name !== 'string' || !g.name.startsWith('Gaia DR3')) continue;
      if (Math.abs(g.distLy - c.distLy) > 0.02) continue;
      if (angSepDeg(c.ra, c.dec, g.ra, g.dec) > 0.06) continue;
      if (c.bp_rp == null && g.bp_rp != null) c.bp_rp   = g.bp_rp;
      if (!c.gaia_id && g.gaia_id)            c.gaia_id = g.gaia_id;
      c.ra  = g.ra;
      c.dec = g.dec;
      if (g.planets && g.planets.length) {
        c.planets = (c.planets || []).concat(g.planets);
        plMoved  += g.planets.length;
      }
      drop.add(g);
      merged++;
      break;
    }
  }
  if (merged) console.log(`[dedup] merged ${merged} GAIA orphans into curated stars (${plMoved} planets moved)`);
  return drop.size ? stars.filter(s => !drop.has(s)) : stars;
}

// Any GAIA-only star that still wears its source-id name but happens to host
// confirmed exoplanets gets renamed to the NASA Archive's `hostname`, which
// is the human designation (GJ 887, eps Ind A, HD 180617, Teegarden's Star,
// …). Cheap rename, hundreds of stars become recognisable.
function promoteHostNames(stars) {
  let renamed = 0;
  for (const s of stars) {
    if (s.isCurated) continue;
    if (typeof s.name !== 'string' || !s.name.startsWith('Gaia DR3')) continue;
    if (!s.planets || s.planets.length === 0) continue;
    const host = s.planets[0].host;
    if (host && host !== s.name) { s.name = host; renamed++; }
  }
  if (renamed) console.log(`[names] promoted ${renamed} GAIA stars to their exoplanet host designation`);
}

async function loadStars() {
  let data;
  try {
    data = await fetch('./data/stars.json?v=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
  } catch (e) {
    setSummary('Failed to load catalog', e.message);
    return;
  }
  // build_dataset.py's 60″ curated↔GAIA match misses high-proper-motion
  // stars (J2000 SIMBAD vs J2016 GAIA — Barnard's, Proxima, Lalande 21185,
  // Wolf 359, …). They leak through as "Gaia DR3 …" orphans, and
  // attach_planets binds exoplanets to those orphans instead of the curated
  // entry. Reunite them client-side until the catalog is rebuilt.
  data = dedupCuratedGaiaOrphans(data);
  promoteHostNames(data);
  STARS = data;
  // Sort ascending by distance so the slider can slice "the N closest" via
  // the uVisibleCount uniform (which simply rejects vertices with aIndex >=
  // visibleStarCount). Curated stars naturally land near the front because
  // they're physically nearby; tie-break keeps named ones first.
  data.sort((a, b) => {
    if (a.distLy !== b.distLy) return a.distLy - b.distLy;
    return (b.isCurated ? 1 : 0) - (a.isCurated ? 1 : 0);
  });

  const CHUNK = 2000;                       // Points means upload is per-chunk, not per-sprite
  for (let i = 0; i < data.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, data.length);
    for (let j = i; j < end; j++) addStar(data[j]);
    commitStars();
    setSummary('Loading…', `${end.toLocaleString()} / ${data.length.toLocaleString()} stars`);
    refreshCountLabel(visibleStarCount);   // distLy of the Nth-closest grows as more stream in
    // Yield to the browser so each chunk is visible during load.
    await new Promise(r => requestAnimationFrame(r));
  }

  // Sun→star sightlines: 50 closest. starData is already distance-sorted.
  for (let i = 0; i < Math.min(50, starCount); i++) {
    addSunLineForStar(i);
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
  visibleStarCount = Math.max(0, n);
  starMat.uniforms.uVisibleCount.value = visibleStarCount;
  // Rings live outside the Points geometry, so they need their own gating.
  for (const ring of planetHostRings.children) {
    ring.visible = ring.userData.starIdx < visibleStarCount;
  }
}

// ─── hover + click-pick via screen-space projection ──────────────────────
// Raycasting 100 k Sprite objects per frame was costing ms — and Points
// raycasting with per-vertex sizes is unreliable. Instead: project visible
// points to screen each query and find the closest within a pixel
// threshold. ~100 k float ops per query → <1 ms.
const hover = document.getElementById('hover');
let lastMouse = null;
const _hoverProj = new THREE.Vector3();
const PICK_PX = 14;

renderer.domElement.addEventListener('mousemove', (e) => { lastMouse = e; });
renderer.domElement.addEventListener('mouseleave', () => {
  lastMouse = null; hover.style.display = 'none';
});

function pickAt(clientX, clientY) {
  const halfW = window.innerWidth  * 0.5;
  const halfH = window.innerHeight * 0.5;
  let bestData = null;
  let bestPx2  = PICK_PX * PICK_PX;

  // Test the Sun first (always visible at origin).
  _hoverProj.set(0, 0, 0).project(camera);
  if (_hoverProj.z > -1 && _hoverProj.z < 1) {
    const sx = halfW + _hoverProj.x * halfW;
    const sy = halfH - _hoverProj.y * halfH;
    const d2 = (sx - clientX) * (sx - clientX) + (sy - clientY) * (sy - clientY);
    if (d2 < bestPx2) { bestPx2 = d2; bestData = sun.userData; }
  }

  const visible = Math.min(visibleStarCount, starCount);
  for (let i = 0; i < visible; i++) {
    _hoverProj.set(
      starPositions[i*3], starPositions[i*3+1], starPositions[i*3+2],
    ).project(camera);
    if (_hoverProj.z <= -1 || _hoverProj.z >= 1) continue;
    const sx = halfW + _hoverProj.x * halfW;
    const sy = halfH - _hoverProj.y * halfH;
    const dx = sx - clientX, dy = sy - clientY;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestPx2) { bestPx2 = d2; bestData = starData[i]; }
  }
  return bestData;
}

function updateHover() {
  if (!lastMouse) { hover.style.display = 'none'; return; }
  const d = pickAt(lastMouse.clientX, lastMouse.clientY);
  if (!d) { hover.style.display = 'none'; return; }
  hover.innerHTML = `<div class="hover-name">${d.name}</div>` + buildStarBody(d);
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
  const hit = pickAt(e.clientX, e.clientY);
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
  updateStarProjection();
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
  const eff = Math.min(n, starCount || n);
  countLabel.textContent = eff.toLocaleString();
  if (starCount > 0 && eff > 0) {
    rangeLabel.textContent = fmtLy(starData[Math.min(eff, starCount) - 1].distLy);
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
// a brightness scalar. The value flows into the uBrightMul uniform; the
// Sun (still a Sprite) gets its world scale updated via applySunSize().
let brightnessMul = 1.0;
const brightSlider = document.getElementById('brightSlider');
const brightLabel  = document.getElementById('brightLabel');
function applyBrightness(v) {
  brightnessMul = Math.max(0.5, Math.min(5, v));
  brightLabel.textContent = brightnessMul.toFixed(brightnessMul < 1 ? 2 : 1);
  starMat.uniforms.uBrightMul.value = brightnessMul;
  applySunSize();
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
  starMat.uniforms.uPxScale.value = makePxScale();   // world-size → pixel-size depends on render height
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
// Stars are sized by uBrightMul on the GPU — this just resizes the Sun
// sprite (which is still a Sprite, not part of the Points geometry).
function applySunSize() {
  const sunSz = sizeForAbsMag(SUN_ABS_MAG) * brightnessMul;
  sun.scale.set(sunSz, sunSz, sunSz);
  sunHalo.scale.set(sunSz * 3.2, sunSz * 3.2, sunSz * 3.2);
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
  updateLabelScales();
  updateHover();
  viewdistEl.textContent = fmtLy(camera.position.distanceTo(controls.target));
  renderer.render(scene, camera);
}
loop();

// Kick off streaming load after the first frame is rendered.
loadStars();
