import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import { HULL_GLSL } from '../world/hullShape.js';
import { RIVER_GLSL } from '../world/river.js';

// Height-field wave simulation in a square window that travels with the boat.
// The moving hull displaces water each step; ripples propagate, interfere,
// lose energy against the banks and die out on their own, so the wake traces
// the boat's real path and fades without any drawn shapes. The window moves
// in whole texels so the field never smears.
const stepShader = /* glsl */ `
${RIVER_GLSL}
${HULL_GLSL}
uniform sampler2D uState;
uniform vec2 uShift;
uniform float uTexel;
uniform vec3 uRect;
uniform vec4 uPosePrev;
uniform vec4 uPoseCur;
uniform float uWaveK;
uniform float uDamping;
uniform float uForce;
uniform vec4 uBladePrev; // x, z, depth, radius
uniform vec4 uBladeCur;
varying vec2 vUv;

float bladeDisplacement(vec2 w, vec4 b) {
  vec2 d = w - b.xy;
  return b.z * exp(-dot(d, d) / (b.w * b.w));
}

vec2 sampleState(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  return texture(uState, uv).rg;
}

vec2 toLocal(vec2 w, vec4 pose) {
  vec2 d = w - pose.xy;
  float c = cos(pose.z);
  float s = sin(pose.z);
  return vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

void main() {
  vec2 uv = vUv + uShift;
  vec2 st = sampleState(uv);
  float h = st.x;
  float v = st.y;
  float l = sampleState(uv - vec2(uTexel, 0.0)).x;
  float r = sampleState(uv + vec2(uTexel, 0.0)).x;
  float d = sampleState(uv - vec2(0.0, uTexel)).x;
  float u = sampleState(uv + vec2(0.0, uTexel)).x;
  v += ((l + r + d + u) * 0.25 - h) * uWaveK;
  v *= uDamping;
  h += v;

  vec2 w = uRect.xy + vUv * uRect.z;
  float before = hullDepth(toLocal(w, uPosePrev), uPosePrev.w);
  float after = hullDepth(toLocal(w, uPoseCur), uPoseCur.w);
  h += (before - after) * uForce;
  // The paddle blade sweeping through the water.
  h += (bladeDisplacement(w, uBladePrev) - bladeDisplacement(w, uBladeCur)) * uForce * 1.4;

  // Banks soak up energy; the window's rim is a sponge so nothing reflects.
  float land = smoothstep(-0.8, 0.6, bankDistance(w));
  float keep = 1.0 - land * 0.35;
  vec2 rim = min(vUv, 1.0 - vUv);
  keep *= mix(0.94, 1.0, smoothstep(0.0, 0.12, min(rim.x, rim.y)));
  gl_FragColor = vec4(h * keep, v * keep, 0.0, 1.0);
}
`;

export class WakeSim {
  constructor(renderer, { size = 512, world = 64, waveSpeed = 1.45, halfLife = 2.6, rate = 60 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.world = world;
    this.texel = world / size;
    this.rate = rate;
    this.accumulator = 0;
    const opts = {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    };
    this.targets = [new WebGLRenderTarget(size, size, opts), new WebGLRenderTarget(size, size, opts)];
    this.current = 0;
    this.origin = new Vector2(NaN, NaN);
    this.rect = new Vector4(); // origin x, origin z, size, 1/size for the water shader

    // Wave speed in texels/step is sqrt(K)/2 for this update scheme.
    const texelsPerStep = waveSpeed / (this.texel * rate);
    const waveK = Math.min(1.6, (2 * texelsPerStep) ** 2);
    const damping = Math.pow(0.5, 1 / (halfLife * rate));

    this.uniforms = {
      uState: { value: null },
      uShift: { value: new Vector2() },
      uTexel: { value: 1 / size },
      uRect: { value: new Vector3(0, 0, world) },
      uPosePrev: { value: new Vector4() },
      uPoseCur: { value: new Vector4() },
      uWaveK: { value: waveK },
      uDamping: { value: damping },
      uForce: { value: 0.9 },
      uBladePrev: { value: new Vector4(0, 0, 0, 0.15) },
      uBladeCur: { value: new Vector4(0, 0, 0, 0.15) },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: stepShader,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new Scene();
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.lastPose = null;
    this.clear();
  }

  get texture() {
    return this.targets[this.current].texture;
  }

  clear() {
    const prev = this.renderer.getRenderTarget();
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(prev);
  }

  // pose: { x, z, heading, heave }; blade: { x, z, depth } of the paddle.
  update(dt, pose, blade = null) {
    const t = this.texel;
    const ox = Math.floor((pose.x - this.world / 2) / t) * t;
    const oz = Math.floor((pose.z - this.world / 2) / t) * t;
    let shiftX = 0;
    let shiftZ = 0;
    if (Number.isNaN(this.origin.x)) {
      this.origin.set(ox, oz);
    } else {
      shiftX = Math.round((ox - this.origin.x) / t);
      shiftZ = Math.round((oz - this.origin.y) / t);
      if (Math.abs(shiftX) > this.size / 2 || Math.abs(shiftZ) > this.size / 2) {
        this.clear();
        shiftX = 0;
        shiftZ = 0;
      }
      this.origin.set(ox, oz);
    }
    if (!this.lastPose) this.lastPose = { ...pose };
    const bladeNow = blade ?? { x: pose.x, z: pose.z, depth: 0 };
    if (!this.lastBlade) this.lastBlade = { ...bladeNow };

    this.accumulator = Math.min(this.accumulator + dt, 4 / this.rate);
    const steps = Math.floor(this.accumulator * this.rate);
    this.accumulator -= steps / this.rate;

    const u = this.uniforms;
    u.uRect.value.x = this.origin.x;
    u.uRect.value.y = this.origin.y;
    const prevTarget = this.renderer.getRenderTarget();
    const from = this.lastPose;
    for (let i = 0; i < steps; i++) {
      const a = i / steps;
      const b = (i + 1) / steps;
      u.uPosePrev.value.set(
        from.x + (pose.x - from.x) * a,
        from.z + (pose.z - from.z) * a,
        from.heading + (pose.heading - from.heading) * a,
        from.heave + (pose.heave - from.heave) * a,
      );
      u.uPoseCur.value.set(
        from.x + (pose.x - from.x) * b,
        from.z + (pose.z - from.z) * b,
        from.heading + (pose.heading - from.heading) * b,
        from.heave + (pose.heave - from.heave) * b,
      );
      const lb = this.lastBlade;
      u.uBladePrev.value.set(lb.x + (bladeNow.x - lb.x) * a, lb.z + (bladeNow.z - lb.z) * a, lb.depth + (bladeNow.depth - lb.depth) * a, 0.16);
      u.uBladeCur.value.set(lb.x + (bladeNow.x - lb.x) * b, lb.z + (bladeNow.z - lb.z) * b, lb.depth + (bladeNow.depth - lb.depth) * b, 0.16);
      u.uShift.value.set(i === 0 ? shiftX / this.size : 0, i === 0 ? shiftZ / this.size : 0);
      u.uState.value = this.targets[this.current].texture;
      const next = 1 - this.current;
      this.renderer.setRenderTarget(this.targets[next]);
      this.renderer.render(this.scene, this.camera);
      this.current = next;
    }
    this.renderer.setRenderTarget(prevTarget);
    if (steps > 0) {
      this.lastPose = { ...pose };
      this.lastBlade = { ...bladeNow };
    }
    // A shift requested on a frame without a step must not be lost.
    if (steps === 0 && (shiftX !== 0 || shiftZ !== 0)) {
      this.origin.set(this.origin.x - shiftX * t, this.origin.y - shiftZ * t);
    }
    this.rect.set(this.origin.x, this.origin.y, this.world, 1 / this.size);
  }
}
