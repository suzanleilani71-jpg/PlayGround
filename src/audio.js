// Tiny procedural synthwave engine. No audio assets, everything is synthesized.
// The AudioContext clock is also the authoritative game clock.

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.track = null;
    this.timer = null;
    this.paused = false;
    this.bpm = 120;
    this.depth = 1;
    this.startAt = 0;
  }

  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 5;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.82 : 0;
      this.master.connect(this.comp).connect(this.ctx.destination);

      // shared feedback delay for plucks
      this.delayIn = this.ctx.createGain();
      this.delay = this.ctx.createDelay(1);
      this.delay.delayTime.value = 0.27;
      this.fb = this.ctx.createGain();
      this.fb.gain.value = 0.28;
      this.wet = this.ctx.createGain();
      this.wet.gain.value = 0.16;
      this.delayIn.connect(this.delay);
      this.delay.connect(this.fb).connect(this.delay);
      this.delay.connect(this.wet).connect(this.master);

      // noise buffer
      const len = this.ctx.sampleRate * 1.2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const ch = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    return true;
  }

  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }
  songTime() { return this.ctx ? this.ctx.currentTime - this.startAt : 0; }

  setEnabled(on) {
    this.enabled = on;
    if (this.master && this.ctx) {
      const v = on ? 0.82 : 0;
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.04);
    }
  }

  // ---------- music ----------
  startTrack(bpm, depth) {
    this._killTrack(0.05);
    if (!this.ctx) return 0;
    this.bpm = bpm;
    this.depth = depth;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.12);
    g.connect(this.master);
    this.track = g;
    this.startAt = ctx.currentTime + 0.3;
    this.stepDur = 60 / bpm / 4;
    this.nextStep = 0;
    this.nextStepTime = this.startAt;
    this.paused = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => this._schedule(), 22);
    this._schedule();
    return this.startAt;
  }

  _killTrack(fade = 0.12) {
    clearInterval(this.timer);
    this.timer = null;
    if (this.track && this.ctx) {
      const t = this.ctx.currentTime;
      const g = this.track;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value || 0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + fade);
        setTimeout(() => { try { g.disconnect(); } catch { /* */ } }, (fade + 0.1) * 1000);
      } catch { /* */ }
    }
    this.track = null;
  }

  stopTrack(fade = 0.35) { this._killTrack(fade); }

  pause() {
    this.paused = true;
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }
  resume() {
    this.paused = false;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _schedule() {
    if (!this.ctx || !this.track || this.paused || this.ctx.state !== 'running') return;
    const lookahead = this.ctx.currentTime + 0.14;
    let guard = 0;
    while (this.nextStepTime < lookahead && guard++ < 32) {
      this._playStep(this.nextStep, this.nextStepTime);
      this.nextStep++;
      this.nextStepTime += this.stepDur;
    }
  }

  _playStep(step, t) {
    const depth = this.depth;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const spb = 60 / this.bpm;
    const chordIdx = bar % 4;
    const roots = [45, 41, 48, 43];
    const chord = [
      [0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]
    ][chordIdx];
    const root = roots[chordIdx];

    // kick
    if (s === 0 || s === 8) this._kick(t, 1);
    if (depth >= 6 && (s === 14 || (depth >= 12 && s === 6))) this._kick(t, 0.6);

    // snare
    if (s === 4 || s === 12) this._snare(t, 0.8);
    if (depth >= 9 && s === 15 && bar % 4 === 3) this._snare(t, 0.5);

    // hats
    if (s % 2 === 0) this._hat(t, s % 8 === 6 ? 1 : 0.55);
    if (depth >= 7 && s % 2 === 1) this._hat(t, 0.22, true);
    if (s === 0 && bar % 4 === 0) this._crash(t);

    // bass
    const bassSteps = [0, 3, 6, 8, 11, 14];
    if (bassSteps.includes(s)) {
      const oct = s === 8 ? 12 : 0;
      this._bass(t, root + oct, spb * 0.55, 0.9);
    }

    // pad chord at bar start
    if (s === 0) {
      this._pad(t, [root + 12, root + 12 + chord[1], root + 12 + chord[2]], spb * 4, 0.75);
    }

    // arp / lead
    if (depth >= 1 && s % 2 === 0) {
      const seq = [0, 2, 1, 2];
      const tone = root + 24 + chord[seq[(s / 2) % 4]] + (s >= 8 ? 12 : 0);
      this._pluck(t, tone, s === 0 ? 0.55 : 0.3);
    }
    if (depth >= 4 && s % 2 === 1) {
      const tone = root + 24 + chord[(s + 1) % 3];
      this._pluck(t, tone, 0.16);
    }
    // sparse high shimmer on bosses
    if (depth % 5 === 0 && s === 10) {
      this._pluck(t, root + 36 + chord[2], 0.22);
    }
  }

  // ---------- instruments ----------
  _noise(t, dur, gain, type, freq, q = 1, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || this.track || this.master);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.02);
  }

  _kick(t, v = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * v, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g).connect(this.track);
    o.start(t); o.stop(t + 0.26);
    this._noise(t, 0.028, 0.18 * v, 'highpass', 1800, 0.7);
  }
  _snare(t, v = 1) {
    const ctx = this.ctx;
    this._noise(t, 0.16, 0.32 * v, 'bandpass', 1900, 0.8);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.track);
    o.start(t); o.stop(t + 0.14);
  }
  _hat(t, v = 1, closed = false) {
    this._noise(t, closed ? 0.03 : 0.055, 0.075 * v, 'highpass', 7600, 0.6);
  }
  _crash(t) {
    this._noise(t, 0.6, 0.11, 'highpass', 4200, 0.5);
  }
  _bass(t, m, dur, v = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = midi(m);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(520, t);
    f.frequency.exponentialRampToValueAtTime(220, t + dur);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.012);
    g.gain.setValueAtTime(0.2 * v, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.track);
    o.start(t); o.stop(t + dur + 0.02);
  }
  _pad(t, notes, dur, v = 1) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(600, t);
    f.frequency.linearRampToValueAtTime(1300, t + dur * 0.6);
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045 * v, t + 0.25);
    g.gain.setValueAtTime(0.045 * v, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.track);
    for (const m of notes) {
      for (const det of [-5, 5]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(m);
        o.detune.value = det;
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }
  _pluck(t, m, v = 0.3) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(m);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3600, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(f).connect(g);
    g.connect(this.track);
    g.connect(this.delayIn);
    o.start(t); o.stop(t + 0.24);
  }

  // ---------- sfx ----------
  _tone(freq, dur, type = 'sine', vol = 0.1, slideTo = null, when = 0) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  hit(quality, lane) {
    const base = [1174, 988, 784][quality] || 784;
    const mult = [1, 1.122, 1.26, 1.335][lane] || 1;
    this._tone(base * mult, 0.09, quality === 0 ? 'sine' : 'triangle', 0.045);
    if (quality === 0) this._tone(base * mult * 2, 0.06, 'sine', 0.018);
  }
  miss() {
    this._tone(180, 0.16, 'sawtooth', 0.06, 70);
    if (!this.ctx) return;
    this._noise(this.ctx.currentTime, 0.08, 0.06, 'lowpass', 500, 1);
  }
  block() {
    this._tone(1560, 0.18, 'triangle', 0.05, 2100);
    this._tone(2340, 0.1, 'sine', 0.025);
  }
  hurt() {
    this._tone(90, 0.32, 'sawtooth', 0.12, 40);
    if (!this.ctx) return;
    this._noise(this.ctx.currentTime, 0.16, 0.1, 'lowpass', 700, 1);
  }
  tick() { this._tone(1760, 0.03, 'sine', 0.015); }
  fever() {
    [0, 4, 7, 12].forEach((st, i) => this._tone(440 * Math.pow(2, st / 12), 0.22, 'triangle', 0.06, null, i * 0.055));
    this._tone(110, 0.5, 'sawtooth', 0.05, 220);
  }
  victory() {
    [0, 7, 12, 16, 19].forEach((st, i) => this._tone(392 * Math.pow(2, st / 12), 0.5, 'triangle', 0.07, null, i * 0.1));
  }
  defeat() {
    [0, -3, -7, -12].forEach((st, i) => this._tone(392 * Math.pow(2, st / 12), 0.65, 'sawtooth', 0.06, null, i * 0.14));
  }
  click() { this._tone(880, 0.06, 'triangle', 0.03); }
  ui() { this._tone(660, 0.05, 'sine', 0.02); }
}
