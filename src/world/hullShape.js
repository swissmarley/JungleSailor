// Analytic hull lines for the rowboat. The boat faces -z in its local frame and
// y = 0 is the design waterline. The GLSL twin below must stay in sync: it is
// used to keep water out of the hull and to push the wake simulation.
//
//   s     0 at the transom (stern) .. 1 at the stem (bow)
//   Y     0 at the keel .. 1 at the sheer (gunwale)

export const HULL_LENGTH = 3.9;
export const HULL_HALF_LENGTH = HULL_LENGTH / 2;
export const HULL_MAX_HALF_BEAM = 0.74;
export const HULL_FLARE = 0.16;
export const PLANK_THICKNESS = 0.022;

const BEAM_PEAK = 0.42;

const smooth01 = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export function halfBeam(s) {
  if (s <= BEAM_PEAK) {
    const u = 1 - s / BEAM_PEAK;
    return HULL_MAX_HALF_BEAM * (0.72 + 0.28 * (1 - u * u));
  }
  const u = (s - BEAM_PEAK) / (1 - BEAM_PEAK);
  return HULL_MAX_HALF_BEAM * Math.max(0, (1 - Math.pow(u, 1.75)) * (1 - 0.12 * u));
}

export function sheerHeight(s) {
  return 0.36 + 0.06 * (1 - s) * (1 - s) + 0.2 * s * s * s;
}

export function keelHeight(s) {
  const t = smooth01(0.82, 1.0, s);
  return -0.2 + 0.06 * Math.pow(1 - s, 3) + 0.52 * Math.pow(t, 1.6);
}

export function sectionExponent(s) {
  return 2.5 - 0.3 * Math.max(0, 1 - s / 0.3) - 1.2 * smooth01(0.55, 1.0, s);
}

export const zAt = (s) => HULL_HALF_LENGTH - s * HULL_LENGTH;
export const sAt = (z) => (HULL_HALF_LENGTH - z) / HULL_LENGTH;

// Half-width of the outer skin at height fraction Y for station s.
export function halfWidthAtY(s, Y) {
  const n = sectionExponent(s);
  const X = Math.pow(Math.max(0, 1 - Math.pow(1 - Y, n)), 1 / n);
  return halfBeam(s) * X * (1 - HULL_FLARE * (1 - Y));
}

// Half-width of the outer skin at local height y (0 outside the hull's span).
export function halfWidthAtHeight(s, y) {
  const yk = keelHeight(s);
  const ys = sheerHeight(s);
  if (y < yk) return 0;
  return halfWidthAtY(s, Math.min((y - yk) / (ys - yk), 1));
}

// Point on the outer skin for a section angle theta in [-pi/2, pi/2]
// (negative = port side). Superellipse sections: round bilge amidships,
// sharpening into a V towards the bow.
export function sectionPoint(s, theta, out) {
  const n = sectionExponent(s);
  const a = Math.abs(theta);
  const X = Math.pow(Math.sin(a), 2 / n);
  const Y = 1 - Math.pow(Math.cos(a), 2 / n);
  const yk = keelHeight(s);
  const ys = sheerHeight(s);
  out.x = Math.sign(theta) * halfBeam(s) * X * (1 - HULL_FLARE * (1 - Y));
  out.y = yk + (ys - yk) * Y;
  out.z = zAt(s);
  return Y;
}

export const HULL_GLSL = /* glsl */ `
const float HULL_HALF_LENGTH = ${HULL_HALF_LENGTH.toFixed(4)};
const float HULL_LENGTH = ${HULL_LENGTH.toFixed(4)};
float hullHalfBeam(float s) {
  if (s <= ${BEAM_PEAK.toFixed(3)}) {
    float u = 1.0 - s / ${BEAM_PEAK.toFixed(3)};
    return ${HULL_MAX_HALF_BEAM.toFixed(4)} * (0.72 + 0.28 * (1.0 - u * u));
  }
  float u = (s - ${BEAM_PEAK.toFixed(3)}) / ${(1 - BEAM_PEAK).toFixed(3)};
  return ${HULL_MAX_HALF_BEAM.toFixed(4)} * max(0.0, (1.0 - pow(u, 1.75)) * (1.0 - 0.12 * u));
}
float hullSheer(float s) {
  return 0.36 + 0.06 * (1.0 - s) * (1.0 - s) + 0.2 * s * s * s;
}
float hullKeel(float s) {
  float t = smoothstep(0.82, 1.0, s);
  return -0.2 + 0.06 * pow(1.0 - s, 3.0) + 0.52 * pow(t, 1.6);
}
float hullExponent(float s) {
  return 2.5 - 0.3 * max(0.0, 1.0 - s / 0.3) - 1.2 * smoothstep(0.55, 1.0, s);
}
// Signed horizontal distance to the outer skin at local point p (> 0 inside).
float hullInside(vec3 p) {
  float s = (HULL_HALF_LENGTH - p.z) / HULL_LENGTH;
  if (s <= 0.0 || s >= 1.0) return -1.0;
  float yk = hullKeel(s);
  if (p.y < yk) return -1.0;
  float ys = hullSheer(s);
  float Y = min((p.y - yk) / (ys - yk), 1.0);
  float n = hullExponent(s);
  float X = pow(max(0.0, 1.0 - pow(1.0 - Y, n)), 1.0 / n);
  float hw = hullHalfBeam(s) * X * (1.0 - ${HULL_FLARE.toFixed(3)} * (1.0 - Y));
  return min(hw - abs(p.x), s * HULL_LENGTH);
}
// Depth of the hull bottom below the water plane at boat-local (x, z) for a
// boat raised by heave (local y = 0 is the design waterline).
float hullDepth(vec2 xz, float heave) {
  float s = (HULL_HALF_LENGTH - xz.y) / HULL_LENGTH;
  if (s <= 0.0 || s >= 1.0) return 0.0;
  float hb = hullHalfBeam(s);
  float yk = hullKeel(s);
  float ys = hullSheer(s);
  float n = hullExponent(s);
  // Bottom height across the section (inverse of the superellipse, flare ignored).
  float X = clamp(abs(xz.x) / max(hb, 1e-3), 0.0, 1.0);
  float Y = 1.0 - pow(max(0.0, 1.0 - pow(X, n)), 1.0 / n);
  float bottom = yk + (ys - yk) * Y + heave;
  return max(0.0, -bottom) * (1.0 - smoothstep(0.55, 1.0, X));
}
`;
