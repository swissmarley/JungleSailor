import {
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import { NOISE_GLSL } from '../shaders/common.js';

// Procedural full moon, baked once on the GPU. Maria follow the familiar
// near-side layout; craters come from three layers of jittered cells; the
// bright ray systems of Tycho and Copernicus dominate as they do at full moon.
const fragmentShader = /* glsl */ `
${NOISE_GLSL}
varying vec2 vUv;

// lon, lat (degrees), radius (degrees), darkness
const int MARIA = 15;
uniform vec4 uMaria[MARIA];

vec2 toLonLat(vec2 uv, out float mu) {
  float r2 = dot(uv, uv);
  float z = sqrt(max(1.0 - r2, 0.0));
  mu = z;
  float lat = asin(clamp(uv.y, -1.0, 1.0));
  float lon = atan(uv.x, z);
  return degrees(vec2(lon, lat));
}

// Crater field: cells on the lon/lat grid with a random crater each.
float craters(vec2 ll, float cell, float seed, out float rim) {
  vec2 g = ll / cell;
  vec2 id = floor(g);
  float dark = 0.0;
  rim = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = id + vec2(float(i), float(j));
      vec3 h = hash32(c + seed);
      if (h.z < 0.35) continue;
      vec2 ctr = c + 0.2 + 0.6 * h.xy;
      float rad = mix(0.12, 0.48, pow(hash12(c * 1.7 + seed), 2.0));
      float d = length(g - ctr) / rad;
      dark += (1.0 - smoothstep(0.55, 1.0, d)) * 0.5;
      rim += smoothstep(0.75, 0.97, d) * (1.0 - smoothstep(0.97, 1.35, d));
    }
  }
  return dark;
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  float r = length(uv);
  float mu;
  vec2 ll = toLonLat(uv / max(r, 1.0), mu);

  // Highlands: bright, finely mottled.
  float base = 0.74 + 0.16 * (fbm5(ll * 0.09) - 0.5) + 0.08 * (vnoise(ll * 0.8) - 0.5);

  // Maria: irregular soft-edged basalt plains.
  float mare = 0.0;
  for (int i = 0; i < MARIA; i++) {
    vec4 m = uMaria[i];
    vec2 d = ll - m.xy;
    d.x *= cos(radians(ll.y));
    float wob = (fbm3(ll * 0.12 + float(i) * 3.1) - 0.5) * 0.65;
    float k = length(d) / m.z + wob;
    mare = max(mare, (1.0 - smoothstep(0.7, 1.05, k)) * m.w);
  }
  float mareTex = 0.9 + 0.2 * fbm3(ll * 0.35);
  float albedo = mix(base, 0.36 * mareTex, mare);

  // Craters at three scales; small ones read as bright pits at full moon.
  float rim1, rim2, rim3;
  float c1 = craters(ll, 9.0, 1.0, rim1);
  float c2 = craters(ll, 4.0, 7.0, rim2);
  float c3 = craters(ll, 1.7, 13.0, rim3);
  albedo *= 1.0 - 0.10 * c1 - 0.07 * c2 - 0.05 * c3;
  albedo += 0.10 * rim1 + 0.08 * rim2 + 0.06 * rim3 * (1.0 - mare * 0.5);

  // Ray craters: Tycho, Copernicus, Kepler, Aristarchus.
  vec4 rays[4];
  rays[0] = vec4(-11.0, -43.0, 4.0, 75.0);
  rays[1] = vec4(-20.0, 10.0, 3.2, 38.0);
  rays[2] = vec4(-38.0, 8.0, 1.8, 22.0);
  rays[3] = vec4(-47.0, 24.0, 1.4, 14.0);
  for (int i = 0; i < 4; i++) {
    vec2 d = ll - rays[i].xy;
    d.x *= cos(radians(ll.y));
    float dist = length(d);
    float ang = atan(d.y, d.x);
    float streak = pow(vnoise(vec2(ang * 9.0, float(i) * 11.0)), 5.0) * 2.2;
    float fall = exp(-dist / rays[i].w);
    albedo += streak * fall * smoothstep(rays[i].z * 0.8, rays[i].z * 2.0, dist) * 0.32;
    albedo += (1.0 - smoothstep(rays[i].z * 0.6, rays[i].z * 1.1, dist)) * 0.32;
    albedo -= (1.0 - smoothstep(0.0, rays[i].z * 0.45, dist)) * 0.12;
  }
  // Aristarchus is the brightest spot on the moon.
  albedo += 0.25 * (1.0 - smoothstep(0.0, 2.2, length((ll - vec2(-47.0, 24.0)) * vec2(cos(radians(24.0)), 1.0))));

  // Full-moon photometry: almost no limb darkening, a touch at the very edge.
  float limb = mix(0.82, 1.0, pow(mu, 0.35));
  vec3 col = vec3(1.0, 0.975, 0.93) * clamp(albedo, 0.0, 1.3) * limb;
  gl_FragColor = vec4(col / 1.3, 1.0);
}
`;

const MARIA = [
  // Oceanus Procellarum (two lobes), Imbrium, Serenitatis, Tranquillitatis
  [-58, 18, 24, 0.95],
  [-48, -2, 17, 0.9],
  [-17, 34, 17, 1.0],
  [17, 28, 9.5, 1.0],
  [30, 8, 11, 0.95],
  // Crisium, Fecunditatis, Nectaris, Nubium, Humorum
  [59, 17, 7, 1.0],
  [51, -6, 9, 0.85],
  [35, -15, 5.5, 0.85],
  [-17, -20, 10, 0.85],
  [-39, -24, 6, 0.9],
  // Frigoris (strip), Vaporum, Insularum, Cognitum, Smythii edge
  [-5, 57, 9, 0.75],
  [4, 13, 4.5, 0.85],
  [-30, 8, 7, 0.75],
  [-23, -10, 5, 0.7],
  [24, 55, 6, 0.6],
];

export function createMoonTexture(renderer, size = 1024) {
  const target = new WebGLRenderTarget(size, size, {
    type: UnsignedByteType,
    format: RGBAFormat,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
  target.texture.colorSpace = SRGBColorSpace;
  const material = new ShaderMaterial({
    uniforms: { uMaria: { value: MARIA.map(([a, b, c, d]) => new Vector4(a, b, c, d)) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
  material.dispose();
  quad.geometry.dispose();
  return target.texture;
}
