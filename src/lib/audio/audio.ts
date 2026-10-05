import type { VehicleProfile } from '../sim/profiles';

type SoundKind = VehicleProfile['sound'];
type HornKind = VehicleProfile['horn'];

export interface AudioFrame {
  v: number;
  /** traction effort -1..1 (negative = braking) */
  effort: number;
  brakeNotchFrac: number;
  inTunnel: boolean;
  rain: number;
  dt: number;
  s: number;
}

/**
 * Fully synthesised sound: no audio files, works offline, tiny.
 * Continuous layers are crossfaded with setTargetAtTime for smoothness.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;
  // layers
  private motorA!: OscillatorNode;
  private motorB!: OscillatorNode;
  private whine!: OscillatorNode;
  private motorFilter!: BiquadFilterNode;
  private motorGain!: GainNode;
  private whineGain!: GainNode;
  private rollFilter!: BiquadFilterNode;
  private rollGain!: GainNode;
  private dieselOsc!: OscillatorNode;
  private pulseOsc!: OscillatorNode;
  private pulseGain!: GainNode;
  private pulseFilter!: BiquadFilterNode;
  private turboOsc!: OscillatorNode;
  private turboGain!: GainNode;
  private gearOsc!: OscillatorNode;
  private gearGain!: GainNode;
  private dieselSub!: OscillatorNode;
  private dieselFilter!: BiquadFilterNode;
  private dieselGain!: GainNode;
  private rainGain!: GainNode;
  private rainFilter!: BiquadFilterNode;
  private squealOsc!: OscillatorNode;
  private squealGain!: GainNode;

  private kind: SoundKind = 'electric';
  private horn: HornKind = 'metro';
  private rail = true;
  private carLength = 20;
  private lastJoint = 0;
  private gear = 1;
  private enabled = true;
  private volume = 0.8;
  private voice: SpeechSynthesisVoice | null = null;
  announcements = true;

  get ready() {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp).connect(ctx.destination);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(1.9);
    this.wet.connect(conv).connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // a touch of brown for body
      d[i] = w * 0.6 + b * 2.4;
    }

    const bus = (g: GainNode) => {
      g.connect(this.dry);
      g.connect(this.wet);
    };

    // electric motor (VVVF-ish)
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'bandpass';
    this.motorFilter.Q.value = 2.5;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorA = ctx.createOscillator();
    this.motorA.type = 'sawtooth';
    this.motorB = ctx.createOscillator();
    this.motorB.type = 'square';
    const mbg = ctx.createGain();
    mbg.gain.value = 0.35;
    this.motorA.connect(this.motorFilter);
    this.motorB.connect(mbg).connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain);
    bus(this.motorGain);
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain);
    bus(this.whineGain);

    // rolling noise
    const roll = this.noiseSource();
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 300;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    roll.connect(this.rollFilter).connect(this.rollGain);
    bus(this.rollGain);

    // diesel
    this.dieselOsc = ctx.createOscillator();
    this.dieselOsc.type = 'sawtooth';
    this.dieselSub = ctx.createOscillator();
    this.dieselSub.type = 'square';
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.distortion(18);
    this.dieselFilter = ctx.createBiquadFilter();
    this.dieselFilter.type = 'lowpass';
    this.dieselFilter.frequency.value = 500;
    this.dieselGain = ctx.createGain();
    this.dieselGain.gain.value = 0;
    const subg = ctx.createGain();
    subg.gain.value = 0.5;
    this.dieselOsc.connect(shaper);
    this.dieselSub.connect(subg).connect(shaper);
    shaper.connect(this.dieselFilter).connect(this.dieselGain);
    bus(this.dieselGain);

    // combustion: filtered noise chopped at the cylinder firing rate gives the "chug"
    const pulseNoise = this.noiseSource();
    this.pulseFilter = ctx.createBiquadFilter();
    this.pulseFilter.type = 'bandpass';
    this.pulseFilter.frequency.value = 520;
    this.pulseFilter.Q.value = 0.9;
    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.type = 'square';
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    this.pulseOsc.connect(depth).connect(chop.gain);
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    pulseNoise.connect(this.pulseFilter).connect(chop).connect(this.pulseGain);
    bus(this.pulseGain);

    // turbocharger whistle rising with load
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain);
    bus(this.turboGain);

    // electric traction: gear-mesh whine of the final drive
    this.gearOsc = ctx.createOscillator();
    this.gearOsc.type = 'triangle';
    const gearBp = ctx.createBiquadFilter();
    gearBp.type = 'bandpass';
    gearBp.Q.value = 6;
    gearBp.frequency.value = 1800;
    this.gearGain = ctx.createGain();
    this.gearGain.gain.value = 0;
    this.gearOsc.connect(gearBp).connect(this.gearGain);
    bus(this.gearGain);

    // rain
    const rain = this.noiseSource();
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 3200;
    this.rainFilter.Q.value = 0.4;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(this.rainFilter).connect(this.rainGain).connect(this.dry);

    // brake squeal
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'sine';
    this.squealOsc.frequency.value = 2900;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealOsc.connect(this.squealGain);
    bus(this.squealGain);

    for (const o of [this.motorA, this.motorB, this.whine, this.dieselOsc, this.dieselSub, this.squealOsc, this.pulseOsc, this.turboOsc, this.gearOsc]) o.start();
    this.pickVoice();
  }

  private noiseSource() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 1.5);
    return src;
  }

  private impulse(seconds: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  private distortion(k: number) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  setVehicle(p: VehicleProfile) {
    this.kind = p.sound;
    this.horn = p.horn;
    this.rail = p.rail;
    this.carLength = p.carLength;
    this.gear = 1;
  }

  setEnabled(on: boolean, volume: number) {
    this.enabled = on;
    this.volume = volume;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? volume : 0, this.ctx.currentTime, 0.05);
    if (!on) this.clearSpeech();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
    this.clearSpeech();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Silences continuous layers (menu screens). */
  idle() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.motorGain, this.whineGain, this.rollGain, this.dieselGain, this.rainGain, this.squealGain, this.pulseGain, this.turboGain, this.gearGain]) g.gain.setTargetAtTime(0, t, 0.25);
    this.hornStop();
    this.wet.gain.setTargetAtTime(0, t, 0.3);
  }

  update(f: AudioFrame) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const T = 0.08;
    const v = f.v;
    const kmh = v * 3.6;
    const eff = Math.abs(f.effort);
    const electric = this.kind === 'electric' || this.kind === 'trolley';

    if (electric) {
      // VVVF: rising "scale" at low speed, then a steadier tone
      let fa: number;
      if (kmh < 12) fa = 260 + kmh * 55;
      else if (kmh < 30) fa = 420 + (kmh - 12) * 34;
      else fa = 380 + kmh * 7.5;
      const gain = (this.kind === 'trolley' ? 0.05 : 0.07) * Math.min(1, v * 1.4) * (0.22 + eff * 1.1);
      this.motorA.frequency.setTargetAtTime(fa, t, T);
      this.motorB.frequency.setTargetAtTime(fa * (kmh < 30 ? 1.5 : 2), t, T);
      this.motorFilter.frequency.setTargetAtTime(fa * 1.6, t, T);
      this.motorGain.gain.setTargetAtTime(gain, t, T);
      this.whine.frequency.setTargetAtTime(900 + kmh * 22, t, T);
      this.whineGain.gain.setTargetAtTime(0.012 * Math.min(1, v) * (0.3 + eff), t, T);
      this.dieselGain.gain.setTargetAtTime(0, t, T);
      this.pulseGain.gain.setTargetAtTime(0, t, T);
      this.turboGain.gain.setTargetAtTime(0, t, T);
      this.gearOsc.frequency.setTargetAtTime(40 + kmh * 26, t, T);
      this.gearGain.gain.setTargetAtTime(0.02 * Math.min(1, v / 3) * (0.35 + eff * 0.9), t, T);
    } else {
      this.motorGain.gain.setTargetAtTime(0, t, T);
      this.whineGain.gain.setTargetAtTime(0, t, T);
      // gearbox
      const ship = this.kind === 'ship';
      const tops = ship ? [0, 99] : [0, 4.5, 8.5, 13, 19, 99];
      if (!ship) {
        while (this.gear < tops.length - 1 && v > tops[this.gear] * 0.98) this.gear++;
        while (this.gear > 1 && v < tops[this.gear - 1] * 0.75) this.gear--;
      }
      const lo = ship ? 0 : tops[this.gear - 1];
      const hi = ship ? 9 : tops[this.gear];
      const frac = Math.min(1, Math.max(0, (v - lo * 0.75) / Math.max(1, hi - lo * 0.75)));
      const rpm = 650 + frac * 1300 + eff * 200 * (f.effort > 0 ? 1 : 0);
      const fire = (rpm / 60) * (ship ? 2 : 3);
      this.dieselOsc.frequency.setTargetAtTime(fire, t, 0.12);
      this.dieselSub.frequency.setTargetAtTime(fire / 2, t, 0.12);
      this.dieselFilter.frequency.setTargetAtTime(ship ? 260 + eff * 200 : 380 + Math.max(0, f.effort) * 700, t, 0.12);
      this.dieselGain.gain.setTargetAtTime((ship ? 0.12 : 0.06) * (0.55 + Math.max(0, f.effort) * 0.9), t, 0.15);
      const load = Math.max(0, f.effort);
      this.pulseOsc.frequency.setTargetAtTime(fire, t, 0.1);
      this.pulseFilter.frequency.setTargetAtTime((ship ? 260 : 420) + rpm * 0.18 + load * 500, t, 0.12);
      this.pulseGain.gain.setTargetAtTime((ship ? 0.22 : 0.16) * (0.45 + load * 0.9), t, 0.12);
      this.turboOsc.frequency.setTargetAtTime(1600 + rpm * 1.1 + load * 900, t, 0.3);
      this.turboGain.gain.setTargetAtTime(ship ? 0 : 0.006 + load * 0.014 * Math.min(1, rpm / 1400), t, 0.35);
      this.gearGain.gain.setTargetAtTime(0, t, T);
    }

    // rolling / water
    const rollMax = this.kind === 'ship' ? 0.16 : this.rail ? 0.2 : 0.12;
    let rg = Math.min(rollMax, v * 0.011);
    if (f.inTunnel) rg *= 1.9;
    this.rollFilter.frequency.setTargetAtTime(this.kind === 'ship' ? 500 + v * 30 : 180 + v * 32, t, T);
    this.rollGain.gain.setTargetAtTime(rg, t, T);
    this.wet.gain.setTargetAtTime(f.inTunnel ? 0.55 : 0.04, t, 0.4);

    // squeal at the very end of a braking stop
    const sq = this.rail && v > 0.15 && v < 3 && f.brakeNotchFrac > 0.35 ? 0.018 * (1 - v / 3) : 0;
    this.squealGain.gain.setTargetAtTime(sq, t, 0.06);
    this.squealOsc.frequency.setTargetAtTime(2700 + Math.sin(t * 7) * 140, t, 0.05);

    // rain on the roof
    this.rainGain.gain.setTargetAtTime(f.inTunnel ? 0 : f.rain * 0.06, t, 0.5);

    // rail joints: clickety-clack
    if (this.rail && this.kind !== 'ship' && v > 1.2) {
      const jointEvery = 25;
      const j = Math.floor(f.s / jointEvery);
      if (j !== this.lastJoint) {
        this.lastJoint = j;
        const offs = [0, 2.5, this.carLength - 2.5, this.carLength, this.carLength * 2 - 2.5, this.carLength * 2];
        for (const o of offs) this.click(t + o / v, 0.18 * Math.min(1, v / 14) * (f.inTunnel ? 1.5 : 1));
      }
    }
  }

  private click(at: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 300;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    src.connect(bp).connect(g);
    g.connect(this.dry);
    g.connect(this.wet);
    src.start(at, Math.random());
    src.stop(at + 0.1);
    const th = ctx.createOscillator();
    th.frequency.value = 70;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, at);
    tg.gain.linearRampToValueAtTime(gain * 0.9, at + 0.005);
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    th.connect(tg).connect(this.dry);
    th.start(at);
    th.stop(at + 0.1);
  }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; at?: number; attack?: number; endFreq?: number; filter?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const at = opts.at ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, at);
    if (opts.endFreq) o.frequency.exponentialRampToValueAtTime(opts.endFreq, at + dur);
    const g = ctx.createGain();
    const peak = opts.gain ?? 0.2;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + (opts.attack ?? 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node: AudioNode = o;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      o.connect(f);
      node = f;
    }
    node.connect(g).connect(this.dry);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private noiseBurst(dur: number, freq: number, type: BiquadFilterType, gain: number, at?: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = at ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.dry);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------ one-shots
  // ------------------------------------------------------------ horns (held)
  private hornVoices: { stop: (at: number) => void }[] = [];
  private hornTimer = 0;
  private bellTimer = 0;

  /** A resonant horn voice: oscillator(s) through a body filter with an attack/release envelope. */
  private hornVoice(freq: number, opts: { type: OscillatorType; gain: number; q: number; formant: number; attack: number; release: number; bend?: number; vibrato?: number; drive?: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = opts.type;
    // air horns "bloom" up to pitch as pressure builds
    o.frequency.setValueAtTime(freq * (1 - (opts.bend ?? 0)), t);
    o.frequency.exponentialRampToValueAtTime(freq, t + Math.max(0.02, opts.attack * 1.4));
    let lfo: OscillatorNode | null = null;
    if (opts.vibrato) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const lg = ctx.createGain();
      lg.gain.value = freq * opts.vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
    }
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = opts.formant;
    body.Q.value = opts.q;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = Math.min(9000, opts.formant * 3.2);
    let src: AudioNode = o;
    if (opts.drive) {
      const sh = ctx.createWaveShaper();
      sh.curve = this.distortion(opts.drive);
      o.connect(sh);
      src = sh;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + opts.attack);
    src.connect(body).connect(air).connect(g);
    g.connect(this.dry);
    g.connect(this.wet);
    o.start(t);
    return {
      stop: (at: number) => {
        g.gain.cancelScheduledValues(at);
        g.gain.setValueAtTime(g.gain.value, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + opts.release);
        o.frequency.setTargetAtTime(freq * (1 - (opts.bend ?? 0) * 0.6), at, opts.release / 2);
        o.stop(at + opts.release + 0.05);
        lfo?.stop(at + opts.release + 0.05);
      },
    };
  }

  private bell() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // inharmonic partials of a struck bell
    for (const [r, g, d] of [
      [1, 0.15, 1.3],
      [2.76, 0.08, 0.9],
      [5.4, 0.05, 0.6],
      [8.93, 0.025, 0.4],
    ] as const) {
      this.tone(1180 * r, d, { gain: g, at: t, attack: 0.002 });
      this.tone(1180 * r, d * 0.8, { gain: g * 0.7, at: t + 0.16, attack: 0.002 });
    }
  }

  hornStart() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    if (this.hornVoices.length) return;
    window.clearTimeout(this.hornTimer);
    switch (this.horn) {
      case 'bus':
        // two-tone electric car/bus horn: harsh, buzzy, instant
        for (const [f, g] of [
          [415, 0.11],
          [523, 0.09],
        ] as const)
          this.hornVoices.push(this.hornVoice(f, { type: 'square', gain: g, q: 2.2, formant: f * 2.6, attack: 0.012, release: 0.06, drive: 6 }));
        break;
      case 'metro':
        // electronic two-tone warning horn of a modern EMU
        for (const [f, g] of [
          [740, 0.07],
          [932, 0.055],
        ] as const)
          this.hornVoices.push(this.hornVoice(f, { type: 'triangle', gain: g, q: 1.4, formant: f * 1.5, attack: 0.03, release: 0.12, vibrato: 0.004 }));
        break;
      case 'train':
        // three-chime air horn: rich, resonant, blooms up to pitch
        for (const [f, g] of [
          [277, 0.085],
          [349, 0.075],
          [415, 0.07],
        ] as const)
          this.hornVoices.push(this.hornVoice(f, { type: 'sawtooth', gain: g, q: 5, formant: f * 2, attack: 0.14, release: 0.45, bend: 0.06, vibrato: 0.003 }));
        break;
      case 'ship':
        for (const [f, g] of [
          [87, 0.14],
          [110, 0.1],
        ] as const)
          this.hornVoices.push(this.hornVoice(f, { type: 'sawtooth', gain: g, q: 3, formant: f * 3, attack: 0.35, release: 0.9, bend: 0.04 }));
        break;
      case 'tram':
        // trams ring a bell repeatedly while the button is held
        this.bell();
        this.bellTimer = window.setInterval(() => this.bell(), 520);
        this.hornVoices.push({ stop: () => window.clearInterval(this.bellTimer) });
        break;
    }
    // never stick on (e.g. pointer released outside the window)
    this.hornTimer = window.setTimeout(() => this.hornStop(), 4000);
  }

  hornStop() {
    const ctx = this.ctx;
    window.clearTimeout(this.hornTimer);
    if (!ctx) {
      this.hornVoices = [];
      return;
    }
    const at = ctx.currentTime;
    for (const v of this.hornVoices) v.stop(at);
    this.hornVoices = [];
  }

  click8() {
    this.tone(2400, 0.025, { type: 'square', gain: 0.025, filter: 4000, attack: 0.001 });
  }

  play(id: string) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    switch (id) {
      case 'doorOpen':
        this.tone(784, 0.7, { gain: 0.13 });
        this.tone(659, 0.9, { gain: 0.13, at: t + 0.32 });
        this.noiseBurst(0.9, 1800, 'highpass', 0.05, t + 0.15);
        break;
      case 'doorWarn':
        for (let i = 0; i < 4; i++) this.tone(1046, 0.13, { type: 'triangle', gain: 0.09, at: t + i * 0.28 });
        break;
      case 'doorClose':
        this.noiseBurst(0.18, 300, 'lowpass', 0.35);
        this.tone(110, 0.16, { gain: 0.2, attack: 0.003 });
        break;
      case 'score':
        [1047, 1319, 1568, 2093].forEach((f, i) => this.tone(f, 0.35, { gain: 0.07, at: t + i * 0.065 }));
        break;
      case 'arrive':
      case 'airRelease':
        this.noiseBurst(0.9, 2600, 'highpass', 0.08);
        break;
      case 'bad':
        this.tone(150, 0.28, { type: 'square', gain: 0.07, filter: 900 });
        this.tone(110, 0.32, { type: 'square', gain: 0.07, filter: 900, at: t + 0.14 });
        break;
      case 'overspeed':
        this.tone(1760, 0.09, { type: 'square', gain: 0.045, filter: 3500 });
        this.tone(1760, 0.09, { type: 'square', gain: 0.045, filter: 3500, at: t + 0.16 });
        break;
      case 'atp':
        for (let i = 0; i < 6; i++) this.tone(i % 2 ? 660 : 880, 0.2, { type: 'square', gain: 0.07, filter: 2500, at: t + i * 0.22 });
        this.noiseBurst(1.6, 1200, 'highpass', 0.08, t + 0.05);
        break;
      case 'slip':
        this.tone(3300, 0.35, { gain: 0.03, endFreq: 2600 });
        break;
      case 'buffer':
        this.noiseBurst(0.6, 220, 'lowpass', 0.6);
        this.tone(55, 0.6, { gain: 0.35, attack: 0.002 });
        break;
      case 'signal':
        this.tone(988, 0.16, { type: 'triangle', gain: 0.08 });
        this.tone(1319, 0.28, { type: 'triangle', gain: 0.08, at: t + 0.12 });
        break;
      case 'ui':
        this.tone(1320, 0.06, { gain: 0.03 });
        break;
    }
  }

  // ------------------------------------------------------------ voice
  private pickVoice() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const choose = () => {
      const vs = synth.getVoices();
      this.voice =
        vs.find((v) => /en-GB/i.test(v.lang) && /female|libby|sonia|serena|kate|google uk english female/i.test(v.name)) ??
        vs.find((v) => /en-GB/i.test(v.lang)) ??
        vs.find((v) => /^en/i.test(v.lang)) ??
        null;
    };
    choose();
    synth.addEventListener?.('voiceschanged', choose);
  }

  // ------------------------------------------------------------ announcements
  private speechQueue: string[] = [];
  private speaking = false;
  /** strong reference: Chrome garbage-collects utterances mid-speech and silently drops them */
  private current: SpeechSynthesisUtterance | null = null;
  private speechTimer = 0;

  /** Queues a station announcement (chime + voice). Announcements never cut each other off. */
  announce(text: string) {
    if (!this.enabled || !this.announcements) return;
    // keep only the freshest pending message so we never fall far behind the train
    this.speechQueue = [...this.speechQueue.slice(-1), text];
    if (!this.speaking) this.nextAnnouncement();
  }

  private nextAnnouncement() {
    const text = this.speechQueue.shift();
    if (!text || !this.enabled || !this.announcements) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    const ctx = this.ctx;
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume();
      const t = ctx.currentTime;
      this.tone(659, 0.5, { gain: 0.08, at: t });
      this.tone(831, 0.5, { gain: 0.08, at: t + 0.22 });
      this.tone(988, 0.8, { gain: 0.08, at: t + 0.44 });
    }
    const synth = window.speechSynthesis;
    if (!synth) {
      window.setTimeout(() => this.nextAnnouncement(), 1400);
      return;
    }
    window.setTimeout(() => {
      if (!this.speaking) return;
      if (!this.voice) this.pickVoice();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) {
        u.voice = this.voice;
        u.lang = this.voice.lang;
      } else u.lang = 'en-GB';
      u.rate = 0.98;
      u.pitch = 1.02;
      u.volume = Math.min(1, this.volume + 0.15);
      const done = () => {
        if (this.current !== u) return;
        this.current = null;
        window.clearTimeout(this.speechTimer);
        window.setTimeout(() => this.nextAnnouncement(), 250);
      };
      u.onend = done;
      u.onerror = done;
      this.current = u;
      // Chrome can leave the engine paused (e.g. after the tab was hidden)
      synth.resume();
      synth.speak(u);
      // safety net if the browser never fires onend
      window.clearTimeout(this.speechTimer);
      this.speechTimer = window.setTimeout(done, 2500 + text.length * 110);
    }, 900);
  }

  clearSpeech() {
    this.speechQueue = [];
    this.speaking = false;
    this.current = null;
    window.clearTimeout(this.speechTimer);
    window.speechSynthesis?.cancel();
  }
}

export const audio = new AudioEngine();
