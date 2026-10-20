import { Vector3 } from 'three';
import { MeshBuilder, addBoxFromCorners } from '../core/MeshBuilder.js';
import {
  HULL_LENGTH,
  PLANK_THICKNESS,
  halfBeam,
  halfWidthAtHeight,
  keelHeight,
  sectionPoint,
  sheerHeight,
  zAt,
} from './hullShape.js';

// Parts let the shader pick a wood tone per component.
export const PART = {
  hullOuter: 0,
  hullInner: 1,
  trim: 2,
  floor: 3,
  seat: 4,
  frame: 5,
};

const STRAKES = 7;
const NS = 64; // stations along the hull
const NT = 36; // samples across the section (both sides)

const tmp = new Vector3();
const tmp2 = new Vector3();

function outerPoint(s, theta, out = new Vector3()) {
  sectionPoint(s, theta, out);
  return out;
}

// Outward normal of the outer skin from finite differences.
function outerNormal(s, theta, out = new Vector3()) {
  const ds = 1e-3;
  const dt = 1e-3;
  const p0 = outerPoint(Math.min(s + ds, 1), theta, new Vector3());
  const p1 = outerPoint(Math.max(s - ds, 0), theta, new Vector3());
  const q0 = outerPoint(s, Math.min(theta + dt, Math.PI / 2), new Vector3());
  const q1 = outerPoint(s, Math.max(theta - dt, -Math.PI / 2), new Vector3());
  const a = p0.sub(p1);
  const b = q0.sub(q1);
  out.crossVectors(a, b);
  if (out.lengthSq() < 1e-12) {
    out.set(Math.sign(theta) || 1, 0, 0);
  }
  return out.normalize();
}

// Arc length along the section from keel to sheer, normalised 0..1, used to
// lay out the clinker strakes.
function sectionArcTable(s) {
  const table = [0];
  let prev = outerPoint(s, 0, new Vector3());
  let total = 0;
  for (let j = 1; j <= NT / 2; j++) {
    const p = outerPoint(s, (j / (NT / 2)) * (Math.PI / 2), new Vector3());
    total += p.distanceTo(prev);
    table.push(total);
    prev = p;
  }
  return { table: table.map((v) => v / Math.max(total, 1e-6)), total };
}

function thetaAt(j) {
  return -Math.PI / 2 + (j / NT) * Math.PI;
}

function buildSkins(b) {
  const outerIds = [];
  const innerIds = [];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const { table, total } = sectionArcTable(s);
    const rowO = [];
    const rowI = [];
    for (let j = 0; j <= NT; j++) {
      const theta = thetaAt(j);
      const p = outerPoint(s, theta, new Vector3());
      const n = outerNormal(s, theta, new Vector3());
      const arc = table[Math.abs(j - NT / 2)];
      const strake = arc * STRAKES;
      const wood = [p.z, arc * total];
      const Y = (p.y - keelHeight(s)) / (sheerHeight(s) - keelHeight(s));
      rowO.push(
        b.vertex({ position: p, normal: n, aPart: PART.hullOuter, aWood: wood, aStrake: strake, aAO: 1 }),
      );
      const q = p.clone().addScaledVector(n, -PLANK_THICKNESS);
      if (Math.sign(q.x) !== Math.sign(p.x)) q.x = 0;
      const ao = 0.45 + 0.55 * Math.pow(Math.min(Math.max(Y, 0), 1), 0.7);
      rowI.push(
        b.vertex({
          position: q,
          normal: n.clone().negate(),
          aPart: PART.hullInner,
          aWood: wood,
          aStrake: strake,
          aAO: ao,
        }),
      );
    }
    outerIds.push(rowO);
    innerIds.push(rowI);
  }
  for (let i = 0; i < NS; i++) {
    for (let j = 0; j < NT; j++) {
      const o = outerIds;
      b.quad(o[i][j], o[i + 1][j], o[i + 1][j + 1], o[i][j + 1]);
      const n = innerIds;
      b.quad(n[i][j], n[i][j + 1], n[i + 1][j + 1], n[i + 1][j]);
    }
  }
}

// Gunwale rails capping both sheer lines, with a rub rail overhanging outside.
function buildGunwales(b) {
  const W_IN = 0.012;
  const W_OUT = 0.03;
  const H = 0.05;
  for (const side of [-1, 1]) {
    const rings = [];
    for (let i = 0; i <= NS; i++) {
      const s = Math.min(i / NS, 0.995);
      const theta = (side * Math.PI) / 2;
      const p = outerPoint(s, theta, new Vector3());
      const n = outerNormal(s, theta, new Vector3());
      n.y = 0;
      if (n.lengthSq() < 1e-6) n.set(side, 0, 0);
      n.normalize();
      const top = p.y + 0.012;
      const inner = p.clone().addScaledVector(n, -(PLANK_THICKNESS + W_IN));
      const outer = p.clone().addScaledVector(n, W_OUT);
      rings.push([
        new Vector3(inner.x, top - H, inner.z),
        new Vector3(outer.x, top - H, outer.z),
        new Vector3(outer.x, top, outer.z),
        new Vector3(inner.x, top, inner.z),
      ]);
    }
    for (let i = 0; i < NS; i++) {
      const a = rings[i];
      const c = rings[i + 1];
      // faces: bottom (0-1), outer (1-2), top (2-3), inner (3-0)
      for (let f = 0; f < 4; f++) {
        const k0 = f;
        const k1 = (f + 1) % 4;
        const quad = side > 0 ? [a[k0], c[k0], c[k1], a[k1]] : [a[k1], c[k1], c[k0], a[k0]];
        const e1 = tmp.subVectors(quad[1], quad[0]);
        const e2 = tmp2.subVectors(quad[3], quad[0]);
        const n = new Vector3().crossVectors(e1, e2).normalize();
        const ids = quad.map((p) =>
          b.vertex({ position: p, normal: n, aPart: PART.trim, aWood: [p.z, p.y * 3 + f], aStrake: 0.5, aAO: 1 }),
        );
        b.quad(ids[0], ids[1], ids[2], ids[3]);
      }
    }
  }
}

// Flat transom closing the stern, with a little thickness and a top cap.
function buildTransom(b) {
  const s = 0;
  const z0 = zAt(s) + 0.004;
  const zi = z0 - 0.032;
  const ys = sheerHeight(s);
  const outline = [];
  for (let j = 0; j <= NT; j++) outline.push(outerPoint(s, thetaAt(j), new Vector3()));
  const center = new Vector3(0, ys, z0);
  const nOut = new Vector3(0, 0, 1);
  const nIn = new Vector3(0, 0, -1);
  const c0 = b.vertex({ position: center, normal: nOut, aPart: PART.hullOuter, aWood: [center.x, center.y], aStrake: 0.5, aAO: 1 });
  const outerIds = outline.map((p) =>
    b.vertex({ position: [p.x, p.y, z0], normal: nOut, aPart: PART.hullOuter, aWood: [p.x, p.y], aStrake: (p.y + 0.2) * 9, aAO: 1 }),
  );
  for (let j = 0; j < NT; j++) b.tri(c0, outerIds[j], outerIds[j + 1]);
  // inner face, shrunk by the plank thickness
  const ci = b.vertex({ position: [0, ys, zi], normal: nIn, aPart: PART.hullInner, aWood: [0, ys], aStrake: 0.5, aAO: 0.9 });
  const innerIds = outline.map((p) => {
    const x = Math.sign(p.x) * Math.max(Math.abs(p.x) - PLANK_THICKNESS * 1.4, 0);
    const y = p.y + PLANK_THICKNESS;
    return b.vertex({ position: [x, y, zi], normal: nIn, aPart: PART.hullInner, aWood: [x, y], aStrake: (y + 0.2) * 9, aAO: 0.55 + 0.45 * (y - keelHeight(0)) / (ys - keelHeight(0)) });
  });
  for (let j = 0; j < NT; j++) b.tri(ci, innerIds[j + 1], innerIds[j]);
  // top cap of the transom board
  const half = halfBeam(0);
  const corners = [
    new Vector3(-half, ys - 0.03, z0 + 0.012),
    new Vector3(half, ys - 0.03, z0 + 0.012),
    new Vector3(half, ys - 0.03, zi),
    new Vector3(-half, ys - 0.03, zi),
    new Vector3(-half, ys + 0.014, z0 + 0.012),
    new Vector3(half, ys + 0.014, z0 + 0.012),
    new Vector3(half, ys + 0.014, zi),
    new Vector3(-half, ys + 0.014, zi),
  ];
  addBoxFromCorners(b, corners, (fi, k, p) => ({ aPart: PART.trim, aWood: [p.x, p.z * 4 + fi], aStrake: 0.5, aAO: 1 }));
}

// Stem post following the bow profile, standing a little proud of the sheer.
function buildStem(b) {
  const pts = [];
  for (let k = 0; k <= 10; k++) {
    const s = 0.8 + 0.2 * (k / 10);
    pts.push(new Vector3(0, keelHeight(s), zAt(s)));
  }
  const top = sheerHeight(1) + 0.07;
  const zb = zAt(1);
  for (let k = 1; k <= 4; k++) {
    pts.push(new Vector3(0, keelHeight(1) + ((top - keelHeight(1)) * k) / 4, zb - 0.005 * k));
  }
  const W = 0.026;
  const D = 0.035;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const c = pts[k + 1];
    const dir = tmp.subVectors(c, a).normalize();
    // outward normal of the profile in the y-z plane
    const out = new Vector3(0, -dir.z, dir.y);
    if (out.z > 0) out.negate();
    const corners = [
      a.clone().add(new Vector3(-W, 0, 0)).addScaledVector(out, -0.01),
      a.clone().add(new Vector3(W, 0, 0)).addScaledVector(out, -0.01),
      c.clone().add(new Vector3(W, 0, 0)).addScaledVector(out, -0.01),
      c.clone().add(new Vector3(-W, 0, 0)).addScaledVector(out, -0.01),
      a.clone().add(new Vector3(-W, 0, 0)).addScaledVector(out, D),
      a.clone().add(new Vector3(W, 0, 0)).addScaledVector(out, D),
      c.clone().add(new Vector3(W, 0, 0)).addScaledVector(out, D),
      c.clone().add(new Vector3(-W, 0, 0)).addScaledVector(out, D),
    ];
    // corners are ordered so that "top" is the outward face of the post
    addBoxFromCorners(b, reorderForBox(corners), (fi, j, p) => ({ aPart: PART.trim, aWood: [p.y * 2, p.x * 6 + fi], aStrake: 0.5, aAO: 1 }));
  }
}

// addBoxFromCorners expects an upright box; for arbitrary hexahedra we just
// need consistent winding, so make sure the "top" quad faces away from bottom.
function reorderForBox(c) {
  const n = new Vector3().crossVectors(tmp.subVectors(c[5], c[4]), tmp2.subVectors(c[7], c[4]));
  const centroidTop = c[4].clone().add(c[5]).add(c[6]).add(c[7]).multiplyScalar(0.25);
  const centroidBot = c[0].clone().add(c[1]).add(c[2]).add(c[3]).multiplyScalar(0.25);
  if (n.dot(centroidTop.sub(centroidBot)) < 0) {
    return [c[1], c[0], c[3], c[2], c[5], c[4], c[7], c[6]];
  }
  return c;
}

// Frames (ribs) running up the inside of the planking.
function buildFrames(b) {
  const stations = [];
  for (let s = 0.085; s < 0.88; s += 0.078) stations.push(s);
  const halfW = 0.018;
  const depth = 0.02;
  for (const s of stations) {
    const pts = [];
    const nrm = [];
    for (let j = 1; j < NT; j++) {
      const theta = thetaAt(j) * 0.985;
      const p = outerPoint(s, theta, new Vector3());
      const n = outerNormal(s, theta, new Vector3());
      p.addScaledVector(n, -PLANK_THICKNESS);
      pts.push(p);
      nrm.push(n.negate());
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const c = pts[k + 1];
      const na = nrm[k];
      const nc = nrm[k + 1];
      const za = new Vector3(0, 0, halfW);
      const corners = [
        a.clone().sub(za),
        c.clone().sub(za),
        c.clone().add(za),
        a.clone().add(za),
        a.clone().sub(za).addScaledVector(na, depth),
        c.clone().sub(za).addScaledVector(nc, depth),
        c.clone().add(za).addScaledVector(nc, depth),
        a.clone().add(za).addScaledVector(na, depth),
      ];
      addBoxFromCorners(
        b,
        reorderForBox(corners),
        (fi, j, p) => ({ aPart: PART.frame, aWood: [p.y * 1.5 + p.x, p.z * 30 + s * 7], aStrake: 0.5, aAO: 0.75 + 0.25 * Math.min(Math.max((p.y + 0.1) / 0.5, 0), 1) }),
        [true, false, true, true, true, true],
      );
    }
  }
}

// Inner half-width (inside the planking) at local height y for station s.
function innerHalfWidth(s, y) {
  return Math.max(halfWidthAtHeight(s, y) - PLANK_THICKNESS * 1.25, 0);
}

function buildFloorboards(b) {
  const yTop = -0.09;
  const thick = 0.022;
  const yBot = yTop - thick;
  const boardW = 0.14;
  const gap = 0.017;
  const count = 5;
  const total = count * boardW + (count - 1) * gap;
  const s0 = 0.06;
  const s1 = 0.87;
  const seg = 28;
  for (let k = 0; k < count; k++) {
    const x0 = -total / 2 + k * (boardW + gap);
    const x1 = x0 + boardW;
    for (let i = 0; i < seg; i++) {
      const sa = s0 + ((s1 - s0) * i) / seg;
      const sc = s0 + ((s1 - s0) * (i + 1)) / seg;
      const wa = innerHalfWidth(sa, yBot) - 0.012;
      const wc = innerHalfWidth(sc, yBot) - 0.012;
      const lim = Math.min(wa, wc);
      const xa = Math.max(x0, -lim);
      const xb = Math.min(x1, lim);
      if (xb - xa < 0.025) continue;
      const za = zAt(sa);
      const zc = zAt(sc);
      const corners = [
        new Vector3(xa, yBot, za),
        new Vector3(xb, yBot, za),
        new Vector3(xb, yBot, zc),
        new Vector3(xa, yBot, zc),
        new Vector3(xa, yTop, za),
        new Vector3(xb, yTop, za),
        new Vector3(xb, yTop, zc),
        new Vector3(xa, yTop, zc),
      ];
      const centre = (x0 + x1) / 2;
      addBoxFromCorners(b, corners, (fi, j, p) => ({
        aPart: PART.floor,
        aWood: [p.z, p.x + k * 3.7],
        aStrake: k + 0.5 + (p.x - centre) / (boardW + gap),
        aAO: fi === 0 ? 0.78 + 0.22 * (1 - Math.abs(p.x) / 0.45) : 0.5,
      }));
    }
  }
}

function buildSeat(b, sCenter, depth, drop, thick = 0.032) {
  const yTop = sheerHeight(sCenter) - drop;
  const yBot = yTop - thick;
  const za = zAt(sCenter) + depth / 2;
  const zc = zAt(sCenter) - depth / 2;
  const sa = sCenter - depth / 2 / HULL_LENGTH;
  const sc = sCenter + depth / 2 / HULL_LENGTH;
  const wa = Math.min(innerHalfWidth(sa, yBot), innerHalfWidth(sa, yTop)) - 0.004;
  const wc = Math.min(innerHalfWidth(sc, yBot), innerHalfWidth(sc, yTop)) - 0.004;
  const corners = [
    new Vector3(-wa, yBot, za),
    new Vector3(wa, yBot, za),
    new Vector3(wc, yBot, zc),
    new Vector3(-wc, yBot, zc),
    new Vector3(-wa, yTop, za),
    new Vector3(wa, yTop, za),
    new Vector3(wc, yTop, zc),
    new Vector3(-wc, yTop, zc),
  ];
  addBoxFromCorners(b, corners, (fi, j, p) => ({
    aPart: PART.seat,
    aWood: [p.x, p.z * 2.3 + sCenter * 9],
    aStrake: 0.5 + (p.z - zAt(sCenter)) / depth,
    aAO: fi === 1 ? 0.45 : 0.95,
  }));
  return { yTop, yBot, wa, wc, za, zc };
}

// Longitudinal riser strips that carry the thwarts.
function buildRisers(b, y) {
  const s0 = 0.12;
  const s1 = 0.86;
  const seg = 24;
  const h = 0.045;
  const t = 0.018;
  for (const side of [-1, 1]) {
    for (let i = 0; i < seg; i++) {
      const sa = s0 + ((s1 - s0) * i) / seg;
      const sc = s0 + ((s1 - s0) * (i + 1)) / seg;
      const ya = y(sa);
      const yc = y(sc);
      const wa = innerHalfWidth(sa, ya) - 0.002;
      const wc = innerHalfWidth(sc, yc) - 0.002;
      if (wa < 0.1 || wc < 0.1) continue;
      const za = zAt(sa);
      const zc = zAt(sc);
      const ca = [
        new Vector3(side * (wa - t), ya - h, za),
        new Vector3(side * wa, ya - h, za),
        new Vector3(side * wc, yc - h, zc),
        new Vector3(side * (wc - t), yc - h, zc),
        new Vector3(side * (wa - t), ya, za),
        new Vector3(side * wa, ya, za),
        new Vector3(side * wc, yc, zc),
        new Vector3(side * (wc - t), yc, zc),
      ];
      const corners = side > 0 ? ca : [ca[1], ca[0], ca[3], ca[2], ca[5], ca[4], ca[7], ca[6]];
      addBoxFromCorners(b, corners, (fi, j, p) => ({ aPart: PART.frame, aWood: [p.z, p.y * 20], aStrake: 0.5, aAO: 0.85 }));
    }
  }
}

// Triangular breasthook at the bow and quarter knees at the transom corners.
function buildKnees(b) {
  const plate = (pts, y0, y1) => {
    const [a, c, d] = pts;
    const corners = [
      new Vector3(a.x, y0, a.z),
      new Vector3(c.x, y0, c.z),
      new Vector3(d.x, y0, d.z),
      new Vector3(d.x, y0, d.z),
      new Vector3(a.x, y1, a.z),
      new Vector3(c.x, y1, c.z),
      new Vector3(d.x, y1, d.z),
      new Vector3(d.x, y1, d.z),
    ];
    addBoxFromCorners(b, reorderForBox(corners), (fi, j, p) => ({ aPart: PART.trim, aWood: [p.x * 3, p.z * 3], aStrake: 0.5, aAO: 0.95 }));
  };
  // breasthook
  const sb = 0.89;
  const yb = sheerHeight(0.95) - 0.005;
  const wb = innerHalfWidth(sb, yb);
  plate([new Vector3(-wb, 0, zAt(sb)), new Vector3(wb, 0, zAt(sb)), new Vector3(0, 0, zAt(0.995))], yb - 0.035, yb);
  // quarter knees
  const sq = 0.07;
  const yq = sheerHeight(0.03) - 0.005;
  for (const side of [-1, 1]) {
    const w0 = innerHalfWidth(0.01, yq);
    const w1 = innerHalfWidth(sq, yq);
    plate(
      [
        new Vector3(side * w0, 0, zAt(0.008)),
        new Vector3(side * (w0 - 0.2), 0, zAt(0.008)),
        new Vector3(side * w1, 0, zAt(sq)),
      ],
      yq - 0.03,
      yq,
    );
  }
}

export function createBoatGeometry() {
  const b = new MeshBuilder({ aPart: 1, aWood: 2, aStrake: 1, aAO: 1 });
  buildSkins(b);
  buildGunwales(b);
  buildTransom(b);
  buildStem(b);
  buildFrames(b);
  buildFloorboards(b);

  const seatDrop = 0.17;
  const riserY = (s) => sheerHeight(s) - seatDrop - 0.032;
  buildRisers(b, riserY);
  buildSeat(b, 0.105, 0.3, 0.2, 0.03); // stern sheets
  buildSeat(b, 0.33, 0.22, seatDrop);
  buildSeat(b, 0.58, 0.22, seatDrop);
  buildSeat(b, 0.8, 0.19, seatDrop);
  buildKnees(b);
  return b.build();
}
