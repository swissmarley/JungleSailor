// Procedural ambience: everything is synthesised with WebAudio, so there are
// no audio files to load. Layers fade with the weather:
//   water (always), night insects / frogs / owl, dawn birds, rain.

function noiseBuffer(ctx, seconds, kind) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'white') {
        data[i] = white * 0.5;
      } else if (kind === 'pink') {
        // Paul Kellet's refined pink filter.
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        brown = (brown + 0.02 * white) / 1.02;
        data[i] = brown * 3.5;
      }
    }
  }
  return buffer;
}

const rand = (a, b) => a + Math.random() * (b - a);

export class Ambience {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 1.0;
    this.timers = { frog: 1, bird: 0.5, owl: 12, drip: 0.2, lap: 0.5 };
    this.mix = { night: 1, dawn: 0, rain: 0 };
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running' && this.enabled;
  }

  async enable() {
    if (!this.ctx) this.build();
    this.enabled = true;
    await this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.volume, t, 0.6);
  }

  disable() {
    this.enabled = false;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.25);
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      if (!this.enabled) this.ctx.suspend();
    }, 1200);
  }

  // Current output level (RMS), used by the HUD test hooks.
  level() {
    if (!this.analyser) return 0;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.sqrt(sum / data.length);
  }

  // Average level (dB) per frequency band, for automated checks.
  bands(edges = [100, 500, 2000, 6000, 12000]) {
    if (!this.analyser) return [];
    const data = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(data);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const out = [];
    for (let b = 0; b < edges.length - 1; b++) {
      let sum = 0;
      let n = 0;
      for (let i = Math.floor(edges[b] / hz); i < Math.min(data.length, Math.floor(edges[b + 1] / hz)); i++) {
        sum += Math.pow(10, data[i] / 10);
        n++;
      }
      out.push(n ? 10 * Math.log10(sum / n + 1e-12) : -120);
    }
    return out;
  }

  build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    comp.connect(this.analyser);

    this.white = noiseBuffer(ctx, 3.3, 'white');
    this.pink = noiseBuffer(ctx, 4.7, 'pink');
    this.brown = noiseBuffer(ctx, 5.9, 'brown');

    this.buildWater();
    this.buildInsects();
    this.buildRain();
  }

  loop(buffer, rate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.loopStart = 0;
    src.start(0, Math.random() * buffer.duration);
    return src;
  }

  lfo(freq, depth, target, type = 'sine') {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(target);
    osc.start();
    return osc;
  }

  buildWater() {
    const ctx = this.ctx;
    // Low murmur of moving water.
    const murmur = this.loop(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const mg = ctx.createGain();
    mg.gain.value = 0.22;
    this.lfo(0.13, 0.07, mg.gain);
    murmur.connect(lp).connect(mg).connect(this.master);

    // Lapping against the hull: band-passed pink noise with slow swells.
    const lap = this.loop(this.pink, 0.9);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650;
    bp.Q.value = 1.1;
    this.lapGain = ctx.createGain();
    this.lapGain.gain.value = 0.0;
    lap.connect(bp).connect(this.lapGain).connect(this.master);

    // Hull swish that grows with speed.
    const swish = this.loop(this.white, 0.8);
    const sb = ctx.createBiquadFilter();
    sb.type = 'bandpass';
    sb.frequency.value = 1400;
    sb.Q.value = 0.7;
    this.swishFilter = sb;
    this.swishGain = ctx.createGain();
    this.swishGain.gain.value = 0;
    swish.connect(sb).connect(this.swishGain).connect(this.master);
  }

  buildInsects() {
    const ctx = this.ctx;
    this.nightBus = ctx.createGain();
    this.nightBus.gain.value = 1;
    this.nightBus.connect(this.master);
    this.dawnBus = ctx.createGain();
    this.dawnBus.gain.value = 0;
    this.dawnBus.connect(this.master);

    // Crickets: a carrier gated by fast pulses, grouped into chirps.
    const voices = [
      { f: 4600, pulse: 31, chirp: 2.3, pan: -0.6, gain: 0.03 },
      { f: 5150, pulse: 27, chirp: 1.7, pan: 0.5, gain: 0.025 },
      { f: 4300, pulse: 35, chirp: 2.9, pan: 0.1, gain: 0.018 },
    ];
    // Soft-edged gates (smoothstep) so the pulses never click.
    const gate = (lo, hi) => {
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = Math.min(Math.max((i / 255 - lo) / (hi - lo), 0), 1);
        curve[i] = x * x * (3 - 2 * x);
      }
      return curve;
    };
    const gateCurve = gate(0.62, 0.82);
    const chirpCurve = gate(0.74, 0.86);
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.frequency.value = v.f;
      const pulseGain = ctx.createGain();
      pulseGain.gain.value = 0;
      const chirpGain = ctx.createGain();
      chirpGain.gain.value = 0;
      const out = ctx.createGain();
      out.gain.value = v.gain;
      const pan = ctx.createStereoPanner();
      pan.pan.value = v.pan;
      osc.connect(pulseGain).connect(chirpGain).connect(out).connect(pan).connect(this.nightBus);
      const shaper = (freq, curve, param, type) => {
        const lfo = ctx.createOscillator();
        lfo.type = type;
        lfo.frequency.value = freq;
        const ws = ctx.createWaveShaper();
        ws.curve = curve;
        lfo.connect(ws).connect(param);
        lfo.start();
        return lfo;
      };
      shaper(v.pulse, gateCurve, pulseGain.gain, 'sine');
      shaper(v.chirp, chirpCurve, chirpGain.gain, 'sawtooth');
      // Drift so the choir never locks into a pattern.
      this.lfo(0.05 + Math.random() * 0.05, v.gain * 0.6, out.gain);
      osc.start();
    }

    // A high, airy bed of distant insects.
    const bed = this.loop(this.white, 1);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 7200;
    hp.Q.value = 2.5;
    const bg = ctx.createGain();
    bg.gain.value = 0.035;
    this.lfo(0.21, 0.015, bg.gain);
    bed.connect(hp).connect(bg).connect(this.nightBus);

    // Dawn birds share a small reverb-ish delay for space.
    this.space = ctx.createDelay(1);
    this.space.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2500;
    this.space.connect(damp).connect(fb).connect(this.space);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.space.connect(wet).connect(this.master);
  }

  buildRain() {
    const ctx = this.ctx;
    this.rainBus = ctx.createGain();
    this.rainBus.gain.value = 0;
    this.rainBus.connect(this.master);
    const hiss = this.loop(this.pink, 1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.4;
    const hg = ctx.createGain();
    hg.gain.value = 0.55;
    hiss.connect(bp).connect(hg).connect(this.rainBus);
    const leaves = this.loop(this.white, 0.7);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4500;
    const lg = ctx.createGain();
    lg.gain.value = 0.12;
    this.lfo(0.4, 0.04, lg.gain);
    leaves.connect(hp).connect(lg).connect(this.rainBus);
    const roar = this.loop(this.brown, 1.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const rg = ctx.createGain();
    rg.gain.value = 0.25;
    roar.connect(lp).connect(rg).connect(this.rainBus);
  }

  // One-shot voices --------------------------------------------------------

  envelope(gain, t, attack, hold, release, peak) {
    gain.setValueAtTime(0, t);
    gain.linearRampToValueAtTime(peak, t + attack);
    gain.setValueAtTime(peak, t + attack + hold);
    gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  voice(type, bus, pan) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(g).connect(p).connect(bus);
    return { osc, g, p };
  }

  frog() {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const base = rand(260, 520);
    const pan = rand(-0.9, 0.9);
    const croaks = Math.random() < 0.5 ? 2 : 3;
    for (let i = 0; i < croaks; i++) {
      const { osc, g } = this.voice('sawtooth', this.nightBus, pan);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = base * 2.2;
      bp.Q.value = 3;
      // Fast amplitude flutter (0..1) before the envelope gives the throaty rasp.
      const rasp = ctx.createGain();
      rasp.gain.value = 0.5;
      osc.disconnect();
      osc.connect(bp).connect(rasp).connect(g);
      const start = t + i * rand(0.13, 0.19);
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.linearRampToValueAtTime(base * 0.86, start + 0.09);
      this.envelope(g.gain, start, 0.01, 0.05, 0.06, rand(0.03, 0.07));
      const am = ctx.createOscillator();
      am.frequency.value = rand(22, 34);
      const amg = ctx.createGain();
      amg.gain.value = 0.5;
      am.connect(amg).connect(rasp.gain);
      am.start(start);
      am.stop(start + 0.2);
      osc.start(start);
      osc.stop(start + 0.2);
    }
  }

  owl() {
    const t = this.ctx.currentTime + 0.05;
    const pan = rand(-0.7, 0.7);
    const notes = [
      [0, 0.32, 395],
      [0.55, 0.22, 380],
      [0.85, 0.5, 372],
    ];
    for (const [dt, len, f] of notes) {
      const { osc, g } = this.voice('sine', this.nightBus, pan);
      osc.frequency.setValueAtTime(f * 1.02, t + dt);
      osc.frequency.linearRampToValueAtTime(f * 0.97, t + dt + len);
      this.envelope(g.gain, t + dt, 0.06, len * 0.5, len * 0.5, 0.045);
      osc.start(t + dt);
      osc.stop(t + dt + len + 0.3);
    }
  }

  bird() {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const pan = rand(-0.9, 0.9);
    const notes = Math.floor(rand(3, 8));
    const base = rand(2400, 4200);
    const style = Math.floor(rand(0, 3));
    for (let i = 0; i < notes; i++) {
      const { osc, g } = this.voice('sine', this.dawnBus, pan);
      g.connect(this.space);
      const start = t + i * rand(0.09, 0.16);
      const f0 = base * rand(0.9, 1.15);
      const f1 = style === 0 ? f0 * 1.4 : style === 1 ? f0 * 0.7 : f0 * rand(0.85, 1.3);
      osc.frequency.setValueAtTime(f0, start);
      osc.frequency.exponentialRampToValueAtTime(f1, start + 0.07);
      this.envelope(g.gain, start, 0.008, 0.03, 0.05, rand(0.012, 0.03));
      osc.start(start);
      osc.stop(start + 0.15);
    }
  }

  drip() {
    const { osc, g } = this.voice('sine', this.rainBus, rand(-0.8, 0.8));
    const t = this.ctx.currentTime + 0.01;
    const f = rand(900, 2600);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.05);
    this.envelope(g.gain, t, 0.002, 0.004, 0.06, rand(0.01, 0.035));
    osc.start(t);
    osc.stop(t + 0.1);
  }

  // Paddle blade entering the water: a soft, deep plunge.
  splash(strength = 1) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1300, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.25);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    this.envelope(g.gain, t, 0.012, 0.03, 0.32, 0.22 * strength);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.3, 0.3);
    src.connect(bp).connect(g).connect(pan).connect(this.master);
    src.start(t, Math.random() * 3, 0.45);
    // A gulp of air as the blade buries.
    const { osc, g: og } = this.voice('sine', this.master, 0);
    osc.frequency.setValueAtTime(rand(240, 320), t);
    osc.frequency.exponentialRampToValueAtTime(rand(90, 120), t + 0.12);
    this.envelope(og.gain, t, 0.004, 0.01, 0.1, 0.05 * strength);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // Drips running off the blade as it lifts out.
  trickle() {
    if (!this.running) return;
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const { osc, g } = this.voice('sine', this.master, rand(-0.4, 0.4));
      const t = this.ctx.currentTime + 0.05 + i * rand(0.06, 0.14);
      const f = rand(1100, 2400);
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.04);
      this.envelope(g.gain, t, 0.002, 0.003, 0.05, rand(0.008, 0.02));
      osc.start(t);
      osc.stop(t + 0.08);
    }
  }

  // A glassy bell when a lotus blossom is gathered.
  chime() {
    if (!this.running) return;
    const t = this.ctx.currentTime + 0.01;
    const base = [659.3, 830.6, 987.8, 1318.5][Math.floor(Math.random() * 4)];
    [1, 2.0, 2.76, 5.4].forEach((ratio, i) => {
      const { osc, g } = this.voice('sine', this.master, rand(-0.2, 0.2));
      g.connect(this.space);
      osc.frequency.value = base * ratio;
      this.envelope(g.gain, t + i * 0.012, 0.004, 0.02, 1.6 / (1 + i * 0.6), 0.07 / (1 + i));
      osc.start(t);
      osc.stop(t + 2);
    });
  }

  // A hollow wooden knock when the hull bumps the bank.
  knock(strength) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const { osc, g } = this.voice('sine', this.master, 0);
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(95, t + 0.18);
    this.envelope(g.gain, t, 0.003, 0.01, 0.25, 0.22 * strength);
    osc.start(t);
    osc.stop(t + 0.35);
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    const ng = ctx.createGain();
    this.envelope(ng.gain, t, 0.002, 0.005, 0.12, 0.25 * strength);
    src.connect(ng).connect(this.master);
    src.start(t, Math.random() * 3, 0.2);
  }

  // Called every frame with the current weather state and boat speed.
  update({ night, dawn, rain, speed }) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    const quietInsects = 1 - 0.75 * rain;
    this.nightBus.gain.setTargetAtTime(Math.max(night, 0.15 * dawn) * quietInsects + 0.1 * rain, t, 0.5);
    this.dawnBus.gain.setTargetAtTime(dawn * (1 - rain), t, 0.5);
    this.rainBus.gain.setTargetAtTime(rain * 0.9, t, 0.5);
    const s = Math.min(Math.abs(speed) / 4, 1);
    this.swishGain.gain.setTargetAtTime(0.02 + 0.16 * s * s, t, 0.3);
    this.swishFilter.frequency.setTargetAtTime(900 + 1400 * s, t, 0.3);

    // Event timers run on the audio clock, independent of the frame rate.
    const elapsed = Math.min(Math.max(t - (this.lastTime ?? t), 0), 1);
    this.lastTime = t;
    const tm = this.timers;
    for (const k of Object.keys(tm)) tm[k] -= elapsed;
    if (tm.lap <= 0) {
      tm.lap = rand(0.6, 2.2);
      const g = this.lapGain.gain;
      g.setTargetAtTime(rand(0.05, 0.16) * (1 + s), t, 0.25);
      g.setTargetAtTime(0.02, t + rand(0.4, 0.9), 0.5);
    }
    if (tm.frog <= 0) {
      tm.frog = rand(0.5, 2.6) / Math.max(night + rain * 0.8, 0.05);
      if (night + rain > 0.2) this.frog();
    }
    if (tm.owl <= 0) {
      tm.owl = rand(22, 45);
      if (night > 0.6 && rain < 0.2) this.owl();
    }
    if (tm.bird <= 0) {
      tm.bird = rand(0.35, 1.6) / Math.max(dawn, 0.05);
      if (dawn > 0.3 && rain < 0.5) this.bird();
    }
    if (tm.drip <= 0) {
      tm.drip = rand(0.03, 0.12);
      if (rain > 0.3) this.drip();
    }
  }
}
