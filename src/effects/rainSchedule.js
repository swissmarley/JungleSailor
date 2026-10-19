// Rain is a deterministic timetable: the water surface is divided into cells
// and each cell receives one drop per period (per layer) at a fresh random
// spot. The falling streaks and the impact ripples read the same timetable,
// so every ripple belongs to a drop you can see land.
export const RAIN = {
  cell: 0.85, // metres
  period: 1.1, // seconds between drops in a cell (per layer)
  layers: 2,
  fallSpeed: 8.5, // m/s
  rippleLife: 0.75, // seconds
  rippleSpeed: 0.38, // ring growth, m/s
};

export const RAIN_GLSL = /* glsl */ `
const float RAIN_CELL = ${RAIN.cell.toFixed(4)};
const float RAIN_PERIOD = ${RAIN.period.toFixed(4)};
const float RAIN_FALL = ${RAIN.fallSpeed.toFixed(4)};
const float RAIN_LIFE = ${RAIN.rippleLife.toFixed(4)};
const float RAIN_RING_SPEED = ${RAIN.rippleSpeed.toFixed(4)};

float rainPhase(vec2 cell, float layer) {
  return hash12(cell * 1.13 + vec2(layer * 41.7, layer * 17.3));
}

// World-space impact point of drop number 'cycle' in a cell.
vec2 rainDropPos(vec2 cell, float layer, float cycle) {
  vec2 j = hash22(cell * 1.37 + vec2(cycle * 7.13 + layer * 3.1, cycle * 1.91));
  return (cell + 0.18 + 0.64 * j) * RAIN_CELL;
}

// Drops can be thinned out for lighter rain: a drop exists if its lottery
// number is below the current intensity.
float rainDropExists(vec2 cell, float layer, float cycle, float intensity) {
  return step(hash12(cell * 0.71 + vec2(cycle * 3.77, layer * 9.1)), intensity);
}
`;
