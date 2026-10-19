import {
  CustomBlending,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { HULL_GLSL } from '../world/hullShape.js';
import { RAIN, RAIN_GLSL } from './rainSchedule.js';

const vertexShader = /* glsl */ `
${NOISE_GLSL}
${RAIN_GLSL}
${HULL_GLSL}
uniform float uTime;
uniform float uRain;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec2 uCenterCell;
uniform float uPixelAngle;
uniform mat4 uBoatInv;
attribute vec3 aCell;     // cell offset x, z and drop layer
attribute vec3 aCorner;   // x: -1..1 across, y: 0..1 along, z: 0 streak / 1 splash
varying float vAlpha;
varying vec2 vCoord;
varying float vSplash;
varying vec3 vWorldPos;

void main() {
  vec2 cell = uCenterCell + aCell.xy;
  float layer = aCell.z;
  float tt = uTime / RAIN_PERIOD + rainPhase(cell, layer);
  float cycle = floor(tt);
  float age = fract(tt) * RAIN_PERIOD;
  vec3 pos;
  float alpha = 0.0;
  vSplash = aCorner.z;
  vCoord = aCorner.xy;
  vec2 slant = uWindDir * uWindStrength * 0.18;

  if (aCorner.z < 0.5) {
    // The next drop of this cell, still falling.
    float until = RAIN_PERIOD - age;
    vec2 hit = rainDropPos(cell, layer, cycle + 1.0);
    float exists = rainDropExists(cell, layer, cycle + 1.0, uRain);
    float h = until * RAIN_FALL;
    vec3 head = vec3(hit.x + slant.x * h, h, hit.y + slant.y * h);
    vec3 axis = normalize(vec3(slant.x, 1.0, slant.y));
    vec3 toEye = cameraPosition - head;
    float dist = length(toEye);
    vec3 side = normalize(cross(axis, toEye / dist));
    float width = max(0.0045, dist * uPixelAngle * 0.7);
    float len = 0.38 + 0.012 * dist;
    pos = head + axis * aCorner.y * len + side * aCorner.x * width;
    alpha = exists * (0.0045 / width) * 0.55 * smoothstep(1.8, 4.5, dist) * (1.0 - smoothstep(18.0, 30.0, dist));
  } else {
    // A small crown where the previous drop struck the water.
    vec2 hit = rainDropPos(cell, layer, cycle);
    float exists = rainDropExists(cell, layer, cycle, uRain);
    vec3 lp = (uBoatInv * vec4(hit.x, 0.0, hit.y, 1.0)).xyz;
    float dry = step(-0.05, hullInside(lp));
    float life = 1.0 - age / 0.2;
    vec3 base = vec3(hit.x, 0.0, hit.y);
    vec3 toEye = cameraPosition - base;
    float dist = length(toEye);
    vec3 side = normalize(vec3(-toEye.z, 0.0, toEye.x));
    float w = (0.035 + age * 0.45) * (1.0 + dist * 0.015);
    float hgt = 0.075 * sin(clamp(age / 0.2, 0.0, 1.0) * 3.14159) + 0.015;
    pos = base + side * aCorner.x * w + vec3(0.0, aCorner.y * hgt, 0.0);
    alpha = exists * (1.0 - dry) * step(0.0, life) * life * 0.6 * (1.0 - smoothstep(12.0, 22.0, dist));
  }
  vAlpha = alpha;
  vWorldPos = pos;
  gl_Position = alpha > 0.001 ? projectionMatrix * viewMatrix * vec4(pos, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
varying float vAlpha;
varying vec2 vCoord;
varying float vSplash;
varying vec3 vWorldPos;
void main() {
  float a;
  if (vSplash < 0.5) {
    float across = 1.0 - abs(vCoord.x);
    a = across * smoothstep(0.0, 0.25, vCoord.y) * (1.0 - vCoord.y * 0.6);
  } else {
    // A little crown: two horns of spray rising from the impact.
    float across = abs(vCoord.x);
    a = smoothstep(0.15, 0.6, across) * (1.0 - smoothstep(0.75, 1.0, across)) * (1.0 - vCoord.y) + (1.0 - across) * 0.35 * (1.0 - vCoord.y);
  }
  // Drops catch the grey sky light.
  vec3 col = uSkyAmbient * 2.6 + uLightColor * 0.6 + vec3(0.02);
  col = applyFog(col, vWorldPos);
  gl_FragColor = vec4(col, a * vAlpha);
  ${OUTPUT_GLSL}
}
`;

export class Rain {
  constructor({ grid = 40 } = {}) {
    this.grid = grid;
    const base = new InstancedBufferGeometry();
    // 4 corners for the streak, 4 for the splash.
    const corners = [
      -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0,
      -1, 0, 1, 1, 0, 1, 1, 1, 1, -1, 1, 1,
    ];
    base.setAttribute('aCorner', new Float32BufferAttribute(corners, 3));
    base.setAttribute('position', new Float32BufferAttribute(new Array(8 * 3).fill(0), 3));
    base.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const cells = [];
    for (let layer = 0; layer < RAIN.layers; layer++) {
      for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) cells.push(i - grid / 2, j - grid / 2, layer);
      }
    }
    base.setAttribute('aCell', new InstancedBufferAttribute(new Float32Array(cells), 3));
    base.instanceCount = cells.length / 3;

    this.uniforms = {
      ...shared,
      uCenterCell: { value: new Vector2() },
      uPixelAngle: { value: 0.001 },
      uBoatInv: { value: new Matrix4() },
    };
    const material = new ShaderMaterial({
      name: 'Rain',
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      // Leave the reflection buffer's sky mask (alpha) untouched.
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.mesh = new Mesh(base, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'Rain';
    this._dir = new Vector3();
  }

  update(camera, boatMesh, viewportHeight) {
    this.mesh.visible = shared.uRain.value > 0.01;
    if (!this.mesh.visible) return;
    // Centre the drop grid a little ahead of the eye, where it is seen.
    const dir = camera.getWorldDirection(this._dir);
    const cx = camera.position.x + dir.x * 11;
    const cz = camera.position.z + dir.z * 11;
    this.uniforms.uCenterCell.value.set(Math.floor(cx / RAIN.cell), Math.floor(cz / RAIN.cell));
    this.uniforms.uPixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(viewportHeight, 1);
    this.uniforms.uBoatInv.value.copy(boatMesh.matrixWorld).invert();
  }
}
