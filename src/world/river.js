// The waterway is an endless meandering channel whose centre line is a sum of
// sines in z. The same formulas are emitted as GLSL so shaders (wake
// simulation, water, vegetation shading) agree exactly with the CPU side.
// Travelling "forward" means heading towards -z.

const TAU = Math.PI * 2;

// [amplitude (m), wavelength (m), phase]
const MEANDERS = [
  [15.0, 300, 0.35],
  [5.6, 118, 2.1],
  [1.8, 47, 4.6],
];

// Half-width of the channel measured perpendicular to the flow.
const WIDTH_BASE = 6.8;
const WIDTH_TERMS = [
  [1.5, 86, 0.9],
  [0.7, 31, 2.7],
];

const X0 = MEANDERS.reduce((sum, [a, , p]) => sum + a * Math.sin(p), 0);

export function riverX(z) {
  let x = -X0;
  for (const [a, l, p] of MEANDERS) x += a * Math.sin((TAU / l) * z + p);
  return x;
}

export function riverSlope(z) {
  let s = 0;
  for (const [a, l, p] of MEANDERS) s += a * (TAU / l) * Math.cos((TAU / l) * z + p);
  return s;
}

export function riverHalfWidthPerp(z) {
  let w = WIDTH_BASE;
  for (const [a, l, p] of WIDTH_TERMS) w += a * Math.sin((TAU / l) * z + p);
  return w;
}

// Half-width measured along x (horizontal slice at constant z), which is what
// we compare against when testing x - riverX(z).
export function riverHalfWidth(z) {
  const s = riverSlope(z);
  return riverHalfWidthPerp(z) * Math.sqrt(1 + s * s);
}

// Unit vector pointing along the flow (towards -z), written into out (x, z).
export function riverDirection(z, out = { x: 0, z: 0 }) {
  const s = riverSlope(z);
  const len = Math.sqrt(1 + s * s);
  out.x = -s / len;
  out.z = -1 / len;
  return out;
}

// Signed lateral offset of a point from the centre line (along x) and how far
// that is from the water's edge (negative = on the water).
export function bankDistance(x, z) {
  const lat = x - riverX(z);
  return Math.abs(lat) - riverHalfWidth(z);
}

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

function sinSum(terms, arg) {
  return terms
    .map(([a, l, p]) => `${f(a)} * sin(${f(TAU / l)} * ${arg} + ${f(p)})`)
    .join(' + ');
}

function cosSlope(terms, arg) {
  return terms
    .map(([a, l, p]) => `${f(a * (TAU / l))} * cos(${f(TAU / l)} * ${arg} + ${f(p)})`)
    .join(' + ');
}

export const RIVER_GLSL = /* glsl */ `
float riverX(float z) {
  return ${sinSum(MEANDERS, 'z')} - ${f(X0)};
}
float riverSlope(float z) {
  return ${cosSlope(MEANDERS, 'z')};
}
float riverHalfWidth(float z) {
  float s = riverSlope(z);
  float w = ${f(WIDTH_BASE)} + ${sinSum(WIDTH_TERMS, 'z')};
  return w * sqrt(1.0 + s * s);
}
// > 0 on land, < 0 over water (metres from the edge along x)
float bankDistance(vec2 xz) {
  return abs(xz.x - riverX(xz.y)) - riverHalfWidth(xz.y);
}
`;
