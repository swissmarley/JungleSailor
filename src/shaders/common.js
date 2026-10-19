import { Color, Vector2, Vector3, Vector4 } from 'three';

// Uniforms shared by every custom material. Materials reference these exact
// objects, so updating a value here updates the whole scene at once.
export const shared = {
  uTime: { value: 0 },
  uLightDir: { value: new Vector3(0, 1, 0) }, // unit vector towards the key light (moon or sun)
  uLightColor: { value: new Color(0, 0, 0) }, // key light, linear
  uSkyAmbient: { value: new Color(0, 0, 0) },
  uGroundAmbient: { value: new Color(0, 0, 0) },
  uFogColor: { value: new Color(0, 0, 0) },
  uFogGlow: { value: new Color(0, 0, 0) }, // extra fog colour when looking towards the light
  uFogDensity: { value: 0.012 },
  uFogFalloff: { value: 0.14 },
  uWindDir: { value: new Vector2(0.8, -0.6) },
  uWindStrength: { value: 0.35 },
  uWetness: { value: 0 },
  uRain: { value: 0 },
  // 1 while rendering the mirrored view: opaque surfaces then write alpha 0 and
  // the sky alpha 1, giving the water a sky-visibility mask.
  uReflPass: { value: 0 },
  // Colour grade: rgb tint and saturation, applied with the fog to every surface.
  uGrade: { value: new Vector4(1, 1, 1, 1) },
};

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s / 0.875;
}
float fbm5(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s / 0.96875;
}
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform vec3 uFogGlow;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uWetness;
uniform float uReflPass;
uniform vec4 uGrade;

// Skipped in the mirror pass: the water grades what it reflects.
vec3 grade(vec3 c) {
  if (uReflPass > 0.5) return c;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, uGrade.w) * uGrade.rgb;
}

vec3 hemiAmbient(vec3 n) {
  return mix(uGroundAmbient, uSkyAmbient, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
}

// Optical depth of exponential height fog between heights a and b over len metres.
float fogSegment(float a, float b, float len) {
  float k = uFogFalloff;
  a = max(a, 0.0);
  b = max(b, 0.0);
  float dh = b - a;
  float ea = exp(-k * a);
  float eb = exp(-k * b);
  return len * (abs(dh) > 0.02 ? (ea - eb) / (k * dh) : ea);
}

// Fog for a surface at wpos. The reflection pass renders from a camera mirrored
// below the water; its path is split at the surface so reflected objects get
// the same mist as the path the light really travels.
vec3 applyFog(vec3 color, vec3 wpos) {
  vec3 cam = cameraPosition;
  vec3 d = wpos - cam;
  float len = length(d);
  float od;
  if (cam.y < 0.0) {
    float h1 = -cam.y;
    float h2 = max(wpos.y, 0.0);
    float split = h1 / max(h1 + h2, 1e-3);
    od = fogSegment(h1, 0.0, len * split) + fogSegment(0.0, h2, len * (1.0 - split));
  } else {
    od = fogSegment(cam.y, wpos.y, len);
  }
  float f = 1.0 - exp(-uFogDensity * od);
  vec3 v = d / max(len, 1e-3);
  if (cam.y < 0.0) v.y = -v.y;
  float g = max(dot(v, uLightDir), 0.0);
  vec3 fogCol = uFogColor + uFogGlow * (0.35 * g * g + 0.65 * pow(g, 12.0));
  return grade(mix(color, fogCol, f));
}
`;

// Optional hook for ShaderMaterials: tone mapping + output colour space, which
// three.js resolves per render target (none for the HDR reflection buffer).
export const OUTPUT_GLSL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
