import { Vector3 } from 'three';
import { MeshBuilder } from '../core/MeshBuilder.js';
import { Rng } from '../core/random.js';
import { ATLAS } from './leafAtlas.js';

// Vertex layout shared by all plants:
//   uv     atlas coordinates (leaves) or bark coordinates (u around, v metres)
//   aWind  x: sway (m at full wind), y: leaf flutter weight, z: phase
//   aAO    ambient occlusion baked from crown depth / trunk height
//   aKind  0 tree bark, 1 palm/fern stem, 2 leaf
//   aTint  0 green .. 1 dry brown (dead fronds)
export const PLANT_ATTRIBUTES = { uv: 2, aWind: 3, aAO: 1, aKind: 1, aTint: 1 };

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

function anyPerpendicular(t, out) {
  out.set(1, 0, 0);
  if (Math.abs(t.x) > 0.9) out.set(0, 0, 1);
  return out.sub(_a.copy(t).multiplyScalar(out.dot(t))).normalize();
}

// Generalized cylinder along a polyline with parallel-transported frames.
function tube(b, pts, radii, { radial = 6, kind = 0, wind, ao = () => 1, tint = 0 }) {
  const rings = [];
  const normal = new Vector3();
  const tangent = new Vector3();
  let length = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(i - 1, 0)];
    const next = pts[Math.min(i + 1, pts.length - 1)];
    tangent.subVectors(next, prev).normalize();
    if (i === 0) anyPerpendicular(tangent, normal);
    else {
      normal.sub(_a.copy(tangent).multiplyScalar(normal.dot(tangent))).normalize();
      length += pts[i].distanceTo(pts[i - 1]);
    }
    const binormal = _b.crossVectors(tangent, normal).normalize();
    const ring = [];
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const dir = new Vector3()
        .copy(normal)
        .multiplyScalar(Math.cos(ang))
        .addScaledVector(binormal, Math.sin(ang));
      const pos = pts[i].clone().addScaledVector(dir, radii[i]);
      ring.push(
        b.vertex({ position: pos, normal: dir, uv: [j / radial, length], aWind: wind(i, pos), aAO: ao(i, pos), aKind: kind, aTint: tint }),
      );
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      b.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
    }
  }
}

function regionUV(region, u, v) {
  return [region[0] + (region[2] - region[0]) * u, region[1] + (region[3] - region[1]) * v];
}

// A flat leaf card whose base sits at 'base' and grows along 'up'.
function card(b, base, up, right, w, h, region, { center, ao = 1, sway = 0.3, flutter = 1, phase = 0, normalBlend = 0.7, tint = 0 }) {
  const face = new Vector3().crossVectors(right, up).normalize();
  const corners = [
    [base.clone().addScaledVector(right, -w / 2), 0, 0],
    [base.clone().addScaledVector(right, w / 2), 1, 0],
    [base.clone().addScaledVector(right, w / 2).addScaledVector(up, h), 1, 1],
    [base.clone().addScaledVector(right, -w / 2).addScaledVector(up, h), 0, 1],
  ];
  const ids = corners.map(([p, u, v]) => {
    const radial = center ? _c.subVectors(p, center).normalize() : face;
    const n = face.clone().multiplyScalar(face.dot(radial) < 0 ? -1 : 1).lerp(radial, normalBlend).normalize();
    return b.vertex({
      position: p,
      normal: n,
      uv: regionUV(region, u, v),
      aWind: [sway, flutter * (0.3 + 0.7 * v), phase],
      aAO: ao,
      aKind: 2,
      aTint: tint,
    });
  });
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}

// A curved strip following 'spine' (frond, big leaf, blade). 'fold' lifts
// both halves into a shallow V so fronds read as 3D from the side.
function ribbon(b, spine, widths, sideDirs, region, { center, fold = 0, sway, flutter = 1, phase = 0, ao = 1, tint = 0 }) {
  const n = spine.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = i / (n - 1);
    const p = spine[i];
    const side = sideDirs[i];
    const t = _a.subVectors(spine[Math.min(i + 1, n - 1)], spine[Math.max(i - 1, 0)]).normalize();
    const faceN = new Vector3().crossVectors(side, t).normalize();
    if (faceN.y < 0) faceN.negate();
    const lift = faceN.clone().multiplyScalar(widths[i] * 0.5 * fold);
    const left = p.clone().addScaledVector(side, -widths[i] * 0.5).add(lift);
    const right = p.clone().addScaledVector(side, widths[i] * 0.5).add(lift);
    const row = [left, p.clone(), right].map((q, k) => {
      const radial = center ? _c.subVectors(q, center).normalize() : faceN;
      const nn = faceN.clone().lerp(radial, 0.45).normalize();
      return b.vertex({
        position: q,
        normal: nn,
        uv: regionUV(region, k / 2, v),
        aWind: [sway(v), flutter * v, phase],
        aAO: ao * (0.75 + 0.25 * v),
        aKind: 2,
        aTint: tint,
      });
    });
    rows.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 2; k++) {
      b.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
    }
  }
}

// Points along a gently bending branch.
function branchPath(rng, start, dir, length, segments, { droop = 0, wiggle = 0.08 }) {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const step = length / segments;
  const p = start.clone();
  for (let i = 1; i <= segments; i++) {
    d.x += rng.range(-wiggle, wiggle);
    d.z += rng.range(-wiggle, wiggle);
    d.y -= droop / segments;
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
  }
  return pts;
}

function leafCluster(b, rng, at, outward, count, size, center, opts = {}) {
  const region = opts.region ?? ATLAS.broadleaf;
  for (let i = 0; i < count; i++) {
    const up = new Vector3(
      outward.x + rng.range(-0.9, 0.9),
      outward.y + rng.range(-0.3, 0.9) + 0.35,
      outward.z + rng.range(-0.9, 0.9),
    ).normalize();
    const right = anyPerpendicular(up, new Vector3());
    right.applyAxisAngle(up, rng.range(0, Math.PI));
    const base = at.clone().add(new Vector3(rng.range(-0.5, 0.5), rng.range(-0.4, 0.3), rng.range(-0.5, 0.5)).multiplyScalar(size * 0.5));
    const s = size * rng.range(0.75, 1.15);
    const depth = center ? base.distanceTo(center) : 1;
    card(b, base, up, right, s, s, region, {
      center,
      ao: opts.ao ?? Math.min(1, 0.55 + depth * 0.06),
      sway: opts.sway ?? 0.4,
      flutter: 1,
      phase: opts.phase ?? 0,
    });
  }
}

function hangingVine(b, rng, top, length, sway, phase) {
  const segs = 6;
  const spine = [];
  const sides = [];
  const drift = new Vector3(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3));
  const side = new Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    spine.push(top.clone().add(new Vector3(drift.x * t * t, -length * t, drift.z * t * t)));
    sides.push(side);
  }
  ribbon(b, spine, spine.map(() => 0.45), sides, ATLAS.vine, {
    sway: (v) => sway + v * 0.25,
    flutter: 0.6,
    phase,
  });
}

// Broad tropical canopy tree: buttressed trunk, limbs, umbrella crown.
export function canopyTree(seed, { leaning = false } = {}) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const H = rng.range(9, 15);
  const r0 = rng.range(0.24, 0.4);
  const lean = new Vector3(rng.range(-0.8, 0.8), H, rng.range(-0.8, 0.8));
  const trunk = branchPath(rng, new Vector3(0, -0.3, 0), lean, H + 0.3, 9, { wiggle: 0.05 });
  const trunkR = trunk.map((p, i) => {
    const t = i / (trunk.length - 1);
    return r0 * (1 - 0.45 * t) * (1 + 1.1 * Math.exp(-(p.y + 0.3) / 0.9));
  });
  const swayAt = (p) => 0.18 * Math.pow(Math.max(p.y, 0) / (H + 8), 2);
  tube(b, trunk, trunkR, {
    radial: 8,
    kind: 0,
    wind: (i, p) => [swayAt(p), 0, 0],
    ao: (i, p) => 0.55 + 0.45 * Math.min(p.y / 4, 1),
  });

  const ends = [];
  const limbs = rng.int(4, 6);
  const az0 = rng.range(0, Math.PI * 2);
  for (let l = 0; l < limbs; l++) {
    const az = az0 + (l / limbs) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const el = rng.range(0.35, 0.95);
    const dir = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const start = trunk[Math.max(trunk.length - 1 - rng.int(0, 2), 1)].clone();
    const len = rng.range(3.5, 6.5);
    const path = branchPath(rng, start, dir, len, 5, { droop: rng.range(0.1, 0.5) });
    const rr = path.map((_, i) => r0 * 0.42 * (1 - (i / path.length) * 0.75));
    tube(b, path, rr, { radial: 5, kind: 0, wind: (i, p) => [swayAt(p) + 0.05 * (i / 5), 0, l], ao: () => 0.85 });
    ends.push({ p: path[path.length - 1], d: dir, phase: l });
    const subs = rng.int(1, 3);
    for (let s = 0; s < subs; s++) {
      const at = path[rng.int(2, 4)];
      const sd = dir.clone().add(new Vector3(rng.range(-0.9, 0.9), rng.range(0, 0.6), rng.range(-0.9, 0.9))).normalize();
      const sp = branchPath(rng, at, sd, rng.range(1.6, 3.2), 3, { droop: 0.2 });
      tube(b, sp, sp.map((_, i) => r0 * 0.2 * (1 - i / 4)), { radial: 4, kind: 0, wind: (i, p) => [swayAt(p) + 0.1, 0, l], ao: () => 0.85 });
      ends.push({ p: sp[sp.length - 1], d: sd, phase: l + s * 0.3 });
    }
  }
  const center = ends.reduce((acc, e) => acc.add(e.p), new Vector3()).multiplyScalar(1 / ends.length);
  center.y -= 1.2;
  for (const e of ends) {
    const out = e.p.clone().sub(center).setY(0).normalize().multiplyScalar(0.8).add(e.d.clone().multiplyScalar(0.4));
    leafCluster(b, rng, e.p, out, rng.int(6, 9), rng.range(1.8, 2.6), center, {
      region: rng.chance(0.3) ? ATLAS.droop : ATLAS.broadleaf,
      sway: swayAt(e.p) + 0.25,
      phase: e.phase,
    });
  }
  // Fill the crown's interior so it never looks hollow.
  for (let i = 0; i < 6; i++) {
    const p = center.clone().add(new Vector3(rng.range(-2, 2), rng.range(0.6, 2), rng.range(-2, 2)));
    leafCluster(b, rng, p, p.clone().sub(center).normalize(), 2, 2.2, center, { sway: swayAt(p) + 0.2, ao: 0.6 });
  }
  if (leaning || rng.chance(0.35)) {
    const vines = rng.int(1, 3);
    for (let i = 0; i < vines; i++) {
      const e = rng.pick(ends);
      hangingVine(b, rng, e.p.clone().add(new Vector3(0, -0.3, 0)), rng.range(3, Math.min(8, e.p.y - 1.5)), swayAt(e.p) + 0.25, i);
    }
  }
  return b.build();
}

// Emergent giant: tall straight trunk with buttress roots and a flat crown.
export function emergentTree(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const H = rng.range(22, 28);
  const r0 = rng.range(0.55, 0.75);
  const trunk = branchPath(rng, new Vector3(0, -0.4, 0), new Vector3(rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)), H, 12, { wiggle: 0.025 });
  const swayAt = (p) => 0.22 * Math.pow(Math.max(p.y, 0) / (H + 6), 2);
  tube(b, trunk, trunk.map((p, i) => r0 * (1 - 0.5 * (i / 12)) * (1 + 1.6 * Math.exp(-(p.y + 0.4) / 1.6))), {
    radial: 10,
    kind: 0,
    wind: (i, p) => [swayAt(p), 0, 0],
    ao: (i, p) => 0.5 + 0.5 * Math.min(p.y / 6, 1),
  });
  // Buttress fins.
  const fins = rng.int(4, 6);
  for (let f = 0; f < fins; f++) {
    const az = (f / fins) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dir = new Vector3(Math.cos(az), 0, Math.sin(az));
    const pts = [new Vector3(0, 2.6, 0).addScaledVector(dir, r0 * 0.6), new Vector3(0, -0.3, 0).addScaledVector(dir, r0 * 3.2)];
    const side = new Vector3(-dir.z, 0, dir.x);
    const inner = new Vector3(0, -0.3, 0).addScaledVector(dir, r0 * 0.5);
    for (const sgn of [-1, 1]) {
      const n = side.clone().multiplyScalar(sgn);
      const ids = [pts[0], pts[1], inner].map((p) =>
        b.vertex({ position: p.clone().addScaledVector(side, sgn * 0.08), normal: n, uv: [0.5 + sgn * 0.2, p.y], aWind: [0, 0, 0], aAO: 0.55, aKind: 0, aTint: 0 }),
      );
      if (sgn > 0) b.tri(ids[0], ids[1], ids[2]);
      else b.tri(ids[0], ids[2], ids[1]);
    }
  }
  const top = trunk[trunk.length - 1];
  const ends = [];
  const limbs = rng.int(5, 7);
  for (let l = 0; l < limbs; l++) {
    const az = (l / limbs) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const el = rng.range(0.15, 0.5);
    const dir = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const path = branchPath(rng, top.clone().add(new Vector3(0, -rng.range(0, 2.5), 0)), dir, rng.range(5, 8), 5, { droop: 0.25 });
    tube(b, path, path.map((_, i) => r0 * 0.35 * (1 - (i / 6) * 0.7)), { radial: 5, kind: 0, wind: (i, p) => [swayAt(p) + 0.04 * i, 0, l], ao: () => 0.85 });
    ends.push({ p: path[path.length - 1], d: dir, phase: l });
    ends.push({ p: path[3], d: dir, phase: l + 0.5 });
  }
  const center = top.clone().add(new Vector3(0, -0.5, 0));
  for (const e of ends) {
    const out = e.p.clone().sub(center).setY(0.4).normalize();
    leafCluster(b, rng, e.p.clone().add(new Vector3(0, 0.6, 0)), out, rng.int(8, 11), rng.range(2.6, 3.4), center, {
      sway: swayAt(e.p) + 0.25,
      phase: e.phase,
    });
  }
  return b.build();
}

// Distant canopy: few big cards on a trunk; cheap filler far from the river.
export function farCanopy(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const H = rng.range(10, 17);
  const swayAt = (p) => 0.15 * Math.pow(Math.max(p.y, 0) / (H + 6), 2);
  const trunk = branchPath(rng, new Vector3(0, -0.3, 0), new Vector3(rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)), H, 3, {});
  tube(b, trunk, trunk.map((_, i) => 0.35 * (1 - i * 0.15)), { radial: 5, kind: 0, wind: (i, p) => [swayAt(p), 0, 0], ao: () => 0.6 });
  const top = trunk[trunk.length - 1];
  const center = top.clone().add(new Vector3(0, 1.0, 0));
  for (let i = 0; i < 16; i++) {
    const az = rng.range(0, Math.PI * 2);
    const rad = rng.range(0.5, 3.6);
    const p = top.clone().add(new Vector3(Math.cos(az) * rad, rng.range(-0.8, 2.6), Math.sin(az) * rad));
    leafCluster(b, rng, p, p.clone().sub(center).normalize(), 1, rng.range(3.0, 4.2), center, { sway: swayAt(p) + 0.2, phase: i });
  }
  return b.build();
}

// Palm with a curving ringed stem and a crown of arching pinnate fronds.
export function palm(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const H = rng.range(7, 14);
  const bendDir = new Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize();
  const bend = rng.range(0.4, 2.2);
  const trunk = [];
  const segs = 10;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    trunk.push(new Vector3(bendDir.x * bend * t * t, -0.3 + (H + 0.3) * t, bendDir.z * bend * t * t));
  }
  const swayAt = (p) => 0.28 * Math.pow(Math.max(p.y, 0) / H, 2);
  const r = rng.range(0.13, 0.18);
  tube(b, trunk, trunk.map((p, i) => r * (1.25 - 0.35 * (i / segs)) * (1 + 0.6 * Math.exp(-(p.y + 0.3) / 0.5))), {
    radial: 6,
    kind: 1,
    wind: (i, p) => [swayAt(p), 0, 0],
    ao: (i, p) => 0.6 + 0.4 * Math.min(p.y / 3, 1),
  });
  const top = trunk[segs];
  const center = top.clone().add(new Vector3(0, -0.4, 0));
  const fronds = rng.int(11, 15);
  const az0 = rng.range(0, Math.PI * 2);
  for (let f = 0; f < fronds; f++) {
    const az = az0 + (f / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const dead = f % 6 === 5 && rng.chance(0.6);
    const el = dead ? rng.range(-1.3, -0.9) : rng.range(-0.35, 0.95);
    const len = rng.range(3.0, 4.6);
    const dir = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const spine = [];
    const sides = [];
    const p = top.clone();
    const d = dir.clone();
    const side = new Vector3(-Math.sin(az), 0, Math.cos(az));
    const n = 8;
    for (let i = 0; i <= n; i++) {
      spine.push(p.clone());
      sides.push(side);
      d.y -= (dead ? 0.05 : 0.17 + 0.05 * Math.max(el, 0));
      d.normalize();
      p.addScaledVector(d, len / n);
    }
    ribbon(b, spine, spine.map((_, i) => 1.35 * Math.sin(Math.PI * Math.min(0.15 + (i / n) * 0.9, 1)) + 0.15), sides, ATLAS.palm, {
      center,
      fold: dead ? 0.1 : 0.55,
      sway: (v) => swayAt(top) + 0.12 + 0.35 * v,
      flutter: 0.7,
      phase: f * 0.7,
      tint: dead ? 1 : rng.range(0, 0.12),
    });
  }
  return b.build();
}

// Understory shrub: a loose dome of leaf cards on short stems.
export function bush(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const R = rng.range(0.9, 1.8);
  const Hh = rng.range(1.0, 2.2);
  const center = new Vector3(0, Hh * 0.35, 0);
  for (let i = 0; i < 4; i++) {
    const dir = new Vector3(rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5));
    const path = branchPath(rng, new Vector3(0, -0.1, 0), dir, Hh * 0.8, 3, {});
    tube(b, path, path.map(() => 0.035), { radial: 3, kind: 0, wind: (i2, p) => [0.04 * p.y, 0, i], ao: () => 0.6 });
  }
  const count = rng.int(12, 18);
  for (let i = 0; i < count; i++) {
    const az = rng.range(0, Math.PI * 2);
    const el = rng.range(-0.1, 1.3);
    const out = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const at = center.clone().add(new Vector3(out.x * R * 0.55, out.y * Hh * 0.45, out.z * R * 0.55));
    leafCluster(b, rng, at, out, 1, rng.range(1.0, 1.5), center, {
      region: rng.chance(0.5) ? ATLAS.smallLeaves : ATLAS.broadleaf,
      sway: 0.06 + 0.05 * at.y,
      phase: i,
    });
  }
  return b.build();
}

function frondRosette(b, rng, base, { count, length, width, region, droop, sway, center, spread = 1 }) {
  const az0 = rng.range(0, Math.PI * 2);
  for (let f = 0; f < count; f++) {
    const az = az0 + (f / count) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const el = rng.range(0.35, 1.15) * spread;
    const len = length * rng.range(0.75, 1.1);
    const dir = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const side = new Vector3(-Math.sin(az), 0, Math.cos(az));
    const spine = [];
    const sides = [];
    const p = base.clone();
    const n = 6;
    for (let i = 0; i <= n; i++) {
      spine.push(p.clone());
      sides.push(side);
      dir.y -= droop;
      dir.normalize();
      p.addScaledVector(dir, len / n);
    }
    ribbon(b, spine, spine.map((_, i) => width * Math.sin(Math.PI * Math.min(0.1 + (i / n) * 0.95, 1)) + width * 0.08), sides, region, {
      center,
      fold: 0.35,
      sway: (v) => sway + 0.12 * v,
      flutter: 0.8,
      phase: f,
      tint: rng.range(0, 0.1),
    });
  }
}

// Ground fern rosette for the water's edge and forest floor.
export function fern(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  frondRosette(b, rng, new Vector3(0, 0.05, 0), {
    count: rng.int(9, 13),
    length: rng.range(1.1, 1.8),
    width: rng.range(0.45, 0.6),
    region: ATLAS.fern,
    droop: 0.22,
    sway: 0.03,
    center: new Vector3(0, -0.3, 0),
  });
  return b.build();
}

// Tree fern: slim dark trunk with an umbrella of long fronds.
export function treeFern(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const H = rng.range(2.6, 4.6);
  const trunk = branchPath(rng, new Vector3(0, -0.2, 0), new Vector3(rng.range(-0.2, 0.2), 1, rng.range(-0.2, 0.2)), H, 5, { wiggle: 0.06 });
  tube(b, trunk, trunk.map((_, i) => 0.12 * (1.2 - 0.3 * (i / 5))), { radial: 6, kind: 1, wind: (i, p) => [0.03 * p.y, 0, 0], ao: () => 0.6 });
  const top = trunk[trunk.length - 1];
  frondRosette(b, rng, top, {
    count: rng.int(9, 13),
    length: rng.range(2.2, 3.2),
    width: rng.range(0.7, 0.9),
    region: ATLAS.fern,
    droop: 0.3,
    sway: 0.03 * H,
    center: top.clone().add(new Vector3(0, -0.6, 0)),
    spread: 0.8,
  });
  return b.build();
}

// Banana / heliconia clump: green pseudo-stems with huge torn paddle leaves.
export function banana(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const stems = rng.int(1, 3);
  for (let s = 0; s < stems; s++) {
    const base = new Vector3(rng.range(-0.5, 0.5), -0.1, rng.range(-0.5, 0.5));
    const H = rng.range(1.2, 2.6);
    const stem = branchPath(rng, base, new Vector3(rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)), H, 3, {});
    tube(b, stem, stem.map((_, i) => 0.1 * (1 - i * 0.15)), { radial: 6, kind: 1, wind: (i, p) => [0.05 * p.y, 0, s], ao: () => 0.7, tint: 0 });
    const top = stem[stem.length - 1];
    const leaves = rng.int(5, 8);
    for (let l = 0; l < leaves; l++) {
      const az = rng.range(0, Math.PI * 2);
      const el = rng.range(0.3, 1.2);
      const dir = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const side = new Vector3(-Math.sin(az), 0, Math.cos(az));
      const len = rng.range(1.5, 2.4);
      const spine = [];
      const sides = [];
      const p = top.clone();
      const n = 6;
      for (let i = 0; i <= n; i++) {
        spine.push(p.clone());
        sides.push(side);
        dir.y -= 0.12;
        dir.normalize();
        p.addScaledVector(dir, len / n);
      }
      ribbon(b, spine, spine.map((_, i) => 0.62 * Math.sin(Math.PI * Math.min(0.12 + (i / n) * 0.92, 1)) + 0.05), sides, ATLAS.banana, {
        center: top.clone().add(new Vector3(0, -0.5, 0)),
        fold: 0.25,
        sway: (v) => 0.05 * H + 0.15 * v,
        flutter: 0.8,
        phase: l + s * 3,
        tint: l === 0 && rng.chance(0.5) ? 0.8 : 0,
      });
    }
  }
  return b.build();
}

// Reeds and sedges at the water line.
export function reeds(seed) {
  const rng = new Rng(seed);
  const b = new MeshBuilder(PLANT_ATTRIBUTES);
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI + rng.range(-0.2, 0.2);
    const h = rng.range(1.0, 1.8);
    const w = h * 0.55;
    const right = new Vector3(Math.cos(az), 0, Math.sin(az));
    const base = new Vector3(rng.range(-0.25, 0.25), -0.15, rng.range(-0.25, 0.25));
    const up = new Vector3(rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)).normalize();
    card(b, base, up, right, w, h, ATLAS.reeds, { sway: 0.08, flutter: 1, phase: i, normalBlend: 0, ao: 0.85 });
  }
  return b.build();
}
