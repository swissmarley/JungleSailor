import { Euler, Quaternion, Vector3 } from 'three';
import { sheerHeight, zAt } from '../world/hullShape.js';

// Body measurements (metres) for a seated adult, and the paddle. Everything is
// expressed in the boat's local frame: bow towards -z, starboard +x, up +y.
export const BODY = {
  hip: 0.095, // hip joint above the seat
  lowerSpine: 0.2,
  chest: 0.27,
  neck: 0.085,
  head: 0.12, // neck top to head centre
  shoulderWidth: 0.185,
  shoulderDrop: 0.05,
  upperArm: 0.29,
  forearm: 0.265,
  grip: 0.07, // wrist to the centre of the closed hand
  hipWidth: 0.095,
  thigh: 0.43,
  shin: 0.44,
  ankle: 0.075,
};

export const PADDLE = {
  length: 1.59,
  gripToBlade: 1.29, // grip centre to blade centre
  bladeLength: 0.5,
  bladeWidth: 0.19,
  handSpan: 0.6, // grip to lower hand along the shaft
};

// The paddler sits on the after thwart.
const SEAT_S = 0.33;
export const SEAT = new Vector3(0, sheerHeight(SEAT_S) - 0.17, zAt(SEAT_S));
export const FLOOR_Y = -0.09;

const _e = new Euler(0, 0, 0, 'YXZ');

// Torso pose -> joint positions. yaw > 0 turns the chest left, lean > 0 bends
// forward, roll > 0 leans towards starboard. The lower spine takes part of
// each rotation so the back curves instead of hinging.
export function torsoJoints(pose, out) {
  const pelvis = out.pelvis.set(SEAT.x + pose.shiftX, SEAT.y + BODY.hip + pose.lift, SEAT.z + 0.02 + pose.shiftZ);
  _e.set(-pose.lean * 0.45, pose.yaw * 0.35, -pose.roll * 0.45);
  out.lowerRot.setFromEuler(_e);
  _e.set(-pose.lean, pose.yaw, -pose.roll);
  out.chestRot.setFromEuler(_e);
  out.chestBase.set(0, BODY.lowerSpine, 0).applyQuaternion(out.lowerRot).add(pelvis);
  out.neck.set(0, BODY.chest, 0).applyQuaternion(out.chestRot).add(out.chestBase);
  out.shoulderL.set(-BODY.shoulderWidth, -BODY.shoulderDrop, 0).applyQuaternion(out.chestRot).add(out.neck);
  out.shoulderR.set(BODY.shoulderWidth, -BODY.shoulderDrop, 0).applyQuaternion(out.chestRot).add(out.neck);
  out.hipL.set(-BODY.hipWidth, -0.02, 0).add(pelvis);
  out.hipR.set(BODY.hipWidth, -0.02, 0).add(pelvis);
  return out;
}

export function makeJoints() {
  return {
    pelvis: new Vector3(),
    chestBase: new Vector3(),
    neck: new Vector3(),
    shoulderL: new Vector3(),
    shoulderR: new Vector3(),
    hipL: new Vector3(),
    hipR: new Vector3(),
    lowerRot: new Quaternion(),
    chestRot: new Quaternion(),
  };
}

const _d = new Vector3();
const _p = new Vector3();

// Two-bone IK: places 'mid' (elbow/knee) so that root->mid->end reaches
// 'target' with segment lengths a and b, bending towards 'pole'. Returns the
// distance the target lies beyond reach (0 when reachable).
export function solveTwoBone(root, target, a, b, pole, mid, end) {
  _d.subVectors(target, root);
  let dist = _d.length();
  const shortfall = Math.max(0, dist - (a + b) * 0.999);
  dist = Math.min(Math.max(dist, Math.abs(a - b) + 1e-3), (a + b) * 0.999);
  _d.normalize();
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(0, -1, 0).addScaledVector(_d, _d.y);
  _p.normalize();
  mid.copy(root).addScaledVector(_d, a * cosA).addScaledVector(_p, a * sinA);
  end.copy(root).addScaledVector(_d, dist);
  return shortfall;
}
