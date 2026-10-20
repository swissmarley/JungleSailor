import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import { Rng } from '../core/random.js';

const WAVE_COUNT = 40;

// A tileable patch of small wind/current ripples, re-synthesised every frame
// from a sum of travelling waves with the deep-water dispersion relation, so
// the surface evolves instead of just sliding. Channels: slope x, slope z,
// slope x², slope z². Mip-mapping the squares gives the sub-pixel slope
// variance (LEAN mapping) that widens the moon's glitter with distance.
const fragmentShader = /* glsl */ `
uniform vec4 uWaves[${WAVE_COUNT}];
uniform float uTime;
uniform float uTile;
varying vec2 vUv;
void main() {
  vec2 slope = vec2(0.0);
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 w = uWaves[i];
    vec2 k = w.xy * 6.2831853;
    float kw = length(k) / uTile;
    float omega = sqrt(9.81 * kw) * 0.75;
    float ph = dot(k, vUv) - omega * uTime + w.w;
    slope += w.z * cos(ph) * k / uTile;
  }
  gl_FragColor = vec4(slope, slope * slope);
}
`;

export class WaveTexture {
  constructor(renderer, { size = 512, tile = 9, rmsSlope = 0.045 } = {}) {
    this.renderer = renderer;
    this.tile = tile;
    this.target = new WebGLRenderTarget(size, size, {
      type: HalfFloatType,
      format: RGBAFormat,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.target.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    // Directional spectrum: mostly along the current with a broad spread.
    const rng = new Rng(4242);
    const used = new Set();
    const waves = [];
    let slopeSq = 0;
    while (waves.length < WAVE_COUNT) {
      const kMag = Math.exp(rng.range(Math.log(2.5), Math.log(38)));
      const spread = rng.chance(0.75) ? rng.normal() * 0.55 : rng.range(-Math.PI, Math.PI);
      const dir = -Math.PI / 2 + spread;
      const m = Math.round(kMag * Math.cos(dir));
      const n = Math.round(kMag * Math.sin(dir));
      const key = `${m},${n}`;
      if ((m === 0 && n === 0) || used.has(key)) continue;
      used.add(key);
      const k = (Math.hypot(m, n) * Math.PI * 2) / tile;
      const amp = Math.pow(k, -1.85) * rng.range(0.6, 1.4);
      slopeSq += 0.5 * (amp * k) ** 2;
      waves.push([m, n, amp, rng.range(0, Math.PI * 2)]);
    }
    const norm = rmsSlope / Math.sqrt(slopeSq);
    this.uniforms = {
      uWaves: { value: waves.map(([m, n, a, p]) => new Vector4(m, n, a * norm, p)) },
      uTime: { value: 0 },
      uTile: { value: tile },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new Scene();
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get texture() {
    return this.target.texture;
  }

  update(time) {
    this.uniforms.uTime.value = time;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }
}
