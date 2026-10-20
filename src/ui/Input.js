// Keyboard (WASD / arrows) and a floating thumb-stick for touch screens.
// Output: throttle and steer in [-1, 1]; positive steer turns left.

const KEYS = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

export class Input {
  constructor({ surface, stick, knob }) {
    this.pressed = new Set();
    this.surface = surface;
    this.stick = stick;
    this.knob = knob;
    this.pointerId = null;
    this.origin = { x: 0, y: 0 };
    this.vector = { x: 0, y: 0 };
    this.radius = 56;
    this.listeners = new Set();

    window.addEventListener('keydown', (e) => {
      const k = KEYS[e.code];
      if (!k) return;
      e.preventDefault();
      this.pressed.add(k);
      this.emit('keyboard');
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYS[e.code];
      if (k) this.pressed.delete(k);
    });
    window.addEventListener('blur', () => this.pressed.clear());

    surface.addEventListener('pointerdown', (e) => this.onDown(e));
    surface.addEventListener('pointermove', (e) => this.onMove(e));
    surface.addEventListener('pointerup', (e) => this.onUp(e));
    surface.addEventListener('pointercancel', (e) => this.onUp(e));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(fn) {
    this.listeners.add(fn);
  }

  emit(kind) {
    for (const fn of this.listeners) fn(kind);
  }

  onDown(e) {
    if (this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.surface.setPointerCapture?.(e.pointerId);
    this.radius = Math.max(44, Math.min(70, Math.min(window.innerWidth, window.innerHeight) * 0.11));
    this.origin.x = e.clientX;
    this.origin.y = e.clientY;
    this.vector.x = 0;
    this.vector.y = 0;
    this.stick.style.setProperty('--size', `${this.radius * 2}px`);
    this.stick.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.stick.classList.add('active');
    this.emit(e.pointerType === 'mouse' ? 'mouse' : 'touch');
  }

  onMove(e) {
    if (e.pointerId !== this.pointerId) return;
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    const r = this.radius;
    if (len > r) {
      // Let the base follow a finger that wanders far, so it never "sticks".
      const over = len - r;
      this.origin.x += (dx / len) * over;
      this.origin.y += (dy / len) * over;
      dx = (dx / len) * r;
      dy = (dy / len) * r;
      this.stick.style.transform = `translate(${this.origin.x}px, ${this.origin.y}px)`;
    }
    this.vector.x = dx / r;
    this.vector.y = dy / r;
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  onUp(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.vector.x = 0;
    this.vector.y = 0;
    this.stick.classList.remove('active');
  }

  // Returns the combined command for this frame.
  read() {
    let throttle = 0;
    let steer = 0;
    if (this.pressed.has('up')) throttle += 1;
    if (this.pressed.has('down')) throttle -= 1;
    if (this.pressed.has('left')) steer += 1;
    if (this.pressed.has('right')) steer -= 1;
    let analog = false;
    if (this.pointerId !== null) {
      const dead = 0.12;
      const shape = (v) => Math.sign(v) * Math.max(0, (Math.abs(v) - dead) / (1 - dead));
      throttle += shape(-this.vector.y);
      steer += shape(-this.vector.x);
      analog = true;
    }
    return {
      throttle: Math.max(-1, Math.min(1, throttle)),
      steer: Math.max(-1, Math.min(1, steer)),
      analog,
    };
  }
}
