import { ACESFilmicToneMapping, PerspectiveCamera, Quaternion, Scene, SRGBColorSpace, Timer, Vector3, WebGLRenderer } from 'three';
import './style.css';
import { Ambience } from './audio/Ambience.js';
import { Character } from './character/Character.js';
import { Stroke } from './character/Stroke.js';
import { detectQuality } from './core/quality.js';
import { Fireflies } from './effects/Fireflies.js';
import { Rain } from './effects/Rain.js';
import { shared } from './shaders/common.js';
import { Hud } from './ui/Hud.js';
import { Input } from './ui/Input.js';
import { Forest } from './vegetation/Forest.js';
import { createLeafAtlas } from './vegetation/leafAtlas.js';
import { PlanarReflection } from './water/PlanarReflection.js';
import { Water } from './water/Water.js';
import { WakeSim } from './water/WakeSim.js';
import { WaveTexture } from './water/WaveTexture.js';
import { Boat, createBoatMesh } from './world/Boat.js';
import { FollowCamera } from './world/FollowCamera.js';
import { LotusField } from './world/Lotus.js';
import { createMoonTexture } from './world/moonTexture.js';
import { Sky } from './world/Sky.js';
import { Celestial, MOON_DIR, Weather } from './world/Weather.js';
import { World } from './world/World.js';

const loader = document.getElementById('loader');
const loaderSub = document.getElementById('loader-sub');

function fail(message) {
  loaderSub.textContent = message;
  loader.classList.remove('done');
}

function start() {
  const quality = detectQuality();
  const canvas = document.getElementById('scene');
  let renderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    fail('This ride needs WebGL 2, which this browser could not provide.');
    console.error(err);
    return;
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 1);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fail('The graphics context was lost. Reload the page to continue.');
  });

  const params = new URLSearchParams(location.search);
  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.1, 1600);
  camera.layers.enable(1); // layer 1: drawn in the main view only, not mirrored

  // Textures baked at startup.
  const moonTexture = createMoonTexture(renderer, quality.moonSize);
  const atlas = createLeafAtlas(quality.atlasSize);

  const sky = new Sky(moonTexture);
  sky.setMoonDirection(MOON_DIR);
  scene.add(sky.mesh);

  const forest = new Forest({
    atlas,
    density: quality.vegetation,
    maxChunks: quality.ahead + quality.behind + 3,
    alphaToCoverage: quality.antialias,
  });
  const lotus = new LotusField();
  scene.add(lotus.group);
  const world = new World({ forest, ahead: quality.ahead, behind: quality.behind, extras: [lotus] });
  scene.add(world.group);

  const boatMesh = createBoatMesh();
  scene.add(boatMesh);
  const startZ = parseFloat(params.get('z'));
  const boat = new Boat(Number.isFinite(startZ) ? startZ : 0);
  const stroke = new Stroke();
  const character = new Character();
  boatMesh.add(character.group);

  const waves = new WaveTexture(renderer, { size: quality.waveSize });
  const sim = new WakeSim(renderer, { size: quality.simSize, world: quality.simWorld });
  const reflection = new PlanarReflection({ scale: quality.reflectionScale });
  const water = new Water({ waves, reflection, sim });
  water.uniforms.uDebugView.value = { refl: 1, mask: 2, normal: 3, fresnel: 4, slope: 5, waves: 6, view: 7 }[params.get('view')] ?? 0;
  scene.add(water.mesh);

  const rain = new Rain({ grid: quality.rainGrid });
  scene.add(rain.mesh);
  const fireflies = new Fireflies({ count: quality.fireflies });
  scene.add(fireflies.points);

  const initialWeather = ['night', 'dawn', 'rain'].includes(params.get('weather')) ? params.get('weather') : 'night';
  const weather = new Weather(initialWeather);
  const follow = new FollowCamera(camera);
  const celestial = new Celestial();
  const audio = new Ambience();
  const input = new Input({
    surface: canvas,
    stick: document.getElementById('stick'),
    knob: document.getElementById('knob'),
  });
  const hud = new Hud({ weather, audio, touch: quality.touch });
  input.on(() => hud.nudge());
  boat.onBump = (strength) => {
    audio.knock(strength);
    character.bump(strength);
  };

  // Resolution: start at the tier's ceiling, let the governor adjust.
  let pixelRatio = quality.fixedPixelRatio ?? Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
  const size = { w: 1, h: 1 };
  function resize() {
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    reflection.setSize(size.w * pixelRatio, size.h * pixelRatio);
  }
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  resize();

  const governor = { time: 0, frames: 0, warmup: 2.5 };
  function govern(dt) {
    if (quality.fixedPixelRatio) return;
    governor.time += dt;
    governor.frames++;
    if (governor.time < 1.5) return;
    const fps = governor.frames / governor.time;
    governor.time = 0;
    governor.frames = 0;
    if (governor.warmup > 0) {
      governor.warmup -= 1.5;
      return;
    }
    const ceiling = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
    let next = pixelRatio;
    if (fps < 48) next = Math.max(quality.minPixelRatio, pixelRatio - (fps < 30 ? 0.25 : 0.12));
    else if (fps > 58) next = Math.min(ceiling, pixelRatio + 0.08);
    if (Math.abs(next - pixelRatio) > 0.01) {
      pixelRatio = next;
      resize();
    }
  }

  // First frame: build the visible river at once.
  boat.applyTo(boatMesh);
  follow.update(0, boat, true);
  camera.updateMatrixWorld();
  const viewDir = new Vector3();
  camera.getWorldDirection(viewDir);
  world.update(camera.position.z, viewDir.z, Infinity);
  celestial.update(0, camera.position.x, camera.position.z);
  sky.setMoonDirection(MOON_DIR);
  weather.update(0);
  weather.apply({ renderer, sky, water });

  const debugCam = params.get('cam');
  const debugLook = new Vector3();
  const interestPoint = new Vector3();
  const moonLocal = new Vector3();
  const boatQuatInv = new Quaternion();
  const bladeWorld = new Vector3();
  const timer = new Timer();
  timer.connect(document);
  let time = 0;
  let frameCount = 0;
  let fpsSmoothed = 60;

  function frame(timestamp) {
    requestAnimationFrame(frame);
    timer.update(timestamp);
    // The first rAF timestamp can predate the timer, so never step backwards.
    const rawDt = Math.max(0, timer.getDelta());
    const dt = Math.min(rawDt, 1 / 20);
    time += dt;
    shared.uTime.value = time;
    if (rawDt > 0) fpsSmoothed += (1 / rawDt - fpsSmoothed) * 0.05;

    // Input -> paddle stroke -> water reaction on the boat -> body pose.
    const command = input.read();
    boat.steerInput(dt, command);
    stroke.update(dt, boat.throttle, boat.steer, boat.u);
    boat.update(dt, stroke);
    boat.applyTo(boatMesh);
    boatMesh.updateMatrixWorld();
    for (const event of stroke.events) {
      if (event === 'catch') audio.splash(0.6 + 0.4 * Math.min(Math.abs(boat.throttle) + 0.3, 1));
      else audio.trickle();
    }
    follow.update(dt, boat);
    if (debugCam) {
      // Fixed vantage points around the boat for close inspection.
      const views = {
        side: [[3.2, 1.3, -0.4], [0, 0.6, 0.4]],
        front: [[0, 1.5, -3.6], [0, 0.6, 0.4]],
        close: [[1.6, 1.6, 2.6], [0, 0.6, 0.4]],
        top: [[0.01, 5.5, 0.3], [0, 0.6, 0.4]],
        water: [[2.2, 1.1, 1.8], [2.6, 0, -1.5]],
        figure: [[1.25, 1.2, -0.85], [0, 0.72, 0.55]],
        back: [[0.7, 1.45, 2.3], [0, 0.85, 0.6]],
        face: [[0.22, 1.12, -0.18], [0, 1.04, 0.64]],
        hand: [[stroke.lower.x * 1.5 + 0.1, stroke.lower.y + 0.25, stroke.lower.z - 0.45], stroke.lower.toArray()],
      };
      const v = views[debugCam];
      if (v) {
        camera.position.fromArray(v[0]);
        boatMesh.localToWorld(camera.position);
        camera.lookAt(boatMesh.localToWorld(debugLook.fromArray(v[1])));
      }
    }
    camera.updateMatrixWorld();
    camera.getWorldDirection(viewDir);
    world.update(camera.position.z, viewDir.z, 1);

    celestial.update(dt, camera.position.x, camera.position.z);
    sky.setMoonDirection(MOON_DIR);
    weather.update(dt);
    weather.apply({ renderer, sky, water });

    const bufferHeight = size.h * pixelRatio;
    const s = weather.state;
    const gathered = lotus.update(dt, time, boat, boatMesh, (0.35 + 0.65 * s.moonVis) * (1 - 0.3 * s.rain) + 0.25 * s.rain, bufferHeight);
    if (gathered.collected) {
      audio.chime();
      character.cheer();
    }
    hud.setLotus(lotus.count);
    let interest = null;
    if (gathered.nearest) {
      interest = boatMesh.worldToLocal(interestPoint.set(gathered.nearest.x, 0.15, gathered.nearest.z));
      if (interest.z > 1.5 || interest.length() > 11) interest = null;
    }
    moonLocal.copy(MOON_DIR).applyQuaternion(boatQuatInv.copy(boatMesh.quaternion).invert());
    character.update(dt, {
      stroke,
      boat,
      weather: { night: s.moonVis, dawn: s.sunVis, rain: s.rain },
      moonLocal: s.moonVis > 0.5 ? moonLocal : null,
      interest,
    });

    waves.update(time);
    bladeWorld.copy(stroke.blade);
    boatMesh.localToWorld(bladeWorld);
    sim.update(
      dt,
      { x: boat.x, z: boat.z, heading: boat.heading, heave: boat.heave },
      { x: bladeWorld.x, z: bladeWorld.z, depth: stroke.submerged * 0.2 },
    );
    water.update(camera, boatMesh);
    rain.update(camera, boatMesh, bufferHeight);
    fireflies.update(camera, weather.state.fireflies, bufferHeight * reflection.scale);

    // Mirror pass: no water, no moon/sun discs (the water draws their glitter).
    water.mesh.visible = false;
    sky.uniforms.uDiscs.value = 0;
    shared.uReflPass.value = 1;
    reflection.render(renderer, scene, camera);
    water.mesh.visible = true;
    sky.uniforms.uDiscs.value = 1;
    shared.uReflPass.value = 0;

    fireflies.setViewportHeight(bufferHeight);
    renderer.render(scene, camera);

    hud.setDistance(boat.distance);
    audio.update({
      night: weather.state.moonVis,
      dawn: weather.state.sunVis,
      rain: weather.state.rain,
      speed: boat.speed,
    });
    govern(rawDt);

    frameCount++;
    if (frameCount === 3) loader.classList.add('done');
  }
  requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    if (!audio.ctx) return;
    if (document.hidden) audio.ctx.suspend();
    else if (audio.enabled) audio.ctx.resume();
  });

  // Small read-only hook used by the automated checks (and handy in devtools).
  window.__jungle = {
    get state() {
      return {
        frame: frameCount,
        time,
        fps: fpsSmoothed,
        pixelRatio,
        quality: quality.name,
        weather: weather.name,
        weatherBlend: weather.t,
        distance: boat.distance,
        speed: boat.speed,
        heading: boat.heading,
        position: { x: boat.x, z: boat.z },
        throttle: boat.throttle,
        steer: boat.steer,
        lotus: lotus.count,
        paddler: { state: stroke.state, side: stroke.side, phase: stroke.phase, submerged: stroke.submerged, force: stroke.force },
        chunks: world.loadedCount,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        audio: { enabled: audio.enabled, state: audio.ctx?.state ?? 'none', level: audio.level() },
        distanceText: document.getElementById('distance').textContent,
      };
    },
    setWeather: (name, instant = false) => weather.set(name, instant),
    audioBands: () => audio.bands(),
    audio,
  };
}

// Let the loader paint before the heavy procedural work begins.
requestAnimationFrame(() => setTimeout(start, 30));
