import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from 'three';

// Accumulates vertices with arbitrary float attributes and builds a
// BufferGeometry. Attribute sizes are declared up-front, e.g.
// new MeshBuilder({ uv: 2, aPart: 1 }).
export class MeshBuilder {
  constructor(spec = {}) {
    this.spec = { position: 3, normal: 3, ...spec };
    this.data = {};
    for (const name of Object.keys(this.spec)) this.data[name] = [];
    this.indices = [];
    this.count = 0;
  }

  // values: { position: Vector3|array, normal: Vector3|array, other: number|array }
  vertex(values) {
    for (const [name, size] of Object.entries(this.spec)) {
      const v = values[name];
      const out = this.data[name];
      if (v === undefined) {
        for (let i = 0; i < size; i++) out.push(0);
      } else if (typeof v === 'number') {
        out.push(v);
      } else if (v.isVector3) {
        out.push(v.x, v.y, v.z);
      } else if (v.isVector2) {
        out.push(v.x, v.y);
      } else {
        for (let i = 0; i < size; i++) out.push(v[i]);
      }
    }
    return this.count++;
  }

  tri(a, b, c) {
    this.indices.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
  }

  // Append another builder with the same attribute spec.
  append(other) {
    const offset = this.count;
    for (const name of Object.keys(this.spec)) this.data[name].push(...other.data[name]);
    for (const i of other.indices) this.indices.push(i + offset);
    this.count += other.count;
  }

  build() {
    const g = new BufferGeometry();
    for (const [name, size] of Object.entries(this.spec)) {
      g.setAttribute(name, new Float32BufferAttribute(this.data[name], size));
    }
    g.setIndex(new Uint32BufferAttribute(this.indices, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Add an axis-aligned-ish box given its 8 corners in the conventional order:
// bottom face (0-3) then top face (4-7), counter-clockwise seen from above.
export function addBoxFromCorners(builder, corners, attrs, faces = [true, true, true, true, true, true]) {
  const [p0, p1, p2, p3, p4, p5, p6, p7] = corners;
  const quads = [
    [p4, p5, p6, p7], // top
    [p3, p2, p1, p0], // bottom
    [p0, p1, p5, p4], // side a
    [p1, p2, p6, p5], // side b
    [p2, p3, p7, p6], // side c
    [p3, p0, p4, p7], // side d
  ];
  const n = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  quads.forEach((q, fi) => {
    if (!faces[fi]) return;
    e1.subVectors(q[1], q[0]);
    e2.subVectors(q[3], q[0]);
    n.crossVectors(e1, e2).normalize();
    const base = typeof attrs === 'function' ? null : attrs;
    const ids = q.map((p, k) =>
      builder.vertex({ ...(base ?? attrs(fi, k, p)), position: p, normal: n }),
    );
    builder.quad(ids[0], ids[1], ids[2], ids[3]);
  });
}
