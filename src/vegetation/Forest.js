import { Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { Rng, hashInts } from '../core/random.js';
import { riverDirection, riverHalfWidth, riverX } from '../world/river.js';
import { CHUNK_LENGTH, shoreJitter, terrainHeight } from '../world/terrain.js';
import { banana, bush, canopyTree, emergentTree, farCanopy, fern, palm, reeds, treeFern } from './plants.js';
import { createVegetationMaterial } from './vegetationMaterial.js';

// Each species lists its geometry variants and where it grows: bands of
// distance from the water's edge (metres) with a typical spacing.
const SPECIES = [
  {
    name: 'canopy',
    variants: () => [canopyTree(11), canopyTree(23), canopyTree(37), canopyTree(51, { leaning: true }), canopyTree(64, { leaning: true })],
    bands: [
      { from: 6, to: 10, spacing: 7 },
      { from: 10, to: 28, spacing: 8.5 },
    ],
    scale: [0.85, 1.3],
    lean: { within: 7, min: 0.03, max: 0.12, chance: 0.3 },
  },
  { name: 'far', variants: () => [farCanopy(5), farCanopy(17), farCanopy(29)], bands: [{ from: 25, to: 80, spacing: 11 }], scale: [0.9, 1.5] },
  { name: 'emergent', variants: () => [emergentTree(3), emergentTree(9)], bands: [{ from: 14, to: 45, spacing: 26 }], scale: [0.85, 1.1] },
  {
    name: 'palm',
    variants: () => [palm(2), palm(14), palm(27), palm(41)],
    bands: [{ from: 1.5, to: 22, spacing: 9 }],
    scale: [0.8, 1.2],
    lean: { within: 5, min: 0.05, max: 0.25, chance: 0.5 },
  },
  { name: 'treefern', variants: () => [treeFern(8), treeFern(19)], bands: [{ from: 0.8, to: 12, spacing: 8 }], scale: [0.8, 1.2] },
  { name: 'banana', variants: () => [banana(4), banana(12)], bands: [{ from: 0.2, to: 7, spacing: 7 }], scale: [0.8, 1.2] },
  {
    name: 'bush',
    variants: () => [bush(6), bush(15), bush(33)],
    bands: [
      { from: 0.1, to: 3, spacing: 3.0 },
      { from: 3, to: 16, spacing: 4.2 },
    ],
    scale: [0.7, 1.4],
  },
  {
    name: 'fern',
    variants: () => [fern(7), fern(21), fern(44)],
    bands: [
      { from: -0.3, to: 3.5, spacing: 2.0 },
      { from: 3.5, to: 14, spacing: 4.5 },
    ],
    scale: [0.7, 1.3],
  },
  { name: 'reeds', variants: () => [reeds(3), reeds(10)], bands: [{ from: -0.8, to: 0.4, spacing: 2.4 }], scale: [0.8, 1.3] },
];

const _m = new Matrix4();
const _q = new Quaternion();
const _qLean = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _color = new Color();

export class Forest {
  constructor({ atlas, density = 1, maxChunks = 9, alphaToCoverage = true }) {
    this.density = density;
    this.material = createVegetationMaterial(atlas, { alphaToCoverage });
    this.group = new Group();
    this.group.name = 'Forest';
    this.chunks = new Map();
    this.dirty = false;
    this.variants = [];

    SPECIES.forEach((species, speciesId) => {
      const geometries = species.variants();
      // Expected count per chunk (both banks), shared across this species' variants.
      const perChunk = species.bands.reduce((sum, b) => sum + 2 * (CHUNK_LENGTH / b.spacing) * Math.max((b.to - b.from) / b.spacing, 0.4), 0);
      const capacity = Math.ceil(((perChunk * density) / geometries.length) * maxChunks * 1.8) + 8;
      geometries.forEach((geometry, i) => {
        const mesh = new InstancedMesh(geometry, this.material, capacity);
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `${species.name}-${i}`;
        // Distant canopy never shows in the water; keep it out of the mirror pass.
        if (species.name === 'far') mesh.layers.set(1);
        this.group.add(mesh);
        this.variants.push({ mesh, capacity, speciesId });
      });
      species.firstVariant = this.variants.length - geometries.length;
      species.variantCount = geometries.length;
    });
  }

  get triangleCount() {
    return this.variants.reduce((sum, v) => sum + (v.mesh.geometry.index.count / 3) * v.mesh.count, 0);
  }

  // Deterministic placements for one stretch of river.
  generate(index) {
    const lists = this.variants.map(() => []);
    const z0 = -index * CHUNK_LENGTH;
    const spacingScale = 1 / Math.sqrt(this.density);
    SPECIES.forEach((species, speciesId) => {
      for (const side of [1, -1]) {
        const rng = new Rng(hashInts(index, side + 7, speciesId * 131 + 17));
        for (const band of species.bands) {
          const sp = band.spacing * spacingScale;
          const nz = Math.max(1, Math.round(CHUNK_LENGTH / sp));
          const nd = Math.max(1, Math.round((band.to - band.from) / sp));
          for (let iz = 0; iz < nz; iz++) {
            for (let id = 0; id < nd; id++) {
              if (!rng.chance(0.85)) continue;
              const z = z0 - ((iz + rng.next()) / nz) * CHUNK_LENGTH;
              const d = band.from + ((id + rng.next()) / nd) * (band.to - band.from);
              const x = riverX(z) + side * (riverHalfWidth(z) + shoreJitter(z, side) + d);
              const y = terrainHeight(x, z) - 0.05;
              const variant = species.firstVariant + rng.int(0, species.variantCount - 1);
              const s = rng.range(species.scale[0], species.scale[1]);
              const yaw = rng.range(0, Math.PI * 2);
              let lean = rng.range(0, 0.05);
              if (species.lean && d < species.lean.within && rng.chance(species.lean.chance)) {
                lean = rng.range(species.lean.min, species.lean.max);
              }
              // Tint: a little hue and brightness variety between plants.
              const bright = rng.range(0.75, 1.2);
              const warm = rng.range(-0.08, 0.1);
              lists[variant].push({ x, y, z, s, yaw, lean, side, r: bright * (1 + warm), g: bright, b: bright * (1 - warm * 1.5) });
            }
          }
        }
      }
    });
    return lists;
  }

  addChunk(index) {
    if (this.chunks.has(index)) return;
    this.chunks.set(index, this.generate(index));
    this.dirty = true;
  }

  removeChunk(index) {
    if (this.chunks.delete(index)) this.dirty = true;
  }

  // Repack all live chunks into the instanced meshes.
  commit() {
    if (!this.dirty) return;
    this.dirty = false;
    const dir = { x: 0, z: 0 };
    this.variants.forEach((variant, vi) => {
      const { mesh, capacity } = variant;
      const mats = mesh.instanceMatrix.array;
      const cols = mesh.instanceColor.array;
      let n = 0;
      for (const lists of this.chunks.values()) {
        for (const p of lists[vi]) {
          if (n >= capacity) break;
          riverDirection(p.z, dir);
          _axis.set(dir.x, 0, dir.z).normalize();
          _qLean.setFromAxisAngle(_axis, -p.side * p.lean);
          _q.setFromAxisAngle(_up, p.yaw).premultiply(_qLean);
          _pos.set(p.x, p.y, p.z);
          _scale.setScalar(p.s);
          _m.compose(_pos, _q, _scale);
          _m.toArray(mats, n * 16);
          _color.setRGB(p.r, p.g, p.b);
          _color.toArray(cols, n * 3);
          n++;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    });
  }
}
