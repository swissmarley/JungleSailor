import { Group } from 'three';
import { CHUNK_LENGTH, TerrainChunk, createTerrainMaterial } from './terrain.js';

// Streams river chunks in and out around the camera. Chunks are deterministic
// functions of their index, so anything dropped can be rebuilt identically.
export class World {
  // extras: other per-chunk content with addChunk(index) / removeChunk(index).
  constructor({ forest, ahead = 5, behind = 2, extras = [] }) {
    this.forest = forest;
    this.extras = extras;
    this.ahead = ahead;
    this.behind = behind;
    this.group = new Group();
    this.group.name = 'World';
    this.terrainMaterial = createTerrainMaterial();
    this.free = [];
    for (let i = 0; i < ahead + behind + 3; i++) {
      const chunk = new TerrainChunk(this.terrainMaterial);
      chunk.mesh.visible = false;
      this.group.add(chunk.mesh);
      this.free.push(chunk);
    }
    this.active = new Map(); // index -> TerrainChunk
    this.group.add(forest.group);
    this.facingForward = true;
  }

  get loadedCount() {
    return this.active.size;
  }

  // budget: how many new chunks may be built this call (Infinity on startup).
  update(cameraZ, viewDirZ, budget = 1) {
    if (viewDirZ < -0.25) this.facingForward = true;
    else if (viewDirZ > 0.25) this.facingForward = false;
    const ic = Math.floor(-cameraZ / CHUNK_LENGTH);
    const lo = this.facingForward ? ic - this.behind : ic - this.ahead;
    const hi = this.facingForward ? ic + this.ahead : ic + this.behind;

    for (const [index, chunk] of this.active) {
      if (index < lo - 1 || index > hi + 1) {
        chunk.mesh.visible = false;
        this.free.push(chunk);
        this.active.delete(index);
        this.forest.removeChunk(index);
        for (const extra of this.extras) extra.removeChunk(index);
      }
    }

    // Build missing chunks nearest-first.
    const wanted = [];
    for (let i = lo; i <= hi; i++) if (!this.active.has(i)) wanted.push(i);
    wanted.sort((a, b) => Math.abs(a - ic) - Math.abs(b - ic));
    for (const index of wanted) {
      if (budget <= 0 || this.free.length === 0) break;
      const chunk = this.free.pop();
      chunk.build(index);
      this.active.set(index, chunk);
      this.forest.addChunk(index);
      for (const extra of this.extras) extra.addChunk(index);
      budget--;
    }
    this.forest.commit();
  }
}
