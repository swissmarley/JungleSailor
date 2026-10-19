import { DoubleSide, ShaderMaterial } from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { RIVER_GLSL } from '../world/river.js';

const vertexShader = /* glsl */ `
${RIVER_GLSL}
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
attribute vec3 aWind;
attribute float aAO;
attribute float aKind;
attribute float aTint;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vAO;
varying float vKind;
varying float vTint;
varying vec3 vInstColor;
varying float vDepth;

void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = m * instanceMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vec3 origin = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Whole-plant sway with slow gusts, plus fast leaf flutter.
  float ph = dot(origin.xz, vec2(0.071, 0.113)) + aWind.z * 1.7;
  float gust = 0.55 + 0.45 * sin(uTime * 0.27 + origin.x * 0.031 + origin.z * 0.017);
  float sway = sin(uTime * 0.9 + ph) * 0.65 + sin(uTime * 1.83 + ph * 1.3) * 0.35;
  vec2 disp = uWindDir * (0.4 + 0.6 * sway) * gust * uWindStrength * aWind.x;
  wp.xz += disp;
  wp.y -= dot(disp, disp) * 0.6;
  float fl = sin(uTime * 6.3 + ph * 7.0 + position.y * 2.3 + position.x * 1.7);
  float fl2 = sin(uTime * 4.1 + ph * 3.0 + position.z * 2.9);
  wp.xyz += vec3(fl, 0.6 * fl2, fl2) * aWind.y * uWindStrength * 0.03;

  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(m) * normal);
  vUv = uv;
  vAO = aAO;
  vKind = aKind;
  vTint = aTint;
  #ifdef USE_INSTANCING_COLOR
    vInstColor = instanceColor;
  #else
    vInstColor = vec3(1.0);
  #endif
  vDepth = bankDistance(origin.xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform sampler2D uAtlas;
uniform float uAtlasSize;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vAO;
varying float vKind;
varying float vTint;
varying vec3 vInstColor;
varying float vDepth;

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo;
  float alpha = 1.0;
  bool leaf = vKind > 1.5;
  if (leaf) {
    vec4 tex = texture(uAtlas, vUv);
    // Coverage shrinks in coarser mips; push it back up so far crowns stay dense.
    vec2 dx = dFdx(vUv * uAtlasSize);
    vec2 dy = dFdy(vUv * uAtlasSize);
    float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    alpha = tex.a * (1.0 + lod * 0.3);
    #ifdef ALPHA_TO_COVERAGE
      alpha = clamp((alpha - 0.42) / max(fwidth(alpha), 1e-4) + 0.5, 0.0, 1.0);
      if (alpha < 0.02) discard;
    #else
      if (alpha < 0.42) discard;
      alpha = 1.0;
    #endif
    albedo = tex.rgb * vInstColor;
    vec3 dry = vec3(0.13, 0.075, 0.03) * (0.7 + 0.6 * dot(tex.rgb, vec3(0.6, 0.3, 0.1)) * 6.0);
    albedo = mix(albedo, dry, vTint);
  } else {
    if (!gl_FrontFacing) n = -n;
    float around = vUv.x * 6.2831853;
    vec2 bp = vec2(vUv.x * 7.0, vUv.y * 0.8);
    float streaks = vnoise(bp * vec2(1.0, 3.0)) * 0.6 + vnoise(bp * vec2(3.0, 9.0)) * 0.4;
    if (vKind < 0.5) {
      // Smooth grey-brown rainforest bark with lichen and a mossy foot.
      albedo = vec3(0.075, 0.062, 0.048) * (0.65 + 0.6 * streaks);
      float lichen = smoothstep(0.62, 0.8, vnoise(vec2(vUv.x * 5.0 + 3.0, vUv.y * 1.3)));
      albedo = mix(albedo, vec3(0.11, 0.115, 0.095), lichen * 0.6);
      float moss = (1.0 - smoothstep(0.3, 2.5, vWorldPos.y)) * smoothstep(0.3, 0.7, vnoise(bp * 2.0));
      albedo = mix(albedo, vec3(0.025, 0.045, 0.012), moss);
    } else {
      // Ringed palm / fern stems.
      float ring = smoothstep(0.75, 1.0, fract(vUv.y * 2.6 + vnoise(vec2(around, vUv.y)) * 0.2));
      albedo = vec3(0.07, 0.06, 0.045) * (0.75 + 0.4 * streaks) * (1.0 - 0.45 * ring);
    }
    albedo *= vInstColor * 0.5 + 0.5;
  }
  albedo *= 1.0 - 0.25 * uWetness;

  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 l = uLightDir;
  float ndl = dot(n, l);
  float wrap = leaf ? 0.5 : 0.15;
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);

  // Deeper in the forest and lower down, less moonlight and sky get through;
  // crowns that rise above the canopy catch it again.
  float inForest = smoothstep(1.5, 18.0, vDepth);
  float lift = smoothstep(5.0, 24.0, vWorldPos.y);
  float open = mix(1.0, 0.16, inForest * (1.0 - 0.85 * lift));
  vec3 amb = hemiAmbient(n) * mix(1.0, 0.4, inForest * (1.0 - lift)) * vAO;
  vec3 col = albedo * (amb + uLightColor * diff * open * vAO);

  if (leaf) {
    // Light shining through leaves towards the eye.
    float back = pow(clamp(dot(-v, l), 0.0, 1.0), 3.0);
    float thin = clamp(0.5 - ndl * 0.5, 0.0, 1.0);
    col += albedo * vec3(1.0, 1.3, 0.5) * uLightColor * back * thin * 0.8 * open;
  }
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 30.0) * (0.03 + 0.22 * uWetness) * (leaf ? 1.0 : 0.3);
  col += uLightColor * spec * open * vAO;

  col = applyFog(col, vWorldPos);
  gl_FragColor = vec4(col, uReflPass > 0.5 ? 0.0 : alpha);
  ${OUTPUT_GLSL}
}
`;

export function createVegetationMaterial(atlas, { alphaToCoverage = true } = {}) {
  return new ShaderMaterial({
    name: 'Vegetation',
    uniforms: {
      ...shared,
      uAtlas: { value: atlas },
      uAtlasSize: { value: atlas.image.width },
    },
    vertexShader,
    fragmentShader,
    side: DoubleSide,
    alphaToCoverage,
  });
}
