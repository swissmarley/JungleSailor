import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';

// Renders the scene mirrored in the water plane (y = 0) into an HDR buffer.
// The oblique near plane clips everything below the surface, so the hull's
// submerged part never shows up in its own reflection.
export class PlanarReflection {
  constructor({ scale = 0.5, clipBias = 0.002 } = {}) {
    this.scale = scale;
    this.clipBias = clipBias;
    this.target = new WebGLRenderTarget(2, 2, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    this.camera = new PerspectiveCamera();
    this.textureMatrix = new Matrix4();
    this._plane = new Plane();
    this._normal = new Vector3(0, 1, 0);
    this._camPos = new Vector3();
    this._rot = new Matrix4();
    this._look = new Vector3();
    this._target = new Vector3();
    this._view = new Vector3();
    this._clip = new Vector4();
    this._q = new Vector4();
  }

  get texture() {
    return this.target.texture;
  }

  setSize(width, height) {
    this.target.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }

  render(renderer, scene, camera) {
    const normal = this._normal;
    const cam = this.camera;
    this._camPos.setFromMatrixPosition(camera.matrixWorld);

    // Mirror the eye and its look-at point through the plane; the mirrored
    // up vector makes this a proper (non-inverted) camera, and the texture
    // matrix below maps water points back into its image.
    this._view.set(this._camPos.x, -this._camPos.y, this._camPos.z);
    this._rot.extractRotation(camera.matrixWorld);
    this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    this._target.set(this._look.x, -this._look.y, this._look.z);

    cam.position.copy(this._view);
    cam.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(normal);
    cam.lookAt(this._target);
    cam.far = camera.far;
    cam.near = camera.near;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Oblique clip plane (Lengyel) so geometry under the water is cut away.
    this._plane.setFromNormalAndCoplanarPoint(normal, new Vector3(0, 0, 0));
    this._plane.applyMatrix4(cam.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const p = cam.projectionMatrix.elements;
    const q = this._q;
    q.x = (Math.sign(clip.x) + p[8]) / p[0];
    q.y = (Math.sign(clip.y) + p[9]) / p[5];
    q.z = -1;
    q.w = (1 + p[10]) / p[14];
    clip.multiplyScalar(2 / clip.dot(q));
    p[2] = clip.x;
    p[6] = clip.y;
    p[10] = clip.z + 1 - this.clipBias;
    p[14] = clip.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
  }
}
