import { Vector3 } from 'three';
import { clamp, damp } from '../core/random.js';
import { riverHalfWidth, riverX } from './river.js';
import { terrainHeight } from './terrain.js';

// Third-person chase camera: trails the boat with a lazy heading, stays over
// the water between the banks and adapts its framing to portrait screens.
export class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.heading = null;
    this.position = new Vector3();
    this.look = new Vector3();
    this.shake = 0;
    this.time = 0;
    this._target = new Vector3();
    this._lookTarget = new Vector3();
  }

  frame(aspect) {
    // Taller field of view and a longer boom when the screen is portrait.
    const portrait = clamp((1.25 - aspect) / 0.75, 0, 1);
    return {
      fov: 56 + 18 * portrait,
      distance: 7.4 + 2.2 * portrait,
      height: 2.65 + 0.85 * portrait,
      ahead: 7 - 1.5 * portrait,
      lookHeight: 1.95 - 0.45 * portrait,
    };
  }

  update(dt, boat, snap = false) {
    const cam = this.camera;
    const f = this.frame(cam.aspect);
    if (Math.abs(cam.fov - f.fov) > 0.01) {
      cam.fov = f.fov;
      cam.updateProjectionMatrix();
    }
    this.time += dt;
    if (this.heading === null || snap) this.heading = boat.heading;
    let dh = boat.heading - this.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.heading += dh * damp(2.2, dt);

    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const t = this._target.set(boat.x - fx * f.distance, f.height, boat.z - fz * f.distance);

    // Keep the eye above water, between the banks, clear of the ground.
    const lat = t.x - riverX(t.z);
    const limit = Math.max(riverHalfWidth(t.z) - 1.6, 1);
    t.x = riverX(t.z) + clamp(lat, -limit, limit);
    t.y = Math.max(t.y, terrainHeight(t.x, t.z) + 1.8);

    if (snap) this.position.copy(t);
    else this.position.lerp(t, damp(5, dt));

    this.look.set(boat.x + fx * f.ahead, f.lookHeight, boat.z + fz * f.ahead);
    if (snap) this._lookTarget.copy(this.look);
    else this._lookTarget.lerp(this.look, damp(8, dt));

    // A soft knock when the hull bumps a bank.
    this.shake = Math.max(this.shake * Math.exp(-dt * 6), boat.bump * 0.12);
    const s = this.shake;
    cam.position.set(
      this.position.x + Math.sin(this.time * 31) * s * 0.3,
      this.position.y + Math.sin(this.time * 0.7) * 0.04 + Math.sin(this.time * 27) * s * 0.2,
      this.position.z,
    );
    cam.lookAt(this._lookTarget);
  }
}
