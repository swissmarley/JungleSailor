import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 1200.0, 1.0);
  gl_Position = p.xyww;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform vec3 uSunGlow;
uniform vec3 uSunHorizon;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform vec3 uMoonRight;
uniform vec3 uMoonUp;
uniform float uMoonRadius;
uniform float uMoonBright;
uniform vec3 uMoonGlow;
uniform float uMoonVis;
uniform sampler2D uMoonTex;
uniform float uStars;
uniform float uCloudCover;
uniform float uCloudSoft;
uniform vec3 uCloudDark;
uniform vec3 uCloudLit;
uniform vec2 uCloudWind;
uniform vec3 uGalaxyNormal;
uniform vec3 uTreeLine;
uniform float uDiscs;
varying vec3 vDir;

vec3 starField(vec3 d) {
  vec3 p = d * 170.0;
  vec3 id = floor(p);
  float h = hash13(id);
  if (h > 0.22) return vec3(0.0);
  vec3 off = vec3(hash13(id + 11.1), hash13(id + 23.7), hash13(id + 37.3));
  vec3 sp = normalize(id + 0.15 + 0.7 * off) * 170.0;
  float dist = length(p - sp);
  float px = max(length(fwidth(p)), 1e-4);
  float mag = pow(hash13(id + 5.3), 7.0);
  float size = 0.035 + 0.09 * mag;
  float w = max(size, px * 0.75);
  float b = exp(-dist * dist / (w * w)) * (size * size) / (w * w);
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * h * 4.0) + h * 300.0);
  vec3 tint = mix(vec3(0.78, 0.86, 1.15), vec3(1.15, 0.96, 0.78), hash13(id + 71.0));
  return tint * b * (0.25 + 5.0 * mag) * tw;
}

// Height fog integrated to infinity along d (d.y > 0).
float skyFog(vec3 d) {
  float y = max(d.y, 0.012);
  float k = uFogFalloff;
  float h0 = abs(cameraPosition.y);
  float od = exp(-k * h0) / (k * y);
  if (cameraPosition.y < 0.0) od += (1.0 - exp(-k * h0)) / (k * y);
  return 1.0 - exp(-uFogDensity * od);
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float hor = 1.0 - clamp(y, 0.0, 1.0);

  vec3 col = mix(uZenith, uHorizon, pow(hor, 4.5));

  // Dawn: warm horizon towards the sun, broad glow around it.
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float sunAz = max(dot(dh, sh), 0.0);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunHorizon * pow(hor, 7.0) * (0.25 + 0.75 * sunAz * sunAz) * uSunVis;
  col += uSunGlow * (pow(sd, 4.0) * 0.4 + pow(sd, 48.0) * 1.2) * uSunVis;

  // Stars and a faint Milky Way.
  if (uStars > 0.001) {
    float band = exp(-pow(dot(d, uGalaxyNormal) / 0.2, 2.0));
    float dust = fbm5(vec2(atan(d.x, d.z) * 3.0, d.y * 6.0));
    col += vec3(0.010, 0.012, 0.018) * band * smoothstep(0.35, 0.8, dust) * uStars * 2.0;
    col += starField(d) * uStars * (1.0 + band * 0.8) * smoothstep(0.02, 0.3, y);
  }

  // Moon halo and disc.
  float md = dot(d, uMoonDir);
  float ang = acos(clamp(md, -1.0, 1.0));
  col += uMoonGlow * (exp(-ang / 0.012) * 0.55 + exp(-ang / 0.07) * 0.2 + exp(-ang / 0.32) * 0.06) * uMoonVis;
  vec2 mp = vec2(dot(d, uMoonRight), dot(d, uMoonUp)) / uMoonRadius;
  float mr = length(mp);
  float moonMask = 0.0;
  if (md > 0.0 && mr < 1.1) {
    float fw = max(fwidth(mr), 1e-3);
    moonMask = (1.0 - smoothstep(1.0 - fw, 1.0 + fw, mr)) * uMoonVis * uDiscs;
    vec3 tex = texture(uMoonTex, mp * 0.5 + 0.5).rgb;
    col = mix(col, tex * uMoonBright, moonMask);
  }

  // Sun disc.
  float sunR = 0.0105;
  float sdisc = smoothstep(cos(sunR * 1.25), cos(sunR), dot(d, uSunDir));
  col += uSunDisc * sdisc * uSunVis * uDiscs;

  // Clouds on a plane far overhead, lit from the key light.
  if (uCloudCover > 0.001) {
    vec2 p = d.xz / (y + 0.09) * 0.55 + uCloudWind * uTime;
    float n = fbm5(p * 1.3);
    float lo = 1.0 - uCloudCover;
    float c = smoothstep(lo, lo + uCloudSoft, n);
    float n2 = fbm3((p + normalize(uLightDir.xz + vec2(1e-4)) * 0.12) * 1.3);
    float lit = clamp(0.5 + (n - n2) * 3.0, 0.0, 1.0);
    float thin = 1.0 - c;
    vec3 cc = mix(uCloudDark, uCloudLit, lit * lit);
    // Silver lining: thin cloud near the moon or sun glows.
    float near = exp(-ang / 0.12) * uMoonVis + pow(sd, 10.0) * uSunVis;
    cc += (uMoonGlow + uSunGlow * 0.5) * near * thin * 0.9;
    float alpha = c * smoothstep(-0.02, 0.12, y);
    col = mix(col, cc, alpha);
  }

  // Distant canopy silhouette: closes the horizon beyond the loaded river.
  float az = atan(d.x, d.z);
  float line = 0.028 + 0.026 * fbm3(vec2(az * 5.0, 3.7)) + 0.012 * vnoise(vec2(az * 38.0, 1.0))
    + 0.01 * step(0.93, vnoise(vec2(az * 22.0, 9.0)));
  float tree = 1.0 - smoothstep(line - 0.002, line + 0.002, y);
  col = mix(col, uTreeLine, tree);

  // Mist thickens towards the horizon.
  float f = skyFog(d);
  float g = max(dot(d, uLightDir), 0.0);
  vec3 fogCol = uFogColor + uFogGlow * (0.35 * g * g + 0.65 * pow(g, 12.0));
  col = mix(col, fogCol, f * (1.0 - 0.6 * moonMask));

  gl_FragColor = vec4(grade(col), 1.0);
  ${OUTPUT_GLSL}
}
`;

export class Sky {
  constructor(moonTexture) {
    this.uniforms = {
      ...shared,
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uSunDir: { value: new Vector3(0, 0.15, -1).normalize() },
      uSunDisc: { value: new Color() },
      uSunGlow: { value: new Color() },
      uSunHorizon: { value: new Color() },
      uSunVis: { value: 0 },
      uMoonDir: { value: new Vector3() },
      uMoonRight: { value: new Vector3() },
      uMoonUp: { value: new Vector3() },
      uMoonRadius: { value: Math.tan((3.0 * Math.PI) / 180) },
      uMoonBright: { value: 3.5 },
      uMoonGlow: { value: new Color() },
      uMoonVis: { value: 1 },
      uMoonTex: { value: moonTexture },
      uStars: { value: 1 },
      uCloudCover: { value: 0.3 },
      uCloudSoft: { value: 0.35 },
      uCloudDark: { value: new Color() },
      uCloudLit: { value: new Color() },
      uCloudWind: { value: new Vector2(0.004, -0.0025) },
      uGalaxyNormal: { value: new Vector3(0.45, 0.35, 0.82).normalize() },
      uTreeLine: { value: new Color() },
      uDiscs: { value: 1 },
    };
    const material = new ShaderMaterial({
      name: 'Sky',
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 64, 32), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.name = 'Sky';
    this.setMoonDirection(new Vector3(-0.22, Math.sin((19 * Math.PI) / 180), -1));
  }

  setMoonDirection(dir) {
    const d = this.uniforms.uMoonDir.value.copy(dir).normalize();
    const up = new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(d, up).normalize();
    const moonUp = new Vector3().crossVectors(right, d).normalize();
    // Tilt the face a little so it does not look printed on.
    const tilt = -0.35;
    this.uniforms.uMoonRight.value.copy(right).multiplyScalar(Math.cos(tilt)).addScaledVector(moonUp, Math.sin(tilt));
    this.uniforms.uMoonUp.value.copy(moonUp).multiplyScalar(Math.cos(tilt)).addScaledVector(right, -Math.sin(tilt));
  }
}
