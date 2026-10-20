import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  TorusGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { BODY, FLOOR_Y, SEAT, makeJoints, solveTwoBone, torsoJoints } from './body.js';

// The paddler as one skinned mesh: a continuous body surface lofted through
// anatomical cross-sections and weighted smoothly across the joints, plus
// rigid detail (face, hat, hands, boots, buckle, satchel) bound to single
// bones. It is built in a seated rest pose, so everyday motion only bends it
// gently. Bones: hips > spine > chest > neck > head, chest > upper arm >
// forearm > (twist, hand), hips > thigh > shin > foot.

// Surface kinds for the shader.
// 'garment' is the torso, whose clothing the shader lays out per pixel.
export const SURFACE = { skin: 0, cloth: 1, leather: 2, metal: 3, hair: 4, eye: 5, wood: 6, garment: 7 };

// Centre of the bar a closed fist holds, in the hand bone's frame (wrist at
// the origin, fingers along +y, back of the hand towards +z).
export const GRIP = { y: 0.074, z: -0.031, radius: 0.017 };

// Palette (linear RGB).
const C = {
  skin: [0.34, 0.205, 0.14],
  skinShade: [0.3, 0.155, 0.095],
  lips: [0.22, 0.1, 0.075],
  stubble: [0.16, 0.1, 0.07],
  shirt: [0.5, 0.46, 0.38],
  shirtShade: [0.38, 0.345, 0.28],
  vest: [0.12, 0.072, 0.036],
  vestEdge: [0.055, 0.032, 0.016],
  trousers: [0.13, 0.12, 0.07],
  trouserShade: [0.09, 0.083, 0.048],
  belt: [0.04, 0.024, 0.013],
  brass: [0.55, 0.38, 0.13],
  strap: [0.19, 0.12, 0.06],
  canvas: [0.21, 0.18, 0.11],
  boots: [0.07, 0.04, 0.021],
  sole: [0.022, 0.016, 0.011],
  laces: [0.2, 0.15, 0.09],
  scarf: [0.36, 0.055, 0.035],
  hat: [0.33, 0.24, 0.13],
  hatBand: [0.055, 0.033, 0.018],
  hair: [0.04, 0.025, 0.015],
  eyeWhite: [0.4, 0.38, 0.35],
  iris: [0.07, 0.04, 0.018],
  pupil: [0.004, 0.003, 0.002],
  brow: [0.035, 0.022, 0.013],
  beard: [0.05, 0.032, 0.02],
  flush: [0.42, 0.17, 0.11],
};

const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

// Piecewise-linear lookup in rows of [x, ...values].
function table(rows, x) {
  if (x <= rows[0][0]) return rows[0].slice(1);
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const a = rows[i - 1];
      const b = rows[i];
      const t = (x - a[0]) / (b[0] - a[0]);
      return a.slice(1).map((v, k) => v + (b[k + 1] - v) * t);
    }
  }
  return rows[rows.length - 1].slice(1);
}

// --- mesh assembly --------------------------------------------------------------

class SkinBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.surf = [];
    this.ao = [];
    this.bi = [];
    this.bw = [];
    this.idx = [];
    this.count = 0;
  }

  // Adds a geometry. attr(p, n, i) returns { color, surface, ao, bones: [[bone, w], ...] }.
  add(geometry, attr) {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const p = geometry.attributes.position;
    const n = geometry.attributes.normal;
    const base = this.count;
    const v = new Vector3();
    const nv = new Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      nv.fromBufferAttribute(n, i);
      const a = attr(v, nv, i);
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(nv.x, nv.y, nv.z);
      this.col.push(a.color[0], a.color[1], a.color[2]);
      this.surf.push(a.surface);
      this.ao.push(a.ao ?? 1);
      const bones = a.bones.filter(([, w]) => w > 1e-3).sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = bones.reduce((s, [, w]) => s + w, 0) || 1;
      for (let k = 0; k < 4; k++) {
        this.bi.push(bones[k] ? bones[k][0] : 0);
        this.bw.push(bones[k] ? bones[k][1] / sum : 0);
      }
      this.count++;
    }
    if (geometry.index) for (const k of geometry.index.array) this.idx.push(base + k);
    else for (let k = 0; k < p.count; k++) this.idx.push(base + k);
  }

  build() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurface', new Float32BufferAttribute(this.surf, 1));
    g.setAttribute('aAO', new Float32BufferAttribute(this.ao, 1));
    g.setAttribute('skinIndex', new Uint16BufferAttribute(this.bi, 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(this.bw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// Tube through 'centers' with per-ring frames; section(ring, angle) gives the
// offset [a, b] along the ring's (normal, binormal). No seam duplicate, so the
// smoothed normals are continuous all the way round.
function loft(centers, frames, section, radial, { capStart = true, capEnd = true } = {}) {
  const pos = [];
  const ringOf = [];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < radial; j++) {
      const [a, b] = section(i, (j / radial) * Math.PI * 2);
      const p = centers[i].clone().addScaledVector(frames[i].n, a).addScaledVector(frames[i].b, b);
      pos.push(p.x, p.y, p.z);
      ringOf.push(i);
    }
  }
  const idx = [];
  for (let i = 0; i < centers.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + ((j + 1) % radial);
      const d = (i + 1) * radial + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const capAt = (i, flip) => {
    const c = centers[i];
    const k = pos.length / 3;
    pos.push(c.x, c.y, c.z);
    ringOf.push(i);
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      if (flip) idx.push(k, b, a);
      else idx.push(k, a, b);
    }
  };
  if (capStart) capAt(0, false);
  if (capEnd) capAt(centers.length - 1, true);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Orientation check on a ring in the middle: normals point away from the axis.
  const n = g.attributes.normal;
  const mid = Math.floor(centers.length / 2) * radial;
  const p0 = new Vector3(pos[mid * 3], pos[mid * 3 + 1], pos[mid * 3 + 2]);
  const n0 = new Vector3(n.getX(mid), n.getY(mid), n.getZ(mid));
  if (n0.dot(p0.sub(centers[Math.floor(centers.length / 2)])) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.userData = { ringOf };
  return g;
}

// Frames along a path by parallel transport, starting from 'normal0'.
function pathFrames(points, normal0) {
  const frames = [];
  const n = normal0.clone();
  for (let i = 0; i < points.length; i++) {
    const t = points[Math.min(i + 1, points.length - 1)].clone().sub(points[Math.max(i - 1, 0)]).normalize();
    n.addScaledVector(t, -n.dot(t)).normalize();
    frames.push({ t, n: n.clone(), b: new Vector3().crossVectors(t, n).normalize() });
  }
  return frames;
}

// Polyline through joints with the corners rounded off.
function roundedPath(points, radius, steps = 4) {
  const out = [points[0].clone()];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const ab = b.clone().sub(a);
    const bc = c.clone().sub(b);
    const r = Math.min(radius, ab.length() * 0.45, bc.length() * 0.45);
    const p0 = b.clone().addScaledVector(ab.normalize(), -r);
    const p1 = b.clone().addScaledVector(bc.normalize(), r);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Quadratic Bezier p0 -> b -> p1.
      out.push(
        p0.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(b, 2 * (1 - t) * t).addScaledVector(p1, t * t),
      );
    }
  }
  out.push(points[points.length - 1].clone());
  return out;
}

// Resample a polyline to roughly uniform spacing; returns points + arc lengths.
function resample(points, spacing) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = lengths[lengths.length - 1];
  const n = Math.max(2, Math.ceil(total / spacing));
  const out = [];
  const s = [];
  let k = 1;
  for (let i = 0; i <= n; i++) {
    const d = (i / n) * total;
    while (k < lengths.length - 1 && lengths[k] < d) k++;
    const t = (d - lengths[k - 1]) / Math.max(lengths[k] - lengths[k - 1], 1e-6);
    out.push(points[k - 1].clone().lerp(points[k], Math.min(Math.max(t, 0), 1)));
    s.push(d);
  }
  return { points: out, s, total };
}

// Arc length of the sample nearest to p.
function arcNearest(points, arc, p) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].distanceToSquared(p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return arc[best];
}

// A finger-like tube along a path with a rounded tip; radius(t) over t in [0, 1].
function capsule(path, radius, spacing, radial, normal0) {
  const { points, s, total } = resample(path, spacing);
  const fr = pathFrames(points, normal0);
  const centers = [];
  const frames = [];
  const radii = [];
  for (let i = 0; i < points.length; i++) {
    centers.push(points[i]);
    frames.push(fr[i]);
    radii.push(radius(s[i] / total));
  }
  const last = points.length - 1;
  const rEnd = radii[last];
  for (let k = 1; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2);
    centers.push(points[last].clone().addScaledVector(fr[last].t, rEnd * Math.sin(a)));
    frames.push(fr[last]);
    radii.push(Math.max(rEnd * Math.cos(a), 1e-4));
  }
  return loft(centers, frames, (i, ang) => [Math.cos(ang) * radii[i], Math.sin(ang) * radii[i]], radial, {
    capStart: true,
    capEnd: false,
  });
}

// Ellipsoid with its own transform, for small rigid details.
function blob(rx, ry, rz, at, segments = 12, rings = 8) {
  const g = new SphereGeometry(1, segments, rings);
  g.scale(rx, ry, rz);
  g.translate(at.x, at.y, at.z);
  return g;
}

// --- skeleton -------------------------------------------------------------------

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'forearmL', 'twistL', 'handL',
  'upperArmR', 'forearmR', 'twistR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];
export const BONE_PARENT = {
  spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  upperArmL: 'chest', forearmL: 'upperArmL', twistL: 'forearmL', handL: 'forearmL',
  upperArmR: 'chest', forearmR: 'upperArmR', twistR: 'forearmR', handR: 'forearmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
};
const B = Object.fromEntries(BONES.map((name, i) => [name, i]));
const SIDES = [-1, 1];
const LETTER = { [-1]: 'L', 1: 'R' };

// Share of the wrist's roll carried by the forearm twist bone.
const TWIST_SHARE = 0.6;

// Signed angle from a to b about the unit axis (a, b roughly perpendicular to it).
const _sa = new Vector3();
function signedAngle(a, b, axis) {
  return Math.atan2(_sa.crossVectors(a, b).dot(axis), a.dot(b));
}

// Hinge axis of a two-bone chain from its root, end and pole: stable even
// when the limb is straight.
const _hd = new Vector3();
const _hp = new Vector3();
export function hingeAxis(root, end, pole, out) {
  _hd.subVectors(end, root).normalize();
  _hp.copy(pole).addScaledVector(_hd, -pole.dot(_hd)).normalize();
  return out.crossVectors(_hd, _hp).normalize();
}

// Rotation whose y axis is exactly 'y' and whose x axis is 'x' made orthogonal.
const _bx = new Vector3();
const _bz = new Vector3();
const _bm = new Matrix4();
function basis(q, x, y) {
  _bz.crossVectors(x, y).normalize();
  _bx.crossVectors(y, _bz).normalize();
  _bm.makeBasis(_bx, y, _bz);
  return q.setFromRotationMatrix(_bm);
}

export function makeFrames() {
  const out = {};
  for (const name of BONES) out[name] = { p: new Vector3(), q: new Quaternion() };
  return out;
}

// Hand axes for a wrist at rest: fist closed round a bar, thumb up.
function restHandAxes(fore, side, hx, hy) {
  hy.copy(fore);
  hx.set(0, 1, 0).addScaledVector(fore, -fore.y).normalize().multiplyScalar(-side);
}

// Character-space frames for every bone of a pose. pose = { joints, arms, legs }
// where arms[side] = { S, E, W, pole, hx, hy, twist0 } (shoulder, elbow, wrist,
// elbow pole, hand x/y axes, rest twist) and legs[side] = { H, K, A, pole }.
const _hinge = new Vector3();
const _fore = new Vector3();
const _seg = new Vector3();
const _hx = new Vector3();
const UP = new Vector3(0, 1, 0);
export function boneFrames(pose, extra, out) {
  const j = pose.joints;
  out.hips.p.copy(j.pelvis);
  out.hips.q.identity().slerp(j.lowerRot, 0.35);
  out.spine.p.set(0, 0.1, 0).applyQuaternion(j.lowerRot).add(j.pelvis);
  out.spine.q.copy(j.lowerRot);
  out.chest.p.copy(j.chestBase);
  out.chest.q.copy(j.chestRot);
  out.neck.p.copy(j.neck);
  out.neck.q.copy(extra.neckQ ?? j.chestRot);
  // The neck leans forward a little, carrying the head ahead of the spine.
  out.head.p.set(0, BODY.neck, -0.016).applyQuaternion(out.neck.q).add(j.neck);
  out.head.q.copy(extra.headQ ?? j.chestRot);
  for (const side of SIDES) {
    const s = LETTER[side];
    const a = pose.arms[side];
    hingeAxis(a.S, a.W, a.pole, _hinge);
    basis(out['upperArm' + s].q, _hinge, _seg.subVectors(a.E, a.S).normalize());
    out['upperArm' + s].p.copy(a.S);
    _fore.subVectors(a.W, a.E).normalize();
    const fq = basis(out['forearm' + s].q, _hinge, _fore);
    out['forearm' + s].p.copy(a.E);
    basis(out['hand' + s].q, a.hx, a.hy);
    out['hand' + s].p.copy(a.W);
    // The twist bone rolls part way towards the hand about the forearm.
    _hx.copy(a.hx).addScaledVector(_fore, -a.hx.dot(_fore)).normalize();
    let roll = signedAngle(_hinge, _hx, _fore) - (a.twist0 ?? 0);
    roll = Math.atan2(Math.sin(roll), Math.cos(roll));
    out['twist' + s].q.setFromAxisAngle(_fore, roll * TWIST_SHARE).multiply(fq);
    out['twist' + s].p.copy(a.E).addScaledVector(_fore, BODY.forearm * 0.5);
    const l = pose.legs[side];
    hingeAxis(l.H, l.A, l.pole, _hinge);
    basis(out['thigh' + s].q, _hinge, _seg.subVectors(l.K, l.H).normalize());
    out['thigh' + s].p.copy(l.H);
    basis(out['shin' + s].q, _hinge, _seg.subVectors(l.A, l.K).normalize());
    out['shin' + s].p.copy(l.K);
    out['foot' + s].q.setFromAxisAngle(UP, -side * 0.12);
    out['foot' + s].p.copy(l.A);
  }
  return out;
}

// Rest pose: seated upright, fists loosely closed above the knees, feet planted.
export function restPose() {
  const j = torsoJoints({ yaw: 0, lean: 0, roll: 0, shiftX: 0, shiftZ: 0, lift: 0 }, makeJoints());
  const pose = { joints: j, arms: {}, legs: {} };
  for (const side of SIDES) {
    const S = (side < 0 ? j.shoulderL : j.shoulderR).clone();
    const pole = new Vector3(side, -0.7, 0.5);
    const E = new Vector3();
    const W = new Vector3();
    solveTwoBone(S, new Vector3(side * 0.29, 0.52, SEAT.z - 0.34), BODY.upperArm, BODY.forearm, pole, E, W);
    const fore = W.clone().sub(E).normalize();
    const hx = new Vector3();
    const hy = new Vector3();
    restHandAxes(fore, side, hx, hy);
    const hinge = hingeAxis(S, W, pole, new Vector3());
    const twist0 = signedAngle(hinge, hx, fore);
    pose.arms[side] = { S, E, W, pole, hx, hy, hz: new Vector3().crossVectors(hx, hy), twist0 };
    const H = (side < 0 ? j.hipL : j.hipR).clone();
    const A = new Vector3(side * 0.13, FLOOR_Y + BODY.ankle, SEAT.z - 0.6);
    const lp = new Vector3(side * 0.35, 1, -1);
    const K = new Vector3();
    solveTwoBone(H, A, BODY.thigh, BODY.shin, lp, K, new Vector3());
    pose.legs[side] = { H, K, A, pole: lp };
  }
  return pose;
}

// --- body parts -----------------------------------------------------------------

// Torso clothing layout, shared by the geometry (thickness) and the shader
// (colour): h is the height above the hip joints, x across, front towards the bow.
const vestOpening = (h) => 0.026 + 0.075 * smooth(0.06, 0.42, h);
const armholeX = (h) => 0.15 - 0.03 * smooth(0.29, 0.4, h);
const strapDistance = (h, x) => Math.abs((x + 0.12) * -0.47 - (h - 0.47) * 0.29) / Math.hypot(0.29, 0.47);

// How far the clothing stands off the shirt underneath.
function torsoThickness(h, x, front) {
  const ax = Math.abs(x);
  if (strapDistance(h, x) < 0.019 && h > -0.02 && h < 0.47) return 0.006;
  if (h >= 0 && h < 0.045) return 0.005;
  if (front && h > 0.39 && h < 0.475 && ax < (0.062 * (h - 0.39)) / 0.085) return 0.004;
  const vest = h >= 0.045 && h < 0.425 && !(front && ax < vestOpening(h)) && !(h > 0.29 && ax > armholeX(h));
  return vest ? 0.005 : 0;
}

const v3 = (c) => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;

// The same layout per pixel, from the rest-pose position, with edges
// antialiased over w. Returns the colour; 'leather' is how much of it is.
export const GARMENT_GLSL = /* glsl */ `
uniform vec2 uTorso; // rest height of the hip joints, depth of the torso centre
float cover(float d, float w) {
  return clamp(d / w + 0.5, 0.0, 1.0);
}
vec3 torsoGarment(vec3 p, float w, out float leather) {
  float h = p.y - uTorso.x;
  float x = p.x;
  float ax = abs(x);
  float front = step(p.z, uTorso.y);
  float opening = 0.026 + 0.075 * smoothstep(0.06, 0.42, h);
  float armX = 0.15 - 0.03 * smoothstep(0.29, 0.4, h);
  // Shirt, with a darker placket down the front.
  vec3 col = mix(${v3(C.shirt)}, ${v3(C.shirtShade)}, front * cover(0.004 - ax, w) * cover(h - 0.05, w));
  // Trousers below the belt, darker where they bunch over the seat.
  col = mix(col, mix(${v3(C.trousers)}, ${v3(C.trouserShade)}, smoothstep(-0.06, -0.135, h)), cover(-h, w));
  float belt = cover(h, w) * cover(0.045 - h, w);
  col = mix(col, ${v3(C.belt)}, belt);
  leather = belt;
  // Vest: open at the front, cut away round the arms, bound with a darker edge.
  float dVest = min(min(h - 0.045, 0.425 - h), min(mix(1.0, ax - opening, front), max(0.29 - h, armX - ax)));
  float vest = cover(dVest, w);
  float pocket = front * cover(min(min(h - 0.1, 0.128 - h), 0.036 - abs(ax - 0.085)), w);
  col = mix(col, mix(${v3(C.vestEdge)}, ${v3(C.vest)}, cover(dVest - 0.011, w) * (1.0 - pocket)), vest);
  leather = max(leather, vest);
  // Neckerchief tails in the open collar.
  float bib = front * cover(min(min(h - 0.39, 0.475 - h), 0.062 * (h - 0.39) / 0.085 - ax), w);
  col = mix(col, ${v3(C.scarf)}, bib);
  leather *= 1.0 - bib;
  // Satchel strap from the left shoulder to the right hip.
  float sd = abs((x + 0.12) * -0.47 - (h - 0.47) * 0.29) / length(vec2(0.29, 0.47));
  float strap = cover(0.019 - sd, w) * cover(h + 0.02, w) * cover(0.47 - h, w);
  col = mix(col, mix(${v3(C.strap)}, ${v3(scale3(C.strap, 0.6))}, cover(sd - 0.014, w)), strap);
  leather = max(leather, strap);
  return col;
}
`;

function buildTorso(sb, rest) {
  const P = rest.joints.pelvis;
  // Height above the hip joints -> [half width, front depth, back depth, squareness]
  const rows = [
    [-0.135, 0.15, 0.1, 0.12, 2.3],
    [-0.09, 0.17, 0.112, 0.138, 2.6],
    [-0.03, 0.174, 0.11, 0.128, 2.7],
    [0.03, 0.166, 0.104, 0.114, 2.6],
    [0.1, 0.152, 0.099, 0.1, 2.5],
    [0.17, 0.153, 0.104, 0.1, 2.5],
    [0.24, 0.165, 0.116, 0.107, 2.6],
    [0.31, 0.177, 0.127, 0.112, 2.7],
    [0.37, 0.186, 0.124, 0.116, 2.8],
    [0.415, 0.19, 0.112, 0.112, 2.8],
    [0.448, 0.184, 0.096, 0.102, 2.6],
    [0.474, 0.155, 0.08, 0.088, 2.3],
    [0.494, 0.104, 0.068, 0.072, 2.1],
    [0.508, 0.064, 0.058, 0.062, 2.0],
  ];
  const hs = [];
  for (let h = -0.135; h <= 0.5081; h += 0.012) hs.push(h);
  hs.push(0.508);
  const centers = hs.map((h) => new Vector3(0, P.y + h, P.z + 0.008));
  const frames = centers.map(() => ({ n: new Vector3(1, 0, 0), b: new Vector3(0, 0, 1) }));
  const g = loft(
    centers,
    frames,
    (i, ang) => {
      const h = hs[i];
      const [w, df, db, n] = table(rows, h);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const e = 2 / n;
      let x = w * Math.sign(c) * Math.pow(Math.abs(c), e);
      let z = Math.sign(s) * Math.pow(Math.abs(s), e) * (s < 0 ? df : db);
      // Shoulder blades, pectorals and a spine groove.
      if (s > 0) {
        z += 0.012 * smooth(0.25, 0.36, h) * (1 - smooth(0.38, 0.45, h)) * Math.exp(-Math.pow((Math.abs(x) - 0.08) / 0.05, 2));
        z -= 0.006 * smooth(0.05, 0.2, h) * (1 - smooth(0.38, 0.46, h)) * Math.exp(-Math.pow(x / 0.022, 2));
      } else {
        z -= 0.01 * smooth(0.27, 0.34, h) * (1 - smooth(0.36, 0.41, h)) * Math.exp(-Math.pow((Math.abs(x) - 0.075) / 0.045, 2));
      }
      // Cloth thickness: vest, belt and strap stand off the shirt.
      const t = torsoThickness(h, x, s < 0);
      if (t) {
        const len = Math.hypot(x, z) || 1;
        x += (x / len) * t;
        z += (z / len) * t;
      }
      return [x, z];
    },
    36,
  );
  const { ringOf } = g.userData;
  const hipW = (h) => 1 - smooth(0.03, 0.17, h);
  const chestW = (h) => smooth(0.19, 0.31, h);
  sb.add(g, (p, n, i) => {
    const h = hs[Math.min(ringOf[i], hs.length - 1)];
    const x = p.x;
    const wh = hipW(h);
    const wc = chestW(h);
    const ws = Math.max(0, 1 - wh - wc);
    const neckW = smooth(0.45, 0.49, h) * 0.35;
    // The shader picks the cloth; the vertex colour carries creases: the
    // shirt bunched above the belt, the trousers over the seat.
    const crease = 0.9 + 0.1 * Math.sin(x * 70 + h * 20);
    const armpit = Math.exp(-Math.pow((Math.abs(x) - 0.17) / 0.03, 2)) * smooth(0.28, 0.36, h) * (1 - smooth(0.4, 0.44, h));
    const ao = (1 - 0.4 * armpit) * (0.62 + 0.38 * smooth(-0.13, -0.04, h)) * (0.9 + 0.1 * smooth(0.0, 0.06, h));
    return {
      color: [crease, crease, crease],
      surface: SURFACE.garment,
      ao,
      bones: [[B.hips, wh], [B.spine, ws], [B.chest, wc * (1 - neckW)], [B.neck, wc * neckW]],
    };
  });
  return P;
}

function buildNeck(sb, rest, frames) {
  const N = rest.joints.neck;
  const head = frames.head.p;
  const pts = [N.clone().add(new Vector3(0, -0.05, 0.006)), N.clone(), head.clone().add(new Vector3(0, 0.04, 0.006))];
  const { points, s, total } = resample(pts, 0.01);
  const fr = pathFrames(points, new Vector3(1, 0, 0));
  const g = loft(
    points,
    fr,
    (i, ang) => {
      const t = s[i] / total;
      // Broad at the base where the trapezius runs into it.
      const rx = 0.066 - 0.011 * smooth(0.1, 0.6, t);
      const rz = 0.058 - 0.007 * smooth(0.1, 0.6, t);
      // Neckerchief rolled round the base of the neck.
      const scarf = 0.009 * smooth(0.25, 0.3, t) * (1 - smooth(0.44, 0.5, t));
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      // Adam's apple.
      const throat = 0.004 * Math.exp(-Math.pow((t - 0.66) / 0.06, 2)) * Math.pow(Math.max(sn, 0), 8);
      return [c * (rx + scarf), sn * (rz + scarf + throat) + 0.004];
    },
    24,
  );
  const { ringOf } = g.userData;
  sb.add(g, (p, n, i) => {
    const t = s[Math.min(ringOf[i], s.length - 1)] / total;
    const scarf = t > 0.27 && t < 0.48;
    const color = scarf ? scale3(C.scarf, 0.85 + 0.15 * Math.sin(Math.atan2(n.x, n.z) * 9)) : C.skin;
    // Under the jaw catches less light.
    const front = n.z < -0.2;
    const ao = (0.7 + 0.3 * (1 - smooth(0.62, 0.9, t) * (front ? 1 : 0.4))) * (scarf ? 1 : 0.94);
    const wHead = smooth(0.62, 0.95, t);
    const wChest = 1 - smooth(0.1, 0.45, t);
    return {
      color,
      surface: scarf ? SURFACE.cloth : SURFACE.skin,
      ao,
      bones: [[B.chest, wChest], [B.neck, Math.max(0, 1 - wHead - wChest)], [B.head, wHead]],
    };
  });
}

function buildArm(sb, rest, side) {
  const a = rest.arms[side];
  const s = LETTER[side];
  // The tube starts inside the chest and rounds over the shoulder joint, which
  // shapes the deltoid cap.
  const start = a.S.clone().add(new Vector3(-side * 0.095, -0.012, 0.004));
  const path = roundedPath([start, a.S, a.E, a.W], 0.05, 8);
  const { points, s: arc } = resample(path, 0.014);
  const sS = arcNearest(points, arc, a.S);
  const sE = arcNearest(points, arc, a.E);
  const sW = arc[arc.length - 1];
  // u: -1..0 inside the chest, 0..1 upper arm, 1..2 forearm.
  const uOf = (x) => (x < sS ? (x - sS) / sS : x < sE ? (x - sS) / (sE - sS) : 1 + (x - sE) / (sW - sE));
  const us = arc.map(uOf);
  const radius = [
    [-1.0, 0.046, 0.046],
    [-0.5, 0.056, 0.054],
    [0.0, 0.061, 0.057],
    [0.2, 0.059, 0.054],
    [0.45, 0.053, 0.05],
    [0.8, 0.046, 0.043],
    [1.0, 0.043, 0.04],
    [1.12, 0.046, 0.042],
    [1.4, 0.041, 0.035],
    [1.75, 0.033, 0.027],
    [2.0, 0.029, 0.021],
  ];
  const hinge = hingeAxis(a.S, a.W, a.pole, new Vector3());
  const fr = pathFrames(points, hinge);
  // Turn the flat of the wrist in line with the palm.
  const wf = fr[fr.length - 1];
  const psiW = signedAngle(wf.n, a.hx.clone().addScaledVector(wf.t, -a.hx.dot(wf.t)).normalize(), wf.t);
  const g = loft(
    points,
    fr,
    (i, ang) => {
      const [rx, rz] = table(radius, us[i]);
      const X = Math.cos(ang) * rx;
      const Z = Math.sin(ang) * rz;
      const psi = psiW * smooth(1.2, 1.9, us[i]);
      return [X * Math.cos(psi) - Z * Math.sin(psi), X * Math.sin(psi) + Z * Math.cos(psi)];
    },
    20,
  );
  const { ringOf } = g.userData;
  const inside = new Vector3();
  sb.add(g, (p, n, i) => {
    const u = us[Math.min(ringOf[i], us.length - 1)];
    const sleeve = u < 1.1;
    let color = sleeve ? C.shirt : C.skin;
    if (sleeve) color = scale3(color, 0.92 + 0.08 * Math.sin(u * 40 + p.x * 90));
    const wChest = 1 - smooth(-0.35, 0.12, u);
    const wFore = smooth(0.88, 1.1, u);
    const wTwist = smooth(1.15, 1.75, u);
    const wHand = smooth(1.9, 2.02, u);
    // Crease on the inside of the elbow.
    inside.subVectors(a.S, a.E).normalize().add(a.W.clone().sub(a.E).normalize()).normalize();
    const crook = Math.exp(-Math.pow((u - 1) / 0.08, 2)) * smooth(0.1, 0.7, n.dot(inside));
    const ao = (0.8 + 0.2 * smooth(-0.3, 0.1, u)) * (1 - 0.35 * crook);
    return {
      color,
      surface: sleeve ? SURFACE.cloth : SURFACE.skin,
      ao,
      bones: [
        [B.chest, wChest],
        [B['upperArm' + s], (1 - wChest) * (1 - wFore)],
        [B['forearm' + s], wFore * (1 - wTwist) * (1 - wHand)],
        [B['twist' + s], wFore * wTwist * (1 - wHand)],
        [B['hand' + s], wFore * wHand],
      ],
    };
  });
  // Rolled cuff just below the elbow.
  const k = us.findIndex((v) => v >= 1.1);
  const [rx, rz] = table(radius, 1.1);
  const cuff = new TorusGeometry(1, 0.22, 8, 24);
  cuff.scale(rx + 0.008, rz + 0.008, 0.07);
  cuff.applyMatrix4(new Matrix4().makeBasis(fr[k].n, fr[k].b, fr[k].t));
  cuff.translate(points[k].x, points[k].y, points[k].z);
  sb.add(cuff, (p, n) => ({
    color: C.shirtShade,
    surface: SURFACE.cloth,
    ao: 0.85 + 0.15 * Math.max(n.dot(fr[k].t), 0),
    bones: [[B['forearm' + s], 1]],
  }));
}

function buildLeg(sb, rest, side) {
  const l = rest.legs[side];
  const s = LETTER[side];
  const thighDir = l.K.clone().sub(l.H).normalize();
  const start = l.H.clone().addScaledVector(thighDir, -0.07).add(new Vector3(0, 0.02, 0.02));
  const path = roundedPath([start, l.H, l.K, l.A], 0.07, 8);
  const { points, s: arc } = resample(path, 0.016);
  const sH = arcNearest(points, arc, l.H);
  const sK = arcNearest(points, arc, l.K);
  const sA = arc[arc.length - 1];
  // u: -1..0 inside the pelvis, 0..1 thigh, 1..2 shin.
  const us = arc.map((x) => (x < sH ? (x - sH) / sH : x < sK ? (x - sH) / (sK - sH) : 1 + (x - sK) / (sA - sK)));
  const radius = [
    [-1.0, 0.074],
    [-0.4, 0.084],
    [0.0, 0.088],
    [0.25, 0.082],
    [0.55, 0.073],
    [0.85, 0.063],
    [1.0, 0.06],
    [1.12, 0.061],
    [1.3, 0.062],
    [1.47, 0.058],
    [1.5, 0.064], // boot rim
    [1.56, 0.06],
    [1.75, 0.054],
    [2.0, 0.05],
  ];
  const hinge = hingeAxis(l.H, l.A, l.pole, new Vector3());
  const fr = pathFrames(points, hinge);
  const g = loft(
    points,
    fr,
    (i, ang) => {
      const u = us[i];
      const [r] = table(radius, u);
      // Calves bulge behind the shin; the seat flattens the thigh a little.
      const calf = 0.012 * smooth(1.08, 1.2, u) * (1 - smooth(1.3, 1.46, u));
      const b = Math.sin(ang);
      const c = Math.cos(ang);
      const flat = 1 - 0.1 * smooth(0.0, 0.2, u) * (1 - smooth(0.6, 0.85, u));
      return [c * r, b * r * (b > 0 ? flat : 1) + (b > 0 ? calf * b : 0)];
    },
    20,
  );
  const { ringOf } = g.userData;
  const inside = l.H.clone().sub(l.K).normalize().add(l.A.clone().sub(l.K).normalize()).normalize();
  sb.add(g, (p, n, i) => {
    const u = us[Math.min(ringOf[i], us.length - 1)];
    const boot = u > 1.48;
    let color = boot ? C.boots : C.trousers;
    // Fabric bunches behind the knee and over the boot tops.
    if (!boot) color = scale3(color, 0.93 + 0.04 * Math.sin(u * 37 + p.y * 31) + 0.03 * Math.sin(u * 83 - p.x * 57));
    if (boot && u < 1.52) color = C.sole;
    const back = Math.exp(-Math.pow((u - 1) / 0.1, 2)) * smooth(0.0, 0.7, n.dot(inside));
    const ao = (0.72 + 0.28 * smooth(-0.6, 0.1, u)) * (1 - 0.4 * back) * (boot && u < 1.56 ? 0.85 : 1);
    const wHips = 1 - smooth(-0.5, 0.15, u);
    const wShin = smooth(0.85, 1.12, u);
    const wFoot = smooth(1.9, 2.02, u);
    return {
      color,
      surface: boot ? SURFACE.leather : SURFACE.cloth,
      ao,
      bones: [
        [B.hips, wHips],
        [B['thigh' + s], (1 - wHips) * (1 - wShin)],
        [B['shin' + s], wShin * (1 - wFoot)],
        [B['foot' + s], wShin * wFoot],
      ],
    };
  });
}

// Boot foot in the foot bone's frame (ankle at origin, toes towards -z).
function buildBoot(sb, frames, side) {
  const s = LETTER[side];
  const rows = [
    // -z, half width, top, bottom
    [-0.07, 0.036, 0.0, -0.068],
    [-0.045, 0.046, 0.032, -0.076],
    [0.0, 0.049, 0.036, -0.078],
    [0.06, 0.05, 0.0, -0.078],
    [0.12, 0.052, -0.024, -0.078],
    [0.17, 0.048, -0.038, -0.078],
    [0.205, 0.037, -0.048, -0.076],
    [0.226, 0.014, -0.058, -0.071],
  ];
  const zs = [];
  for (let z = 0.07; z >= -0.226; z -= 0.01) zs.push(z);
  zs.push(-0.226);
  const centers = zs.map((z) => {
    const [, top, bot] = table(rows, -z);
    return new Vector3(0, (top + bot) / 2, z);
  });
  const fr = centers.map(() => ({ n: new Vector3(1, 0, 0), b: new Vector3(0, 1, 0) }));
  const g = loft(
    centers,
    fr,
    (i, ang) => {
      const [w, top, bot] = table(rows, -zs[i]);
      const h = (top - bot) / 2;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const e = sn < 0 ? 0.5 : 0.85; // flat sole, rounded upper
      // Welt: the sole sticks out a few millimetres round the upper.
      const welt = sn < -0.55 ? 0.004 : 0;
      return [(w + welt) * Math.sign(c) * Math.pow(Math.abs(c), e), h * Math.sign(sn) * Math.pow(Math.abs(sn), e)];
    },
    22,
  );
  const { ringOf } = g.userData;
  const frame = frames['foot' + s];
  const inv = frame.q.clone().invert();
  g.applyMatrix4(new Matrix4().compose(frame.p, frame.q, new Vector3(1, 1, 1)));
  sb.add(g, (p, n, i) => {
    const z = zs[Math.min(ringOf[i], zs.length - 1)];
    const local = p.clone().sub(frame.p).applyQuaternion(inv);
    let color = C.boots;
    let ao = 1;
    if (local.y < -0.062) {
      color = C.sole;
      ao = 0.55;
    } else if (z < 0.02 && z > -0.12 && Math.abs(local.x) < 0.022 && local.y > -0.02) {
      // Laces criss-crossing the tongue.
      const zig = Math.abs(((((-z * 45) % 1) + 1) % 1) * 2 - 1);
      if (Math.abs(Math.abs(local.x) - zig * 0.018) < 0.0035) color = C.laces;
      else ao = 0.8;
    } else if (z < -0.15) {
      // Scuffed toe cap.
      color = scale3(C.boots, 1.35);
    }
    return { color, surface: SURFACE.leather, ao, bones: [[B['foot' + s], 1]] };
  });
}

// A fist closed round a bar, in the hand bone's frame: wrist at the origin,
// fingers along +y, back of the hand towards +z, the bar along x at GRIP.
function buildHand(sb, frames, side) {
  const s = LETTER[side];
  const frame = frames['hand' + s];
  const m = new Matrix4().compose(frame.p, frame.q, new Vector3(1, 1, 1));
  const ts = -side; // thumb side: -x on the right hand, +x on the left
  const C0 = new Vector3(0, GRIP.y, GRIP.z);
  const parts = [];

  // Palm and back of the hand, wrist to knuckles.
  const rows = [
    // y, half width, back, front, squareness
    [-0.012, 0.027, 0.013, -0.011, 2.2],
    [0.015, 0.032, 0.015, -0.013, 2.6],
    [0.045, 0.038, 0.016, -0.014, 3.0],
    [0.072, 0.041, 0.015, -0.013, 3.2],
    [0.088, 0.04, 0.012, -0.009, 2.8],
    [0.098, 0.034, 0.007, -0.004, 2.4],
  ];
  const ys = [];
  for (let y = -0.012; y <= 0.0981; y += 0.01) ys.push(y);
  ys.push(0.098);
  const centers = ys.map((y) => {
    const [, back, front] = table(rows, y);
    return new Vector3(0, y, (back + front) / 2);
  });
  parts.push(
    loft(
      centers,
      centers.map(() => ({ n: new Vector3(1, 0, 0), b: new Vector3(0, 0, 1) })),
      (i, ang) => {
        const [w, back, front, sq] = table(rows, ys[i]);
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const e = 2 / sq;
        // The little-finger edge of the palm is lower than the index side.
        const slant = (ys[i] / 0.1) * 0.006 * (c * -ts);
        return [w * Math.sign(c) * Math.pow(Math.abs(c), e), ((back - front) / 2) * Math.sign(sn) * Math.pow(Math.abs(sn), e) + slant];
      },
      16,
    ),
  );
  // Thenar and hypothenar pads on the palm.
  parts.push(blob(0.017, 0.026, 0.012, new Vector3(ts * 0.02, 0.032, -0.012)));
  parts.push(blob(0.013, 0.028, 0.009, new Vector3(-ts * 0.026, 0.038, -0.01)));

  // Fingers: index to little, wrapped round the bar.
  const R = GRIP.radius + 0.0115;
  const fingers = [
    // across, knuckle y, proximal, middle, distal, radius
    [0.027, 0.091, 0.042, 0.026, 0.02, 0.0094],
    [0.008, 0.094, 0.046, 0.029, 0.021, 0.0098],
    [-0.011, 0.09, 0.043, 0.027, 0.02, 0.0092],
    [-0.028, 0.082, 0.035, 0.021, 0.018, 0.0082],
  ];
  const onCircle = (theta) => new Vector3(0, C0.y + R * Math.cos(theta), C0.z + R * Math.sin(theta));
  for (const [ax, ky, l1, l2, l3, r] of fingers) {
    const x = ts * ax;
    const M = new Vector3(x, ky, 0.002);
    // PIP on the circle a proximal phalanx away from the knuckle, then the
    // middle and distal phalanges as chords further round.
    const dy = M.y - C0.y;
    const dz = M.z - C0.z;
    const D = Math.hypot(dy, dz);
    const thM = Math.atan2(dz, dy);
    const th1 = thM - Math.acos(Math.min(Math.max((R * R + D * D - l1 * l1) / (2 * R * D), -1), 1));
    const th2 = th1 - 2 * Math.asin(Math.min(l2 / (2 * R), 1));
    const th3 = th2 - 2 * Math.asin(Math.min(l3 / (2 * R), 1)) * 0.95;
    const joints = [M.clone().add(new Vector3(0, -0.012, 0.0)), M, onCircle(th1), onCircle(th2), onCircle(th3)];
    for (const p of joints.slice(2)) p.x = x;
    const path = roundedPath(joints, 0.006, 4);
    parts.push(
      capsule(path, (t) => r * (1.08 - 0.22 * t) * (1 + 0.06 * Math.exp(-Math.pow((t - 0.55) / 0.06, 2))), 0.0045, 10, new Vector3(1, 0, 0)),
    );
  }
  // Thumb: from the base of the palm round the outside of the fingers.
  const thumb = [
    new Vector3(ts * 0.016, 0.006, -0.002),
    new Vector3(ts * 0.036, 0.03, -0.016),
    new Vector3(ts * 0.044, 0.05, -0.036),
    new Vector3(ts * 0.032, 0.064, -0.066),
    new Vector3(ts * 0.012, 0.07, -0.08),
  ];
  parts.push(capsule(roundedPath(thumb, 0.008, 4), (t) => 0.0128 - 0.004 * t, 0.0045, 10, new Vector3(0, 1, 0)));

  const out = new Vector3();
  for (const g of parts) {
    const local = g.attributes.position;
    // Cavity shading from the rest-frame geometry before it is moved.
    const aos = [];
    const nrm = g.attributes.normal;
    for (let i = 0; i < local.count; i++) {
      out.set(0, local.getY(i) - C0.y, local.getZ(i) - C0.z);
      const facing = out.lengthSq() > 1e-8 ? -(nrm.getY(i) * out.y + nrm.getZ(i) * out.z) / out.length() : 0;
      aos.push(0.92 - 0.3 * smooth(0.1, 0.8, facing) * smooth(0.06, 0.03, out.length()));
    }
    g.applyMatrix4(m);
    sb.add(g, (p, n, i) => ({ color: C.skin, surface: SURFACE.skin, ao: aos[i], bones: [[B['hand' + s], 1]] }));
  }
}

// Head, face, hair and hat in the head bone's frame (neck top at origin).
const HEAD_SCALE = new Vector3(0.078, 0.112, 0.098); // half width, height, depth
const HEAD_CENTRE = new Vector3(0, 0.106, -0.006);
const g2 = (ax, ay, sx, sy, x, y) => Math.exp(-(Math.pow((Math.abs(x) - ax) / sx, 2) + Math.pow((y - ay) / sy, 2)));

// Beard coverage in unit-head coordinates (short, trimmed, with a moustache).
function beardMask(x, y, z0) {
  const ax = Math.abs(x);
  const line = -0.2 - 0.12 * (1 - Math.min(ax / 0.95, 1)); // cheek line
  let m = smooth(line + 0.06, line - 0.04, y) * smooth(0.25, -0.05, z0);
  // Moustache over the upper lip.
  m = Math.max(m, smooth(0.34, 0.24, ax) * smooth(-0.43, -0.38, y) * smooth(-0.24, -0.3, y) * smooth(0.3, 0.6, -z0));
  // Lips stay clear; the beard thins out under the jaw.
  m *= smooth(0.7, 1.0, Math.hypot(ax / 0.2, (y + 0.5) / 0.06));
  m *= 1 - smooth(-0.86, -0.98, y) * smooth(-0.2, 0.3, z0);
  return m;
}

// Hair below the hat: the back of the head down to the nape, temples, sideburns.
function hairMask(x, y, z0) {
  const ax = Math.abs(x);
  const back = smooth(-0.1, 0.15, z0) * smooth(-0.64 + 0.1 * smooth(0.2, 0.8, Math.abs(x)), -0.5, y);
  const top = smooth(0.4 + 0.25 * ax, 0.52 + 0.25 * ax, y);
  const temple = smooth(0.72, 0.82, ax) * smooth(0.1, 0.22, y) * smooth(-0.55, -0.42, z0);
  const sideburn = smooth(0.8, 0.88, ax) * smooth(-0.46, -0.38, z0) * smooth(-0.06, -0.16, z0) * smooth(0.3, 0.2, y);
  // A rounded patch of bare skin round the ear.
  const ear = smooth(0.62, 0.78, ax) * smooth(1.0, 0.8, Math.hypot((z0 - 0.05) / 0.27, (y + 0.08) / 0.36));
  return Math.max(back, top, temple, sideburn) * (1 - ear);
}

function sculptHead(u) {
  const z0 = u.z;
  let { x, y, z } = u;
  const wF = smooth(0.3, 0.8, -z0); // face
  // Jaw narrower than the cranium; a flatter face; tucked nape, rounded occiput.
  const lower = smooth(0.1, -1.0, y);
  x *= 1 - 0.2 * lower * lower;
  if (z < -0.5) z = -0.5 - (-z - 0.5) * 0.7;
  if (z > 0) z *= 1 + 0.08 * smooth(-0.2, 0.4, y) - 0.25 * smooth(-0.3, -0.9, y);
  // Brow ridge, eye sockets, cheekbones, the hollow beneath them.
  z -= 0.06 * g2(0.27, 0.37, 0.32, 0.08, x, y) * wF;
  z += 0.1 * g2(0.36, 0.19, 0.17, 0.1, x, y) * wF;
  z -= 0.05 * g2(0.5, -0.02, 0.18, 0.1, x, y) * wF;
  x *= 1 + 0.05 * Math.exp(-Math.pow(y / 0.16, 2)) * smooth(0.0, 0.5, -z0);
  z += 0.03 * g2(0.46, -0.3, 0.12, 0.12, x, y) * wF;
  // Mouth: muzzle, lips and the line between them; then the chin.
  z -= 0.05 * g2(0.0, -0.45, 0.32, 0.16, x, y) * wF;
  z -= 0.022 * g2(0.0, -0.42, 0.2, 0.04, x, y) * wF;
  z -= 0.018 * g2(0.0, -0.53, 0.17, 0.04, x, y) * wF;
  z += 0.012 * g2(0.0, -0.475, 0.21, 0.014, x, y) * wF;
  z -= 0.07 * g2(0.0, -0.8, 0.24, 0.12, x, y) * wF;
  // Square jaw angle below the ears, slightly narrower temples.
  x += Math.sign(x) * 0.06 * Math.exp(-Math.pow((y + 0.6) / 0.16, 2)) * Math.exp(-Math.pow(z0 / 0.45, 2));
  x *= 1 - 0.04 * Math.exp(-Math.pow((y - 0.35) / 0.15, 2)) * smooth(0.0, 0.5, -z0);
  // Beard and hair volume.
  const b = beardMask(u.x, u.y, z0);
  const hm = hairMask(u.x, u.y, z0);
  const k = 1 + 0.04 * b + 0.05 * hm;
  return { x: x * k, y: y * (1 + 0.02 * b + 0.03 * hm), z: z * k, beard: b, hair: hm };
}

function buildHead(sb, frames) {
  const frame = frames.head;
  // Built at 1.04 scale: a touch more presence under the hat.
  const m = new Matrix4().compose(frame.p, frame.q, new Vector3(1.04, 1.04, 1.04));
  const inv = frame.q.clone().invert();
  const centre = HEAD_CENTRE;
  const add = (g, attr) => {
    g.applyMatrix4(m);
    sb.add(g, (p, n, i) => ({ bones: [[B.head, 1]], ...attr(p, n, i) }));
  };
  const toLocal = (p) => p.clone().sub(frame.p).applyQuaternion(inv).divideScalar(1.04).sub(centre);
  const nLocal = (n) => n.clone().applyQuaternion(inv);

  // Skull and face, sculpted from a sphere.
  const skull = new SphereGeometry(1, 112, 84);
  const pos = skull.attributes.position;
  const u = new Vector3();
  const beard = [];
  const hairAt = [];
  const unit = [];
  for (let i = 0; i < pos.count; i++) {
    u.fromBufferAttribute(pos, i);
    unit.push(u.clone());
    const h = sculptHead(u);
    beard.push(h.beard);
    hairAt.push(h.hair);
    pos.setXYZ(i, h.x * HEAD_SCALE.x + centre.x, h.y * HEAD_SCALE.y + centre.y, h.z * HEAD_SCALE.z + centre.z);
  }
  skull.computeVertexNormals();
  add(skull, (p, n, i) => {
    const d = unit[i];
    const ax = Math.abs(d.x);
    let color = C.skin;
    // Warmer cheeks, nose and ears; lips.
    color = mix3(color, C.flush, 0.35 * g2(0.4, -0.12, 0.18, 0.15, d.x, d.y) * smooth(0.3, 0.8, -d.z));
    const lips = smooth(1.0, 0.6, Math.hypot(ax / 0.21, (d.y + 0.48) / 0.065)) * smooth(0.6, 0.8, -d.z);
    color = mix3(color, C.lips, lips);
    // Beard, with a soft edge, and hair at the temples and nape.
    color = mix3(color, C.beard, smooth(0.1, 0.7, beard[i]));
    color = mix3(color, C.hair, smooth(0.15, 0.75, hairAt[i]));
    // Eye sockets and the shadow under the brow; darker under the jaw.
    const socket = g2(0.38, 0.2, 0.2, 0.12, d.x, d.y) * smooth(0.4, 0.8, -d.z);
    const ao = (0.8 + 0.2 * smooth(-0.95, -0.6, d.y)) * (1 - 0.4 * socket);
    return { color, surface: SURFACE.skin, ao };
  });

  // Nose: down the bridge to the tip, then back under it to the lip.
  const np = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    np.push(new Vector3(0, 0.026 - 0.044 * t, -0.088 - 0.021 * Math.pow(Math.sin(t * 1.5), 1.4)));
  }
  np.push(new Vector3(0, -0.0225, -0.1075), new Vector3(0, -0.0255, -0.103), new Vector3(0, -0.027, -0.097));
  for (const p of np) p.add(centre);
  const nose = loft(
    np,
    pathFrames(np, new Vector3(1, 0, 0)),
    (i, ang) => {
      const t = Math.min(i / 10, 1);
      const tail = Math.max(0, i - 10) / 3;
      const w = (0.0076 + 0.0052 * t * t) * (1 - 0.35 * tail);
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      return [c * w, (sn < 0 ? sn * 0.011 : sn * 0.007) * (0.55 + 0.6 * t) * (1 - 0.4 * tail)];
    },
    16,
    { capStart: true, capEnd: true },
  );
  add(nose, () => ({ color: mix3(C.skin, C.flush, 0.25), surface: SURFACE.skin, ao: 0.97 }));
  for (const sx of [-1, 1]) {
    add(blob(0.0066, 0.0054, 0.0072, new Vector3(sx * 0.0115, -0.019, -0.0935).add(centre), 12, 8), (p, n) => ({
      color: mix3(C.skin, C.flush, 0.3),
      surface: SURFACE.skin,
      ao: nLocal(n).y < -0.4 ? 0.6 : 0.9,
    }));

    // Eyes set back into the sockets, under heavy lids.
    const eyeAt = new Vector3(sx * 0.031, 0.021, -0.0715).add(centre);
    add(blob(0.0115, 0.0115, 0.0115, eyeAt, 18, 14), (p, n) => {
      const f = -nLocal(n).z;
      const color = f > 0.965 ? C.pupil : f > 0.86 ? C.iris : C.eyeWhite;
      return { color, surface: SURFACE.eye, ao: 0.7 };
    });
    const lid = new SphereGeometry(1, 18, 6, 0, Math.PI * 2, 0, Math.PI * 0.4);
    lid.scale(0.0125, 0.0125, 0.0125);
    lid.translate(eyeAt.x, eyeAt.y + 0.0006, eyeAt.z);
    add(lid, () => ({ color: C.skinShade, surface: SURFACE.skin, ao: 0.78 }));
    const lower = new SphereGeometry(1, 18, 4, 0, Math.PI * 2, Math.PI * 0.68, Math.PI * 0.32);
    lower.scale(0.0122, 0.0122, 0.0122);
    lower.rotateX(0.18);
    lower.translate(eyeAt.x, eyeAt.y, eyeAt.z);
    add(lower, () => ({ color: C.skinShade, surface: SURFACE.skin, ao: 0.85 }));

    // Brow.
    const bp = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      bp.push(new Vector3(sx * (0.011 + 0.036 * t), 0.038 + 0.005 * Math.sin(t * 3) - 0.004 * t, -0.093 + 0.022 * t * t).add(centre));
    }
    const brow = loft(bp, pathFrames(bp, new Vector3(0, 1, 0)), (i, ang) => {
      const w = 1 - 0.55 * Math.pow(i / 6, 2);
      return [Math.cos(ang) * 0.0048 * w, Math.sin(ang) * 0.0032 * w];
    }, 8);
    add(brow, () => ({ color: C.brow, surface: SURFACE.hair, ao: 0.9 }));

    // Ear: the auricle standing out a little at the back, a rolled rim and
    // the darker bowl inside.
    const earAt = new Vector3(sx * 0.074, 0.0, 0.009).add(centre);
    const auricle = new SphereGeometry(1, 14, 12);
    auricle.scale(0.006, 0.029, 0.017);
    auricle.rotateY(sx * 0.35);
    auricle.rotateX(0.2);
    auricle.translate(earAt.x + sx * 0.003, earAt.y, earAt.z + 0.006);
    add(auricle, (p, n) => ({ color: mix3(C.skin, C.flush, 0.15), surface: SURFACE.skin, ao: nLocal(n).x * sx < 0 ? 0.7 : 0.92 }));
    const flare = (dz) => sx * (0.005 + 0.3 * Math.max(dz, 0));
    const helix = [
      [-0.003, 0.012],
      [0.0, 0.024],
      [0.009, 0.03],
      [0.018, 0.024],
      [0.021, 0.01],
      [0.018, -0.008],
      [0.011, -0.02],
      [0.005, -0.027],
    ].map(([dz, dy]) => earAt.clone().add(new Vector3(flare(dz), dy, dz)));
    add(capsule(roundedPath(helix, 0.006, 4), (t) => 0.003 + 0.002 * smooth(0.7, 1.0, t), 0.003, 8, new Vector3(sx, 0, 0)), (p, n) => ({
      color: mix3(C.skin, C.flush, 0.15),
      surface: SURFACE.skin,
      ao: nLocal(n).x * sx < 0 ? 0.75 : 0.95,
    }));
    const concha = blob(0.004, 0.014, 0.009, earAt.clone().add(new Vector3(sx * 0.0085, -0.003, 0.007)), 10, 8);
    add(concha, () => ({ color: C.skinShade, surface: SURFACE.skin, ao: 0.55 }));
  }

  // Fedora: crown with a centre crease and front pinches, band, brim.
  const crownRows = [
    // from the top (t = 0) to the band (t = 1): radius, height
    [0.0, 0.29],
    [0.04, 0.288],
    [0.075, 0.281],
    [0.092, 0.268],
    [0.099, 0.24],
    [0.101, 0.2],
    [0.097, 0.168],
  ];
  const crown = new SphereGeometry(1, 56, 18, 0, Math.PI * 2, 0, Math.PI / 2);
  const cp = crown.attributes.position;
  const rowsT = crownRows.map((r, k) => [k / (crownRows.length - 1), r[0], r[1]]);
  for (let i = 0; i < cp.count; i++) {
    u.fromBufferAttribute(cp, i);
    const ang = Math.atan2(u.z, u.x);
    const [r0, y0] = table(rowsT, 1 - u.y);
    const onAxis = Math.hypot(u.x, u.z) < 1e-6;
    let x = onAxis ? 0 : Math.cos(ang) * r0;
    let z = onAxis ? 0 : Math.sin(ang) * r0 * 1.12;
    let y = y0;
    // Centre crease front to back, deepest towards the front.
    const crease = Math.exp(-Math.pow(x / 0.03, 2)) * smooth(0.098, 0.06, r0) * (0.8 - 0.2 * (z / 0.11));
    y -= 0.022 * crease;
    // Pinches either side of the front.
    const pinch = (Math.sin(ang) < 0 ? Math.exp(-Math.pow((Math.abs(Math.cos(ang)) - 0.55) / 0.2, 2)) : 0) * smooth(0.235, 0.28, y0) * 0.014;
    x -= Math.cos(ang) * pinch;
    z -= Math.sin(ang) * pinch;
    cp.setXYZ(i, x, y, z);
  }
  crown.computeVertexNormals();
  add(crown, (p) => {
    const l = toLocal(p).add(centre);
    const band = l.y < 0.194;
    // Felt darkened by sweat and rain just above the band.
    const color = band ? C.hatBand : mix3(C.hat, scale3(C.hat, 0.72), smooth(0.215, 0.195, l.y));
    return { color, surface: band ? SURFACE.leather : SURFACE.cloth, ao: band ? 0.9 : 1 };
  });
  add(buildBrim(), (p, n) => {
    const l = toLocal(p).add(centre);
    const r = Math.hypot(l.x, l.z / 1.12);
    // Bound edge and a worn underside.
    const color = r > 0.184 ? scale3(C.hat, 0.6) : C.hat;
    return { color, surface: SURFACE.cloth, ao: nLocal(n).y < -0.5 ? 0.55 : 1 };
  });
}

function buildBrim() {
  const seg = 64;
  const rings = 8;
  const pos = [];
  const idx = [];
  const ringR = (k) => 0.094 + (k / rings) * 0.098;
  const point = (k, a, top) => {
    const r = ringR(k);
    const t = k / rings;
    const side = Math.pow(Math.abs(Math.cos(a)), 2);
    // Curled up at the sides, snapped down a touch at the front.
    const lift = 0.036 * t * t * side - 0.012 * t * t * Math.max(0, -Math.sin(a)) * (1 - side);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 1.12;
    return [x, 0.169 + lift + (top ? 0.004 : -0.002), z];
  };
  for (const top of [true, false]) {
    const base = pos.length / 3;
    for (let k = 0; k <= rings; k++) {
      for (let j = 0; j < seg; j++) pos.push(...point(k, (j / seg) * Math.PI * 2, top));
    }
    for (let k = 0; k < rings; k++) {
      for (let j = 0; j < seg; j++) {
        const a = base + k * seg + j;
        const b = base + k * seg + ((j + 1) % seg);
        const c = base + (k + 1) * seg + ((j + 1) % seg);
        const d = base + (k + 1) * seg + j;
        if (top) idx.push(a, d, c, a, c, b);
        else idx.push(a, b, c, a, c, d);
      }
    }
  }
  // Outer edge.
  const topOuter = rings * seg;
  const botOuter = (rings + 1) * seg + rings * seg;
  for (let j = 0; j < seg; j++) {
    const a = topOuter + j;
    const b = topOuter + ((j + 1) % seg);
    const c = botOuter + ((j + 1) % seg);
    const d = botOuter + j;
    idx.push(a, b, c, a, c, d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Belt buckle, a canvas satchel on the right hip, collar and neckerchief knot.
function buildKit(sb, rest) {
  const P = rest.joints.pelvis;
  const buckle = new TorusGeometry(1, 0.28, 6, 16);
  buckle.scale(0.022, 0.017, 0.012);
  buckle.translate(0, P.y + 0.022, P.z - 0.113);
  sb.add(buckle, () => ({ color: C.brass, surface: SURFACE.metal, ao: 1, bones: [[B.hips, 1]] }));
  const bag = new SphereGeometry(1, 20, 12);
  const bp = bag.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    // A soft box: superellipse-ish squaring of a sphere.
    const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.5);
    bp.setXYZ(i, sq(bp.getX(i)) * 0.075, sq(bp.getY(i)) * 0.06, sq(bp.getZ(i)) * 0.03);
  }
  bag.computeVertexNormals();
  bag.rotateY(-0.5);
  bag.translate(0.17, P.y + 0.03, P.z + 0.11);
  sb.add(bag, (p) => {
    const flap = p.y > P.y + 0.045;
    return {
      color: flap ? C.strap : C.canvas,
      surface: flap ? SURFACE.leather : SURFACE.cloth,
      ao: p.y < P.y - 0.01 ? 0.7 : 0.9,
      bones: [[B.hips, 1]],
    };
  });
  // Shirt collar points.
  for (const sx of [-1, 1]) {
    const c = new SphereGeometry(1, 10, 6);
    c.scale(0.032, 0.006, 0.022);
    c.rotateZ(sx * 0.5);
    c.rotateY(sx * 0.4);
    c.translate(sx * 0.042, rest.joints.neck.y - 0.012, rest.joints.neck.z - 0.055);
    sb.add(c, () => ({ color: C.shirt, surface: SURFACE.cloth, ao: 0.95, bones: [[B.chest, 1]] }));
  }
  // Neckerchief knot.
  const knot = blob(0.022, 0.019, 0.013, new Vector3(0, rest.joints.neck.y + 0.012, rest.joints.neck.z - 0.06), 12, 8);
  sb.add(knot, () => ({ color: C.scarf, surface: SURFACE.cloth, ao: 0.9, bones: [[B.neck, 1]] }));
}

// --- assembly -------------------------------------------------------------------

export function createCharacterModel(material) {
  const rest = restPose();
  const frames = boneFrames(rest, {}, makeFrames());
  const sb = new SkinBuilder();
  const hips = buildTorso(sb, rest);
  buildNeck(sb, rest, frames);
  for (const side of SIDES) {
    buildArm(sb, rest, side);
    buildLeg(sb, rest, side);
    buildBoot(sb, frames, side);
    buildHand(sb, frames, side);
  }
  buildHead(sb, frames);
  buildKit(sb, rest);
  const geometry = sb.build();

  // Bones in the rest pose: local transforms relative to each parent.
  const bones = {};
  for (const name of BONES) {
    bones[name] = new Bone();
    bones[name].name = name;
  }
  const inv = new Quaternion();
  for (const name of BONES) {
    const f = frames[name];
    const parent = BONE_PARENT[name];
    if (parent) {
      const pf = frames[parent];
      inv.copy(pf.q).invert();
      bones[name].position.copy(f.p).sub(pf.p).applyQuaternion(inv);
      bones[name].quaternion.copy(inv).multiply(f.q);
      bones[parent].add(bones[name]);
    } else {
      bones[name].position.copy(f.p);
      bones[name].quaternion.copy(f.q);
    }
  }
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'Paddler';
  mesh.frustumCulled = false;
  mesh.add(bones.hips);
  mesh.bind(new Skeleton(BONES.map((n) => bones[n])));
  return { mesh, bones, rest, torso: { y: hips.y, z: hips.z + 0.008 } };
}

// Writes a pose into the bones as local transforms.
const _inv = new Quaternion();
export function applyFrames(bones, frames) {
  for (const name of BONES) {
    const f = frames[name];
    const bone = bones[name];
    const parent = BONE_PARENT[name];
    if (parent) {
      const pf = frames[parent];
      _inv.copy(pf.q).invert();
      bone.position.copy(f.p).sub(pf.p).applyQuaternion(_inv);
      bone.quaternion.copy(_inv).multiply(f.q);
    } else {
      bone.position.copy(f.p);
      bone.quaternion.copy(f.q);
    }
  }
}
