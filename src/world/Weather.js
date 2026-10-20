import { Vector3 } from 'three';
import { damp } from '../core/random.js';
import { shared } from '../shaders/common.js';
import { riverX } from './river.js';

const deg = Math.PI / 180;
// azimuth 0 = towards -z, positive = towards +x
const setDir = (out, azimuthDeg, elevationDeg) => {
  const a = azimuthDeg * deg;
  const e = elevationDeg * deg;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

// Live directions: the presets reference these vectors, Celestial moves them.
export const MOON_DIR = setDir(new Vector3(), -4, 18);
export const SUN_DIR = setDir(new Vector3(), 14, 8.5);
const OVERCAST_DIR = new Vector3(0.25, 1, -0.35).normalize();

// The moon and the dawn sun hang low over the river's long-range course, so
// they usually sit at the far end of the corridor with their glitter running
// back towards the boat. They follow the river far too slowly to notice.
export class Celestial {
  constructor() {
    this.azimuth = null;
  }

  update(dt, x, z) {
    const ahead = 35;
    const target = Math.atan2(riverX(z - ahead) - x, ahead) / deg;
    if (this.azimuth === null) this.azimuth = target;
    else this.azimuth += (target - this.azimuth) * damp(0.06, dt);
    setDir(MOON_DIR, this.azimuth, 18);
    setDir(SUN_DIR, this.azimuth + 14, 8.5);
  }
}

// Colours are linear RGB. Values were tuned by eye under ACES tone mapping.
export const PRESETS = {
  night: {
    label: 'Moonlit night',
    exposure: 2.2,
    keyDir: MOON_DIR,
    keyColor: [0.2, 0.25, 0.34],
    specDir: MOON_DIR,
    specColor: [0.03, 0.036, 0.044],
    specRadius: 0.052,
    skyAmbient: [0.014, 0.022, 0.036],
    groundAmbient: [0.003, 0.0045, 0.0045],
    fogColor: [0.0085, 0.016, 0.024],
    fogGlow: [0.03, 0.042, 0.058],
    fogDensity: 0.017,
    fogFalloff: 0.16,
    zenith: [0.0016, 0.003, 0.009],
    horizon: [0.009, 0.019, 0.034],
    sunDisc: [0, 0, 0],
    sunGlow: [0, 0, 0],
    sunHorizon: [0, 0, 0],
    sunVis: 0,
    moonVis: 1,
    moonBright: 0.62,
    moonGlow: [0.075, 0.09, 0.12],
    stars: 1,
    cloudCover: 0.3,
    cloudSoft: 0.35,
    cloudDark: [0.004, 0.006, 0.011],
    cloudLit: [0.035, 0.043, 0.056],
    treeLine: [0.004, 0.008, 0.012],
    waterColor: [0.02, 0.028, 0.02],
    waveAmp: 1.0,
    windStrength: 0.35,
    wetness: 0,
    rain: 0,
    fireflies: 1,
    grade: [0.92, 0.98, 1.12],
    saturation: 0.72,
  },
  dawn: {
    label: 'Warm dawn',
    exposure: 1.05,
    keyDir: SUN_DIR,
    keyColor: [1.45, 0.82, 0.46],
    specDir: SUN_DIR,
    specColor: [0.75, 0.45, 0.24],
    specRadius: 0.03,
    skyAmbient: [0.17, 0.19, 0.26],
    groundAmbient: [0.045, 0.04, 0.032],
    fogColor: [0.27, 0.23, 0.22],
    fogGlow: [0.85, 0.5, 0.26],
    fogDensity: 0.02,
    fogFalloff: 0.12,
    zenith: [0.09, 0.15, 0.3],
    horizon: [0.62, 0.42, 0.34],
    sunDisc: [36, 26, 15],
    sunGlow: [1.0, 0.58, 0.28],
    sunHorizon: [0.85, 0.42, 0.18],
    sunVis: 1,
    moonVis: 0,
    moonBright: 3.2,
    moonGlow: [0, 0, 0],
    stars: 0,
    cloudCover: 0.38,
    cloudSoft: 0.4,
    cloudDark: [0.24, 0.19, 0.22],
    cloudLit: [1.05, 0.62, 0.42],
    treeLine: [0.1, 0.085, 0.085],
    waterColor: [0.05, 0.045, 0.03],
    waveAmp: 0.8,
    windStrength: 0.25,
    wetness: 0,
    rain: 0,
    fireflies: 0.12,
    grade: [1.04, 1.0, 0.95],
    saturation: 1.0,
  },
  rain: {
    label: 'Overcast rain',
    exposure: 1.3,
    keyDir: OVERCAST_DIR,
    keyColor: [0.1, 0.11, 0.115],
    specDir: OVERCAST_DIR,
    specColor: [0, 0, 0],
    specRadius: 0.2,
    skyAmbient: [0.085, 0.095, 0.105],
    groundAmbient: [0.018, 0.022, 0.02],
    fogColor: [0.06, 0.068, 0.072],
    fogGlow: [0.015, 0.016, 0.016],
    fogDensity: 0.03,
    fogFalloff: 0.075,
    zenith: [0.055, 0.062, 0.07],
    horizon: [0.09, 0.098, 0.102],
    sunDisc: [0, 0, 0],
    sunGlow: [0, 0, 0],
    sunHorizon: [0, 0, 0],
    sunVis: 0,
    moonVis: 0,
    moonBright: 3.2,
    moonGlow: [0, 0, 0],
    stars: 0,
    cloudCover: 1.0,
    cloudSoft: 0.6,
    cloudDark: [0.045, 0.05, 0.056],
    cloudLit: [0.1, 0.108, 0.115],
    treeLine: [0.045, 0.052, 0.055],
    waterColor: [0.03, 0.034, 0.028],
    waveAmp: 1.25,
    windStrength: 0.75,
    wetness: 1,
    rain: 1,
    fireflies: 0,
    grade: [0.96, 1.0, 1.02],
    saturation: 0.78,
  },
};

export const WEATHER_ORDER = ['night', 'dawn', 'rain'];

const COLOR_KEYS = [
  'grade',
  'keyColor', 'specColor', 'skyAmbient', 'groundAmbient', 'fogColor', 'fogGlow', 'zenith', 'horizon',
  'sunDisc', 'sunGlow', 'sunHorizon', 'moonGlow', 'cloudDark', 'cloudLit', 'treeLine', 'waterColor',
];
const SCALAR_KEYS = [
  'exposure', 'specRadius', 'fogDensity', 'fogFalloff', 'sunVis', 'moonVis', 'moonBright', 'stars', 'cloudCover',
  'cloudSoft', 'waveAmp', 'windStrength', 'wetness', 'rain', 'fireflies', 'saturation',
];
const DIR_KEYS = ['keyDir', 'specDir'];

function snapshot(p) {
  const s = {};
  for (const k of COLOR_KEYS) s[k] = [...p[k]];
  for (const k of SCALAR_KEYS) s[k] = p[k];
  for (const k of DIR_KEYS) s[k] = p[k].clone();
  return s;
}

const smooth = (t) => t * t * (3 - 2 * t);

export class Weather {
  constructor(name = 'night') {
    this.name = name;
    this.state = snapshot(PRESETS[name]);
    this.from = snapshot(PRESETS[name]);
    this.to = PRESETS[name];
    this.t = 1;
    this.duration = 3.5;
    this.listeners = new Set();
  }

  set(name, instant = false) {
    if (!PRESETS[name]) return;
    this.name = name;
    this.from = snapshot(this.state);
    this.to = PRESETS[name];
    this.t = instant ? 1 : 0;
    if (instant) this.state = snapshot(this.to);
    for (const fn of this.listeners) fn(name);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  update(dt) {
    const s = this.state;
    // Directions are live (the moon drifts), so they are refreshed every frame.
    if (this.t >= 1) {
      for (const key of DIR_KEYS) s[key].copy(this.to[key]);
      return;
    }
    this.t = Math.min(1, this.t + dt / this.duration);
    const k = smooth(this.t);
    for (const key of COLOR_KEYS) {
      for (let i = 0; i < 3; i++) s[key][i] = this.from[key][i] + (this.to[key][i] - this.from[key][i]) * k;
    }
    for (const key of SCALAR_KEYS) s[key] = this.from[key] + (this.to[key] - this.from[key]) * k;
    for (const key of DIR_KEYS) s[key].copy(this.from[key]).lerp(this.to[key], k).normalize();
  }

  // Push the current state into every system that depends on it.
  apply({ renderer, sky, water }) {
    const s = this.state;
    const set = (uniform, rgb) => uniform.value.setRGB(rgb[0], rgb[1], rgb[2]);
    renderer.toneMappingExposure = s.exposure;
    shared.uLightDir.value.copy(s.keyDir);
    set(shared.uLightColor, s.keyColor);
    set(shared.uSkyAmbient, s.skyAmbient);
    set(shared.uGroundAmbient, s.groundAmbient);
    set(shared.uFogColor, s.fogColor);
    set(shared.uFogGlow, s.fogGlow);
    shared.uFogDensity.value = s.fogDensity;
    shared.uFogFalloff.value = s.fogFalloff;
    shared.uWindStrength.value = s.windStrength;
    shared.uWetness.value = s.wetness;
    shared.uRain.value = s.rain;
    shared.uGrade.value.set(s.grade[0], s.grade[1], s.grade[2], s.saturation);

    const u = sky.uniforms;
    set(u.uZenith, s.zenith);
    set(u.uHorizon, s.horizon);
    set(u.uSunDisc, s.sunDisc);
    set(u.uSunGlow, s.sunGlow);
    set(u.uSunHorizon, s.sunHorizon);
    u.uSunDir.value.copy(SUN_DIR);
    u.uSunVis.value = s.sunVis;
    u.uMoonVis.value = s.moonVis;
    u.uMoonBright.value = s.moonBright;
    set(u.uMoonGlow, s.moonGlow);
    u.uStars.value = s.stars;
    u.uCloudCover.value = s.cloudCover;
    u.uCloudSoft.value = s.cloudSoft;
    set(u.uCloudDark, s.cloudDark);
    set(u.uCloudLit, s.cloudLit);
    set(u.uTreeLine, s.treeLine);

    const w = water.uniforms;
    set(w.uWaterColor, s.waterColor);
    set(w.uSpecColor, s.specColor);
    w.uSpecDir.value.copy(s.specDir);
    w.uSpecRadius.value = s.specRadius;
    w.uWaveAmp.value = s.waveAmp;
    w.uRainRipples.value = s.rain;
  }
}

