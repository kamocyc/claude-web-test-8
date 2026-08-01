import { clamp, clamp01, lerp } from '../core/MathUtils';

/**
 * Everything you hear, synthesised in the Web Audio graph.
 *
 * No sample files: the traction sound is a VVVF-style oscillator bank whose
 * frequencies track the motor, rolling noise is filtered white noise driven by
 * speed, rail joints are impulses fired by distance travelled, and the tunnel
 * "reverb" is a short feedback delay that opens up when the bore closes in.
 */

export interface AudioState {
  /** Speed in m/s. */
  speed: number;
  /** Distance travelled since the last update, metres. */
  distance: number;
  /** Traction demand, 0..1. */
  traction: number;
  /** Brake cylinder level, 0..1. */
  brake: number;
  /** 0 outside, 1 fully inside a tunnel. */
  tunnel: number;
  /** 0..1 rain intensity. */
  rain: number;
  /** 0..1 proximity to the sea. */
  sea: number;
  /** 0..1 built-up surroundings. */
  town: number;
  /** True while a level crossing near the train is active. */
  crossing: boolean;
  /** True while the doors are open. */
  doorsOpen: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // Voices.
  private rolling!: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private wind!: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private motor!: { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode };
  private whine!: { osc: OscillatorNode; gain: GainNode };
  private ambience!: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private tunnelSend!: GainNode;
  private hornGain!: GainNode;
  private hornOsc: OscillatorNode[] = [];

  private jointDistance = 0;
  private compressorTimer = 22;
  private crossingBellTimer = 0;
  private lastBrake = 0;
  private started = false;

  volume = 0.8;
  muted = false;

  get isReady(): boolean {
    return this.started;
  }

  /** Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.started) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Short feedback delay used as a cheap tunnel reverberation.
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.085;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.55;
    const damping = ctx.createBiquadFilter();
    damping.type = 'lowpass';
    damping.frequency.value = 1400;
    this.tunnelSend = ctx.createGain();
    this.tunnelSend.gain.value = 0;
    this.tunnelSend.connect(delay);
    delay.connect(damping);
    damping.connect(feedback);
    feedback.connect(delay);
    damping.connect(this.master);

    this.noiseBuffer = this.createNoiseBuffer(ctx, 3);

    this.rolling = this.createNoiseVoice(ctx, 'bandpass', 240, 1.1, 0);
    this.wind = this.createNoiseVoice(ctx, 'highpass', 1800, 0.7, 0);
    this.ambience = this.createNoiseVoice(ctx, 'lowpass', 700, 0.8, 0);

    // Traction: a stack of detuned sawtooths through a resonant low pass, the
    // classic inverter sound.
    this.motor = { osc: [], gain: ctx.createGain(), filter: ctx.createBiquadFilter() };
    this.motor.gain.gain.value = 0;
    this.motor.filter.type = 'lowpass';
    this.motor.filter.frequency.value = 900;
    this.motor.filter.Q.value = 4;
    this.motor.filter.connect(this.motor.gain);
    this.motor.gain.connect(this.master);
    this.motor.gain.connect(this.tunnelSend);
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.6 : 0.22;
      osc.connect(g);
      g.connect(this.motor.filter);
      osc.start();
      this.motor.osc.push(osc);
    }

    // Motor whine that rises with speed.
    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sine';
    whineOsc.frequency.value = 400;
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whineOsc.connect(whineGain);
    whineGain.connect(this.master);
    whineOsc.start();
    this.whine = { osc: whineOsc, gain: whineGain };

    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.master);
    this.hornGain.connect(this.tunnelSend);
    for (const freq of [311, 466]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2200;
      osc.connect(filter);
      filter.connect(this.hornGain);
      osc.start();
      this.hornOsc.push(osc);
    }

    this.started = true;
  }

  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // Slight low-pass to make it less harsh than pure white noise.
      last = last * 0.35 + white * 0.65;
      data[i] = last;
    }
    return buffer;
  }

  private createNoiseVoice(
    ctx: AudioContext,
    type: BiquadFilterType,
    frequency: number,
    q: number,
    gain: number,
  ): { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    source.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    g.connect(this.tunnelSend);
    source.start();
    return { source, filter, gain: g };
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.started) this.master.gain.value = this.muted ? 0 : volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.started) this.master.gain.value = muted ? 0 : this.volume;
  }

  update(dt: number, state: AudioState): void {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const speed = Math.abs(state.speed);
    const kmh = speed * 3.6;

    // Rolling noise: louder and brighter with speed.
    const rollGain = clamp01(speed / 34) * 0.32 * lerp(1, 1.5, state.tunnel);
    this.rolling.gain.gain.setTargetAtTime(rollGain, now, 0.12);
    this.rolling.filter.frequency.setTargetAtTime(120 + kmh * 7.5, now, 0.2);

    // Wind noise grows with the square of speed.
    const windGain = clamp01((speed * speed) / 1400) * 0.22;
    this.wind.gain.gain.setTargetAtTime(windGain, now, 0.25);
    this.wind.filter.frequency.setTargetAtTime(1200 + kmh * 22, now, 0.3);

    // Traction: frequency ramps with speed, resetting at each notch of the
    // inverter's switching pattern.
    const stage = Math.floor(clamp(kmh / 22, 0, 4));
    const withinStage = (kmh - stage * 22) / 22;
    const baseFreq = 55 + withinStage * 130 + stage * 12;
    for (let i = 0; i < this.motor.osc.length; i++) {
      this.motor.osc[i].frequency.setTargetAtTime(baseFreq * (1 + i * 0.503), now, 0.08);
    }
    const motorGain = state.traction * 0.16 * clamp01(0.25 + speed / 12);
    this.motor.gain.gain.setTargetAtTime(motorGain, now, 0.1);
    this.motor.filter.frequency.setTargetAtTime(500 + kmh * 16 + state.traction * 600, now, 0.15);

    this.whine.osc.frequency.setTargetAtTime(280 + kmh * 13, now, 0.1);
    this.whine.gain.gain.setTargetAtTime(
      (state.traction * 0.5 + clamp01(speed / 40) * 0.5) * 0.012,
      now,
      0.2,
    );

    // Ambience bed: sea, town or countryside.
    const ambientGain = (state.sea * 0.14 + state.town * 0.05 + state.rain * 0.2) * (1 - state.tunnel);
    this.ambience.gain.gain.setTargetAtTime(ambientGain, now, 0.6);
    this.ambience.filter.frequency.setTargetAtTime(
      state.rain > 0.2 ? 2600 : state.sea > 0.4 ? 520 : 900,
      now,
      0.8,
    );

    this.tunnelSend.gain.setTargetAtTime(state.tunnel * 0.55, now, 0.4);

    // Rail joints.
    this.jointDistance += state.distance;
    const jointSpacing = 25;
    while (this.jointDistance > jointSpacing) {
      this.jointDistance -= jointSpacing;
      if (speed > 1.5) this.clack(clamp01(speed / 30));
    }

    // Brake noises: a hiss as the brakes release, a squeal as the train stops.
    if (state.brake < this.lastBrake - 0.08) this.hiss(0.35);
    if (state.brake > 0.15 && speed < 6 && speed > 0.3) {
      this.squeal(clamp01((6 - speed) / 6) * state.brake * 0.4);
    }
    this.lastBrake = state.brake;

    // Compressor cuts in from time to time.
    this.compressorTimer -= dt;
    if (this.compressorTimer <= 0) {
      this.compressorTimer = 40 + Math.random() * 50;
      this.compressor();
    }

    // Level crossing bell.
    if (state.crossing) {
      this.crossingBellTimer -= dt;
      if (this.crossingBellTimer <= 0) {
        this.crossingBellTimer = 0.42;
        this.ding(880, 0.055, 0.35);
      }
    } else {
      this.crossingBellTimer = 0;
    }
  }

  /** A short percussive impulse for rail joints and points. */
  private clack(intensity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 180 + Math.random() * 220;
    filter.Q.value = 2.5;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08 * intensity + 0.001, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    gain.connect(this.tunnelSend);
    source.start(now);
    source.stop(now + 0.16);
  }

  private hiss(amount: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2400;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12 * amount + 0.001, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + 0.8);
  }

  private squeal(amount: number): void {
    if (!this.ctx || amount < 0.02) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 1800 + Math.random() * 900;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = osc.frequency.value;
    filter.Q.value = 14;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.008 * amount + 0.0002, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  private compressor(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 42;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 240;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.03, now + 0.4);
    gain.gain.setValueAtTime(0.03, now + 7);
    gain.gain.linearRampToValueAtTime(0.0001, now + 8);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 8.2);
  }

  private ding(frequency: number, attack: number, duration: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /** Two-note station chime played when the doors open. */
  doorChime(): void {
    this.ding(1046, 0.02, 0.5);
    window.setTimeout(() => this.ding(1318, 0.02, 0.7), 220);
  }

  /** Air rushing as the doors operate. */
  doorAir(): void {
    this.hiss(0.6);
  }

  setHorn(on: boolean): void {
    if (!this.started || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.hornGain.gain.cancelScheduledValues(now);
    this.hornGain.gain.setTargetAtTime(on ? 0.09 : 0, now, on ? 0.02 : 0.08);
  }

  /** The pressure wave and roar of a train passing the other way. */
  passingTrain(speed: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(220, now);
    filter.frequency.exponentialRampToValueAtTime(900, now + 0.35);
    filter.frequency.exponentialRampToValueAtTime(180, now + 1.1);
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    const peak = clamp01(speed / 30) * 0.3;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak + 0.001, now + 0.28);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + 1.5);
  }

  dispose(): void {
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
