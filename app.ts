// ---------------------------------------------------------------------------
// COSMIC ZOOM  —  from the Solar System out to the Observable Universe.
// Implemented from COSMIC_ZOOM_SPECIFICATION.md
//
// Architectural decisions (see spec §1.2, §4, §6):
//  - World units: 1 unit = 1 light-year (ly). Galactic coordinates:
//    Sagittarius A* at (0, 0, 0); the Sun sits at (18850, 65, 18850) ly,
//    ~26,660 ly from the galactic centre on the Orion–Cygnus Spur.
//  - The existing Solar System is kept as a self-contained PivotGroup
//    (internal local units unchanged) placed at the Sun anchor, scaled
//    SOLAR_SCALE so the planets occupy a tiny fraction of a light-year.
//    Individually large world offsets cancel in double precision on the CPU,
//    so the GPU only ever receives small model-view matrices ("floating
//    origin" benefit of nested transforms, spec §6.2).
//  - Logarithmic camera zoom: CamDistance(t) = Base * 10^(k*t) (spec §1.2,
//    §4). One custom controller replaces OrbitControls' linear dolly.
//  - Logarithmic depth buffer on the renderer prevents Z-fighting over the
//    15+ orders of magnitude between near and far planes (spec §6.2).
//  - LOD alpha cross-fade: each of the 9 levels is its own group with a
//    log-distance band; opacity is tweened ("opacity tweening", spec §6.3)
//    so adjacent levels blend smoothly instead of popping.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CatmullRomCurve3 } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
if (!canvas) throw new Error('missing canvas #scene');

// -- renderer with logarithmic depth buffer ---------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060c);

// near plane tiny (tens of thousands of a ly inside the solar system),
// far plane ~1.2e11 ly (beyond the 46.5-Gly observable boundary)
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1e-4, 2.5e11);
const cosmosLabels: THREE.Sprite[] = []; // screen-constant label registry (declared early)

// ---------------------------------------------------------------------------
// Core astronomical anchors (world units = ly)
// ---------------------------------------------------------------------------
const SUN_ANCHOR = new THREE.Vector3(18850, 65, 18850); // ~26,660 ly from centre, Orion Spur
const GAL_CENTER = new THREE.Vector3(0, 0, 0); // Sagittarius A*
const SOLAR_SCALE = 0.002; // solar-system local unit -> ly (planets fit inside a fraction of a ly)

// ---------------------------------------------------------------------------
// Procedural surface textures (unchanged identical generators)
// ---------------------------------------------------------------------------
function hexLum(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function grayCss(l: number): string {
  const v = Math.round(Math.min(255, Math.max(0, l)));
  return `rgb(${v},${v},${v})`;
}

interface SurfaceSpec {
  base: string;
  bands?: { color: string; y: number; h: number }[];
  blobs?: { color: string; count: number; size: number; squash: number }[];
  craters?: number;
  grain?: number;
}

const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

function buildSurface(spec: SurfaceSpec, width = 1024, height = 512): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const map = document.createElement('canvas');
  map.width = width;
  map.height = height;
  const mctx = map.getContext('2d')!;
  mctx.fillStyle = spec.base;
  mctx.fillRect(0, 0, width, height);

  const bump = document.createElement('canvas');
  bump.width = width;
  bump.height = height;
  const bctx = bump.getContext('2d')!;
  const baseLum = 90 + hexLum(spec.base) * 70;
  bctx.fillStyle = grayCss(baseLum);
  bctx.fillRect(0, 0, width, height);

  if (spec.bands) {
    for (const b of spec.bands) {
      mctx.fillStyle = b.color;
      mctx.fillRect(0, b.y * height, width, b.h * height);
      bctx.fillStyle = grayCss(baseLum + (hexLum(b.color) - hexLum(spec.base)) * 90);
      bctx.fillRect(0, b.y * height, width, b.h * height);
    }
  }

  if (spec.blobs) {
    for (const blob of spec.blobs) {
      for (let i = 0; i < blob.count; i++) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const rx = (Math.random() * 0.6 + 0.4) * blob.size;
        const ry = rx * blob.squash;
        const g = mctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
        g.addColorStop(0, blob.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        mctx.beginPath();
        mctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        mctx.fillStyle = g;
        mctx.fill();
        const bg = bctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
        const lum = 70 + hexLum(blob.color) * 130;
        bg.addColorStop(0, grayCss(lum));
        bg.addColorStop(1, 'rgba(0,0,0,0)');
        bctx.beginPath();
        bctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        bctx.fillStyle = bg;
        bctx.fill();
      }
    }
  }

  if (spec.craters) {
    for (let i = 0; i < spec.craters; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 4 + Math.random() * 14;
      mctx.beginPath();
      mctx.arc(x, y, r, 0, Math.PI * 2);
      mctx.fillStyle = 'rgba(0,0,0,0.28)';
      mctx.fill();
      mctx.beginPath();
      mctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
      mctx.fillStyle = 'rgba(255,255,255,0.14)';
      mctx.fill();
      bctx.beginPath();
      bctx.arc(x, y, r, 0, Math.PI * 2);
      bctx.fillStyle = grayCss(baseLum - (20 + Math.random() * 30));
      bctx.fill();
      bctx.strokeStyle = grayCss(baseLum + 22);
      bctx.lineWidth = 2;
      bctx.beginPath();
      bctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
      bctx.stroke();
    }
  }

  if (spec.grain) {
    const img = mctx.getImageData(0, 0, width, height);
    const data = img.data;
    const amp = Math.round(spec.grain * 22);
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() - 0.5) * 2 * amp;
      data[i] += n;
      data[i + 1] += n;
      data[i + 2] += n;
    }
    mctx.putImageData(img, 0, 0);
    const bimg = bctx.getImageData(0, 0, width, height);
    const bdata = bimg.data;
    const bamp = Math.round(spec.grain * 30);
    for (let i = 0; i < bdata.length; i += 4) {
      bdata[i] += (Math.random() - 0.5) * 2 * bamp;
      bdata[i + 1] = bdata[i];
      bdata[i + 2] = bdata[i];
    }
    bctx.putImageData(bimg, 0, 0);
  }

  const mapTex = new THREE.CanvasTexture(map);
  mapTex.colorSpace = THREE.SRGBColorSpace;
  mapTex.wrapS = THREE.RepeatWrapping;
  mapTex.anisotropy = MAX_ANISO;
  const bumpTex = new THREE.CanvasTexture(bump);
  bumpTex.wrapS = THREE.RepeatWrapping;
  bumpTex.anisotropy = MAX_ANISO;
  return { map: mapTex, bump: bumpTex };
}

const earth = buildSurface({
  base: '#1f6fd0',
  blobs: [
    { color: '#2f9e4f', count: 60, size: 34, squash: 0.5 },
    { color: '#e8e4d0', count: 30, size: 20, squash: 0.4 },
    { color: '#1a57a8', count: 34, size: 42, squash: 0.7 },
    { color: '#3d7dd8', count: 20, size: 28, squash: 0.7 },
  ],
  grain: 0.05,
});
const moonSurf = buildSurface({
  base: '#9a9a95',
  blobs: [
    { color: '#6c6c68', count: 60, size: 12, squash: 0.6 },
    { color: '#c8c4ba', count: 30, size: 8, squash: 0.7 },
  ],
  craters: 70,
  grain: 0.12,
});
const mercury = buildSurface({
  base: '#8f877b',
  blobs: [
    { color: '#6f685f', count: 20, size: 16, squash: 0.7 },
    { color: '#a9a297', count: 14, size: 10, squash: 0.7 },
  ],
  craters: 90,
  grain: 0.14,
});
const venus = buildSurface({
  base: '#e3c37c',
  bands: [
    { color: '#dcb468', y: 0.1, h: 0.08 },
    { color: '#f0d9a0', y: 0.25, h: 0.1 },
    { color: '#e8c98a', y: 0.5, h: 0.22 },
    { color: '#f2dba6', y: 0.8, h: 0.12 },
  ],
  blobs: [{ color: '#fbe7bd', count: 26, size: 16, squash: 0.7 }],
  grain: 0.05,
});
const mars = buildSurface({
  base: '#c95b2e',
  blobs: [
    { color: '#8f3a1e', count: 26, size: 26, squash: 0.6 },
    { color: '#b8492c', count: 20, size: 18, squash: 0.7 },
    { color: '#e8a173', count: 12, size: 10, squash: 0.6 },
  ],
  craters: 40,
  grain: 0.1,
});
const jupiter = buildSurface({
  base: '#dcc08a',
  bands: [
    { color: '#c9c2b0', y: 0.04, h: 0.05 },
    { color: '#b97b3c', y: 0.15, h: 0.09 },
    { color: '#efe2c0', y: 0.29, h: 0.17 },
    { color: '#c9884a', y: 0.5, h: 0.11 },
    { color: '#efe2c0', y: 0.65, h: 0.15 },
    { color: '#b97b3c', y: 0.84, h: 0.09 },
    { color: '#8a5a2c', y: 0.95, h: 0.05 },
  ],
  blobs: [{ color: '#e8d8b0', count: 40, size: 9, squash: 0.18 }],
  grain: 0.03,
});
const saturn = buildSurface({
  base: '#e6cf9a',
  bands: [
    { color: '#d9bd86', y: 0.08, h: 0.09 },
    { color: '#f2e7c8', y: 0.24, h: 0.13 },
    { color: '#c9a86a', y: 0.5, h: 0.22 },
    { color: '#f2e7c8', y: 0.78, h: 0.13 },
    { color: '#c9a86a', y: 0.92, h: 0.08 },
  ],
  grain: 0.04,
});
const uranus = buildSurface({
  base: '#9fd9dd',
  blobs: [
    { color: '#8ecfd4', count: 10, size: 30, squash: 0.6 },
    { color: '#b3e4e6', count: 10, size: 16, squash: 0.7 },
  ],
  grain: 0.02,
});
const neptune = buildSurface({
  base: '#3a6cff',
  bands: [
    { color: '#3160e8', y: 0.18, h: 0.12 },
    { color: '#4a7bff', y: 0.5, h: 0.2 },
    { color: '#2d58d8', y: 0.8, h: 0.12 },
  ],
  blobs: [{ color: '#7fc0ff', count: 12, size: 10, squash: 0.5 }],
  grain: 0.04,
});
const sunSurf = buildSurface({
  base: '#ffc24d',
  blobs: [
    { color: '#ff8f1f', count: 240, size: 14, squash: 0.8 },
    { color: '#ffe08a', count: 180, size: 8, squash: 0.8 },
    { color: '#ffb04d', count: 140, size: 22, squash: 0.9 },
  ],
  grain: 0.1,
});

const SURF: Record<string, { map: THREE.CanvasTexture; bump: THREE.CanvasTexture }> = {
  Mercury: mercury,
  Venus: venus,
  Earth: earth,
  Mars: mars,
  Jupiter: jupiter,
  Saturn: saturn,
  Uranus: uranus,
  Neptune: neptune,
};

// ---------------------------------------------------------------------------
// Level 0 — Solar System (PivotGroup, internal logic untouched)
// ---------------------------------------------------------------------------
const SUN_RADIUS = 2.6;
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(SUN_RADIUS, 128, 96),
  new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xffb43a,
    emissiveMap: sunSurf.map,
    emissiveIntensity: 2.4,
    roughness: 1,
    bumpMap: sunSurf.bump,
    bumpScale: 0.25,
  }),
);

const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,200,90,1)');
  g.addColorStop(0.25, 'rgba(255,150,40,0.55)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const glow = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
);
glow.scale.setScalar(11);

// light scaled to the compressed (0.002x) local distances so the planets
// keep roughly the same lit look as the original build
const sunLight = new THREE.PointLight(0xffd9a0, 0.048, 1.2, 1.7);

const ambient = new THREE.AmbientLight(0x3f4e78, 0.175);
scene.add(ambient);

interface PlanetSpec {
  name: string;
  radius: number;
  orbit: number;
  speed: number;
  rotSpeed: number;
  tilt: number;
  color: number;
  ring?: boolean;
  bumpScale: number;
  phase: number;
}

const EARTH_ORBIT = 9.4;
const EARTH_SPEED = 1.0;
const MOON_ORBITS_PER_EARTH_YEAR = 365.25 / 27.32;
const MOON_ORBIT_DIST = 1.15;
const MOON_RADIUS = 0.17;

const PLANETS: PlanetSpec[] = [
  { name: 'Mercury', radius: 0.34, orbit: 5.2, speed: 0, rotSpeed: 0.05, tilt: 0.0, color: 0x8f877b, bumpScale: 0.8, phase: 2.6 },
  { name: 'Venus', radius: 0.55, orbit: 7.2, speed: 0, rotSpeed: -0.03, tilt: 0.05, color: 0xe3c37c, bumpScale: 0.3, phase: 4.1 },
  { name: 'Earth', radius: 0.62, orbit: EARTH_ORBIT, speed: 0, rotSpeed: 0.06, tilt: 0.41, color: 0xffffff, bumpScale: 0.5, phase: 0.8 },
  { name: 'Mars', radius: 0.46, orbit: 11.6, speed: 0, rotSpeed: 0.06, tilt: 0.44, color: 0xffffff, bumpScale: 0.7, phase: 5.3 },
  { name: 'Jupiter', radius: 1.55, orbit: 15.4, speed: 0, rotSpeed: 0.18, tilt: 0.05, color: 0xffffff, bumpScale: 0.3, phase: 1.9 },
  { name: 'Saturn', radius: 1.35, orbit: 19.6, speed: 0, rotSpeed: 0.16, tilt: 0.47, color: 0xffffff, ring: true, bumpScale: 0.3, phase: 3.4 },
  { name: 'Uranus', radius: 0.95, orbit: 23.6, speed: 0, rotSpeed: 0.05, tilt: 1.71, color: 0x9fd9dd, bumpScale: 0.15, phase: 0.3 },
  { name: 'Neptune', radius: 0.9, orbit: 27.6, speed: 0, rotSpeed: 0.05, tilt: 0.5, color: 0x3a6cff, bumpScale: 0.25, phase: 2.1 },
];
for (const s of PLANETS) {
  s.speed = EARTH_SPEED * Math.pow(EARTH_ORBIT / s.orbit, 1.5);
}

const planetGroup = new THREE.Group();
const planets: { pivot: THREE.Object3D; mesh: THREE.Mesh; spec: PlanetSpec; moon?: THREE.Mesh }[] = [];

function addRim(mesh: THREE.Mesh, intensity = 0.85, power = 2.6, color = 0x6fc3ff): void {
  const rim = new THREE.Mesh(
    mesh.geometry,
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: intensity },
        uPower: { value: power },
      },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uPower;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float rim = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), uPower);
          gl_FragColor = vec4(uColor, rim * uIntensity);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  rim.scale.setScalar(1.03);
  mesh.add(rim);
  mesh.userData.rim = rim.material as THREE.ShaderMaterial;
  mesh.userData.rimBase = intensity;
}

for (const spec of PLANETS) {
  const pivot = new THREE.Object3D();
  pivot.userData.spec = spec;
  planetGroup.add(pivot);

  const surf = SURF[spec.name];
  const mat = new THREE.MeshStandardMaterial({
    color: surf ? 0xffffff : spec.color,
    map: surf?.map,
    bumpMap: surf?.bump,
    bumpScale: spec.bumpScale,
    roughness: spec.name === 'Earth' ? 0.75 : 0.55,
    metalness: 0.02,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 96, 64), mat);
  mesh.rotation.z = spec.tilt;
  mesh.userData.spec = spec;
  pivot.add(mesh);
  addRim(mesh);

  const entry: { pivot: THREE.Object3D; mesh: THREE.Mesh; spec: PlanetSpec; moon?: THREE.Mesh } = {
    pivot,
    mesh,
    spec,
  };

  if (spec.ring) {
    const inner = spec.radius * 1.3;
    const outer = spec.radius * 2.4;
    const ringSurf = buildSurface({
      base: '#cbb183',
      bands: [
        { color: '#e8ddc0', y: 0.2, h: 0.1 },
        { color: '#a8885f', y: 0.45, h: 0.12 },
        { color: '#b9a077', y: 0.7, h: 0.1 },
        { color: '#d9c49a', y: 0.9, h: 0.08 },
      ],
      grain: 0.06,
    }, 1024, 64);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 128, 8),
      new THREE.MeshStandardMaterial({
        map: ringSurf.map,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        roughness: 0.8,
        color: 0xffffff,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = 0.12;
    mesh.add(ring);
  }

  if (spec.name === 'Earth') {
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(MOON_RADIUS, 64, 48),
      new THREE.MeshStandardMaterial({ map: moonSurf.map, color: 0xffffff, roughness: 0.9, bumpMap: moonSurf.bump, bumpScale: 0.8 }),
    );
    moon.userData.spec = { name: 'Moon', radius: MOON_RADIUS, orbit: MOON_ORBIT_DIST, speed: 0, rotSpeed: 0.02, tilt: 0.1, color: 0xffffff, bumpScale: 0.8, phase: 1.2 };
    pivot.add(moon);
    addRim(moon, 0.35, 2.4);
    entry.moon = moon;
  }

  planets.push(entry);
}

const orbitLines = new THREE.Group();
for (const spec of PLANETS) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * spec.orbit, 0, Math.sin(a) * spec.orbit));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x3a4356, transparent: true, opacity: 0.5 }),
  );
  orbitLines.add(line);
}

const beltCount = 4200;
const belt = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.12, 0.1, 0.12),
  new THREE.MeshStandardMaterial({ color: 0x8d8577, roughness: 1 }),
  beltCount,
);
const dummy = new THREE.Object3D();
for (let i = 0; i < beltCount; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = 12.5 + Math.random() * 2.6;
  const y = (Math.random() - 0.5) * 0.8;
  dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
  dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  dummy.scale.setScalar(0.6 + Math.random() * 1.4);
  dummy.updateMatrix();
  belt.setMatrixAt(i, dummy.matrix);
}
belt.instanceMatrix.needsUpdate = true;
belt.userData.animate = true;

const solarSystem = new THREE.Group(); // Level 0 PivotGroup (spec §6.1)
solarSystem.position.copy(SUN_ANCHOR);
solarSystem.scale.setScalar(SOLAR_SCALE);
solarSystem.add(sun, glow, sunLight, planetGroup, orbitLines, belt);
scene.add(solarSystem);

// bright point marking the collapsed solar system when zoomed out
// (spec §4 Level 1: "Hệ Mặt Trời thành 1 chấm sáng")
const sunPointGroup = new THREE.Group();
sunPointGroup.userData.lod = { c: 1.5, w: 2.4 };
const sunPoint = makeGlowSprite('rgba(255,210,120,1)', 'rgba(255,150,50,0.55)', 1.6, 1);
sunPoint.position.copy(SUN_ANCHOR);
sunPointGroup.add(sunPoint);
const sunPointLabel = makeLabel('Mặt Trời', 2.6, '#ffd07a', 'rgba(6,10,20,0.5)', 26);
sunPointLabel.position.copy(SUN_ANCHOR).add(new THREE.Vector3(0, 1.8, 0));
sunPointGroup.add(sunPointLabel);
scene.add(sunPointGroup);

// ---------------------------------------------------------------------------
// Post-processing (bloom)
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.35, 0.16);
composer.addPass(bloom);

// ---------------------------------------------------------------------------
// Generic procedural helpers for the cosmic layers
// ---------------------------------------------------------------------------
function randomGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makePoints(positions: number[], colors: number[], size: number, opacity = 1, dim: { center: THREE.Vector3; ref: number } | null = null): THREE.Points {
  if (dim) {
    for (let o = 0; o < positions.length; o += 3) {
      const dx = positions[o] - dim.center.x;
      const dy = positions[o + 1] - dim.center.y;
      const dz = positions[o + 2] - dim.center.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const f = 1 / (1 + d / dim.ref);
      colors[o] *= f;
      colors[o + 1] *= f;
      colors[o + 2] *= f;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Points(g, m);
}
function makeGlowSprite(inner: string, outer: string, size: number, opacity = 1): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, inner);
  g.addColorStop(0.28, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  s.renderOrder = 3;
  return s;
}
function makeLabel(text: string, hWorld: number, color = '#ffd07a', bg = 'rgba(6,10,20,0.55)', px = 28): THREE.Sprite {
  const c = document.createElement('canvas');
  const fs = 72;
  const tmp = document.createElement('canvas').getContext('2d')!;
  tmp.font = `600 ${fs}px ui-sans-serif,system-ui,sans-serif`;
  const tw = tmp.measureText(text).width;
  c.width = Math.ceil(tw + 64);
  c.height = fs + 40;
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${fs}px ui-sans-serif,system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = bg;
  ctx.fillRect(30, 16, c.width - 60, c.height - 32);
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  const aspect = c.width / c.height;
  s.userData.baseWorld = hWorld;
  s.userData.px = px;
  s.userData.asp = aspect;
  s.scale.set(hWorld * aspect, hWorld, 1);
  s.renderOrder = 9;
  cosmosLabels.push(s);
  return s;
}
const lblPos = new THREE.Vector3();
const lblParentScale = new THREE.Vector3();
const lblTanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
// Screen-constant labels: keep each text a fixed pixel height so it never
// covers the scene no matter how close you zoom ("gờ chỉnh khoảng cách rõ").
function updateCosmosLabels(): void {
  const vh = window.innerHeight;
  if (vh < 1) return;
  const tw = (2 * lblTanHalf) / vh;
  for (const s of cosmosLabels) {
    if (!s.visible) continue;
    s.getWorldPosition(lblPos);
    const d = lblPos.distanceTo(camera.position);
    if (d < 1e-6) continue;
    let pwsY = 1;
    if (s.parent) {
      s.parent.getWorldScale(lblParentScale);
      pwsY = Math.max(1e-9, Math.abs(lblParentScale.y));
    }
    const H = (d * (s.userData.px as number) * tw) / pwsY;
    const asp = s.userData.asp as number;
    s.scale.set(H * asp, H, 1);
  }
}
function galaxySprite(size: number, warm: number, opacity = 1): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
  if (warm > 0) {
    g.addColorStop(0, 'rgba(255,255,235,1)');
    g.addColorStop(0.18, `rgba(255,220,150,${opacity * 0.9})`);
    g.addColorStop(0.45, `rgba(255,170,150,${opacity * 0.35})`);
    g.addColorStop(1, 'rgba(255,150,160,0)');
  } else {
    g.addColorStop(0, 'rgba(235,245,255,1)');
    g.addColorStop(0.18, `rgba(170,200,255,${opacity * 0.9})`);
    g.addColorStop(0.45, `rgba(120,150,235,${opacity * 0.35})`);
    g.addColorStop(1, 'rgba(90,120,220,0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(size, size * 0.45, 1);
  s.renderOrder = 3;
  return s;
}
function galaxyHaloPoints(center: THREE.Vector3, rad: number, count: number, size: number, col: THREE.Color): THREE.Points {
  const pos: number[] = [];
  const cols: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = rad * (0.35 + Math.random() * 0.65);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    pos.push(center.x + r * Math.sin(ph) * Math.cos(th), center.y + r * Math.cos(ph) * 0.32, center.z + r * Math.sin(ph) * Math.sin(th));
    const j = 0.5 + Math.random() * 0.5;
    cols.push(col.r * j, col.g * j, col.b * j);
  }
  return makePoints(pos, cols, size, 0.8, { center, ref: rad });
}

// ---------------------------------------------------------------------------
// Level 1 — Local Interstellar Neighborhood & Local Bubble (10–300 ly)
// ---------------------------------------------------------------------------
function buildLocal(): THREE.Group {
  const g = new THREE.Group();
  const lvl = (v: THREE.Vector3) => v.clone().add(SUN_ANCHOR);

  const pos: number[] = [];
  const col: number[] = [];
  const fieldHex = ['#ffffff', '#ffe9c0', '#cfdfff', '#ffd2c8'];
  const ancillary = new THREE.Color();
  for (let i = 0; i < 1600; i++) {
    const r = 4 + Math.random() * 300;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    pos.push(SUN_ANCHOR.x + r * Math.sin(ph) * Math.cos(th), SUN_ANCHOR.y + r * Math.cos(ph), SUN_ANCHOR.z + r * Math.sin(ph) * Math.sin(th));
    ancillary.set(fieldHex[Math.floor(Math.random() * fieldHex.length)]);
    const j = 0.6 + Math.random() * 0.4;
    col.push(ancillary.r * j, ancillary.g * j, ancillary.b * j);
  }
  g.add(makePoints(pos, col, 0.12, 0.9, { center: SUN_ANCHOR, ref: 150 }));

  const stars: { name: string; d: number; dir: [number, number, number]; col: string; h: number }[] = [
    { name: 'Alpha Centauri', d: 4.37, dir: [-0.45, 0.62, 0.65], col: '#ffe3a8', h: 1.0 },
    { name: 'Barnard', d: 5.96, dir: [0.8, -0.15, 0.58], col: '#ffb3a0', h: 0.45 },
    { name: 'Wolf 359', d: 7.86, dir: [0.05, -0.4, 0.91], col: '#ff8f6a', h: 0.32 },
    { name: 'Sirius', d: 8.6, dir: [0.32, 0.5, -0.8], col: '#d9f0ff', h: 1.1 },
    { name: 'Vega', d: 25, dir: [-0.9, 0.35, -0.2], col: '#cfdbff', h: 0.85 },
    { name: 'Arcturus', d: 36.7, dir: [0.6, -0.55, 0.58], col: '#ffc88a', h: 0.8 },
    { name: 'Aldebaran', d: 65, dir: [0.2, 0.45, -0.87], col: '#ffb069', h: 0.75 },
  ];
  const extraStars: { name: string; d: number; col: string; h: number }[] = [
    { name: 'Lalande 21185', d: 8.3, col: '#ffb98a', h: 0.4 },
    { name: 'Epsilon Eridani', d: 10.5, col: '#ffc488', h: 0.45 },
    { name: 'Procyon', d: 11.4, col: '#fff3d8', h: 0.7 },
    { name: '61 Cygni', d: 11.4, col: '#ffc488', h: 0.4 },
    { name: 'Tau Ceti', d: 11.9, col: '#fff0b0', h: 0.5 },
  ];
  extraStars.forEach((st, i) => {
    const stx = Math.sin(i * 2.399 + 1.7) * Math.cos(i * 0.7);
    const sty = Math.sin(i * 1.31 + 0.4) * 0.6;
    const stz = Math.cos(i * 1.91 + 0.9);
    stars.push({ name: st.name, d: st.d, dir: [stx, sty, stz], col: st.col, h: st.h });
  });
  for (const st of stars) {
    const p = new THREE.Vector3(...st.dir).normalize().multiplyScalar(st.d);
    const w = lvl(p);
    const glow = makeGlowSprite(`rgba(255,240,220,1)`, `rgba(200,200,255,0.4)`, st.h, 1);
    glow.position.copy(w);
    glow.material.color.set(st.col);
    g.add(glow);
    const lb = makeLabel(st.name, 2.4, '#cfe0ff', 'rgba(6,10,20,0.5)', 23);
    lb.position.copy(w).add(new THREE.Vector3(0, 0.7, 0));
    g.add(lb);
  }
  // Alpha Centauri triple system (A / B / Proxima)
  const acA = new THREE.Vector3(...stars[0].dir).normalize().multiplyScalar(4.37).add(SUN_ANCHOR);
  const acB = new THREE.Vector3(acA.x + 0.03, acA.y - 0.05, acA.z + 0.04);
  const prx = new THREE.Vector3(acA.x - 0.09, acA.y + 0.1, acA.z - 0.12);
  for (const p of [acB, prx]) {
    const s = makeGlowSprite('rgba(255,210,160,1)', 'rgba(255,160,120,0.4)', 0.18, 1);
    s.position.copy(p);
    g.add(s);
  }

  // Local Bubble: faint hourglass-ish ionized gas shells around the Sun
  const bubbleColors = ['rgba(140,170,255,0.10)', 'rgba(255,180,140,0.05)', 'rgba(120,160,235,0.06)'];
  for (let i = 0; i < 7; i++) {
    const r = 70 + Math.random() * 160;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    const p = new THREE.Vector3(SUN_ANCHOR.x + r * Math.sin(ph) * Math.cos(th), SUN_ANCHOR.y + r * Math.cos(ph) * 0.55, SUN_ANCHOR.z + r * Math.sin(ph) * Math.sin(th));
    const b = makeGlowSprite(bubbleColors[i % bubbleColors.length], 'rgba(0,0,0,0)', 1, 1);
    b.position.copy(p);
    const sx = 120 + Math.random() * 220;
    b.scale.set(sx, sx * (0.6 + Math.random() * 0.7), 1);
    b.renderOrder = 1;
    g.add(b);
  }
  const bubLabel = makeLabel('Bong bóng Cục bộ · Local Bubble', 70, '#8fb4ff', 'rgba(6,10,20,0.45)', 22);
  bubLabel.position.copy(SUN_ANCHOR).add(new THREE.Vector3(160, 130, 40));
  g.add(bubLabel);
  (bubLabel.material as THREE.SpriteMaterial).opacity = 0.85;

  return g;
}

// ---------------------------------------------------------------------------
// Level 2 — Orion Arm / Orion Spur (1,000–15,000 ly)
// ---------------------------------------------------------------------------
function buildOrionArm(): THREE.Group {
  const g = new THREE.Group();
  const dir = new THREE.Vector3(0.58, 0.16, 0.8).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const perp = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp2 = new THREE.Vector3().crossVectors(dir, perp).normalize();

  function band(bias: number, count: number, size: number, opacity: number, pinkProb: number): THREE.Points {
    const pos: number[] = [];
    const col: number[] = [];
    const cWarm = new THREE.Color(0xffe9b8);
    const cCool = new THREE.Color(0xcfdfff);
    const cPink = new THREE.Color(0xffcfe6);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const u = (Math.random() * 2 - 1) * 7500;
      const lat = randomGaussian() * 240;
      const yoff = randomGaussian() * 70;
      const center = SUN_ANCHOR
        .clone()
        .addScaledVector(dir, u)
        .addScaledVector(perp, Math.sin(u * 0.0018 + bias * 1.4) * 380)
        .addScaledVector(perp2, bias * 7800);
      pos.push(center.x + perp2.x * lat, center.y + yoff, center.z + perp2.z * lat);
      const t = Math.abs(u) / 7500;
      c.copy(cCool).lerp(cWarm, t);
      if (Math.random() < pinkProb) c.copy(cPink).lerp(cWarm, Math.random() * 0.4);
      const j = 0.7 + Math.random() * 0.5;
      col.push(c.r * j, c.g * j, c.b * j);
    }
    return makePoints(pos, col, size, opacity, { center: SUN_ANCHOR, ref: 5200 });
  }

  g.add(band(0, 3000, 30, 0.9, 0.06)); // Orion Spur (our arm)
  g.add(band(1, 700, 42, 0.5, 0.03)); // Perseus arm (outer)
  g.add(band(-1, 700, 42, 0.5, 0.03)); // Sagittarius arm (inner)

  // real nebulae with their actual distances from the Sun (ly)
  const nebulae: { name: string; d: number; inner: string; outer: string; size: number }[] = [
    { name: 'Tinh vân Lạp Hộ · M42 (1.344 ly)', d: 1344, inner: 'rgba(255,190,210,0.9)', outer: 'rgba(255,130,170,0.4)', size: 300 },
    { name: 'Tinh vân Lagoon · M8 (4.100 ly)', d: 4100, inner: 'rgba(255,170,140,0.85)', outer: 'rgba(255,120,100,0.35)', size: 360 },
    { name: 'Tinh vân Đại Bàng · M16 (5.700 ly)', d: 5700, inner: 'rgba(255,195,220,0.85)', outer: 'rgba(255,140,190,0.35)', size: 340 },
    { name: 'Tinh vân Con Cua · M1 (6.500 ly)', d: 6500, inner: 'rgba(255,185,165,0.8)', outer: 'rgba(255,130,110,0.3)', size: 260 },
    { name: 'Tinh vân Carina (7.600 ly)', d: 7600, inner: 'rgba(255,200,215,0.85)', outer: 'rgba(255,140,180,0.35)', size: 380 },
  ];
  for (let i = 0; i < nebulae.length; i++) {
    const nb = nebulae[i];
    const off = ((i % 3) - 1) * 1400;
    const p = SUN_ANCHOR.clone().addScaledVector(dir, nb.d).addScaledVector(perp2, off + (Math.random() * 2 - 1) * 500);
    const neb = makeGlowSprite(nb.inner, nb.outer, nb.size, 0.9);
    neb.position.copy(p);
    g.add(neb);
    const lb = makeLabel(nb.name, 520, '#ffd3e2', 'rgba(6,10,20,0.45)', 26);
    lb.position.copy(p).add(new THREE.Vector3(0, 240, 0));
    g.add(lb);
  }

  const orionLabel = makeLabel('Nhánh Xoắn Orion', 1600, '#bcd6ff', 'rgba(6,10,20,0.45)', 26);
  orionLabel.position.copy(SUN_ANCHOR).addScaledVector(dir, 3800);
  g.add(orionLabel);
  const perLabel = makeLabel('Nhánh Perseus', 1500, '#93a9cc', 'rgba(6,10,20,0.45)', 24);
  perLabel.position.copy(SUN_ANCHOR).addScaledVector(dir, -2600).addScaledVector(perp2, 7800);
  g.add(perLabel);
  const sagLabel = makeLabel('Nhánh Sagittarius', 1500, '#93a9cc', 'rgba(6,10,20,0.45)', 24);
  sagLabel.position.copy(SUN_ANCHOR).addScaledVector(dir, 3600).addScaledVector(perp2, -7800);
  g.add(sagLabel);

  return g;
}

// ---------------------------------------------------------------------------
// Level 3 — Milky Way Galaxy (~100,000 ly diameter, 4 spiral arms)
// ---------------------------------------------------------------------------
const GALAXY_R = 52000;
const ARM_PITCH = 0.42;
const SUN_GALACTIC_LY = 26660;
const SUN_AZIMUTH = Math.atan2(SUN_ANCHOR.z, SUN_ANCHOR.x); // π/4
const ARM_0_AT_SUN = Math.log((SUN_GALACTIC_LY + 1) / 60) * ARM_PITCH;
const GALAXY_ROT_Y = SUN_AZIMUTH - ARM_0_AT_SUN;

function armOffset(theta: number, r: number, arm: number): number {
  const t = Math.log((r + 1) / 60) * ARM_PITCH + ((arm * Math.PI) / 2);
  let d = (theta - t) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
function minArmOffset(theta: number, r: number): number {
  let m = Infinity;
  for (let arm = 0; arm < 4; arm++) m = Math.min(m, armOffset(theta, r, arm));
  return m;
}

function buildGalaxy(): THREE.Group {
  const g = new THREE.Group();
  const ancillary = new THREE.Color();
  const colWarm = new THREE.Color(0xffe9b8);
  const colBlue = new THREE.Color(0xd9e6ff);
  const colPink = new THREE.Color(0xffcfe6);
  const colHalo = new THREE.Color(0xdfe8ff);

  const diskPos: number[] = [];
  const diskCol: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const r = 400 + Math.random() * (GALAXY_R - 400);
    const theta = Math.random() * Math.PI * 2;
    const armD = minArmOffset(theta, r);
    const width = 0.1 + r * 0.003;
    let density = armD < width ? 1 : 0.16;
    if (r < 3200) density = Math.max(density, 0.75);
    if (Math.random() > density) continue;
    const rr = r * (0.92 + Math.random() * 0.16);
    const x = rr * Math.cos(theta);
    const z = rr * Math.sin(theta);
    const y = randomGaussian() * (60 + rr * 0.006);
    const tIn = 1 - rr / GALAXY_R;
    ancillary.lerpColors(colBlue, colWarm, tIn);
    if (armD < width * 0.6 && Math.random() < 0.1) ancillary.copy(colPink);
    const jit = 0.75 + Math.random() * 0.5;
    diskPos.push(x, y, z);
    diskCol.push(ancillary.r * jit, ancillary.g * jit, ancillary.b * jit);
  }
  g.add(makePoints(diskPos, diskCol, 170, 0.85, { center: GAL_CENTER, ref: 40000 }));

  const bulgePos: number[] = [];
  const bulgeCol: number[] = [];
  for (let i = 0; i < 7000; i++) {
    const r = Math.abs(randomGaussian()) * 0.4;
    const u = r < 1 ? r : 1;
    const rad = 120 + u * 1500;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const x = rad * Math.sin(phi) * Math.cos(theta);
    const z = rad * Math.sin(phi) * Math.sin(theta);
    const y = rad * Math.cos(phi) * 0.5;
    ancillary.copy(colWarm).lerp(new THREE.Color(0xffd9a0), Math.random() * 0.6);
    const jit = 0.8 + Math.random() * 0.4;
    bulgePos.push(x, y, z);
    bulgeCol.push(ancillary.r * jit, ancillary.g * jit, ancillary.b * jit);
  }
  g.add(makePoints(bulgePos, bulgeCol, 260, 0.9, { center: GAL_CENTER, ref: 2200 }));

  // galactic bar: dense warm core crossing the centre, ~27° off the Sun–centre
  // line, ~25,000 ly end-to-end (Gaia/Hipparcos structural data)
  const barPos: number[] = [];
  const barCol: number[] = [];
  const barAng = SUN_AZIMUTH - 0.47;
  const barDir = new THREE.Vector3(Math.cos(barAng), 0, Math.sin(barAng));
  for (let i = 0; i < 4200; i++) {
    const dist = Math.abs(randomGaussian()) * 12000;
    const px2 = barDir.x * dist;
    const pz = barDir.z * dist;
    const py = randomGaussian() * 300;
    ancillary.copy(colWarm).lerp(new THREE.Color(0xffd9a0), Math.random() * 0.5);
    const jit = 0.8 + Math.random() * 0.4;
    barPos.push(px2, py, pz);
    barCol.push(ancillary.r * jit, ancillary.g * jit, ancillary.b * jit);
  }
  g.add(makePoints(barPos, barCol, 210, 0.85, { center: GAL_CENTER, ref: 12000 }));

  const haloPos: number[] = [];
  const haloCol: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const rad = 4000 + Math.random() * 48000;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    haloPos.push(rad * Math.sin(phi) * Math.cos(theta), rad * Math.cos(phi) * 0.8, rad * Math.sin(phi) * Math.sin(theta));
    const jit = 0.45 + Math.random() * 0.55;
    haloCol.push(colHalo.r * jit, colHalo.g * jit, colHalo.b * jit);
  }
  g.add(makePoints(haloPos, haloCol, 420, 0.4, { center: GAL_CENTER, ref: 48000 }));

  // galactic dust volume glow
  const dust = makeGlowSprite('rgba(255,220,170,0.35)', 'rgba(200,180,255,0.12)', 40000, 0.5);
  g.add(dust);

  return g;
}

const galaxyGroup = buildGalaxy();
galaxyGroup.rotation.y = GALAXY_ROT_Y; // a spiral arm passes through the Sun at 45°
galaxyGroup.rotation.x = 0.3; // galactic plane tilt (stylised)

const centerGlow = makeGlowSprite('rgba(255,235,190,1)', 'rgba(255,200,120,0.5)', 4200, 0.9);
centerGlow.position.copy(GAL_CENTER);
const centerLabel = makeLabel('Tâm Ngân Hà · Sagittarius A*', 9000, '#ffd9a0', 'rgba(6,10,20,0.45)', 30);
centerLabel.position.copy(GAL_CENTER).add(new THREE.Vector3(0, 5200, 0));
const sunGLabel = makeLabel('Hệ Mặt Trời · Vành đai Orion', 6000, '#9fd0ff', 'rgba(6,10,20,0.45)', 30);
sunGLabel.position.copy(SUN_ANCHOR).add(new THREE.Vector3(0, 4600, 0));

// ---------------------------------------------------------------------------
// Level 4 — Local Group (~10 Mly)
// ---------------------------------------------------------------------------
function buildLocalGroup(): THREE.Group {
  const g = new THREE.Group();
  const anc = new THREE.Color(0xffe9c0);
  const ancCool = new THREE.Color(0xbcd6ff);

  // galaxies in the Local Group with real diameters (NASA/IPAC)
  const galaxies: { name: string; pos: THREE.Vector3; size: number; warm: boolean; px: number }[] = [
    { name: 'Andromeda (M31 · NGC 224)', pos: new THREE.Vector3(-1790000, 1220000, 500000), size: 200000, warm: true, px: 33 },
    { name: 'Tam Giác (M33 · NGC 598)', pos: new THREE.Vector3(-1950000, 1920000, 850000), size: 55000, warm: false, px: 30 },
    { name: 'Magellan Lớn (LMC)', pos: new THREE.Vector3(-110000, -41000, -98000), size: 30000, warm: true, px: 29 },
    { name: 'Magellan Nhỏ (SMC)', pos: new THREE.Vector3(-120000, -115000, -135000), size: 17000, warm: false, px: 29 },
  ];
  const satellites: { name: string; pos: THREE.Vector3; size: number; warm: boolean; px: number }[] = [
    { name: 'M32 · NGC 221', pos: new THREE.Vector3(-1630000, 1280000, 560000), size: 9000, warm: false, px: 24 },
    { name: 'M110 · NGC 205', pos: new THREE.Vector3(-1960000, 1160000, 440000), size: 14000, warm: false, px: 24 },
    { name: 'Sagittarius Dwarf', pos: new THREE.Vector3(-52000, 26000, -30000), size: 12000, warm: false, px: 24 },
  ];
  for (const ga of galaxies.concat(satellites)) {
    const s = galaxySprite(ga.size, ga.warm ? 1 : 0, 0.9);
    s.position.copy(ga.pos);
    g.add(s);
    const core = makeGlowSprite(ga.warm ? 'rgba(255,250,230,1)' : 'rgba(235,245,255,1)', 'rgba(255,220,160,0.5)', ga.size * 0.42, 0.75);
    core.position.copy(ga.pos);
    g.add(core);
    g.add(galaxyHaloPoints(ga.pos, ga.size * 0.7, 500, 14000, ga.warm ? anc : ancCool));
    const lb = makeLabel(ga.name, ga.size * 0.7, '#cfe0ff', 'rgba(6,10,20,0.5)', ga.px);
    lb.position.copy(ga.pos).add(new THREE.Vector3(0, ga.size * 0.75, 0));
    g.add(lb);
  }

  // our Milky Way represented as a small disc at L4 scale
  const mw = galaxySprite(170000, 1, 0.9);
  mw.position.copy(GAL_CENTER);
  g.add(mw);
  const mwCore = makeGlowSprite('rgba(255,245,225,1)', 'rgba(255,220,160,0.5)', 90000, 0.75);
  mwCore.position.copy(GAL_CENTER);
  g.add(mwCore);
  const mwLabel = makeLabel('Dải Ngân Hà (Milky Way)', 700000, '#ffd9a0', 'rgba(6,10,20,0.45)', 32);
  mwLabel.position.copy(GAL_CENTER).add(new THREE.Vector3(0, 140000, 0));
  g.add(mwLabel);

  return g;
}

// ---------------------------------------------------------------------------
// Level 5 — Virgo Supercluster (~110 Mly)
// ---------------------------------------------------------------------------
const VIRGO_CENTER = new THREE.Vector3(0, 53800000, 0);

function buildVirgo(): THREE.Group {
  const g = new THREE.Group();
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const warm = new THREE.Color(0xfff0c8);
  const blue = new THREE.Color(0xd9e6ff);
  for (let i = 0; i < 3000; i++) {
    const r = Math.abs(randomGaussian()) * 1.6e7;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    pos.push(VIRGO_CENTER.x + r * Math.sin(ph) * Math.cos(th), VIRGO_CENTER.y + r * Math.cos(ph), VIRGO_CENTER.z + r * Math.sin(ph) * Math.sin(th));
    c.copy(warm).lerp(blue, Math.random());
    const j = 0.7 + Math.random() * 0.5;
    col.push(c.r * j, c.g * j, c.b * j);
  }
  g.add(makePoints(pos, col, 320000, 0.7, { center: VIRGO_CENTER, ref: 2.2e7 }));

  const m87 = makeGlowSprite('rgba(255,255,235,1)', 'rgba(255,220,150,0.5)', 1.6e7, 0.95);
  m87.position.copy(VIRGO_CENTER);
  g.add(m87);
  const m87Label = makeLabel('Cụm Xử Nữ · Virgo Cluster · M87 (54 triệu ly)', 5e7, '#ffd9a0', 'rgba(6,10,20,0.45)', 34);
  m87Label.position.copy(VIRGO_CENTER).add(new THREE.Vector3(0, 1.3e7, 0));
  g.add(m87Label);

  // bright Virgo member galaxies (Messier/NGC names, NASA HEASARC)
  const members: { name: string; off: [number, number, number]; size: number }[] = [
    { name: 'M49 · NGC 4472', off: [-1.1e7, 3.4e6, 6.0e6], size: 1.1e7 },
    { name: 'M60 · NGC 4649', off: [1.3e7, 2.0e6, -4.5e6], size: 9.5e6 },
    { name: 'M86 · NGC 4406', off: [2.6e6, -4.2e6, 8.8e6], size: 8.5e6 },
    { name: 'M100 · NGC 4321', off: [-1.6e7, -3.0e6, -4.2e6], size: 1.0e7 },
  ];
  for (const m of members) {
    const p = VIRGO_CENTER.clone().add(new THREE.Vector3(...m.off));
    const ms = makeGlowSprite('rgba(255,250,235,1)', 'rgba(255,220,150,0.5)', m.size, 0.9);
    ms.position.copy(p);
    g.add(ms);
    const ml = makeLabel(m.name, m.size * 0.8, '#ffe9c8', 'rgba(6,10,20,0.5)', 25);
    ml.position.copy(p).add(new THREE.Vector3(0, m.size * 0.7, 0));
    g.add(ml);
  }

  // Local Group at the edge of the supercluster
  const lg = makeGlowSprite('rgba(255,245,225,1)', 'rgba(160,200,255,0.4)', 2.5e6, 1);
  lg.position.copy(GAL_CENTER);
  g.add(lg);
  const lgLabel = makeLabel('Nhóm Địa phương (Local Group)', 2.2e7, '#bcd6ff', 'rgba(6,10,20,0.45)', 30);
  lgLabel.position.copy(GAL_CENTER).add(new THREE.Vector3(0, 1.4e6, 0));
  g.add(lgLabel);

  return g;
}

// ---------------------------------------------------------------------------
// Level 6 — Laniakea Supercluster (~520 Mly) & Great Attractor
// ---------------------------------------------------------------------------
const GREAT_ATTRACTOR = new THREE.Vector3(205000000, -62000000, 34000000); // ~222 Mly, Abell 3627 / Norma

function buildLaniakea(): THREE.Group {
  const g = new THREE.Group();
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const warm = new THREE.Color(0xffe9c0);

  const curves: THREE.CatmullRomCurve3[] = [
    new CatmullRomCurve3([GAL_CENTER, new THREE.Vector3(2.0e7, 6.0e7, 1.0e7), VIRGO_CENTER]),
    new CatmullRomCurve3([VIRGO_CENTER, new THREE.Vector3(9.0e7, 2.0e7, 2.8e7), GREAT_ATTRACTOR]),
    new CatmullRomCurve3([GAL_CENTER, new THREE.Vector3(1.1e8, -1.2e8, -6.0e7)]),
    new CatmullRomCurve3([GAL_CENTER, new THREE.Vector3(-8.0e7, 1.5e8, 3.0e7)]),
  ];

  for (const curve of curves) {
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const base = curve.getPoint(t);
      for (let k = 0; k < 3; k++) {
        const jx = randomGaussian() * 5.0e6;
        const jy = randomGaussian() * 5.0e6;
        const jz = randomGaussian() * 3.0e6;
        pos.push(base.x + jx, base.y + jy, base.z + jz);
        c.copy(warm).lerp(new THREE.Color(0x9fd0ff), Math.random());
        const j = 0.6 + Math.random() * 0.5;
        col.push(c.r * j, c.g * j, c.b * j);
      }
    }
  }
  g.add(makePoints(pos, col, 2.2e6, 0.75, { center: GREAT_ATTRACTOR, ref: 2.2e7 }));

  const gaGlow = makeGlowSprite('rgba(255,245,220,1)', 'rgba(255,200,140,0.5)', 3.6e7, 0.95);
  gaGlow.position.copy(GREAT_ATTRACTOR);
  g.add(gaGlow);
  const gaLabel = makeLabel('Great Attractor · Abell 3627 (Norma)', 1.1e8, '#ffd9a0', 'rgba(6,10,20,0.45)', 34);
  gaLabel.position.copy(GREAT_ATTRACTOR).add(new THREE.Vector3(0, 2.5e7, 0));
  g.add(gaLabel);
  const laniakea = makeLabel('Siêu đám Laniakea', 2.6e8, '#bcd6ff', 'rgba(6,10,20,0.45)', 40);
  laniakea.position.copy(new THREE.Vector3(5.0e7, 1.4e8, 2.0e7));
  g.add(laniakea);

  // Shapley Concentration ~650 Mly (the basin Laniakea drifts toward)
  const shapley = new THREE.Vector3(560000000, -150000000, 150000000);
  const shGlow = makeGlowSprite('rgba(235,240,255,1)', 'rgba(160,200,255,0.4)', 6.0e7, 0.8);
  shGlow.position.copy(shapley);
  g.add(shGlow);
  const shLabel = makeLabel('Shapley Concentration · ~650 triệu ly', 3.6e8, '#bcd6ff', 'rgba(6,10,20,0.45)', 33);
  shLabel.position.copy(shapley).add(new THREE.Vector3(0, 4.5e7, 0));
  g.add(shLabel);

  // Perseus–Pisces supercluster ~250 Mly on the opposite flow
  const perPis = new THREE.Vector3(-150000000, 195000000, 80000000);
  const ppGlow = makeGlowSprite('rgba(240,235,255,1)', 'rgba(170,160,255,0.4)', 5.0e7, 0.75);
  ppGlow.position.copy(perPis);
  g.add(ppGlow);
  const ppLabel = makeLabel('Siêu đám Perseus–Pisces', 3.0e8, '#cdd6ff', 'rgba(6,10,20,0.45)', 32);
  ppLabel.position.copy(perPis).add(new THREE.Vector3(0, 4.0e7, 0));
  g.add(ppLabel);

  // faint marker re-using the Virgo position so the flow reads
  const virgoPing = makeGlowSprite('rgba(255,240,210,1)', 'rgba(255,180,120,0.5)', 1.1e7, 0.8);
  virgoPing.position.copy(VIRGO_CENTER);
  g.add(virgoPing);

  return g;
}

// ---------------------------------------------------------------------------
// Level 7 — Cosmic Web & Voids (1–10 Gly)
// ---------------------------------------------------------------------------
function buildCosmicWeb(): THREE.Group {
  const g = new THREE.Group();
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const warm = new THREE.Color(0xffe9c8);
  const blue = new THREE.Color(0xbcd0ff);

  // frozen pseudo-random seeds so the web looks the same every load
  const rnd = mulberry32(42);
  const HALF = 2.6e9;
  const seeds: THREE.Vector3[] = [];
  const nSeeds = 36;
  for (let i = 0; i < nSeeds; i++) {
    seeds.push(new THREE.Vector3((rnd() * 2 - 1) * HALF, (rnd() * 2 - 1) * HALF * 0.7, (rnd() * 2 - 1) * HALF));
  }
  // filament segments linking nearby seeds
  const linked = new Set<number>();
  for (let i = 0; i < nSeeds; i++) {
    const dists: { j: number; d: number }[] = [];
    for (let j = 0; j < nSeeds; j++) {
      if (i === j) continue;
      dists.push({ j, d: seeds[i].distanceTo(seeds[j]) });
    }
    dists.sort((a, b) => a.d - b.d);
    for (let k = 0; k < Math.min(3, dists.length); k++) {
      if (dists[k].d > 3.4e9) continue;
      const key = Math.min(i, dists[k].j) * 1e5 + Math.max(i, dists[k].j);
      if (linked.has(key)) continue;
      linked.add(key);
      const a = seeds[i];
      const b = seeds[dists[k].j];
      const steps = 28;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const mid = new THREE.Vector3().lerpVectors(a, b, t);
        for (let kk = 0; kk < 2; kk++) {
          pos.push(
            mid.x + randomGaussian() * 3.2e7,
            mid.y + randomGaussian() * 3.2e7,
            mid.z + randomGaussian() * 3.2e7,
          );
          c.copy(blue).lerp(warm, rnd());
          const j = 0.7 + rnd() * 0.5;
          col.push(c.r * j, c.g * j, c.b * j);
        }
      }
    }
  }
  // Sloan Great Wall: an elongated strip in x (spec: >1.37 Gy long)
  for (let i = 0; i < 1400; i++) {
    const x = 8.0e8 + rnd() * 5.7e8;
    const y = (rnd() * 2 - 1) * 3.5e8;
    const z = (rnd() * 2 - 1) * 4.5e8;
    pos.push(x, y, z);
    c.copy(warm).lerp(blue, rnd() * 0.5);
    const j = 0.8 + rnd() * 0.4;
    col.push(c.r * j, c.g * j, c.b * j);
  }
  // sparse background galaxies to fill the web
  for (let i = 0; i < 1600; i++) {
    pos.push((rnd() * 2 - 1) * HALF, (rnd() * 2 - 1) * HALF * 0.8, (rnd() * 2 - 1) * HALF);
    c.copy(blue).lerp(warm, rnd());
    col.push(c.r * 0.7, c.g * 0.7, c.b * 0.7);
  }
  g.add(makePoints(pos, col, 2.4e7, 0.8, { center: GAL_CENTER, ref: 6e8 }));

  const wallLabel = makeLabel('Bức tường Lớn Sloan (1,37 tỷ ly · SDSS)', 6.5e8, '#ffd9a0', 'rgba(6,10,20,0.45)', 36);
  wallLabel.position.copy(new THREE.Vector3(1.08e9, 1.6e8, -0.4e8));
  g.add(wallLabel);
  const filLabel = makeLabel('Sợi vũ trụ · galaxy filament', 1.6e9, '#9fb8e8', 'rgba(6,10,20,0.45)', 30);
  filLabel.position.copy(new THREE.Vector3(-2.1e9, 0.9e9, 1.2e9));
  g.add(filLabel);
  const cfaLabel = makeLabel('Bức tường Lớn CfA2 (500 triệu ly)', 1.6e9, '#9fb8e8', 'rgba(6,10,20,0.45)', 30);
  cfaLabel.position.copy(new THREE.Vector3(2.3e9, -0.7e9, 0.5e9));
  g.add(cfaLabel);

  // Boötes Void: nearly empty, drawn as a faint wireframe shell
  const voidSphere = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.SphereGeometry(1.7e8, 24, 12)),
    new THREE.LineBasicMaterial({ color: 0x5a6a8c, transparent: true, opacity: 0.3, depthWrite: false }),
  );
  voidSphere.position.copy(new THREE.Vector3(350000000, 420000000, -200000000));
  g.add(voidSphere);
  const voidLabel = makeLabel('Khoảng trống Boötes (Boötes Void · 330 triệu ly)', 6.5e8, '#8fb4ff', 'rgba(6,10,20,0.45)', 34);
  voidLabel.position.copy(new THREE.Vector3(350000000, 650000000, -200000000));
  g.add(voidLabel);

  return g;
}

// ---------------------------------------------------------------------------
// Level 8 — Observable Universe & CMBR boundary
// ---------------------------------------------------------------------------
function buildCMBRTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 1024;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#02030a';
  ctx.fillRect(0, 0, 2048, 1024);
  // CMB dipole: motion-induced ~3.36 mK hotspot on one hemisphere (COBE/Planck)
  const dip = ctx.createLinearGradient(0, 0, 2048, 0);
  dip.addColorStop(0, 'rgba(225,110,55,0.12)');
  dip.addColorStop(0.3, 'rgba(80,95,145,0.07)');
  dip.addColorStop(0.62, 'rgba(35,60,115,0.10)');
  dip.addColorStop(0.85, 'rgba(90,120,175,0.06)');
  dip.addColorStop(1, 'rgba(235,140,70,0.12)');
  ctx.fillStyle = dip;
  ctx.fillRect(0, 0, 2048, 1024);
  // large faint temperature patches (WMAP/Planck style)
  const patchColors = ['rgba(30,50,90,0.4)', 'rgba(50,42,80,0.4)', 'rgba(24,44,70,0.4)', 'rgba(20,70,110,0.3)'];
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * 2048;
    const y = Math.random() * 1024;
    const r = 60 + Math.random() * 240;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, patchColors[i % patchColors.length]);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // red/blue anisotropy speckles
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * 2048;
    const y = Math.random() * 1024;
    const r = 1 + Math.random() * 4;
    const hot = Math.random();
    ctx.fillStyle =
      hot < 0.5
        ? `rgba(255,90,50,${0.2 + Math.random() * 0.45})`
        : `rgba(60,140,255,${0.18 + Math.random() * 0.45})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + Math.random() * 0.3), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  return t;
}

function buildObservableUniverse(): THREE.Group {
  const g = new THREE.Group();
  const R = 4.65e10; // comoving radius of the observable universe (ly)

  const cmbr = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshBasicMaterial({
      map: buildCMBRTexture(),
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  cmbr.scale.setScalar(R);
  g.add(cmbr);

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 48),
    new THREE.MeshBasicMaterial({
      color: 0x0a1030,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  shell.scale.setScalar(R * 1.02);
  g.add(shell);

  const edgeLabel = makeLabel('Ranh giới vũ trụ quan sát được · CMBR', 4.5e9, '#9fc2ff', 'rgba(6,10,20,0.45)', 38);
  edgeLabel.position.set(0, 0, R * 0.94);
  g.add(edgeLabel);
  const cmbScience = makeLabel('CMBR · T ≈ 2,725 K · z ≈ 1100 · dị hướng ~1:10.000', 5.2e9, '#9fc2ff', 'rgba(6,10,20,0.45)', 31);
  cmbScience.position.set(R * 0.94, 0, R * 0.2);
  g.add(cmbScience);
  const uniScience = makeLabel('Vũ trụ quan sát được · ~93 tỷ ly · tuổi 13,8 tỷ năm', 5.2e9, '#8f9fff', 'rgba(6,10,20,0.45)', 31);
  uniScience.position.set(-R * 0.6, R * 0.5, R * 0.5);
  g.add(uniScience);

  // deep "vutru" reference images as faint background nebulae
  const deepDirs = [
    new THREE.Vector3(0.6, 0.3, 0.72).normalize(),
    new THREE.Vector3(-0.7, -0.2, 0.62).normalize(),
    new THREE.Vector3(-0.25, 0.45, -0.7).normalize(),
  ];
  deepDirs.forEach((d, i) => {
    const mat = new THREE.SpriteMaterial({
      map: loadTex(`/assets/vutru/0${i + 1}.png`),
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(d).multiplyScalar(2.6e10);
    const sx = 7.5e9;
    spr.scale.set(sx, sx / 1.79, 1);
    spr.renderOrder = 1;
    g.add(spr);
  });

  return g;
}

const loadTex = (p: string): THREE.Texture => {
  const t = new THREE.TextureLoader().load(p);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  return t;
};

// ---------------------------------------------------------------------------
// LOD registry (spec §4 CAMERA LOD MATRIX: log-distance bands)
// ---------------------------------------------------------------------------
const LODS = [
  { name: 'Hệ Mặt Trời', c: -1.5, w: 1.35 },
  { name: 'Môi trường Liên sao Cục bộ', c: 1.2, w: 1.55 },
  { name: 'Nhánh Xoắn Orion', c: 3.6, w: 1.5 },
  { name: 'Dải Ngân Hà', c: 5.0, w: 1.5 },
  { name: 'Nhóm Địa phương', c: 6.5, w: 1.5 },
  { name: 'Siêu đám Xử Nữ', c: 7.4, w: 1.4 },
  { name: 'Siêu đám Laniakea', c: 8.7, w: 1.4 },
  { name: 'Mạng lưới Sợi Vũ trụ', c: 9.7, w: 1.5 },
  { name: 'Vũ trụ Quan sát được', c: 11.0, w: 2.6 },
];

const cosmosLayer = new THREE.Group();
const localGroup = buildLocal();
const orionGroup = buildOrionArm();
const virgoGroup = buildVirgo();
const laniakeaGroup = buildLaniakea();
const webGroup = buildCosmicWeb();
const universeGroup = buildObservableUniverse();
const localGroupGroup = buildLocalGroup();
const galaxyRoot = new THREE.Group();
galaxyRoot.add(galaxyGroup, centerGlow, centerLabel, sunGLabel);

const layers: THREE.Group[] = [
  solarSystem, // 0
  localGroup, // 1
  orionGroup, // 2
  galaxyRoot, // 3
  localGroupGroup, // 4
  virgoGroup, // 5
  laniakeaGroup, // 6
  webGroup, // 7
  universeGroup, // 8
];
layers.forEach((l, i) => {
  if (i > 0) {
    l.userData.lod = { c: LODS[i].c, w: LODS[i].w };
    cosmosLayer.add(l);
  } else {
    l.userData.lod = { c: LODS[0].c, w: LODS[0].w };
  }
});
scene.add(cosmosLayer);

let cosmosOn = true;

function levelAlpha(dist: number, c: number, w: number): number {
  const L = Math.log10(Math.max(dist, 1e-12));
  const x = Math.abs(L - c) / w;
  if (x >= 1) return 0;
  const u = 1 - x;
  return u * u * (3 - 2 * u);
}
function applyGroupOpacity(group: THREE.Object3D, alpha: number): void {
  group.visible = alpha > 0.008;
  group.traverse(o => {
    const mat = (o as { material?: THREE.Material | THREE.Material[] }).material;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      m.transparent = true;
      if (m.userData.baseOp === undefined) m.userData.baseOp = m.opacity;
      m.opacity = (m.userData.baseOp as number) * alpha;
    }
  });
}
function applyLOD(dist: number): number[] {
  const alphas = LODS.map((lod, i) => {
    let a = levelAlpha(dist, lod.c, lod.w);
    if (i > 0 && !cosmosOn) a = 0;
    return a;
  });
  // bump the solar system to full brightness around the "home" distance so
  // the detent view shows a clearly lit system (LOD 0 alone fades there)
  if (cosmosOn) alphas[0] = Math.min(1, alphas[0] * solarBrightnessBoost(dist));
  layers.forEach((l, i) => applyGroupOpacity(l, alphas[i]));
  applyGroupOpacity(sunPointGroup, levelAlpha(dist, 1.5, 2.4));
  return alphas;
}

// smooth 1→~2.35x brightness notch centred on SOLAR_FIT_DIST (±0.55 decades)
function solarBrightnessBoost(d: number): number {
  const x = Math.abs(Math.log10(d) - Math.log10(SOLAR_FIT_DIST));
  if (x > 0.55) return 1;
  const u = 1 - x / 0.55;
  return 1 + 1.35 * (1 - u * u);
}

// ---------------------------------------------------------------------------
// Custom camera controller: logarithmic zoom + orbit + pan
// ---------------------------------------------------------------------------
const ZOOM_MIN = 6e-3; // ly (just outside the compressed Sun)
const ZOOM_MAX = 9e10; // ly (past the CMBR boundary)
const LOG_SPAN = 14; // 10^(14t - 3): 1e-3 .. 1e11

const tToDist = (t: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.pow(10, LOG_SPAN * t - 3)));
const distToT = (d: number): number => Math.min(1, Math.max(0, (Math.log10(d) + 3) / LOG_SPAN));

const camState = {
  theta: -0.7,
  phi: 1.2,
  dist: 0.09,
  targetDist: 0.09,
  target: new THREE.Vector3().copy(SUN_ANCHOR),
  autoRotate: true,
};
let zoomT = distToT(0.09);

// Whole solar system fits the 45° FOV with margin here (Neptune orbit is
// ~0.055 ly radius, diameter ~0.11 ly). Used by the home button and the
// wheel "detent" that snaps back to this exact framing.
const SOLAR_FIT_DIST = 0.17;
const SOLAR_FIT_T = distToT(SOLAR_FIT_DIST);
let flightTarget: THREE.Vector3 | null = null;
let snapArmed = true;

// optional deep-view start: open e.g. ...?#z=1e5 to begin zoomed at that dist
const hashZ = /#z=([\d.+-eE]+)/.exec(location.hash);
if (hashZ) {
  const v = THREE.MathUtils.clamp(parseFloat(hashZ[1]), ZOOM_MIN, ZOOM_MAX);
  camState.dist = v;
  camState.targetDist = v;
  zoomT = distToT(v);
}

camera.position.set(15, 30, 40);

// hue-based readable distance formatter
function fmtDist(d: number): string {
  if (d < 1) return `${(d * 1).toExponential(1)} ly`;
  if (d < 1e3) return `${d.toFixed(1)} ly`;
  if (d < 1e6) return `${(d / 1e3).toFixed(1)} nghìn ly`;
  if (d < 1e9) return `${(d / 1e6).toFixed(1)} triệu ly`;
  return `${(d / 1e9).toFixed(2)} tỷ ly`;
}

function integrateCamera(dt: number): void {
  camState.phi = THREE.MathUtils.clamp(camState.phi, 0.06, Math.PI - 0.06);
  if (camState.autoRotate) camState.theta += dt * 0.045;

  const k = 1 - Math.exp(-4 * dt);
  camState.dist += (camState.targetDist - camState.dist) * k;

  const sp = Math.sin(camState.phi);
  camera.position.set(
    camState.target.x + sp * Math.cos(camState.theta) * camState.dist,
    camState.target.y + Math.cos(camState.phi) * camState.dist,
    camState.target.z + sp * Math.sin(camState.theta) * camState.dist,
  );
  camera.lookAt(camState.target);
  camera.up.set(0, 1, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  // follow a selected planet
  if (selectedPivot) {
    const wp = new THREE.Vector3();
    selectedPivot.getWorldPosition(wp);
    camState.target.lerp(wp, Math.min(1, 5 * dt));
  }
  // glide towards a requested flight target (e.g. full-screen solar view)
  if (flightTarget) {
    camState.target.lerp(flightTarget, Math.min(1, 6 * dt));
    if (camState.target.distanceTo(flightTarget) < 0.02) {
      camState.target.copy(flightTarget);
      flightTarget = null;
    }
  }
}

let dragLast = { x: 0, y: 0 };
let dragging = false;
let dragMoved = false;
let panMode = false;

canvas.addEventListener('pointerdown', (e: PointerEvent) => {
  dragging = true;
  dragMoved = false;
  dragLast = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e: PointerEvent) => {
  const dx = e.clientX - dragLast.x;
  const dy = e.clientY - dragLast.y;
  if (dragging) {
    if (Math.abs(dx) + Math.abs(dy) > 1) dragMoved = true;
    const leftDown = (e.buttons & 1) !== 0;
    const rightDown = (e.buttons & 2) !== 0;
    const panning = (panMode && leftDown) || rightDown;
    if (panning) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const s = camState.dist * 0.0016;
      camState.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      if (selectedPivot) deselectPlanet();
    } else if (leftDown) {
      camState.theta -= dx * 0.0052;
      camState.phi -= dy * 0.0052;
      if (selectedPivot) deselectPlanet();
    }
    dragLast = { x: e.clientX, y: e.clientY };
    return;
  }
  // hover (no button pressed)
  pointerToNdc(e);
  if (panMode) {
    canvas.style.cursor = e.buttons ? 'grabbing' : 'grab';
    clearHover();
    return;
  }
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickMeshes, false)[0];
  const hitMesh = (hit?.object as THREE.Mesh | undefined) ?? null;
  if (hitMesh !== hoverMesh) {
    clearHover(hitMesh);
    if (hitMesh) {
      hitMesh.scale.setScalar(1.28);
      const rim = hitMesh.userData.rim as THREE.ShaderMaterial;
      if (rim) rim.uniforms.uIntensity.value = (hitMesh.userData.rimBase as number) * 2.2;
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = '';
    }
  }
});
canvas.addEventListener('pointerup', (e: PointerEvent) => {
  if (!dragging) return;
  const wasDrag = dragMoved || Math.hypot(e.clientX - dragLast.x, e.clientY - dragLast.y) > 4;
  dragging = false;
  if (panMode || wasDrag) return;
  pointerToNdc(e);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickMeshes, false)[0];
  const hitMesh = (hit?.object as THREE.Mesh | undefined) ?? null;
  if (!hitMesh) {
    deselectPlanet();
    return;
  }
  selectPlanet(hitMesh);
});
canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  // zoom slow-down near the solar system so small planets don't overshoot
  const d = camState.targetDist;
  const speedMul = d >= 1 ? 1 : d <= SOLAR_FIT_DIST ? 0.2 :
    1 - 0.8 * (Math.log10(d) - 0) / (Math.log10(SOLAR_FIT_DIST) - 0);
  zoomT = THREE.MathUtils.clamp(zoomT + e.deltaY * 0.0006 * Math.max(0.2, speedMul), 0, 1);
  let dist = tToDist(zoomT);
  // magnetic "detent": scrolling near the full-solar-system framing snaps to
  // it and nudges the view back to the Sun (re-arms only after leaving the band)
  const lgD = Math.log10(dist);
  const lgFit = Math.log10(SOLAR_FIT_DIST);
  const band = 0.09;
  if (snapArmed && Math.abs(lgD - lgFit) <= band) {
    dist = SOLAR_FIT_DIST;
    zoomT = SOLAR_FIT_T;
    snapArmed = false;
    flightTarget = SUN_ANCHOR.clone();
  } else if (!snapArmed && Math.abs(lgD - lgFit) > band * 1.6) {
    snapArmed = true;
  }
  camState.targetDist = dist;
  if (camState.targetDist > 0.5) deselectPlanet();
}, { passive: false });

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const btn = (id: string): HTMLButtonElement => {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (!el) throw new Error(`missing button #${id}`);
  return el;
};
const input = (id: string): HTMLInputElement => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`missing input #${id}`);
  return el;
};
const clockStop = document.getElementById('clockstop') as HTMLSpanElement;
const clockAstro = document.getElementById('clockastro') as HTMLSpanElement;
const levelInfo = document.getElementById('levelinfo') as HTMLSpanElement;

const planetSelect = document.getElementById('planetselect') as HTMLSelectElement;
const chaseName = document.getElementById('chasename') as HTMLSpanElement;
const PLANET_VI: Record<string, string> = {
  Mercury: 'Sao Thủy', Venus: 'Sao Kim', Earth: 'Trái Đất', Mars: 'Sao Hỏa',
  Jupiter: 'Sao Mộc', Saturn: 'Sao Thổ', Uranus: 'Sao Thiên Vương', Neptune: 'Sao Hải Vương',
  Moon: 'Mặt Trăng',
};
planetSelect.addEventListener('change', () => {
  const v = planetSelect.value;
  if (!v) { deselectPlanet(); return; }
  if (v === 'Sun') {
    deselectPlanet();
    flightTarget = SUN_ANCHOR.clone();
    camState.targetDist = SOLAR_FIT_DIST * 0.5;
    zoomT = distToT(SOLAR_FIT_DIST * 0.5);
    snapArmed = false;
    chaseName.textContent = 'Mặt Trời';
    planetSelect.value = 'Sun';
    return;
  }
  const p = planets.find(x => x.spec.name === v);
  if (!p) { deselectPlanet(); return; }
  flightTarget = null;
  selectPlanet(v === 'Moon' ? p.moon! : p.mesh);
});

const timeSlider = input('timescale');
const timeValue = document.getElementById('timevalue') as HTMLSpanElement;
let timeScale = parseFloat(timeSlider.value) || 1;
setTimeScale(timeScale);

function setTimeScale(v: number): void {
  timeSlider.value = String(v);
  timeScale = v;
  timeValue.textContent = `${v.toFixed(2).replace(/\.?0+$/, '')}x`;
}
timeSlider.addEventListener('input', () => {
  setTimeScale(parseFloat(timeSlider.value) || 0);
});
document.querySelectorAll<HTMLButtonElement>('button[data-scale]').forEach(b => {
  b.addEventListener('click', () => setTimeScale(parseFloat(b.dataset.scale!) || 0));
});

let paused = false;
btn('pause').addEventListener('click', () => {
  paused = !paused;
  btn('pause').textContent = paused ? 'Play' : 'Pause';
});
btn('turntable').addEventListener('click', () => {
  camState.autoRotate = !camState.autoRotate;
  btn('turntable').textContent = camState.autoRotate ? 'Turntable: ON' : 'Turntable: OFF';
});
btn('orbits').addEventListener('click', () => {
  orbitLines.visible = !orbitLines.visible;
  btn('orbits').textContent = orbitLines.visible ? 'Orbits: ON' : 'Orbits: OFF';
});
btn('belt').addEventListener('click', () => {
  belt.visible = !belt.visible;
  btn('belt').textContent = belt.visible ? 'Belt: ON' : 'Belt: OFF';
});
btn('bloom').addEventListener('click', () => {
  composer.enabled = !composer.enabled;
  btn('bloom').textContent = composer.enabled ? 'Glow: ON' : 'Glow: OFF';
});
btn('universe').addEventListener('click', () => {
  cosmosOn = !cosmosOn;
  btn('universe').textContent = cosmosOn ? 'Vũ trụ: ON' : 'Vũ trụ: OFF';
  if (!cosmosOn) deselectPlanet();
});
btn('pan').addEventListener('click', () => {
  panMode = !panMode;
  btn('pan').textContent = panMode ? 'Bàn tay: ON' : 'Bàn tay: OFF';
  canvas.style.cursor = panMode ? 'grab' : '';
  clearHover();
});
btn('shot').addEventListener('click', () => {
  composer.render();
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'cosmic-zoom.png';
  a.click();
});
btn('house').addEventListener('click', () => {
  deselectPlanet();
  flightTarget = SUN_ANCHOR.clone();
  camState.targetDist = SOLAR_FIT_DIST;
  zoomT = SOLAR_FIT_T;
  snapArmed = false;
});

// ---------------------------------------------------------------------------
// Planet labels (DOM overlay, only inside the Solar system level)
// ---------------------------------------------------------------------------
const labelLayer = document.getElementById('labels') as HTMLDivElement;
const labelEls: { el: HTMLDivElement; mesh: THREE.Mesh }[] = [];
const labelStyle = document.createElement('style');
labelStyle.textContent =
  '.pl { position:absolute; transform:translate(-50%,-150%); font:11px/1.3 ui-sans-serif,system-ui,sans-serif; color:#cfd8e8; text-shadow:0 1px 3px #000,0 0 6px #000; pointer-events:none; white-space:nowrap; opacity:.85; }';
document.head.appendChild(labelStyle);

function addLabel(mesh: THREE.Mesh, text: string): void {
  const el = document.createElement('div');
  el.className = 'pl';
  el.textContent = text;
  labelLayer.appendChild(el);
  labelEls.push({ el, mesh });
}
for (const p of planets) {
  addLabel(p.mesh, p.spec.name);
  if (p.moon) addLabel(p.moon, 'Moon');
}

const cameraSpace = new THREE.Vector3();
function updateLabels(show: boolean): void {
  const pxPerRad = window.innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  for (const { el, mesh } of labelEls) {
    if (!show) {
      el.style.display = 'none';
      continue;
    }
    mesh.getWorldPosition(cameraSpace);
    const appR = ((mesh.userData.spec?.radius ?? 0.5) * SOLAR_SCALE) / Math.max(1e-6, cameraSpace.distanceTo(camera.position));
    cameraSpace.project(camera);
    if (cameraSpace.z > 1) {
      el.style.display = 'none';
    } else {
      el.style.display = 'block';
      el.style.left = `${((cameraSpace.x + 1) / 2) * window.innerWidth}px`;
      el.style.top = `${((1 - cameraSpace.y) / 2) * window.innerHeight}px`;
      const fx = Math.min(1, Math.max(0, (appR * pxPerRad - 8) / 55));
      el.style.fontSize = `${(11 * (1 + 0.7 * fx)).toFixed(1)}px`;
    }
  }
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pointerToNdc(e: PointerEvent | MouseEvent): void {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

const pickMeshes: THREE.Mesh[] = planets.map(p => p.mesh).concat(planets.filter(p => p.moon).map(p => p.moon!));
const infoPanel = document.getElementById('planinfo') as HTMLDivElement;
const infoName = document.getElementById('infoname') as HTMLSpanElement;
const infoLines = document.getElementById('infolines') as HTMLDivElement;
let hoverMesh: THREE.Mesh | null = null;
let selectedPlanet: THREE.Mesh | null = null;
let selectedPivot: THREE.Object3D | null = null;

function clearHover(keep?: THREE.Mesh | null): void {
  if (hoverMesh && hoverMesh !== keep && hoverMesh !== selectedPlanet) hoverMesh.scale.setScalar(1);
  if (hoverMesh) {
    const rim = hoverMesh.userData.rim as THREE.ShaderMaterial;
    if (rim) rim.uniforms.uIntensity.value = hoverMesh.userData.rimBase;
  }
  hoverMesh = null;
}
function planetOf(mesh: THREE.Mesh): { pivot: THREE.Object3D; isMoon: boolean } {
  const p = planets.find(x => x.mesh === mesh);
  if (p) return { pivot: p.pivot, isMoon: false };
  const pm = planets.find(x => x.moon === mesh);
  if (pm) return { pivot: pm.pivot, isMoon: true };
  return { pivot: mesh.parent!, isMoon: false };
}
function selectPlanet(mesh: THREE.Mesh): void {
  const { pivot, isMoon } = planetOf(mesh);
  selectedPlanet = mesh;
  selectedPivot = pivot;
  mesh.scale.setScalar(1.35);
  clearHover();

  const worldPos = new THREE.Vector3();
  pivot.getWorldPosition(worldPos);
  const radLocal = mesh.geometry.boundingSphere?.radius ?? 0.5;
  const targetDist = Math.max(radLocal * SOLAR_SCALE * 9, ZOOM_MIN);

  camState.target.copy(worldPos);
  camState.targetDist = targetDist;
  camState.dist = targetDist;
  zoomT = distToT(targetDist);

  const spec = mesh.userData.spec as PlanetSpec | undefined;
  const name = (spec?.name && PLANET_VI[spec.name]) || spec?.name;
  infoName.textContent = name ?? '';
  if (spec?.name) {
    planetSelect.value = spec.name;
    chaseName.textContent = name ?? '—';
  }
  const lines: string[] = [];
  if (isMoon) {
    lines.push('Chu kỳ quanh Trái Đất: 27,3 ngày');
  } else if (spec) {
    lines.push(`Chu kỳ quỹ đạo: ${(365.25 / spec.speed).toFixed(1)} ngày`);
    lines.push(`Vành đai: ${spec.ring ? 'Có' : 'Không'}`);
  }
  lines.push('Nhấp khoảng trống hoặc lăn xa để bỏ chọn');
  infoLines.textContent = lines.join('\n');
  infoPanel.style.display = 'block';
}
function deselectPlanet(): void {
  selectedPlanet = null;
  selectedPivot = null;
  clearHover();
  infoPanel.style.display = 'none';
  planetSelect.value = '';
  chaseName.textContent = '—';
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let elapsed = 0;
let simSeconds = 0;
let beltAngle = 0;
let moonAngle = 1.2;

renderer.setAnimationLoop(() => {
  const dt = Math.min(paused ? 0 : clock.getDelta(), 0.1);
  elapsed += dt * timeScale;
  if (timeScale > 0) simSeconds += dt * timeScale;

  const cs = Math.floor(simSeconds);
  clockStop.textContent = `${String(Math.floor(cs / 3600)).padStart(2, '0')}:${String(Math.floor((cs % 3600) / 60)).padStart(2, '0')}:${String(cs % 60).padStart(2, '0')}`;
  const totalDays = (elapsed / (Math.PI * 2)) * 365.25;
  clockAstro.textContent = `T+ ${totalDays.toFixed(1)} ngày · ${(totalDays / 365.25).toFixed(1)} năm`;

  sun.rotation.y += dt * timeScale * 0.02;
  const pulse = 1 + 0.02 * Math.sin(elapsed * 2.2);
  glow.scale.setScalar(11 * pulse);

  for (const { pivot, mesh, spec, moon } of planets) {
    const a = spec.phase + elapsed * spec.speed;
    pivot.position.set(Math.cos(a) * spec.orbit, 0, Math.sin(a) * spec.orbit);
    mesh.rotation.y += dt * timeScale * spec.rotSpeed;
    if (moon) {
      moonAngle = (moonAngle + dt * timeScale * EARTH_SPEED * MOON_ORBITS_PER_EARTH_YEAR) % (Math.PI * 2);
      moon.position.set(Math.cos(moonAngle) * MOON_ORBIT_DIST, 0, Math.sin(moonAngle) * MOON_ORBIT_DIST);
      moon.rotation.y += dt * timeScale * 0.05;
    }
  }
  beltAngle += dt * timeScale * 0.007;
  belt.rotation.y = beltAngle;

  integrateCamera(dt);
  updateCosmosLabels();
  const camDist = camState.target.distanceTo(camera.position);
  const alphas = applyLOD(camDist);

  let best = 0;
  for (let i = 1; i < alphas.length; i++) if (alphas[i] > alphas[best]) best = i;
  levelInfo.textContent = `Cấp ${best} · ${LODS[best].name} · cam ${fmtDist(camDist)}`;

  updateLabels(alphas[0] > 0.03);
  composer.render();
});

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' || e.key === 'Esc') deselectPlanet();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});