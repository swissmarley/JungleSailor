import { Color, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3, Vector4 } from 'three';
import { RAIN_GLSL } from '../effects/rainSchedule.js';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { HULL_GLSL } from '../world/hullShape.js';
import { RIVER_GLSL } from '../world/river.js';

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
${RIVER_GLSL}
${HULL_GLSL}
${RAIN_GLSL}
uniform sampler2D uWaves;
uniform float uWaveTile;
uniform float uWaveAmp;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform sampler2D uSim;
uniform vec4 uSimRect;
uniform float uSimGain;
uniform mat4 uBoatInv;
uniform vec3 uWaterColor;
uniform vec3 uSpecDir;
uniform vec3 uSpecColor;
uniform float uSpecRadius;
uniform float uDistort;
uniform float uRainRipples;
uniform int uDebugView;
varying vec3 vWorldPos;

const mat2 ROT2 = mat2(0.8124, 0.5831, -0.5831, 0.8124);
const mat2 ROT3 = mat2(0.3624, -0.9320, 0.9320, 0.3624);

// Expanding impact rings from the shared rain timetable. 'p' is already
// displaced by the surface waves, so the rings ride and bend with them.
vec2 rainRipples(vec2 p, float t, float intensity) {
  vec2 slope = vec2(0.0);
  vec2 q = p / RAIN_CELL;
  vec2 base = floor(q);
  vec2 o = step(0.5, q - base) - 1.0;
  for (int layer = 0; layer < 2; layer++) {
    float lf = float(layer);
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 cell = base + o + vec2(float(i), float(j));
        float tt = t / RAIN_PERIOD + rainPhase(cell, lf);
        float cycle = floor(tt);
        float age = fract(tt) * RAIN_PERIOD;
        if (age > RAIN_LIFE) continue;
        if (rainDropExists(cell, lf, cycle, intensity) < 0.5) continue;
        vec2 d = p - rainDropPos(cell, lf, cycle);
        float dist = length(d) + 1e-4;
        float life = 1.0 - age / RAIN_LIFE;
        float radius = age * RAIN_RING_SPEED;
        float x = dist - radius;
        float env = exp(-x * x * 650.0);
        // Derivative of a damped cosine ring: a crest with a trailing ripple.
        float k = 92.0;
        float dh = (-k * sin(k * x) - 1300.0 * x * cos(k * x)) * env;
        float amp = 0.0026 * life * life / (1.0 + radius * 5.0);
        slope += (d / dist) * dh * amp;
      }
    }
  }
  return slope;
}

void main() {
  vec3 p = vWorldPos;

  // Keep the boat dry: no water surface inside the hull.
  vec3 lp = (uBoatInv * vec4(p, 1.0)).xyz;
  float inside = hullInside(lp);
  if (inside > -0.006) discard;

  vec3 toEye = cameraPosition - p;
  float dist = length(toEye);
  vec3 v = toEye / dist;

  // Ripples drift with the current.
  float s = riverSlope(p.z);
  vec2 flow = normalize(vec2(-s, -1.0)) * 0.22;
  vec2 uv1 = (p.xz - flow * uTime) / uWaveTile;
  vec2 uv2 = ROT2 * (p.xz - flow * uTime * 1.15) / (uWaveTile * 0.37) + 0.37;
  vec2 uv3 = ROT3 * (p.xz - flow * uTime * 1.3) / (uWaveTile * 0.13) + 0.71;
  vec4 w1 = texture(uWaves, uv1);
  vec4 w2 = texture(uWaves, uv2);
  vec4 w3 = texture(uWaves, uv3);
  vec2 s1 = w1.xy;
  vec2 s2 = transpose(ROT2) * w2.xy;
  vec2 s3 = transpose(ROT3) * w3.xy;
  float var1 = max(w1.z - w1.x * w1.x, 0.0) + max(w1.w - w1.y * w1.y, 0.0);
  float var2 = max(w2.z - w2.x * w2.x, 0.0) + max(w2.w - w2.y * w2.y, 0.0);
  float var3 = max(w3.z - w3.x * w3.x, 0.0) + max(w3.w - w3.y * w3.y, 0.0);
  // Three octaves of the same ripple patch: swell, ripples, fine cat's-paws.
  vec2 slope = (s1 + s2 * 0.6 + s3 * 0.45) * uWaveAmp;
  float variance = (var1 + var2 * 0.36 + var3 * 0.2) * 0.5 * uWaveAmp * uWaveAmp + 0.0003;

  // Wake from the height-field simulation, faded out at the window's edge.
  vec2 suv = (p.xz - uSimRect.xy) / uSimRect.z;
  vec2 rim = min(suv, 1.0 - suv);
  float simFade = smoothstep(0.0, 0.15, min(rim.x, rim.y));
  if (simFade > 0.0) {
    float e = uSimRect.w;
    float hl = texture(uSim, suv - vec2(e, 0.0)).r;
    float hr = texture(uSim, suv + vec2(e, 0.0)).r;
    float hd = texture(uSim, suv - vec2(0.0, e)).r;
    float hu = texture(uSim, suv + vec2(0.0, e)).r;
    vec2 g = vec2(hr - hl, hu - hd) / (2.0 * e * uSimRect.z) * uSimGain;
    // Tame the steepest bits; right against the planks the water simply
    // hugs the hull.
    float gl = length(g);
    g *= min(1.0, 0.45 / max(gl, 1e-4));
    g *= smoothstep(0.0, 0.12, -inside);
    slope += g * simFade;
  }

  // Rain: rings near the eye, extra roughness further out.
  float rippleSheen = 0.0;
  if (uRainRipples > 0.001) {
    float near = 1.0 - smoothstep(14.0, 32.0, dist);
    if (near > 0.0) {
      vec2 warp = slope * 0.55;
      vec2 ripple = rainRipples(p.xz + warp, uTime, uRainRipples) * near;
      slope += ripple;
      rippleSheen = clamp(length(ripple) * 2.5, 0.0, 1.0);
    }
    variance += 0.004 * uRainRipples * (1.0 - near * 0.7);
  }

  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  float ndv = max(dot(n, v), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Distorted mirror image. Alpha is 1 where the reflected ray reaches open sky.
  vec4 rc = uReflMatrix * vec4(p, 1.0);
  vec2 ruv = rc.xy / rc.w;
  vec3 tilt = mat3(viewMatrix) * (n - vec3(0.0, 1.0, 0.0));
  ruv += tilt.xy * uDistort;
  vec4 refl = texture(uReflection, clamp(ruv, vec2(0.001), vec2(0.999)));

  // Water body: dark, slightly tea-coloured jungle water.
  vec3 body = uWaterColor * (hemiAmbient(vec3(0.0, 1.0, 0.0)) + uLightColor * 0.25);

  vec3 col = mix(body, refl.rgb, fres);
  // Ring crests tilt towards the bright overcast and catch its light.
  col += uSkyAmbient * rippleSheen * 0.55;

  // Glitter of the moon (or sun) from the slope distribution: sharp sparkles
  // up close, a soft path far away where mip-mapped variance grows.
  vec3 hv = normalize(uSpecDir + v);
  if (hv.y > 0.0 && uSpecDir.y > 0.0) {
    vec2 hs = -hv.xz / hv.y;
    vec2 ds = hs - slope;
    float var = variance + uSpecRadius * uSpecRadius * 0.25;
    float pdf = exp(-dot(ds, ds) / (2.0 * var)) / (6.2831853 * var);
    float fh = 0.02 + 0.98 * pow(1.0 - max(dot(v, hv), 0.0), 5.0);
    float spec = fh * pdf / (4.0 * pow(hv.y, 4.0) * max(v.y, 0.08));
    float skyVis = smoothstep(0.35, 0.95, refl.a);
    col += uSpecColor * spec * skyVis;
  }

  gl_FragColor = vec4(applyFog(col, p), 1.0 - uReflPass);
  if (uDebugView == 1) gl_FragColor = vec4(refl.rgb, 1.0);
  if (uDebugView == 2) gl_FragColor = vec4(vec3(refl.a), 1.0);
  if (uDebugView == 3) gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  if (uDebugView == 4) gl_FragColor = vec4(vec3(fres), 1.0);
  ${OUTPUT_GLSL}
  if (uDebugView == 5) gl_FragColor = vec4(slope * 2.0 + 0.5, 0.5, 1.0);
  if (uDebugView == 6) gl_FragColor = vec4(w1.xy * 2.0 + 0.5, sqrt(variance) * 4.0, 1.0);
  if (uDebugView == 7) gl_FragColor = vec4(v * 0.5 + 0.5, 1.0);
}
`;

export class Water {
  constructor({ waves, reflection, sim }) {
    this.uniforms = {
      ...shared,
      uWaves: { value: waves.texture },
      uWaveTile: { value: waves.tile },
      uWaveAmp: { value: 1 },
      uReflection: { value: reflection.texture },
      uReflMatrix: { value: reflection.textureMatrix },
      uSim: { value: sim.texture },
      uSimRect: { value: new Vector4() },
      uSimGain: { value: 1.6 },
      uBoatInv: { value: new Matrix4() },
      uWaterColor: { value: new Color(0.02, 0.03, 0.022) },
      uSpecDir: { value: new Vector3(0, 1, 0) },
      uSpecColor: { value: new Color(0, 0, 0) },
      uSpecRadius: { value: 0.052 },
      uDistort: { value: 0.55 },
      uRainRipples: { value: 0 },
      uDebugView: { value: 0 },
    };
    const material = new ShaderMaterial({
      name: 'Water',
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
    });
    const geometry = new PlaneGeometry(2400, 2400, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'Water';
    this.sim = sim;
  }

  update(camera, boatMesh) {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.uniforms.uSim.value = this.sim.texture;
    this.uniforms.uSimRect.value.copy(this.sim.rect);
    boatMesh.updateMatrixWorld();
    this.uniforms.uBoatInv.value.copy(boatMesh.matrixWorld).invert();
  }
}
