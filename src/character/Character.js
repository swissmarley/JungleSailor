import {
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Shape,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { BODY, FLOOR_Y, PADDLE, SEAT, makeJoints, solveTwoBone, torsoJoints } from './body.js';
import { GARMENT_GLSL, GRIP, SURFACE, applyFrames, boneFrames, createCharacterModel, makeFrames } from './characterModel.js';

const WOOD = [0.3, 0.17, 0.08];
const WOOD_DARK = [0.13, 0.065, 0.03];

// --- paddle -----------------------------------------------------------------

function paint(geometry, colorAt) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = colorAt(pos.getY(i));
    col.set(c, i * 3);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('aSurface', new Float32BufferAttribute(new Float32Array(pos.count).fill(SURFACE.wood), 1));
  g.setAttribute('aAO', new Float32BufferAttribute(new Float32Array(pos.count).fill(1), 1));
  return g;
}

function buildPaddle() {
  // Grip at the origin, shaft down -y, blade face normal along +z.
  const parts = [];
  const grip = new CylinderGeometry(0.02, 0.02, 0.12, 12);
  grip.rotateZ(Math.PI / 2);
  parts.push(paint(grip, () => WOOD_DARK));
  const shaftLength = PADDLE.gripToBlade - PADDLE.bladeLength / 2 + 0.02;
  const shaft = new CylinderGeometry(GRIP.radius - 0.001, GRIP.radius, shaftLength, 12);
  shaft.translate(0, -shaftLength / 2, 0);
  parts.push(paint(shaft, () => WOOD));
  const w = PADDLE.bladeWidth / 2;
  const L = PADDLE.bladeLength;
  const shape = new Shape();
  shape.moveTo(-0.02, 0);
  shape.bezierCurveTo(-w * 0.9, -0.04, -w, -0.12, -w, -0.22);
  shape.lineTo(-w, -L + 0.08);
  shape.quadraticCurveTo(-w, -L, 0, -L);
  shape.quadraticCurveTo(w, -L, w, -L + 0.08);
  shape.lineTo(w, -0.22);
  shape.bezierCurveTo(w, -0.12, w * 0.9, -0.04, 0.02, 0);
  shape.closePath();
  const blade = new ExtrudeGeometry(shape, {
    depth: 0.01,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.004,
    bevelSegments: 1,
    curveSegments: 10,
  });
  blade.translate(0, -(PADDLE.gripToBlade - L / 2), -0.005);
  parts.push(paint(blade, (y) => (y < -(PADDLE.gripToBlade + L / 2 - 0.07) ? WOOD_DARK : WOOD)));
  return mergeGeometries(parts);
}

// --- material ---------------------------------------------------------------

const vertexShader = /* glsl */ `
#include <skinning_pars_vertex>
attribute vec3 color;
attribute float aSurface;
attribute float aAO;
varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vRest;
varying float vSurface;
varying float vAO;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * objectNormal);
  // Rest-pose position: procedural detail stays put on the body as it moves.
  vRest = position;
  vColor = color;
  vSurface = aSurface;
  vAO = aAO;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
${GARMENT_GLSL}
varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vRest;
varying float vSurface;
varying float vAO;

struct Surface {
  vec3 albedo;
  float rough;
  float f0;
  float wrap;
  float sheen;
  float metal;
  float scatter;
};

// Shading parameters by kind; detail noise is low-frequency only, since at
// play distance a centimetre is about a pixel.
Surface surfaceOf(int kind, vec3 albedo, float n1, float n2) {
  float wet = uWetness;
  Surface s = Surface(albedo, 0.8, 0.03, 0.2, 0.0, 0.0, 0.0);
  if (kind == 0) {
    // Skin: soft sheen, light bleeding red through the terminator.
    s.rough = 0.5 - 0.2 * wet;
    s.f0 = 0.028;
    s.wrap = 0.5;
    s.scatter = 1.0;
    s.albedo *= 0.94 + 0.12 * n1;
  } else if (kind == 1) {
    // Cloth: matte, a velvety rim, darker and smoother when soaked.
    s.rough = 0.9 - 0.25 * wet;
    s.f0 = 0.02;
    s.wrap = 0.3;
    s.sheen = 0.5;
    s.albedo *= (0.93 + 0.1 * n1 + 0.06 * (n2 - 0.5)) * (1.0 - 0.38 * wet);
  } else if (kind == 2) {
    // Leather: worn, with a waxy highlight.
    s.rough = 0.5 - 0.1 * n2 - 0.22 * wet;
    s.f0 = 0.04;
    s.wrap = 0.15;
    s.albedo *= (0.85 + 0.25 * n1) * (1.0 - 0.2 * wet);
  } else if (kind == 3) {
    s.rough = 0.3;
    s.metal = 1.0;
    s.wrap = 0.0;
  } else if (kind == 4) {
    s.rough = 0.55;
    s.f0 = 0.04;
    s.wrap = 0.25;
    s.albedo *= 0.85 + 0.3 * n2;
  } else if (kind == 5) {
    s.rough = 0.12;
    s.f0 = 0.03;
    s.wrap = 0.1;
  } else {
    // Wood: grain along the paddle.
    s.rough = 0.55 - 0.2 * wet;
    s.f0 = 0.03;
    s.wrap = 0.1;
    s.albedo *= 0.8 + 0.35 * vnoise(vec2(vRest.x * 60.0 + vRest.z * 40.0, vRest.y * 3.0));
  }
  return s;
}

float ggx(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(cameraPosition - vWorldPos);
  // Derivatives outside any branch.
  vec3 dRest = fwidth(vRest);
  float aa = max(max(dRest.x, dRest.y), dRest.z) + 1e-5;
  float n1 = vnoise(vRest.xy * 38.0 + vRest.z * 23.0);
  float n2 = vnoise(vRest.zy * 95.0 + 7.0);
  int kind = int(vSurface + 0.5);
  Surface s;
  if (kind == 7) {
    // Torso: the clothing is laid out per pixel; vertex colour holds creases.
    float leather;
    vec3 base = torsoGarment(vRest, aa, leather) * vColor.r;
    Surface c = surfaceOf(1, base, n1, n2);
    Surface l = surfaceOf(2, base, n1, n2);
    s = Surface(mix(c.albedo, l.albedo, leather), mix(c.rough, l.rough, leather), mix(c.f0, l.f0, leather),
      mix(c.wrap, l.wrap, leather), mix(c.sheen, l.sheen, leather), 0.0, 0.0);
  } else {
    s = surfaceOf(kind, vColor, n1, n2);
  }
  float ao = vAO;

  float ndl = dot(n, uLightDir);
  float nv = max(dot(n, v), 1e-3);
  float diff = clamp((ndl + s.wrap) / (1.0 + s.wrap), 0.0, 1.0);
  vec3 diffuse = s.albedo * (1.0 - s.metal);
  vec3 col = diffuse * (hemiAmbient(n) * ao + uLightColor * diff * mix(1.0, ao, 0.5));
  col += diffuse * vec3(0.3, 0.07, 0.03) * uLightColor * s.scatter * clamp(0.55 - abs(ndl), 0.0, 0.55);

  // Specular from the moon or sun, and a glossy hint of the sky.
  vec3 h = normalize(uLightDir + v);
  float a = max(s.rough * s.rough, 0.02);
  vec3 F0 = mix(vec3(s.f0), s.albedo, s.metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  float vis = 0.25 / max(mix(nv, 1.0, a) * mix(max(ndl, 0.0), 1.0, a), 0.05);
  col += uLightColor * F * ggx(max(dot(n, h), 0.0), a) * vis * max(ndl, 0.0) * ao;
  vec3 Fv = F0 + (1.0 - F0) * pow(1.0 - nv, 5.0);
  col += uSkyAmbient * Fv * (1.0 - s.rough) * (1.0 - s.rough) * 1.6 * ao;

  // Cloth sheen and the rim that keeps the silhouette readable at night: sky
  // all round, and the moon or sun catching the edges from behind.
  float rim = pow(1.0 - nv, 3.0);
  float back = pow(max(dot(-v, uLightDir), 0.0), 2.0);
  col += s.albedo * s.sheen * pow(1.0 - nv, 4.0) * (hemiAmbient(n) + uLightColor * diff) * 2.0;
  col += (uSkyAmbient * rim * 0.8 + uFogGlow * rim * 0.3 + uLightColor * rim * (1.0 - nv) * back * 0.8) * mix(0.6, 1.0, ao);

  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0 - uReflPass);
  ${OUTPUT_GLSL}
}
`;

// --- posing helpers -----------------------------------------------------------

const _e = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _v = new Vector3();
const _fore = new Vector3();
const _perp = new Vector3();
const _bar = new Vector3();
const _tAxis = new Vector3();
const _prefer = new Vector3();
const _up = new Vector3();
const UP = new Vector3(0, 1, 0);
const SIDES = [-1, 1];

// A wrist bends sideways about 35 degrees before the grip has to slip.
const MAX_DEVIATION = 0.6;

const smooth01 = (t) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

// Critically damped spring for scalars.
class Spring {
  constructor(value = 0, stiffness = 40) {
    this.value = value;
    this.velocity = 0;
    this.k = stiffness;
  }

  step(target, dt) {
    const k = this.k;
    const c = 2 * Math.sqrt(k);
    this.velocity += (k * (target - this.value) - c * this.velocity) * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  kick(v) {
    this.velocity += v;
  }
}

// --- the paddler --------------------------------------------------------------

export class Character {
  constructor() {
    const torso = { value: new Vector2() };
    const material = (name) => new ShaderMaterial({ name, uniforms: { ...shared, uTorso: torso }, vertexShader, fragmentShader });
    this.material = material('Character');
    this.paddleMaterial = material('Paddle');
    this.group = new Group();
    this.group.name = 'Paddler';
    const model = createCharacterModel(this.material);
    torso.value.set(model.torso.y, model.torso.z);
    this.mesh = model.mesh;
    this.bones = model.bones;
    this.group.add(this.mesh);
    this.paddle = new Mesh(buildPaddle(), this.paddleMaterial);
    this.paddle.name = 'paddle';
    this.paddle.frustumCulled = false;
    this.group.add(this.paddle);

    this.joints = makeJoints();
    this.pose = { yaw: 0, lean: 0, roll: 0, shiftX: 0, shiftZ: 0, lift: 0 };
    this.lean = new Spring(0.06, 60);
    this.yaw = new Spring(0, 60);
    this.roll = new Spring(0, 60);
    this.shift = new Spring(0, 40); // sliding along the thwart towards the paddle
    this.surge = new Spring(0, 30); // bump / acceleration reaction
    this.sway = new Spring(0, 30);
    this.lookYaw = new Spring(0, 18);
    this.lookPitch = new Spring(0, 18);
    this.nod = new Spring(0, 70);
    this.time = 0;
    this.idleTime = 0;
    this.glance = { timer: 2, yaw: 0, pitch: 0 };
    this.stretch = -1; // progress of a dawn stretch, -1 when not stretching
    this.stretchDone = false;

    // Limb chains handed to the skeleton each frame.
    this.arms = {};
    this.legs = {};
    for (const side of SIDES) {
      const r = model.rest.arms[side];
      this.arms[side] = {
        side,
        S: new Vector3(),
        E: r.E.clone(),
        W: r.W.clone(),
        T: new Vector3(),
        pole: new Vector3(),
        hx: r.hx.clone(),
        hy: r.hy.clone(),
        hz: r.hz.clone(),
        bar: r.hx.clone(),
        shaftSign: 1,
        gripSign: 1,
        twist0: r.twist0,
      };
      this.legs[side] = {
        H: side < 0 ? this.joints.hipL : this.joints.hipR,
        K: new Vector3(),
        A: new Vector3(side * 0.13, FLOOR_Y + BODY.ankle, SEAT.z - 0.6),
        pole: new Vector3(side * 0.35, 1, -1),
      };
    }
    this.body = { joints: this.joints, arms: this.arms, legs: this.legs };
    this.frames = makeFrames();
    this.neckQ = new Quaternion();
    this.headQ = new Quaternion();
    this.look = { neckQ: this.neckQ, headQ: this.headQ };
    this._hands = { [-1]: new Vector3(), 1: new Vector3() };
    this._tmp = new Vector3();
    this._end = new Vector3();
  }

  bump(strength) {
    this.surge.kick(-strength * 1.6);
    this.sway.kick((Math.random() - 0.5) * strength * 1.2);
    this.nod.kick(strength * 2);
  }

  cheer() {
    this.nod.kick(-2.4);
  }

  // ctx: { stroke, boat, weather:{night,dawn,rain}, moonLocal, interest }
  update(dt, ctx) {
    const { stroke, boat, weather } = ctx;
    this.time += dt;
    const t = this.time;
    const resting = stroke.state === 'rest' && stroke.active < 0.1;
    this.idleTime = resting ? this.idleTime + dt : 0;
    if (!resting) {
      this.stretch = -1;
      this.stretchDone = false;
    }

    // Dawn: once per rest, a slow stretch with the paddle across the knees.
    if (resting && weather.dawn > 0.6 && !this.stretchDone && this.idleTime > 4) {
      this.stretch = 0;
      this.stretchDone = true;
    }
    let stretchW = 0;
    if (this.stretch >= 0) {
      this.stretch += dt / 3.2;
      const s = this.stretch;
      stretchW = Math.sin(Math.min(s, 1) * Math.PI);
      stretchW = stretchW * stretchW * (3 - 2 * stretchW);
      if (s >= 1) this.stretch = -1;
    }

    // Torso: stroke choreography + balance + reactions + weather.
    const breathe = Math.sin(t * 1.55) * 0.5 + 0.5;
    const hunch = weather.rain * 0.12;
    const balanceRoll = -boat.roll * 0.75 + Math.max(-0.1, Math.min(0.1, boat.r * boat.u * 0.025));
    const accelLean = Math.max(-0.08, Math.min(0.08, -boat.accel * 0.025));
    const targetLean = stroke.torso.lean + hunch + accelLean + 0.012 * breathe - stretchW * 0.3;
    this.lean.step(targetLean, dt);
    this.yaw.step(stroke.torso.yaw, dt);
    this.roll.step(stroke.torso.roll + balanceRoll, dt);
    this.shift.step(stroke.torso.shift, dt);
    this.surge.step(0, dt);
    this.sway.step(0, dt);
    const pose = this.pose;
    pose.lean = this.lean.value + this.surge.value;
    pose.yaw = this.yaw.value;
    pose.roll = this.roll.value + this.sway.value;
    pose.lift = 0.006 * breathe + stretchW * 0.02;
    pose.shiftX = this.shift.value + this.roll.value * 0.05;
    pose.shiftZ = 0;

    // Hands: on the paddle, or reaching up during a stretch.
    const hl = this._hands[-1].copy(stroke.handL);
    const hr = this._hands[1].copy(stroke.handR);
    if (stretchW > 0) {
      hl.lerp(this._tmp.set(-0.22, SEAT.y + 1.3, SEAT.z + 0.05), stretchW);
      hr.lerp(this._tmp.set(0.22, SEAT.y + 1.3, SEAT.z + 0.05), stretchW);
    }
    this.updateGrips(dt, stroke, stretchW);

    // Arms reach for the wrists that put each fist round its bar; if a hand
    // cannot quite reach, the body leans in after it.
    for (let iter = 0; iter < 3; iter++) {
      torsoJoints(pose, this.joints);
      const sl = this.solveArm(this.arms[-1], hl);
      const sr = this.solveArm(this.arms[1], hr);
      if (iter === 2 || (iter > 0 && Math.max(sl, sr) < 0.004)) break;
      this.leanTowards(this.arms[-1], sl);
      this.leanTowards(this.arms[1], sr);
    }

    // Legs: feet planted on the floorboards, knees up and slightly apart.
    for (const side of SIDES) {
      const leg = this.legs[side];
      leg.A.set(side * 0.13 - pose.roll * 0.05, FLOOR_Y + BODY.ankle, SEAT.z - 0.6);
      solveTwoBone(leg.H, leg.A, BODY.thigh, BODY.shin, leg.pole, leg.K, this._end);
    }

    // Head: steady gaze with idle glances, points of interest, the moon.
    this.updateGaze(dt, ctx, resting, stretchW);
    this.applyPose(stroke);
  }

  // Lean and tip the shoulders towards a hand that falls 'short' of its grip.
  leanTowards(arm, short) {
    if (short < 0.004) return;
    _v.subVectors(arm.T, arm.S).normalize();
    this.pose.lean += short * 1.6 * Math.max(-_v.z, 0.25);
    this.pose.roll += short * 1.2 * _v.x;
  }

  // The bar each fist closes round: the T-grip for the top hand, the shaft
  // for the lower one (and for both while resting). Signs keep the knuckles
  // up and outward, and only change when the old choice gets clearly wrong.
  updateGrips(dt, stroke, stretchW) {
    _tAxis.crossVectors(stroke.dir, stroke.bladeNormal).normalize();
    const k = 1 - Math.exp(-dt * 16);
    for (const side of SIDES) {
      const arm = this.arms[side];
      const along = _v.subVectors(this._hands[side], stroke.grip).dot(stroke.dir);
      const onShaft = Math.max(smooth01((along - 0.05) / 0.15), 1 - stroke.active);
      // Knuckles = bar x fingers; flip the bar if they would face the wrong way.
      _prefer.set(side * 0.6 * onShaft, 0.8, 0.1 - 0.6 * (1 - onShaft));
      const fs = _v.crossVectors(stroke.dir, arm.hy).dot(_prefer);
      if (fs * arm.shaftSign < -0.15) arm.shaftSign = -arm.shaftSign;
      const gs = _v.crossVectors(_tAxis, arm.hy).dot(_prefer);
      if (gs * arm.gripSign < -0.15) arm.gripSign = -arm.gripSign;
      _bar.copy(stroke.dir).multiplyScalar(arm.shaftSign * onShaft).addScaledVector(_tAxis, arm.gripSign * (1 - onShaft));
      // Stretching: hands open towards thumbs-up.
      if (stretchW > 0) {
        _x.copy(UP).addScaledVector(arm.hy, -arm.hy.y).normalize().multiplyScalar(-side);
        _bar.normalize().lerp(_x, stretchW);
      }
      if (_bar.lengthSq() < 1e-6) continue;
      _bar.normalize();
      _q.setFromUnitVectors(arm.bar, _bar);
      _q2.identity().slerp(_q, k);
      arm.bar.applyQuaternion(_q2).normalize();
    }
  }

  // Two-bone arm to the wrist that puts the fist's bar on 'hand'. The hand
  // frame from the last solve places the wrist, then is refreshed.
  solveArm(arm, hand) {
    const j = this.joints;
    arm.S.copy(arm.side < 0 ? j.shoulderL : j.shoulderR);
    arm.T.copy(hand).addScaledVector(arm.hy, -GRIP.y).addScaledVector(arm.hz, -GRIP.z);
    // Elbows point out and back for a low reach, and drop beneath a hand
    // raised in front of the face.
    _up.set(0, 1, 0).applyQuaternion(j.chestRot);
    const raised = smooth01((_v.subVectors(arm.T, arm.S).dot(_up) + 0.05) / 0.3);
    arm.pole
      .set(arm.side * (1 - 0.65 * raised), -0.7 - 0.3 * raised, 0.5 - 0.65 * raised)
      .applyQuaternion(j.chestRot);
    const short = solveTwoBone(arm.S, arm.T, BODY.upperArm, BODY.forearm, arm.pole, arm.E, arm.W);
    // Fingers follow the forearm, bending sideways at the wrist (within
    // reason) so the bar runs straight across the fist.
    _fore.subVectors(arm.W, arm.E).normalize();
    _y.copy(_fore).addScaledVector(arm.bar, -_fore.dot(arm.bar));
    if (_y.lengthSq() < 1e-6) return short;
    _y.normalize();
    const c = _y.dot(_fore);
    if (c < Math.cos(MAX_DEVIATION)) {
      _perp.copy(_y).addScaledVector(_fore, -c).normalize();
      _y.copy(_fore).multiplyScalar(Math.cos(MAX_DEVIATION)).addScaledVector(_perp, Math.sin(MAX_DEVIATION));
    }
    _x.copy(arm.bar).addScaledVector(_y, -arm.bar.dot(_y));
    if (_x.lengthSq() < 1e-6) return short;
    arm.hy.copy(_y);
    arm.hx.copy(_x.normalize());
    arm.hz.crossVectors(arm.hx, arm.hy);
    return short;
  }

  updateGaze(dt, ctx, resting, stretchW) {
    const g = this.glance;
    g.timer -= dt;
    if (g.timer <= 0) {
      g.timer = resting ? 2.5 + Math.random() * 4 : 3 + Math.random() * 5;
      const r = Math.random();
      if (ctx.moonLocal && ctx.weather.night > 0.6 && r < 0.3) {
        g.target = 'moon';
      } else if (r < (resting ? 0.75 : 0.45)) {
        g.target = 'glance';
        g.yaw = (Math.random() - 0.5) * (resting ? 1.9 : 1.1);
        g.pitch = (Math.random() - 0.6) * 0.3;
      } else {
        g.target = 'ahead';
      }
    }
    let yaw = 0;
    let pitch = -0.05 - 0.22 * ctx.weather.rain;
    if (g.target === 'glance') {
      yaw = g.yaw;
      pitch += g.pitch;
    } else if (g.target === 'moon' && ctx.moonLocal) {
      const m = ctx.moonLocal;
      yaw = Math.atan2(-m.x, -m.z);
      pitch = Math.asin(Math.max(-1, Math.min(1, m.y)));
    }
    // A nearby blossom or anything else of interest wins.
    if (ctx.interest) {
      const d = this._tmp.subVectors(ctx.interest, this.joints.neck);
      yaw = Math.atan2(-d.x, -d.z);
      pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    }
    // Look into the turn while steering.
    yaw += Math.max(-0.4, Math.min(0.4, ctx.boat.r * 0.5));
    pitch += stretchW * 0.45;
    // Relative to the chest, within what a neck can do.
    yaw -= this.pose.yaw * 0.85;
    yaw = Math.max(-1.25, Math.min(1.25, yaw));
    pitch = Math.max(-0.6, Math.min(0.75, pitch));
    this.lookYaw.step(yaw, dt);
    this.lookPitch.step(pitch, dt);
    this.nod.step(0, dt);
  }

  applyPose(stroke) {
    const j = this.joints;
    const pose = this.pose;
    // Neck takes part of the look, the head the rest, and the head stays
    // nearly level as the torso leans and rolls.
    _e.set(-this.lookPitch.value * 0.35 + this.nod.value * 0.1, this.lookYaw.value * 0.3, 0);
    this.neckQ.copy(j.chestRot).multiply(_q.setFromEuler(_e));
    _e.set(-this.lookPitch.value + this.nod.value * 0.25, this.lookYaw.value, -pose.roll * 0.4);
    this.headQ.copy(j.chestRot).multiply(_q.setFromEuler(_e));
    _e.set(pose.lean * 0.55, 0, pose.roll * 0.6);
    this.headQ.multiply(_q.setFromEuler(_e));
    applyFrames(this.bones, boneFrames(this.body, this.look, this.frames));

    // Paddle frame: -y down the shaft, +z the blade face.
    _y.copy(stroke.dir).negate();
    _z.copy(stroke.bladeNormal);
    _x.crossVectors(_y, _z).normalize();
    _z.crossVectors(_x, _y).normalize();
    _m.makeBasis(_x, _y, _z);
    this.paddle.quaternion.setFromRotationMatrix(_m);
    this.paddle.position.copy(stroke.grip);
  }
}
