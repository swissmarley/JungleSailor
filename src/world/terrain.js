import { BufferAttribute, BufferGeometry, Mesh, ShaderMaterial } from 'three';
import { fbm2, noise2, smoothstep } from '../core/random.js';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { riverHalfWidth, riverX } from './river.js';

export const CHUNK_LENGTH = 40;

// Lateral samples measured from the nominal water edge (negative = riverbed).
const LATERAL = [
  -4, -2.2, -1.1, -0.4, 0, 0.35, 0.75, 1.2, 1.8, 2.5, 3.3, 4.3, 5.5, 7, 8.8, 11, 13.5, 16.5, 20, 24,
  29, 35, 42, 50, 60, 72, 86, 102,
];
const Z_SEGMENTS = 26;

// Random wobble of the shoreline so banks are not perfectly smooth curves.
export function shoreJitter(z, side) {
  return 0.45 + 0.6 * noise2(z * 0.085, side * 13.7) + 0.3 * noise2(z * 0.29, side * 5.1);
}

function bankProfile(d) {
  if (d < 0) return -1.9 * (1 - Math.exp(d / 2.2));
  return 1.1 * (1 - Math.exp(-d / 2.3)) + 0.015 * d;
}

// Ground height anywhere in the world.
export function terrainHeight(x, z) {
  const lat = x - riverX(z);
  const side = lat >= 0 ? 1 : -1;
  const d = Math.abs(lat) - riverHalfWidth(z) - shoreJitter(z, side);
  let y = bankProfile(d);
  const land = smoothstep(0.4, 7, d);
  y += land * (1.1 * fbm2(x * 0.03 + 7.1, z * 0.03, 3) + 0.22 * noise2(x * 0.21, z * 0.21));
  // Low muddy shelves and root mounds right at the water line.
  y += smoothstep(-0.6, 0.4, d) * (1 - smoothstep(0.8, 3, d)) * 0.18 * noise2(z * 0.55, x * 0.55);
  return y;
}

// Metres from the (jittered) water edge: < 0 over water, > 0 on land.
export function landDistance(x, z) {
  const lat = x - riverX(z);
  const side = lat >= 0 ? 1 : -1;
  return Math.abs(lat) - riverHalfWidth(z) - shoreJitter(z, side);
}

const vertexShader = /* glsl */ `
attribute float aLand;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vLand;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normal;
  vLand = aLand;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vLand;
void main() {
  vec2 p = vWorldPos.xz;
  float n1 = fbm3(p * 0.11);
  float n2 = vnoise(p * 0.9);
  float n3 = vnoise(p * 3.7);
  vec3 mud = vec3(0.034, 0.024, 0.015);
  vec3 litter = vec3(0.055, 0.036, 0.020);
  vec3 moss = vec3(0.022, 0.040, 0.014);
  vec3 col = mix(litter, moss, smoothstep(0.45, 0.7, n1 + 0.15 * n2));
  col *= 0.75 + 0.35 * n2 + 0.2 * n3;
  col = mix(mud * (0.8 + 0.4 * n2), col, smoothstep(0.3, 2.2, vLand));

  // Wet margin along the waterline.
  float wet = 1.0 - smoothstep(0.02, 0.35, vWorldPos.y);
  col *= 1.0 - 0.45 * max(wet, uWetness * 0.6);

  vec3 n = normalize(vNormal);
  // Under the canopy the floor sees little sky and almost no direct light.
  float canopy = smoothstep(1.0, 9.0, vLand);
  float direct = clamp((dot(n, uLightDir) + 0.1) / 1.1, 0.0, 1.0) * (1.0 - 0.92 * canopy);
  vec3 ambient = hemiAmbient(n) * (1.0 - 0.75 * canopy);
  vec3 c = col * (ambient + uLightColor * direct);

  // A faint sheen on wet mud.
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(uLightDir + v);
  float spec = pow(max(dot(n, h), 0.0), 60.0) * max(wet, uWetness) * (1.0 - canopy);
  c += uLightColor * spec * 0.08;

  gl_FragColor = vec4(applyFog(c, vWorldPos), 1.0 - uReflPass);
  ${OUTPUT_GLSL}
}
`;

export function createTerrainMaterial() {
  return new ShaderMaterial({
    name: 'Terrain',
    uniforms: { ...shared },
    vertexShader,
    fragmentShader,
  });
}

// One mesh per chunk slot; geometry buffers are rewritten when the slot is
// reassigned to a different stretch of river.
export class TerrainChunk {
  constructor(material) {
    const cols = LATERAL.length;
    const rows = Z_SEGMENTS + 1;
    const vertsPerSide = cols * rows;
    const total = vertsPerSide * 2;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(total * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(total * 3), 3));
    geometry.setAttribute('aLand', new BufferAttribute(new Float32Array(total), 1));
    const index = [];
    for (let side = 0; side < 2; side++) {
      const base = side * vertsPerSide;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = base + r * cols + c;
          const b = a + 1;
          const d = a + cols;
          const e = d + 1;
          // Rows advance towards -z; block 0 is the right bank (+x), block 1
          // the mirrored left bank, so its winding flips.
          if (side === 0) {
            index.push(a, b, e, a, e, d);
          } else {
            index.push(a, e, b, a, d, e);
          }
        }
      }
    }
    geometry.setIndex(index);
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = true;
    this.mesh.name = 'TerrainChunk';
    this.cols = cols;
    this.rows = rows;
  }

  build(chunkIndex) {
    const z0 = -chunkIndex * CHUNK_LENGTH;
    const pos = this.mesh.geometry.attributes.position.array;
    const nor = this.mesh.geometry.attributes.normal.array;
    const land = this.mesh.geometry.attributes.aLand.array;
    let k = 0;
    const e = 0.15;
    for (const side of [1, -1]) {
      for (let r = 0; r < this.rows; r++) {
        const z = z0 - (r / (this.rows - 1)) * CHUNK_LENGTH;
        const cx = riverX(z);
        const hw = riverHalfWidth(z);
        const jitter = shoreJitter(z, side);
        for (let c = 0; c < this.cols; c++) {
          const x = cx + side * (hw + jitter + LATERAL[c]);
          const y = terrainHeight(x, z);
          pos[k * 3] = x;
          pos[k * 3 + 1] = y;
          pos[k * 3 + 2] = z;
          const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
          const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
          const nx = -dx / (2 * e);
          const nz = -dz / (2 * e);
          const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
          nor[k * 3] = nx * inv;
          nor[k * 3 + 1] = inv;
          nor[k * 3 + 2] = nz * inv;
          land[k] = LATERAL[c];
          k++;
        }
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.aLand.needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.mesh.visible = true;
  }
}
