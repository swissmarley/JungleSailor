import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  OneFactor,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng, hashInts } from '../core/random.js';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { halfBeam, sAt } from './hullShape.js';
import { riverHalfWidth, riverX } from './river.js';
import { CHUNK_LENGTH } from './terrain.js';

const MAX_BLOSSOMS = 40;
const MAX_PADS = 220;

// --- geometry -----------------------------------------------------------------

function withColor(geometry, rgb, glow = 0) {
  const n = geometry.attributes.position.count;
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) col.set([rgb[0], rgb[1], rgb[2], glow], i * 4);
  geometry.setAttribute('aColor', new BufferAttribute(col, 4));
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

function padGeometry() {
  // A round leaf with the characteristic notch, slightly cupped.
  const g = new CircleGeometry(0.5, 28, 0.18, Math.PI * 2 - 0.36);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getZ(i));
    p.setY(i, 0.012 + r * r * 0.05);
  }
  g.computeVertexNormals();
  return withColor(g, [0.025, 0.06, 0.018]);
}

function petal(length, width, cup) {
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new Vector2(Math.max(Math.sin(Math.PI * Math.pow(t, 0.8)) * width, 1e-4), t * length));
  }
  const g = new LatheGeometry(pts, 8, 0, Math.PI * 0.55);
  g.scale(1, 1, cup);
  return g;
}

function flowerGeometry() {
  const parts = [];
  const rings = [
    { n: 8, len: 0.17, w: 0.05, tilt: 1.05, y: 0.03, rgb: [0.75, 0.62, 0.7] },
    { n: 7, len: 0.15, w: 0.048, tilt: 0.72, y: 0.04, rgb: [0.85, 0.74, 0.8] },
    { n: 6, len: 0.12, w: 0.042, tilt: 0.38, y: 0.05, rgb: [0.95, 0.88, 0.9] },
  ];
  const q = new Quaternion();
  const m = new Matrix4();
  rings.forEach((ring, ri) => {
    for (let i = 0; i < ring.n; i++) {
      const g = petal(ring.len, ring.w, 0.6);
      const az = (i / ring.n) * Math.PI * 2 + ri * 0.4;
      q.setFromAxisAngle(new Vector3(0, 0, 1), -ring.tilt);
      m.makeRotationFromQuaternion(q);
      g.applyMatrix4(m);
      g.rotateY(az);
      g.translate(0, ring.y, 0);
      parts.push(withColor(g, ring.rgb, 1));
    }
  });
  const heart = new LatheGeometry(
    [new Vector2(1e-4, 0), new Vector2(0.03, 0.01), new Vector2(0.028, 0.05), new Vector2(1e-4, 0.055)],
    10,
  );
  heart.translate(0, 0.03, 0);
  parts.push(withColor(heart, [0.9, 0.75, 0.25], 1.4));
  return mergeGeometries(parts);
}

// --- materials ----------------------------------------------------------------

const solidVertex = /* glsl */ `
attribute vec4 aColor;
attribute float aFade;
varying vec4 vColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFade;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(m) * normal);
  vColor = aColor;
  vFade = aFade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const solidFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform float uGlow;
varying vec4 vColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFade;
void main() {
  if (vFade < 0.01) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vColor.rgb;
  float diff = clamp((dot(n, uLightDir) + 0.4) / 1.4, 0.0, 1.0);
  vec3 col = albedo * (hemiAmbient(n) + uLightColor * diff);
  vec3 h = normalize(uLightDir + v);
  col += uLightColor * pow(max(dot(n, h), 0.0), 40.0) * 0.15;
  // Moon lotus: the petals hold their own soft light.
  col += albedo * vColor.a * uGlow * (0.9 + 0.1 * sin(uTime * 2.0 + vWorldPos.x));
  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0 - uReflPass);
  ${OUTPUT_GLSL}
}
`;

const glowVertex = /* glsl */ `
attribute float aFade;
varying vec2 vUv;
varying float vFade;
varying vec3 vWorldPos;
void main() {
  vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float size = length((instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = centre + (right * position.x + up * position.y) * size;
  vUv = uv;
  vFade = aFade;
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const glowFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform float uGlow;
uniform vec3 uGlowColor;
varying vec2 vUv;
varying float vFade;
varying vec3 vWorldPos;
void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float r = dot(c, c);
  float a = exp(-r * 4.5) * 0.55 + exp(-r * 22.0) * 0.6;
  float d = length(vWorldPos - cameraPosition);
  vec3 col = uGlowColor * a * vFade * uGlow * exp(-d * uFogDensity * 0.8);
  gl_FragColor = vec4(col, 0.0);
  ${OUTPUT_GLSL}
}
`;

const sparkVertex = /* glsl */ `
attribute float aLife;
uniform float uViewportHeight;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = 0.07 * projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-mv.z, 0.1);
  gl_PointSize = aLife > 0.0 ? clamp(px * (0.4 + aLife), 1.5, 24.0) : 0.0;
}
`;

const sparkFragment = /* glsl */ `
uniform vec3 uGlowColor;
varying float vLife;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float a = exp(-r * 6.0) * vLife;
  gl_FragColor = vec4(uGlowColor * a * 2.2, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const premultipliedAdd = {
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneFactor,
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor,
};

// --- the field ------------------------------------------------------------------

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _local = new Vector3();
const _axisY = new Vector3(0, 1, 0);

export class LotusField {
  constructor() {
    this.group = new Group();
    this.group.name = 'Lotus';
    this.collected = new Set();
    this.count = 0;
    this.chunks = new Map();
    this.active = [];
    this.uniforms = {
      ...shared,
      uGlow: { value: 1 },
      uGlowColor: { value: new Color(0.62, 0.6, 0.95) },
      uViewportHeight: { value: 1 },
    };

    const solid = new ShaderMaterial({ name: 'Lotus', uniforms: this.uniforms, vertexShader: solidVertex, fragmentShader: solidFragment, side: DoubleSide });
    this.pads = new InstancedMesh(padGeometry(), solid, MAX_PADS);
    this.flowers = new InstancedMesh(flowerGeometry(), solid, MAX_BLOSSOMS);
    const glowGeo = new PlaneGeometry(1, 1);
    this.glows = new InstancedMesh(glowGeo, new ShaderMaterial({ name: 'LotusGlow', uniforms: this.uniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...premultipliedAdd }), MAX_BLOSSOMS);
    for (const mesh of [this.pads, this.flowers, this.glows]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.geometry.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count).fill(1), 1));
      this.group.add(mesh);
    }
    this.glows.renderOrder = 25;

    // Sparkle burst pool.
    const sparkCount = 160;
    const sparkGeo = new BufferGeometry();
    sparkGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(sparkCount * 3), 3));
    sparkGeo.setAttribute('aLife', new Float32BufferAttribute(new Float32Array(sparkCount), 1));
    this.sparkVel = new Float32Array(sparkCount * 3);
    this.sparks = new Points(sparkGeo, new ShaderMaterial({ name: 'LotusSparks', uniforms: this.uniforms, vertexShader: sparkVertex, fragmentShader: sparkFragment, ...premultipliedAdd }));
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 26;
    this.group.add(this.sparks);
    this.sparkCursor = 0;
  }

  // Deterministic blossoms (and decorative pads) for one stretch of river.
  addChunk(index) {
    if (this.chunks.has(index)) return;
    const rng = new Rng(hashInts(index, 9001));
    const z0 = -index * CHUNK_LENGTH;
    const blossoms = [];
    const n = index < 0 ? 1 : rng.int(2, 3);
    for (let i = 0; i < n; i++) {
      const id = `${index}:${i}`;
      const z = z0 - ((i + rng.range(0.15, 0.85)) / n) * CHUNK_LENGTH;
      const hw = riverHalfWidth(z) - 2.2;
      const x = riverX(z) + rng.range(-hw, hw) * 0.8;
      blossoms.push({ id, x, z, phase: rng.range(0, 6.28), yaw: rng.range(0, 6.28), t: this.collected.has(id) ? 2 : -1 });
    }
    // The first one floats just ahead of the start, so it is found right away.
    if (index === 0) {
      blossoms[0].z = -16;
      blossoms[0].x = riverX(-16) + 0.9;
    }
    const pads = [];
    const padCount = rng.int(7, 12);
    for (let i = 0; i < padCount; i++) {
      const z = z0 - rng.range(0, CHUNK_LENGTH);
      const side = rng.chance(0.5) ? 1 : -1;
      const x = riverX(z) + side * (riverHalfWidth(z) - rng.range(0.6, 2.4));
      pads.push({ x, z, s: rng.range(0.55, 1.15), yaw: rng.range(0, 6.28), phase: rng.range(0, 6.28) });
    }
    this.chunks.set(index, { blossoms, pads });
  }

  removeChunk(index) {
    this.chunks.delete(index);
  }

  burst(at) {
    const pos = this.sparks.geometry.attributes.position.array;
    const life = this.sparks.geometry.attributes.aLife.array;
    const total = life.length;
    for (let i = 0; i < 36; i++) {
      const k = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % total;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.35;
      pos[k * 3] = at.x + Math.cos(a) * r * 0.4;
      pos[k * 3 + 1] = at.y + 0.1;
      pos[k * 3 + 2] = at.z + Math.sin(a) * r * 0.4;
      this.sparkVel[k * 3] = Math.cos(a) * (0.2 + r);
      this.sparkVel[k * 3 + 1] = 0.6 + Math.random() * 1.1;
      this.sparkVel[k * 3 + 2] = Math.sin(a) * (0.2 + r);
      life[k] = 1;
    }
  }

  // Returns the blossom collected this frame (if any) and the nearest one
  // ahead for the paddler to look at.
  update(dt, time, boat, boatMesh, glow, viewportHeight) {
    this.uniforms.uGlow.value = glow;
    this.uniforms.uViewportHeight.value = viewportHeight;
    const inv = this._inv ?? (this._inv = new Matrix4());
    inv.copy(boatMesh.matrixWorld).invert();
    let collected = null;
    let nearest = null;
    let nearestD = 14;
    let nb = 0;
    let np = 0;
    const fadeB = this.flowers.geometry.attributes.aFade.array;
    const fadeG = this.glows.geometry.attributes.aFade.array;
    for (const { blossoms, pads } of this.chunks.values()) {
      for (const b of blossoms) {
        if (b.t >= 2) continue;
        const bob = Math.sin(time * 1.3 + b.phase) * 0.012;
        if (b.t < 0) {
          // Waiting: is the hull passing over it?
          _local.set(b.x, 0, b.z).applyMatrix4(inv);
          const s = sAt(_local.z);
          const reach = s > -0.06 && s < 1.04 ? halfBeam(Math.min(Math.max(s, 0.02), 0.98)) + 0.42 : -1;
          if (Math.abs(_local.x) < reach) {
            b.t = 0;
            this.collected.add(b.id);
            this.count++;
            collected = b;
            this.burst(_p.set(b.x, 0.15, b.z));
          } else {
            const d = Math.hypot(b.x - boat.x, b.z - boat.z);
            if (d < nearestD && _local.z < 1) {
              nearestD = d;
              nearest = b;
            }
          }
        } else {
          b.t += dt / 1.1;
        }
        if (nb >= MAX_BLOSSOMS) continue;
        const k = b.t < 0 ? 0 : b.t;
        const rise = k * k * 0.9;
        const scale = b.t < 0 ? 1 : Math.max(0, 1 - k) * (1 + k * 0.6);
        _q.setFromAxisAngle(_axisY, b.yaw + time * 0.15 + k * 5);
        _m.compose(_p.set(b.x, bob + rise, b.z), _q, _s.setScalar(Math.max(scale, 1e-4)));
        this.flowers.setMatrixAt(nb, _m);
        _m.compose(_p.set(b.x, 0.22 + bob + rise, b.z), _q, _s.setScalar(0.95 * (1 + k * 1.5)));
        this.glows.setMatrixAt(nb, _m);
        fadeB[nb] = b.t < 0 ? 1 : Math.max(0, 1 - k);
        fadeG[nb] = b.t < 0 ? 0.85 + 0.15 * Math.sin(time * 2.3 + b.phase) : Math.max(0, 1 - k) * 1.6;
        // Its own pad stays behind on the water.
        if (np < MAX_PADS) {
          _q.setFromAxisAngle(_axisY, b.yaw);
          _m.compose(_p.set(b.x, bob - 0.004, b.z), _q, _s.setScalar(0.8));
          this.pads.setMatrixAt(np++, _m);
        }
        nb++;
      }
      for (const p of pads) {
        if (np >= MAX_PADS) break;
        _q.setFromAxisAngle(_axisY, p.yaw + Math.sin(time * 0.3 + p.phase) * 0.05);
        _m.compose(_p.set(p.x, Math.sin(time * 1.1 + p.phase) * 0.008 - 0.004, p.z), _q, _s.setScalar(p.s));
        this.pads.setMatrixAt(np++, _m);
      }
    }
    this.flowers.count = nb;
    this.glows.count = nb;
    this.pads.count = np;
    for (const mesh of [this.flowers, this.glows, this.pads]) mesh.instanceMatrix.needsUpdate = true;
    this.flowers.geometry.attributes.aFade.needsUpdate = true;
    this.glows.geometry.attributes.aFade.needsUpdate = true;

    // Sparkles drift up and fade.
    const pos = this.sparks.geometry.attributes.position.array;
    const life = this.sparks.geometry.attributes.aLife.array;
    let any = false;
    for (let i = 0; i < life.length; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] = Math.max(0, life[i] - dt / 1.4);
      this.sparkVel[i * 3 + 1] *= 1 - dt * 0.8;
      pos[i * 3] += this.sparkVel[i * 3] * dt;
      pos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
    }
    if (any || this._sparksWereLive) {
      this.sparks.geometry.attributes.position.needsUpdate = true;
      this.sparks.geometry.attributes.aLife.needsUpdate = true;
    }
    this._sparksWereLive = any;
    return { collected, nearest };
  }
}
