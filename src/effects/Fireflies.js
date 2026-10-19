import {
  BufferGeometry,
  CustomBlending,
  Float32BufferAttribute,
  OneFactor,
  Points,
  ShaderMaterial,
  Vector3,
  ZeroFactor,
} from 'three';
import { Rng } from '../core/random.js';
import { ATMOSPHERE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { RIVER_GLSL } from '../world/river.js';

const vertexShader = /* glsl */ `
${RIVER_GLSL}
uniform float uTime;
uniform float uAmount;
uniform vec3 uCenter;
uniform float uBox;
uniform float uViewportHeight;
attribute vec4 aSeed;
varying float vGlow;
varying vec3 vWorldPos;
void main() {
  vec2 home = aSeed.xz * uBox;
  vec2 rel = mod(home - uCenter.xz + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 p = vec3(uCenter.x + rel.x, 0.35 + aSeed.y * aSeed.y * 3.4, uCenter.z + rel.y);
  float t = uTime * (0.12 + 0.1 * aSeed.w);
  p += vec3(sin(t * 1.3 + aSeed.x * 40.0), 0.35 * sin(t * 1.9 + aSeed.z * 30.0), cos(t * 1.1 + aSeed.y * 20.0)) * 1.1;

  // They gather along the banks and over the shallows.
  float bd = bankDistance(p.xz);
  float place = smoothstep(-4.0, -1.2, bd) * (1.0 - smoothstep(9.0, 16.0, bd));
  float period = 2.6 + aSeed.w * 3.5;
  float cyc = fract(uTime / period + aSeed.x * 7.0);
  float blink = smoothstep(0.0, 0.06, cyc) * (1.0 - smoothstep(0.1, 0.42, cyc));
  // Ones drifting right past the lens would bloom into blobs; let them fade.
  float near = smoothstep(2.5, 6.0, distance(p, cameraPosition));
  vGlow = blink * place * near * uAmount;
  vWorldPos = p;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = 0.32 * projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-mv.z, 0.1);
  gl_PointSize = vGlow > 0.002 ? clamp(px, 2.0, 40.0) : 0.0;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
varying float vGlow;
varying vec3 vWorldPos;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float core = exp(-r * 22.0);
  float halo = exp(-r * 5.0) * 0.28;
  vec3 col = vec3(0.95, 1.0, 0.42) * (core * 3.2 + halo) * vGlow;
  // Mist swallows distant ones.
  float d = length(vWorldPos - cameraPosition);
  col *= exp(-d * uFogDensity * 0.9);
  gl_FragColor = vec4(col, 0.0);
  ${OUTPUT_GLSL}
}
`;

export class Fireflies {
  constructor({ count = 160, box = 70 } = {}) {
    const rng = new Rng(99);
    const seeds = [];
    for (let i = 0; i < count; i++) seeds.push(rng.next(), rng.next(), rng.next(), rng.next());
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 4));
    this.uniforms = {
      ...shared,
      uAmount: { value: 1 },
      uCenter: { value: new Vector3() },
      uBox: { value: box },
      uViewportHeight: { value: 1 },
    };
    const material = new ShaderMaterial({
      name: 'Fireflies',
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
    this.points.name = 'Fireflies';
  }

  update(camera, amount, viewportHeight) {
    this.uniforms.uAmount.value = amount;
    this.points.visible = amount > 0.01;
    const dir = camera.getWorldDirection(this.uniforms.uCenter.value);
    this.uniforms.uCenter.value.set(camera.position.x + dir.x * 20, 0, camera.position.z + dir.z * 20);
    this.uniforms.uViewportHeight.value = viewportHeight;
  }

  setViewportHeight(h) {
    this.uniforms.uViewportHeight.value = h;
  }
}
