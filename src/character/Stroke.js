import { Vector3 } from 'three';
import { PADDLE, SEAT } from './body.js';

// Paddle choreography. Keyframes describe the starboard (+x) stroke in the
// boat frame; port strokes mirror x. 'h' is the lower hand on the shaft (it
// rides just outside the gunwale), 'd' points down the shaft towards the
// blade, z values are relative to the seat. The top hand stays out in front
// of the chest so the far arm never has to pass through the body, and the
// paddler slides a little towards the working side ('shift').
//   0.00 catch . 0.12 planted . 0.32 mid-pull . 0.50 exit . 0.60 lift
//   0.80 recovery . 0.92 reach (blade poised above the water) . 1.00 catch
const KEYS = [
  { t: 0.0, h: [0.755, 0.534, -0.439], d: [0.558, -0.819, -0.132], yaw: 0.3, lean: 0.27, roll: 0.2, shift: 0.1, feather: 0.12 },
  { t: 0.12, h: [0.78, 0.497, -0.363], d: [0.55, -0.834, -0.038], yaw: 0.22, lean: 0.2, roll: 0.22, shift: 0.1, feather: 0 },
  { t: 0.32, h: [0.798, 0.466, -0.177], d: [0.529, -0.814, 0.239], yaw: 0.02, lean: 0.12, roll: 0.22, shift: 0.1, feather: 0 },
  { t: 0.5, h: [0.783, 0.449, 0.031], d: [0.539, -0.689, 0.485], yaw: -0.16, lean: 0.06, roll: 0.18, shift: 0.1, feather: 0.1 },
  { t: 0.6, h: [0.782, 0.668, 0.061], d: [0.604, -0.619, 0.502], yaw: -0.1, lean: 0.08, roll: 0.12, shift: 0.1, feather: 0.8 },
  { t: 0.8, h: [0.715, 0.654, -0.414], d: [0.775, -0.629, 0.06], yaw: 0.18, lean: 0.18, roll: 0.14, shift: 0.1, feather: 1 },
  { t: 0.92, h: [0.67, 0.617, -0.532], d: [0.75, -0.66, -0.053], yaw: 0.29, lean: 0.26, roll: 0.18, shift: 0.1, feather: 0.4 },
];

// Paddle lifted and carried forward over the bow while the hands swap.
const SWITCH_MID = { h: [0, 0.84, -0.8], d: [0, -0.06, -1], yaw: 0, lean: 0.36, roll: 0, shift: 0, feather: 1 };

// Resting across the knees, blade out over the gunwale on the working side.
const REST = { h: [0.3, 0.5, -0.42], d: [1, 0.0, -0.06], yaw: 0, lean: 0.06, roll: 0, shift: 0, feather: 1 };

const SCALARS = ['yaw', 'lean', 'roll', 'shift', 'feather'];

const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

const smooth = (t) => t * t * (3 - 2 * t);

// Samples the looping keyframe track at phase t for a stroke on 'side'.
function sampleCycle(t, side, out) {
  const n = KEYS.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? KEYS[k + 1].t : 1;
    if (t >= KEYS[k].t && t < next) {
      i = k;
      break;
    }
  }
  const k0 = KEYS[(i - 1 + n) % n];
  const k1 = KEYS[i];
  const k2 = KEYS[(i + 1) % n];
  const k3 = KEYS[(i + 2) % n];
  const t1 = k1.t;
  const t2 = i + 1 < n ? k2.t : 1;
  const u = (t - t1) / (t2 - t1);
  for (let c = 0; c < 3; c++) {
    out.h[c] = catmull(k0.h[c], k1.h[c], k2.h[c], k3.h[c], u);
    out.d[c] = catmull(k0.d[c], k1.d[c], k2.d[c], k3.d[c], u);
  }
  for (const key of SCALARS) out[key] = catmull(k0[key], k1[key], k2[key], k3[key], u);
  mirror(out, side);
  return out;
}

function mirror(pose, side) {
  pose.h[0] *= side;
  pose.d[0] *= side;
  pose.yaw *= side;
  pose.roll *= side;
  pose.shift *= side;
}

function copyPose(src, side, out) {
  out.h = [...src.h];
  out.d = [...src.d];
  out.yaw = src.yaw;
  out.lean = src.lean;
  out.roll = src.roll;
  out.shift = src.shift;
  out.feather = src.feather;
  mirror(out, side);
  return out;
}

function lerpPose(a, b, t, out) {
  for (let c = 0; c < 3; c++) {
    out.h[c] = a.h[c] + (b.h[c] - a.h[c]) * t;
    out.d[c] = a.d[c] + (b.d[c] - a.d[c]) * t;
  }
  for (const key of SCALARS) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

const newPose = () => ({ h: [0, 0, 0], d: [0, -1, 0], yaw: 0, lean: 0, roll: 0, shift: 0, feather: 0 });

export class Stroke {
  constructor() {
    this.state = 'rest'; // rest | stroke | switch
    this.phase = 0.8;
    this.direction = 1; // +1 forward strokes, -1 back strokes (cycle runs backwards)
    this.side = 1; // +1 starboard, -1 port
    this.active = 0; // 0 = resting pose, 1 = stroking
    this.cadence = 0.8;
    this.strokesOnSide = 0;
    this.switchT = 0;
    this.switchFrom = 1;
    this.switchTo = 1;
    this.lowerHand = 1; // +1: right hand is the lower hand on the shaft

    // Outputs (boat frame).
    this.grip = new Vector3();
    this.lower = new Vector3(); // point on the shaft held by the lower hand
    this.handL = new Vector3();
    this.handR = new Vector3();
    this.dir = new Vector3(0, -1, 0); // grip -> blade
    this.blade = new Vector3();
    this.bladeNormal = new Vector3(0, 0, 1);
    this.torso = { yaw: 0, lean: 0, roll: 0, shift: 0 };
    this.force = 0; // forward push on the boat (m/s^2)
    this.torque = 0; // yaw acceleration (rad/s^2)
    this.submerged = 0;
    this.events = [];

    this._cycle = newPose();
    this._from = newPose();
    this._to = newPose();
    this._mid = newPose();
    this._rest = newPose();
    this._pose = newPose();
    this._power = new Vector3();
    this._feather = new Vector3();
    this._prevBlade = new Vector3();
    this._bladeVel = new Vector3();
    this._first = true;
  }

  // Phase where a stroke re-enters the cycle after resting or switching.
  entryPhase() {
    return this.direction > 0 ? 0.8 : 0.66;
  }

  bladeIsOut() {
    return this.direction > 0 ? this.phase >= 0.6 || this.phase < 0.01 : this.phase >= 0.62;
  }

  // throttle/steer in [-1, 1]; speed = boat forward speed (m/s).
  update(dt, throttle, steer, speed) {
    this.events.length = 0;
    const turning = Math.abs(steer) > 0.2;
    this.steering = turning;
    // Steering alone: wide sweep strokes that mostly spin the boat.
    this.sweeping = turning && Math.abs(throttle) <= 0.12;
    let want = 0;
    if (throttle > 0.12) want = 1;
    else if (throttle < -0.12) want = -1;
    else if (turning) want = 1;

    // Forward strokes on the right turn the bow left; back strokes reverse it.
    let desiredSide = this.side;
    if (turning) desiredSide = (steer > 0 ? 1 : -1) * (want < 0 ? -1 : 1);
    const effort = want > 0 ? Math.max(Math.abs(throttle), Math.abs(steer) * 0.8) : Math.abs(throttle);

    if (this.state === 'rest') {
      if (want !== 0) {
        this.state = 'stroke';
        this.direction = want;
        this.side = desiredSide;
        this.phase = this.entryPhase();
        this.strokesOnSide = 0;
      }
    } else if (this.state === 'stroke') {
      this.cadence = want < 0 ? 0.58 + 0.16 * effort : 0.5 + 0.35 * effort;
      if (want === 0 || want !== this.direction) {
        // Finish the pull, then rest (or turn around from rest).
        if (this.bladeIsOut()) this.state = 'rest';
      } else {
        this.phase = (this.phase + this.direction * this.cadence * dt + 1) % 1;
        // Change sides while the blade is in the air.
        const straight = !turning && this.direction > 0;
        const wantSwitch = desiredSide !== this.side || (straight && this.strokesOnSide >= 4);
        const window = this.direction > 0 ? this.phase > 0.62 && this.phase < 0.78 : this.phase > 0.68 && this.phase < 0.9;
        if (wantSwitch && window) {
          this.state = 'switch';
          this.switchT = 0;
          this.switchFrom = this.side;
          this.switchTo = straight && desiredSide === this.side ? -this.side : desiredSide;
          this.switchPhase = this.phase;
        }
      }
    } else if (this.state === 'switch') {
      this.switchT += dt / 0.62;
      if (this.switchT >= 1) {
        this.side = this.switchTo;
        this.phase = this.entryPhase();
        this.strokesOnSide = 0;
        this.state = want === 0 ? 'rest' : 'stroke';
        if (want !== 0) this.direction = want;
      }
    }

    const target = this.state === 'rest' ? 0 : 1;
    this.active += (target - this.active) * (1 - Math.exp(-dt * (target ? 4.5 : 2.8)));
    this.solvePose();
    this.measure(dt, speed);
  }

  solvePose() {
    const pose = this._pose;
    let stroke = sampleCycle(this.phase, this.side, this._cycle);
    if (this.state === 'switch') {
      // Old-side lift -> paddle carried forward over the bow -> new-side entry.
      const u = Math.min(this.switchT, 1);
      sampleCycle(this.switchPhase, this.switchFrom, this._from);
      sampleCycle(this.entryPhase(), this.switchTo, this._to);
      copyPose(SWITCH_MID, 1, this._mid);
      if (u < 0.5) lerpPose(this._from, this._mid, smooth(u * 2), pose);
      else lerpPose(this._mid, this._to, smooth(u * 2 - 1), pose);
      stroke = pose;
    }
    copyPose(REST, this.side, this._rest);
    lerpPose(this._rest, stroke, smooth(Math.min(Math.max(this.active, 0), 1)), this._pose);

    const p = this._pose;
    this.dir.set(p.d[0], p.d[1], p.d[2]).normalize();
    this.lower.set(p.h[0], p.h[1], SEAT.z + p.h[2]);
    this.grip.copy(this.lower).addScaledVector(this.dir, -PADDLE.handSpan);
    this.blade.copy(this.grip).addScaledVector(this.dir, PADDLE.gripToBlade);
    this.placeHands();
    this.torso.yaw = p.yaw;
    this.torso.lean = p.lean;
    this.torso.roll = p.roll;
    this.torso.shift = p.shift;
    // Blade face: square to the keel while pulling, feathered on recovery.
    const side = this.state === 'switch' ? this.switchTo : this.side;
    this._power.set(0, 0, 1);
    this._feather.set(side, 0, 0);
    this.bladeNormal.copy(this._power).lerp(this._feather, Math.min(Math.max(p.feather, 0), 1));
    this.bladeNormal.addScaledVector(this.dir, -this.bladeNormal.dot(this.dir)).normalize();
  }

  // Hands: the working-side hand low on the shaft, the other on the grip.
  // During a switch the old lower hand slides up to the grip while the other
  // lets go and re-grips lower down, passing under the shaft.
  placeHands() {
    let lowSide = this.side;
    let right = this.side > 0 ? this.lower : this.grip;
    let left = this.side > 0 ? this.grip : this.lower;
    if (this.state === 'switch') {
      const u = Math.min(this.switchT, 1);
      const up = smooth(Math.min(Math.max((u - 0.12) / 0.5, 0), 1));
      const down = smooth(Math.min(Math.max((u - 0.3) / 0.55, 0), 1));
      const sliding = this._a ?? (this._a = new Vector3());
      const regrip = this._b ?? (this._b = new Vector3());
      sliding.copy(this.grip).addScaledVector(this.dir, PADDLE.handSpan * (1 - up));
      regrip.copy(this.grip).addScaledVector(this.dir, PADDLE.handSpan * down);
      regrip.y -= 0.1 * Math.sin(Math.PI * down);
      lowSide = down > 0.5 ? this.switchTo : this.switchFrom;
      right = this.switchFrom > 0 ? sliding : regrip;
      left = this.switchFrom > 0 ? regrip : sliding;
    }
    this.lowerHand = lowSide;
    this.handR.copy(right);
    this.handL.copy(left);
  }

  // Water reaction on the blade pushes and turns the boat.
  measure(dt, speed) {
    const tipY = this.blade.y + this.dir.y * PADDLE.bladeLength * 0.5;
    const submerged = Math.min(Math.max((-tipY - 0.02) / (PADDLE.bladeLength * 0.6), 0), 1);
    if (this._first) {
      this._prevBlade.copy(this.blade);
      this._first = false;
    }
    this._bladeVel.subVectors(this.blade, this._prevBlade).divideScalar(Math.max(dt, 1e-4));
    this._prevBlade.copy(this.blade);
    // Blade speed through the water along the keel (+z = backwards). The
    // gearing stands in for the leverage of a full-body stroke.
    const rel = this._bladeVel.z * 2.7 - speed;
    const facing = Math.abs(this.bladeNormal.z);
    const push = submerged * facing * rel * Math.abs(rel) * 0.9;
    const gain = this.sweeping ? 0.3 : push < 0 && this.direction < 0 ? 0.45 : 1;
    this.force = Math.max(-4, Math.min(4, push)) * gain;
    const turn = this.sweeping ? 0.42 : this.steering ? 0.3 : 0.08;
    this.torque = Math.max(-4, Math.min(4, push)) * this.blade.x * turn;
    if (submerged > 0.05 && this.submerged <= 0.05) this.events.push('catch');
    if (submerged <= 0.05 && this.submerged > 0.05) {
      this.events.push('release');
      this.strokesOnSide++;
    }
    this.submerged = submerged;
  }
}
