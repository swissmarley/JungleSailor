import { Mesh, ShaderMaterial, Vector2 } from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, OUTPUT_GLSL, shared } from '../shaders/common.js';
import { clamp, damp } from '../core/random.js';
import { createBoatGeometry } from './boatGeometry.js';
import { riverDirection, riverHalfWidth, riverSlope, riverX } from './river.js';

const vertexShader = /* glsl */ `
attribute float aPart;
attribute vec2 aWood;
attribute float aStrake;
attribute float aAO;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec2 vWood;
varying float vStrake;
varying float vAO;
varying float vPart;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vLocal = position;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vWood = aWood;
  vStrake = aStrake;
  vAO = aAO;
  vPart = aPart;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec2 vWood;
varying float vStrake;
varying float vAO;
varying float vPart;

vec3 partColor(float part) {
  if (part < 0.5) return vec3(0.150, 0.072, 0.030);   // hull outside, oiled planks
  if (part < 1.5) return vec3(0.240, 0.135, 0.064);   // hull inside, dry and lighter
  if (part < 2.5) return vec3(0.080, 0.034, 0.014);   // gunwales and trim
  if (part < 3.5) return vec3(0.300, 0.190, 0.100);   // floorboards, sun-bleached
  if (part < 4.5) return vec3(0.200, 0.098, 0.042);   // thwarts
  return vec3(0.110, 0.052, 0.024);                   // frames and risers
}

void main() {
  float part = floor(vPart + 0.5);
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  // Wood grain: stretched noise along the plank plus fine fibres.
  float g = fbm3(vec2(vWood.x * 0.7, vWood.y * 22.0));
  float fibre = sin(vWood.y * 160.0 + g * 9.0) * 0.5 + 0.5;
  float plank = floor(vStrake);
  float plankTone = 0.86 + 0.28 * hash12(vec2(plank, part * 7.0 + 3.0));
  vec3 albedo = partColor(part) * plankTone * (0.78 + 0.3 * g + 0.1 * fibre);

  // Plank seams and clinker laps.
  float f = fract(vStrake);
  float seam = smoothstep(0.0, 0.035, f) * smoothstep(1.0, 0.965, f);
  float lap = 1.0;
  if (part < 1.5) {
    lap = 0.82 + 0.3 * smoothstep(0.0, 0.25, f);
    float edge = smoothstep(0.03, 0.06, f) * (1.0 - smoothstep(0.06, 0.12, f));
    lap += edge * 0.25;
  }
  albedo *= mix(0.45, 1.0, seam) * lap;

  // Waterline: dark algae stain below, a wet band just above.
  if (part < 0.5) {
    float wl = vLocal.y;
    float below = 1.0 - smoothstep(-0.01, 0.035, wl + 0.012 * sin(vLocal.z * 7.0));
    albedo = mix(albedo, vec3(0.018, 0.024, 0.012), below * 0.85);
    float wet = 1.0 - smoothstep(0.03, 0.11, wl);
    albedo *= 1.0 - 0.35 * wet;
  }
  // Rain soaks the wood.
  albedo *= 1.0 - 0.35 * uWetness;

  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 l = uLightDir;
  float ndl = dot(n, l);
  float diff = clamp((ndl + 0.15) / 1.15, 0.0, 1.0);
  vec3 h = normalize(l + v);
  float gloss = mix(28.0, 90.0, uWetness);
  float spec = pow(max(dot(n, h), 0.0), gloss) * (gloss + 8.0) / 25.0;
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float specAmt = (part < 0.5 || part > 1.5 && part < 2.5) ? 0.5 : 0.18;
  specAmt *= 1.0 + 1.5 * uWetness;

  vec3 col = albedo * (hemiAmbient(n) * vAO + uLightColor * diff * mix(0.6, 1.0, vAO));
  col += uLightColor * spec * fres * specAmt * step(0.0, ndl);
  // Soft rim from the sky behind the boat keeps the silhouette readable at night.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += uSkyAmbient * rim * 0.35 * vAO;

  col = applyFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0 - uReflPass);
  ${OUTPUT_GLSL}
}
`;

export function createBoatMesh() {
  const material = new ShaderMaterial({
    name: 'BoatWood',
    uniforms: { ...shared },
    vertexShader,
    fragmentShader,
  });
  const mesh = new Mesh(createBoatGeometry(), material);
  mesh.rotation.order = 'YXZ';
  mesh.name = 'Boat';
  return mesh;
}

// Boat dynamics in the horizontal plane. Heading uses three.js yaw: the boat's
// forward axis is local -z, so forward = (-sin h, -cos h). Positive yaw turns left.
export class Boat {
  constructor(startZ = 0) {
    this.x = riverX(startZ);
    this.z = startZ;
    const dir = riverDirection(startZ);
    this.heading = Math.atan2(-dir.x, -dir.z);
    this.u = 0; // forward speed (m/s)
    this.v = 0; // sideways speed (m/s, + = starboard)
    this.r = 0; // yaw rate (rad/s)
    this.throttle = 0;
    this.steer = 0;
    this.distance = 0;
    this.bump = 0; // recent collision strength, decays
    this.time = 0;
    this.heave = 0;
    this.pitch = 0;
    this.roll = 0;
    this.accel = 0;
    this.prevSpeed = 0;
    this.velocity = new Vector2();
    this.onBump = null;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.y);
  }

  // Eases the raw input so keyboard steering feels like a boat, not a car.
  steerInput(dt, input) {
    this.throttle += (input.throttle - this.throttle) * damp(input.analog ? 10 : 4, dt);
    this.steer += (input.steer - this.steer) * damp(input.analog ? 10 : 5, dt);
  }

  // paddle: { force, torque } from the blade in the water this frame.
  update(dt, paddle) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, paddle);

    this.time += dt;
    const sp = this.u;
    this.accel += ((sp - this.prevSpeed) / Math.max(dt, 1e-4) - this.accel) * damp(3, dt);
    this.prevSpeed = sp;
    this.bump *= Math.exp(-dt * 3);

    // Gentle bobbing: the hull rides slightly submerged and settles with motion.
    const t = this.time;
    this.heave = 0.011 * Math.sin(t * 1.27) + 0.006 * Math.sin(t * 2.13 + 1.1) - 0.004 * Math.min(Math.abs(sp), 4);
    this.pitch = 0.011 * Math.sin(t * 0.93 + 0.4) + 0.006 * Math.sin(t * 1.71) + clamp(this.accel * 0.012, -0.03, 0.03) + 0.006 * Math.min(Math.max(sp, 0), 4) / 4;
    this.roll = 0.014 * Math.sin(t * 1.07 + 2.0) + 0.007 * Math.sin(t * 1.93 + 0.7) - clamp(this.r * sp * 0.03, -0.07, 0.07);
  }

  step(h, paddle) {
    // The paddle pushes in pulses; the hull glides between strokes.
    this.u += (paddle.force - 0.1 * this.u - 0.075 * this.u * Math.abs(this.u)) * h;
    this.v += -3.0 * this.v * h;

    // Each stroke turns the bow a little; the steering input adds the rest
    // (a paddler's J-stroke and sweeps), so the boat answers promptly.
    const turnAuthority = 0.4 + 0.6 * Math.min(Math.abs(this.u) / 2, 1);
    this.r += (this.steer * 1.05 * turnAuthority + paddle.torque - 2.3 * this.r) * h;

    // Turning keeps the hull's momentum in world space, so it slides a little.
    const wx = -Math.sin(this.heading) * this.u + Math.cos(this.heading) * this.v;
    const wz = -Math.cos(this.heading) * this.u - Math.sin(this.heading) * this.v;
    this.heading += this.r * h;
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    this.u = wx * fx + wz * fz;
    this.v = wx * rx + wz * rz;

    // A lazy current carries the boat downstream.
    const dir = riverDirection(this.z);
    const current = 0.22;
    const vx = wx + dir.x * current;
    const vz = wz + dir.z * current;
    this.x += vx * h;
    this.z += vz * h;
    this.distance += Math.hypot(vx, vz) * h;

    this.collide();
    this.velocity.set(fx * this.u + rx * this.v, fz * this.u + rz * this.v);
  }

  // Keep bow, middle and stern inside the banks; slide along them.
  collide() {
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    for (const off of [1.6, 0, -1.6]) {
      const px = this.x + fx * off;
      const pz = this.z + fz * off;
      const lat = px - riverX(pz);
      const pen = Math.abs(lat) - (riverHalfWidth(pz) - 1.05);
      if (pen <= 0) continue;
      const side = Math.sign(lat);
      const s = riverSlope(pz);
      const inv = 1 / Math.sqrt(1 + s * s);
      // Bank normal pointing back towards the water.
      const nx = -side * inv;
      const nz = side * s * inv;
      this.x += nx * pen * inv;
      this.z += nz * pen * inv;

      // Remove velocity into the bank, keep (damped) tangential motion.
      const wx = fx * this.u + rx * this.v;
      const wz = fz * this.u + rz * this.v;
      const into = wx * nx + wz * nz;
      if (into >= 0) continue;
      const nwx = wx - 1.25 * into * nx;
      const nwz = wz - 1.25 * into * nz;
      this.u = (nwx * fx + nwz * fz) * 0.985;
      this.v = (nwx * rx + nwz * rz) * 0.9;
      const strength = Math.min(-into / 2.5, 1);
      if (strength > this.bump + 0.08 && this.onBump) this.onBump(strength);
      this.bump = Math.max(this.bump, strength);
      // A knock at the bow or stern yaws the hull away from the bank.
      if (off !== 0) this.r += Math.sign(off) * (fz * nx - fx * nz) * strength * 0.6;
    }
  }

  applyTo(mesh) {
    mesh.position.set(this.x, this.heave, this.z);
    mesh.rotation.set(this.pitch, this.heading, this.roll);
  }
}
