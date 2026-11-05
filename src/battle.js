// The rhythm-combat engine: judging, enemy attacks, fever, particles, canvas rendering.
import { LANES } from './chart.js';
import { clamp, lerp, easeOut, mulberry32, hash } from './util.js';

const BASE_DAMAGE = 4;
const WIN = { perfect: 0.068, great: 0.116, good: 0.178 };
const TIMING_MULT = [1.3, 1.05, 0.7];
const TIMING_SCORE = [1.3, 1.05, 0.7];
const ACC_WEIGHT = [1, 0.8, 0.5, 0];
const FEVER_GAIN = [4.6, 2.6, 1.0];
const SHIELD_GAIN = [3, 1.6, 0.5];
const LANE_COLORS = ['#38e8ff', '#ff54d8', '#ffc94d', '#7dff8a'];
const LANE_RGB = [[56, 232, 255], [255, 84, 216], [255, 201, 77], [125, 255, 138]];

function rr(c, x, y, w, h, r) {
  if (!(w > 0) || !(h > 0)) return;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export class Battle {
  constructor(opts) {
    this.run = opts.run;
    this.chart = opts.chart;
    this.audio = opts.audio;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.onEnd = opts.onEnd || (() => {});
    this.onHud = opts.onHud || (() => {});
    this.onCoach = opts.onCoach || (() => {});

    const spb = this.chart.spb;
    const pre = this.chart.preRollBeats;
    this.spb = spb;
    this.pre = pre;
    this.notes = this.chart.notes.map(n => ({
      id: n.id,
      lane: n.lane,
      time: (pre + n.beat) * spb,
      hold: n.hold * spb,
      holdBeats: n.hold,
      head: 'pending',
      quality: 0,
      nextTick: 0,
      tickCount: 0,
      hitAt: 0
    }));
    this.attacks = this.chart.attacks.map(a => ({
      beat: a.beat,
      time: (pre + a.beat) * spb,
      dmg: a.dmg,
      fired: false
    }));

    this.hp = this.run.hp;
    this.maxHp = this.run.maxHp;
    this.shield = Math.min(this.run.startShield, this.run.shieldMax);
    this.enemyHp = this.chart.hp;
    this.enemyMax = this.chart.hp;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.fever = clamp(this.run.startFever, 0, 100);
    this.feverEnd = 0;
    this.feverActive = false;
    this.feverUsed = 0;

    this.state = 'intro';
    this.paused = false;
    this.elapsed = 0;
    this.lastSong = 0;
    this.endDelay = 0;
    this.endCalled = false;
    this.result = null;

    this.laneFlash = [0, 0, 0, 0];
    this.laneHold = [0, 0, 0, 0];
    this.pressPulse = [0, 0, 0, 0];
    this.particles = [];
    this.rings = [];
    this.floaters = [];
    this.judgeFx = null;
    this.judgePop = 0;
    this.shake = 0;
    this.hurtFlash = 0;
    this.feverFlash = 0;
    this.coreFlash = 0;
    this.comboPop = 0;
    this.hitGlow = 0;
    this.countdownDone = false;
    this.hintIndex = 0;

    this.stars = [];
    const rng = mulberry32(hash(this.chart.seed || 1, this.chart.depth, 55));
    for (let i = 0; i < 36; i++) {
      this.stars.push({
        x: rng(), y: rng(), s: 0.4 + rng() * 1.6, sp: 0.004 + rng() * 0.016,
        a: 0.12 + rng() * 0.4
      });
    }

    this.hudTimer = 0;
    this.lastHud = {};
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement || this.canvas);

    this._bindInput();
    this._startTime = null;
    this._lastTs = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  // ---------- lifecycle ----------
  start() {
    this._startTime = this.audio.startTrack(this.chart.bpm, this.chart.depth);
    this.run.notesTotal += this.notes.length;
    this.emitHud(true);
  }

  resize() {
    const el = this.canvas;
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(200, rect.width);
    this.H = Math.max(220, rect.height);
    el.width = Math.round(this.W * dpr);
    el.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pad = Math.max(6, this.W * 0.018);
    this.laneW = Math.min(150, (this.W - this.pad * 2) / LANES);
    this.playW = this.laneW * LANES;
    this.x0 = (this.W - this.playW) / 2;
    this.hitY = this.H - Math.max(44, this.H * 0.105);
    this.approach = 3.15;
    this.pxPerBeat = (this.hitY + 90) / this.approach;
    this.coreX = this.W / 2;
    this.coreY = Math.min(this.H * 0.18, 96);
    this.coreR = Math.min(this.laneW * 0.72, this.H * 0.17, 60);
    this.ui = clamp(Math.min(this.W / 390, this.H / 640), 0.72, 1.5);
    this.judgeOffset = clamp(this.H * 0.09, 24, 66);
    this.comboOffset = clamp(this.H * 0.21, 50, 140);
  }

  songTime() {
    if (!this._startTime) return 0;
    return Math.max(0, this.audio.now() - this._startTime);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._unbindInput();
    try { this.ro.disconnect(); } catch { /* */ }
    this.audio.stopTrack(0.25);
  }

  pause() {
    if (this.paused || this.state === 'victory' || this.state === 'defeat') return;
    this.paused = true;
    this.audio.pause();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.audio.resume();
    this._lastTs = 0;
  }

  // ---------- input ----------
  _bindInput() {
    this._onPointerDown = (e) => {
      if (this.paused) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.W / rect.width);
      const lane = Math.floor((x - this.x0) / this.laneW);
      if (lane < 0 || lane >= LANES) return;
      e.preventDefault();
      this.pointers.set(e.pointerId, lane);
      this.laneHold[lane]++;
      this.pressLane(lane);
    };
    this._onPointerUp = (e) => {
      const lane = this.pointers.get(e.pointerId);
      if (lane == null) return;
      this.pointers.delete(e.pointerId);
      this.laneHold[lane] = Math.max(0, this.laneHold[lane] - 1);
    };
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const lane = { d: 0, f: 1, j: 2, k: 3, arrowleft: 0, arrowup: 1, arrowdown: 2, arrowright: 3 }[key];
      if (lane != null) {
        e.preventDefault();
        if (this.keys.has(key)) return;
        this.keys.add(key);
        this.keyLane[key] = lane;
        this.laneHold[lane]++;
        this.pressLane(lane);
      } else if (key === ' ' || key === 'shift') {
        e.preventDefault();
        this.activateFever();
      }
    };
    this._onKeyUp = (e) => {
      const key = e.key.toLowerCase();
      if (this.keys.has(key)) {
        this.keys.delete(key);
        const lane = this.keyLane[key];
        delete this.keyLane[key];
        if (lane != null) this.laneHold[lane] = Math.max(0, this.laneHold[lane] - 1);
      }
    };
    this.pointers = new Map();
    this.keys = new Set();
    this.keyLane = {};
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _unbindInput() {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  pressLane(lane) {
    if (this.paused || this.state === 'victory' || this.state === 'defeat') return;
    this.laneFlash[lane] = 1;
    this.pressPulse[lane] = 1;
    const t = this.songTime();
    const winGood = WIN.good * this.run.windowMult;
    let best = null;
    let bestDiff = 1e9;
    for (const n of this.notes) {
      if (n.lane !== lane || n.head !== 'pending') continue;
      const d = t - n.time;
      if (Math.abs(d) > winGood) continue;
      if (Math.abs(d) < Math.abs(bestDiff)) { best = n; bestDiff = d; }
    }
    if (best) this.judge(best, bestDiff);
    else this.audio.ui();
  }

  judge(note, diff) {
    const wm = this.run.windowMult;
    const ad = Math.abs(diff);
    let q;
    if (ad <= WIN.perfect * wm) q = 0;
    else if (ad <= WIN.great * wm) q = 1;
    else q = 2;

    note.head = 'hit';
    note.quality = q;
    note.hitAt = this.songTime();

    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    if (this.combo > this.run.bestCombo) this.run.bestCombo = this.combo;
    this.comboPop = 1;

    const comboMult = 1 + Math.min(this.combo, this.run.comboCap) * 0.02;
    const feverMult = this.feverActive ? this.run.feverDamage : 1;
    let dmg = BASE_DAMAGE * TIMING_MULT[q] * comboMult * this.run.damageMult * feverMult;
    if (note.hold > 0) dmg *= 1 + 0.12;
    this.dealDamage(dmg);

    const feverScore = this.feverActive ? 1.5 : 1;
    const addScore = Math.round(100 * TIMING_SCORE[q] * comboMult * feverScore * this.run.scoreMult);
    this.score += addScore;
    this.run.score += addScore;

    if (!this.feverActive) this.fever = Math.min(100, this.fever + FEVER_GAIN[q] * this.run.feverGain);
    this.shield = Math.min(this.run.shieldMax, this.shield + SHIELD_GAIN[q] * this.run.shieldGainMult);
    if (this.run.lifesteal > 0) this.hp = Math.min(this.maxHp, this.hp + this.run.lifesteal);

    // stats
    this.run.judged++;
    this.run.weighted += ACC_WEIGHT[q];
    this.run.notesHit++;

    if (note.hold > 0) {
      note.nextTick = note.time + this.spb * 0.25;
    }

    // juicing
    this.audio.hit(q, note.lane);
    this.hitGlow = 1;
    const x = this.x0 + note.lane * this.laneW + this.laneW / 2;
    this.spawnHit(x, this.hitY, note.lane, q);
    this.judgeFx = {
      text: ['PERFECT', 'GREAT', 'GOOD'][q],
      color: q === 0 ? '#bff8ff' : q === 1 ? '#9fe8b3' : '#ffd166',
      life: 0, max: 0.5, size: (q === 0 ? 19 : 16) * this.ui
    };
    this.judgePop = 1;
    this.emitHud(true);
  }

  dealDamage(dmg) {
    if (this.state === 'victory' || this.state === 'defeat') return;
    this.enemyHp = Math.max(0, this.enemyHp - dmg);
    this.coreFlash = 1;
    if (this.enemyHp <= 0) this.victory();
  }

  miss(note) {
    note.head = 'miss';
    this.combo = 0;
    this.comboPop = 0;
    const dmg = Math.round((6 + this.run.depth * 0.16) * this.run.missMult);
    this.hurt(dmg);
    this.audio.miss();
    this.shake = Math.max(this.shake, 10);
    this.hurtFlash = 1;
    this.judgeFx = { text: 'MISS', color: '#ff5c7c', life: 0, max: 0.6, size: 17 * this.ui };
    this.judgePop = 1;
    this.run.judged++;
    this.run.weighted += 0;
    this.emitHud(true);
  }

  hurt(amount) {
    const dmg = Math.round(amount);
    this.hp = Math.max(0, this.hp - dmg);
    if (this.hp <= 0) {
      if (this.run.revives > 0) {
        this.run.revives--;
        this.hp = Math.round(this.maxHp * 0.4);
        this.shield = Math.min(this.run.shieldMax, 14);
        this.fever = Math.min(100, this.fever + 40);
        this.floaters.push({
          text: 'ENCORE', color: '#ffd166', x: this.W / 2, y: this.hitY - 100,
          vy: -20, life: 0, max: 1.2, size: 24 * this.ui
        });
        this.audio.fever();
        this.hurtFlash = 0.6;
        this.emitHud(true);
        return;
      }
      this.defeat();
    }
  }

  activateFever() {
    if (this.state !== 'play' && this.state !== 'intro') return;
    if (this.feverActive || this.fever < 100) return;
    this.fever = 0;
    this.feverActive = true;
    this.feverUsed++;
    this.feverEnd = this.songTime() + this.spb * 8;
    this.feverFlash = 1;
    this.audio.fever();
    this.emitHud(true);
  }

  victory() {
    if (this.state === 'victory' || this.state === 'defeat') return;
    this.state = 'victory';
    this.result = 'victory';
    this.endDelay = 1.6;
    const bonus = Math.round((400 + this.run.depth * 120 + this.hp * 6) * this.run.scoreMult);
    this.score += bonus;
    this.run.score += bonus;
    this.clearBonus = bonus;
    this.audio.stopTrack(0.7);
    this.audio.victory();
    this.shake = Math.max(this.shake, 8);
    this.feverFlash = 0.8;
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 240;
      this.particles.push({
        x: this.coreX, y: this.coreY,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: 150, life: 0, max: 0.6 + Math.random() * 0.6,
        size: 1.5 + Math.random() * 3,
        color: Math.random() < 0.5 ? 'rgba(255,124,228,1)' : 'rgba(110,244,255,1)'
      });
    }
    this.rings.push({ x: this.coreX, y: this.coreY, r: this.coreR, max: Math.max(this.W, this.H) * 0.9, life: 0, dur: 0.75, color: '255,255,255', w: 3 });
    this.floaters.push({
      text: 'CLEARED', color: '#d8fbff', x: this.W / 2, y: this.H * 0.44,
      vy: -14, life: 0, max: 1.4, size: 30 * this.ui
    });
    this.emitHud(true);
  }

  defeat() {
    if (this.state === 'defeat' || this.state === 'victory') return;
    this.state = 'defeat';
    this.result = 'defeat';
    this.endDelay = 2;
    this.audio.stopTrack(0.4);
    this.audio.defeat();
    this.shake = Math.max(this.shake, 14);
    this.floaters.push({
      text: 'FLATLINE', color: '#ff5c7c', x: this.W / 2, y: this.H * 0.44,
      vy: -10, life: 0, max: 1.5, size: 26 * this.ui
    });
    this.emitHud(true);
  }

  // ---------- update ----------
  update(dt, t) {
    this.elapsed += dt;
    if (this.state === 'victory' || this.state === 'defeat') {
      this.endDelay -= dt;
      this.stepEffects(dt);
      this.hudTimer += dt;
      if (this.hudTimer > 0.12) { this.hudTimer = 0; this.emitHud(); }
      if (this.endDelay <= 0 && !this.endCalled) {
        this.endCalled = true;
        this.finish();
      }
      return;
    }

    if (this.state === 'intro' && t > 0.05) this.state = 'play';

    // fever lifetime
    if (this.feverActive && t >= this.feverEnd) {
      this.feverActive = false;
      this.feverFlash = 0;
    }

    // misses
    const missCut = WIN.good * this.run.windowMult;
    for (const n of this.notes) {
      if (n.head !== 'pending') continue;
      if (t > n.time + missCut) this.miss(n);
    }

    // hold sustain
    for (const n of this.notes) {
      if (n.head !== 'hit' || n.hold <= 0) continue;
      if (this.laneHold[n.lane] <= 0) continue;
      const end = n.time + n.hold;
      while (n.nextTick > 0 && n.nextTick <= Math.min(t, end)) {
        const comboMult = 1 + Math.min(this.combo, this.run.comboCap) * 0.02;
        const feverMult = this.feverActive ? this.run.feverDamage : 1;
        this.dealDamage(0.9 * this.run.damageMult * comboMult * feverMult * this.run.holdBonus);
        const addScore = Math.round(14 * (this.feverActive ? 1.5 : 1) * this.run.scoreMult);
        this.score += addScore;
        this.run.score += addScore;
        n.nextTick += this.spb * 0.25;
        n.tickCount++;
        if (n.tickCount % 2 === 0) this.audio.tick();
        const x = this.x0 + n.lane * this.laneW + this.laneW / 2 + (Math.random() - 0.5) * this.laneW * 0.5;
        this.spark(x, this.hitY - 4, n.lane, 2);
      }
    }

    // enemy attacks
    for (const a of this.attacks) {
      if (a.fired) continue;
      if (t >= a.time) {
        a.fired = true;
        this.resolveAttack(a);
      }
    }

    // chart over
    const endT = (this.pre + this.chart.totalBeats + 0.5) * this.spb;
    if (t > endT && this.state === 'play') this.defeat();

    // coaching hints for the first descent
    if (this.run.depth === 1 && this.state === 'play') {
      const hints = [
        [0.4, 'TAP THE LANES AS NOTES CROSS THE LINE'],
        [7.5, 'PERFECTS CHARGE SHIELD ◈ AND FEVER ⚡'],
        [16, 'POP FEVER (SPACE / BUTTON) WHEN FULL'],
        [24, 'KILL THE TARGET BEFORE THE TRACK ENDS']
      ];
      const b = t / this.spb;
      while (this.hintIndex < hints.length && b > hints[this.hintIndex][0]) {
        this.onCoach(hints[this.hintIndex][1], this.hintIndex);
        this.hintIndex++;
      }
    }

    this.stepEffects(dt);

    this.hudTimer += dt;
    if (this.hudTimer > 0.1) { this.hudTimer = 0; this.emitHud(); }
  }

  resolveAttack(a) {
    const dmg = Math.max(1, Math.round(a.dmg * this.run.missMult));
    this.shake = Math.max(this.shake, 12);
    this.hitGlow = 0.6;
    if (this.shield >= dmg) {
      this.shield = 0;
      this.audio.block();
      this.floaters.push({
        text: 'BLOCKED', color: '#ffd166', x: this.W / 2, y: this.coreY + this.coreR + 44,
        vy: -18, life: 0, max: 0.7, size: 18 * this.ui
      });
      this.rings.push({ x: this.W / 2, y: this.coreY, r: this.coreR, max: this.coreR * 3.6, life: 0, dur: 0.5, color: '255,209,102', w: 3 });
      this.shieldFlash = 1;
    } else {
      const overflow = dmg - this.shield;
      this.shield = 0;
      this.hurt(overflow);
      this.audio.hurt();
      this.hurtFlash = 1;
      this.floaters.push({
        text: `-${Math.round(overflow)} HP`, color: '#ff5c7c', x: this.W / 2, y: this.coreY + this.coreR + 44,
        vy: -22, life: 0, max: 0.9, size: 19 * this.ui
      });
    }
    this.emitHud(true);
  }

  stepEffects(dt) {
    this.laneFlash = this.laneFlash.map(v => Math.max(0, v - dt * 5.5));
    this.pressPulse = this.pressPulse.map(v => Math.max(0, v - dt * 7));
    this.shake *= Math.pow(0.0018, dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3.2);
    this.feverFlash = Math.max(0, this.feverFlash - dt * 1.5);
    this.coreFlash = Math.max(0, this.coreFlash - dt * 5);
    this.comboPop = Math.max(0, this.comboPop - dt * 4);
    this.judgePop = Math.max(0, this.judgePop - dt * 5);
    if (this.judgeFx) {
      this.judgeFx.life += dt;
      if (this.judgeFx.life >= this.judgeFx.max) this.judgeFx = null;
    }
    this.hitGlow = Math.max(0, this.hitGlow - dt * 5);
    if (this.shieldFlash) this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.g * dt;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      if (r.life >= r.dur) this.rings.splice(i, 1);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life += dt;
      f.y += f.vy * dt;
      if (f.life >= f.max) this.floaters.splice(i, 1);
    }
    for (const s of this.stars) {
      s.y += s.sp * dt;
      if (s.y > 1.05) { s.y = -0.05; s.x = Math.random(); }
    }
  }

  spawnHit(x, y, lane, q) {
    const rgb = LANE_RGB[lane];
    const count = q === 0 ? 12 : q === 1 ? 8 : 5;
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = (60 + Math.random() * 190) * (q === 0 ? 1.25 : 1);
      this.particles.push({
        x: x + (Math.random() - 0.5) * this.laneW * 0.55,
        y: y + (Math.random() - 0.5) * 10,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        g: 280, life: 0, max: 0.34 + Math.random() * 0.3,
        size: 1.5 + Math.random() * 2.6,
        color: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`
      });
    }
    this.rings.push({
      x, y, r: 4, max: this.laneW * 0.72,
      life: 0, dur: q === 0 ? 0.34 : 0.28,
      color: rgb.join(','), w: q === 0 ? 2.5 : 1.5
    });
  }

  spark(x, y, lane, count = 3) {
    const rgb = LANE_RGB[lane];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x, y, vx: (Math.random() - 0.5) * 120, vy: -40 - Math.random() * 100,
        g: 220, life: 0, max: 0.3 + Math.random() * 0.2,
        size: 1 + Math.random() * 1.6,
        color: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`
      });
    }
  }

  finish() {
    const accuracy = this.run.judged ? this.run.weighted / this.run.judged : 0;
    this.run.hp = this.hp;
    this.audio.stopTrack(0.2);
    this.onEnd(this.result, {
      depth: this.run.depth,
      score: this.run.score,
      battleScore: this.score,
      maxCombo: this.maxCombo,
      notesHit: this.run.notesHit,
      notesTotal: this.run.notesTotal,
      accuracy,
      hp: this.hp,
      clearBonus: this.clearBonus || 0
    });
  }

  emitHud(force = false) {
    const t = this.lastSong;
    const next = this.attacks.find(a => !a.fired);
    const attackIn = next ? (next.time - t) / this.spb : null;
    const snapshot = {
      hp: this.hp, maxHp: this.maxHp,
      shield: Math.round(this.shield), shieldMax: this.run.shieldMax,
      enemyHp: Math.ceil(this.enemyHp), enemyMax: this.enemyMax,
      score: this.run.score, combo: this.combo,
      mult: 1 + Math.min(this.combo, this.run.comboCap) * 0.02,
      fever: this.fever, feverActive: this.feverActive,
      feverLeft: this.feverActive ? Math.max(0, this.feverEnd - t) : 0,
      attackIn, state: this.state, revives: this.run.revives
    };
    this.onHud(snapshot);
  }

  // ---------- render ----------
  _tick = (ts) => {
    this._raf = requestAnimationFrame(this._tick);
    if (!this._lastTs) this._lastTs = ts;
    const dt = Math.min(0.05, (ts - this._lastTs) / 1000);
    this._lastTs = ts;
    const t = this.songTime();
    this.lastSong = t;
    if (!this.paused) this.update(dt, t);
    else this.stepEffects(dt * 0.3);
    this.render(t, dt);
  };

  render(t, dt) {
    const c = this.ctx;
    const W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    c.save();
    if (this.shake > 0.4) {
      c.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    const bpmPulse = Math.max(0, 1 - ((t / this.spb) % 1)) ** 2;

    this.drawBg(c, W, H, bpmPulse);
    this.drawLanes(c, W, H, t, bpmPulse);
    this.drawCore(c, t, bpmPulse);
    this.drawNotes(c, t);
    this.drawHitLine(c, H, t, bpmPulse);
    this.drawParticles(c);
    this.drawFloaters(c);
    this.drawJudgement(c);
    this.drawCombo(c, t);

    if (this.feverActive) {
      const left = clamp((this.feverEnd - t) / (this.spb * 8), 0, 1);
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,79,216,0.14)');
      g.addColorStop(0.6, 'rgba(255,79,216,0.03)');
      g.addColorStop(1, 'rgba(255,209,102,0.12)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.strokeStyle = `rgba(255,209,102,${0.22 + 0.3 * left})`;
      c.lineWidth = 2;
      c.strokeRect(1, 1, W - 2, H - 2);
      if (this.feverFlash > 0.05) {
        c.fillStyle = `rgba(255,255,255,${this.feverFlash * 0.32})`;
        c.fillRect(0, 0, W, H);
      }
    }

    if (this.hurtFlash > 0.02) {
      const g = c.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
      g.addColorStop(0, 'rgba(255,30,80,0)');
      g.addColorStop(1, `rgba(255,30,80,${this.hurtFlash * 0.28})`);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }

    if (this.state !== 'victory' && this.state !== 'defeat' && t < this.spb * 4.9) this.drawCountdown(c, t);
    c.restore();

    // vignette (not shaken)
    const vg = c.createRadialGradient(W / 2, H * 0.44, H * 0.28, W / 2, H * 0.44, H * 0.92);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
  }

  drawBg(c, W, H, pulse) {
    const hue = this.chart.hue;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsla(${hue},70%,20%,0.12)`);
    g.addColorStop(0.4, 'rgba(10,4,24,0.1)');
    g.addColorStop(1, 'rgba(5,2,14,0.34)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // drifting stars
    for (const s of this.stars) {
      c.globalAlpha = s.a * (0.7 + pulse * 0.3);
      c.fillStyle = s.s > 1.4 ? '#ffd9f6' : '#b8e9ff';
      c.fillRect(s.x * W, s.y * H, s.s, s.s);
    }
    c.globalAlpha = 1;

    // side rails
    c.strokeStyle = 'rgba(151,113,255,0.16)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(this.x0 - 3, 0);
    c.lineTo(this.x0 - 3, H);
    c.moveTo(this.x0 + this.playW + 3, 0);
    c.lineTo(this.x0 + this.playW + 3, H);
    c.stroke();
  }

  drawLanes(c, W, H, t, pulse) {
    const x0 = this.x0, y0 = 4, y1 = this.hitY + 22;
    const fieldH = y1 - y0;

    c.save();
    rr(c, x0, y0, this.playW, fieldH, 14);
    c.fillStyle = 'rgba(9,4,20,0.48)';
    c.fill();
    c.clip();

    for (let i = 0; i < LANES; i++) {
      const x = x0 + i * this.laneW;
      const flash = this.laneFlash[i];
      const rgb = LANE_RGB[i];
      if (flash > 0.01) {
        const lg = c.createLinearGradient(0, this.hitY - 160, 0, this.hitY);
        lg.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        lg.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.16 * flash})`);
        c.fillStyle = lg;
        c.fillRect(x + 1, 0, this.laneW - 2, this.hitY + 20);
      }
      // beat sheen
      const gsheen = c.createLinearGradient(0, 0, 0, this.hitY);
      gsheen.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.03 + 0.025 * pulse})`);
      gsheen.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gsheen;
      c.fillRect(x + 1, 0, this.laneW - 2, this.hitY);

      // lane color rising toward the hit line
      const laneGlow = c.createLinearGradient(0, this.hitY - 250, 0, this.hitY);
      laneGlow.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      laneGlow.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.055 + flash * 0.03})`);
      c.fillStyle = laneGlow;
      c.fillRect(x + 1, this.hitY - 250, this.laneW - 2, 250);

      if (i > 0) {
        c.strokeStyle = 'rgba(151,113,255,0.13)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, y1);
        c.stroke();
      }
    }

    // horizontal scrolling measure lines
    const pxPerBeat = this.pxPerBeat;
    const beat = t / this.spb;
    const beatFloor = Math.floor(beat);
    c.strokeStyle = 'rgba(151,113,255,0.10)';
    for (let k = 0; k < 12; k++) {
      const b = beatFloor + k - 1;
      const y = this.hitY - (b - beat) * pxPerBeat;
      if (y < 0 || y > this.hitY + 20) continue;
      c.globalAlpha = ((b % 4) === 0 ? 0.5 : 0.22) * clamp(1 - (this.hitY - y) / 500, 0.2, 1);
      c.beginPath();
      c.moveTo(x0 + 3, y);
      c.lineTo(x0 + this.playW - 3, y);
      c.stroke();
    }
    c.globalAlpha = 1;

    // receptors
    for (let i = 0; i < LANES; i++) {
      const x = x0 + i * this.laneW + (this.laneW - Math.min(this.laneW - 16, 82)) / 2;
      const w = Math.min(this.laneW - 16, 82);
      const h = 9 + this.pressPulse[i] * 5;
      const rgb = LANE_RGB[i];
      c.save();
      c.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.5 + this.laneFlash[i] * 0.5})`;
      c.shadowBlur = 14 + this.laneFlash[i] * 22;
      rr(c, x, this.hitY - h / 2, w, h, h / 2);
      c.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.18 + this.laneFlash[i] * 0.55})`;
      c.fill();
      c.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.55 + this.laneFlash[i] * 0.45})`;
      c.lineWidth = 1.5;
      c.stroke();
      c.restore();
    }
    c.restore();
  }

  drawCore(c, t, pulse) {
    const x = this.coreX, y = this.coreY;
    const hue = this.chart.hue;
    const active = this.state !== 'victory' && this.state !== 'defeat';
    const next = this.attacks.find(a => !a.fired);
    const warn = next && active && (next.time - t) / this.spb < 2 ? 1 - clamp((next.time - t) / (this.spb * 2), 0, 1) : 0;

    const beat = t / this.spb;
    const wob = Math.sin(beat * Math.PI) * 0.03;
    const R = this.coreR * (0.94 + pulse * 0.08 + wob) * (this.state === 'victory' ? 0.4 : 1);

    c.save();
    c.translate(x, y);

    // aura
    const aura = c.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 2.6);
    aura.addColorStop(0, `hsla(${hue},90%,65%,${0.26 + pulse * 0.12})`);
    aura.addColorStop(0.45, `hsla(${hue},90%,55%,0.09)`);
    aura.addColorStop(1, 'hsla(0,0%,0%,0)');
    c.fillStyle = aura;
    c.beginPath();
    c.arc(0, 0, R * 2.6, 0, Math.PI * 2);
    c.fill();

    const rot = this.elapsed * 0.35 + beat * 0.2;

    // outer rings
    for (let i = 0; i < 3; i++) {
      const rr2 = R * (1.35 + i * 0.3);
      c.strokeStyle = `hsla(${(hue + i * 24) % 360},90%,68%,${0.28 - i * 0.06})`;
      c.lineWidth = 1.2;
      c.setLineDash([R * (0.5 + i * 0.2), R * (0.65 + i * 0.1)]);
      c.lineDashOffset = (i % 2 ? -1 : 1) * rot * (30 + i * 10);
      c.beginPath();
      c.arc(0, 0, rr2, 0, Math.PI * 2);
      c.stroke();
    }
    c.setLineDash([]);

    // warning ring closes
    if (warn > 0) {
      c.strokeStyle = `rgba(255,59,107,${0.4 + warn * 0.5})`;
      c.lineWidth = 2 + warn * 2;
      c.beginPath();
      c.arc(0, 0, R * (1.2 + (1 - warn) * 1.6), 0, Math.PI * 2);
      c.stroke();
    }

    // polygon body
    const sides = 5 + this.chart.shape;
    c.save();
    c.rotate(-rot * 0.4);
    c.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const rad = R * (0.66 + 0.07 * Math.sin(beat * Math.PI * 2 + i * 1.7));
      const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = `hsla(${hue},85%,58%,0.10)`;
    c.fill();
    c.strokeStyle = `hsla(${hue},92%,72%,${0.65 + this.coreFlash * 0.35})`;
    c.lineWidth = 1.6;
    c.shadowColor = `hsla(${hue},92%,65%,0.9)`;
    c.shadowBlur = 22;
    c.stroke();
    c.restore();

    // inner core
    c.save();
    c.rotate(rot * 0.8);
    c.beginPath();
    c.arc(0, 0, R * 0.3 * (1 + pulse * 0.12), 0, Math.PI * 2);
    c.fillStyle = `hsla(${(hue + 40) % 360},100%,72%,${0.26 + this.coreFlash * 0.5})`;
    c.shadowColor = `hsl(${hue},100%,70%)`;
    c.shadowBlur = 28;
    c.fill();
    c.strokeStyle = `hsla(${hue},100%,84%,0.9)`;
    c.lineWidth = 1.2;
    c.stroke();
    c.restore();

    // vertical eye slit
    c.fillStyle = `rgba(255,255,255,${0.5 + this.coreFlash * 0.5})`;
    c.fillRect(-1, -R * 0.16, 2, R * 0.32);

    if (this.coreFlash > 0.05) {
      c.globalAlpha = this.coreFlash * 0.5;
      c.fillStyle = '#fff';
      c.beginPath();
      c.arc(0, 0, R * 1.1, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }
    c.restore();
  }

  drawNotes(c, t) {
    if (this.state === 'victory' || this.state === 'defeat') return;
    const pxPerBeat = this.pxPerBeat;
    const spb = this.spb;
    const headH = Math.min(26, Math.max(18, this.laneW * 0.22));
    const headW = this.laneW - Math.max(16, this.laneW * 0.16);

    for (const n of this.notes) {
      if (n.head === 'hit' && n.hold <= 0) continue;
      const laneX = this.x0 + n.lane * this.laneW + (this.laneW - headW) / 2;
      const beatsAhead = (n.time - t) / spb;

      if (n.head === 'hit' && n.hold > 0) {
        // remaining sustain body, consumed at the hit line
        const remainBeats = (n.time + n.hold - t) / spb;
        if (remainBeats <= 0) continue;
        const topY = this.hitY - remainBeats * pxPerBeat;
        const rgb = LANE_RGB[n.lane];
        const g = c.createLinearGradient(0, topY, 0, this.hitY);
        g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.10)`);
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.5})`);
        c.fillStyle = g;
        rr(c, laneX + headW * 0.28, topY, headW * 0.44, this.hitY - topY, headW * 0.22);
        c.fill();
        c.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`;
        c.lineWidth = 1;
        c.stroke();
        continue;
      }

      const y = this.hitY - beatsAhead * pxPerBeat;
      if (y < -70 || y > this.H + 70) continue;
      const rgb = LANE_RGB[n.lane];
      const missed = n.head === 'miss';
      const alpha = missed ? 0.3 : 1;

      // hold tail
      if (n.hold > 0 && !missed) {
        const tailY = y - (n.hold / spb) * pxPerBeat;
        const tailTop = Math.max(-60, tailY);
        if (y - tailTop > 2) {
          const g = c.createLinearGradient(0, tailTop, 0, y);
          g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.05)`);
          g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.28)`);
          c.fillStyle = g;
          rr(c, laneX + headW * 0.28, tailTop, headW * 0.44, y - tailTop, headW * 0.22);
          c.fill();
          c.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.4)`;
          c.lineWidth = 1;
          c.stroke();
          // cap
          if (tailY > -60) {
            c.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.6)`;
            rr(c, laneX + headW * 0.18, tailY - 3, headW * 0.64, 5, 3);
            c.fill();
          }
        }
      }

      // head
      c.save();
      c.globalAlpha = alpha;
      c.shadowColor = missed ? 'rgba(255,60,100,0.8)' : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.85)`;
      c.shadowBlur = missed ? 8 : 16;
      const g = c.createLinearGradient(0, y - headH / 2, 0, y + headH / 2);
      if (missed) {
        g.addColorStop(0, '#5a2034');
        g.addColorStop(1, '#2b0f1b');
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.28, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.72)`);
      }
      c.fillStyle = g;
      rr(c, laneX, y - headH / 2, headW, headH, headH * 0.32);
      c.fill();
      c.strokeStyle = missed ? 'rgba(255,90,120,0.4)' : 'rgba(255,255,255,0.6)';
      c.lineWidth = 1;
      c.stroke();
      // inner slit
      if (!missed) {
        c.fillStyle = 'rgba(255,255,255,0.75)';
        rr(c, laneX + headW * 0.18, y - 1.5, headW * 0.64, 3, 2);
        c.fill();
      }
      c.restore();
    }
  }

  drawHitLine(c, H, t, pulse) {
    const y = this.hitY;
    const x0 = this.x0, w = this.playW;
    c.save();
    c.shadowColor = 'rgba(79,240,255,0.7)';
    c.shadowBlur = 16 + pulse * 20 + this.hitGlow * 24;
    const g = c.createLinearGradient(x0, 0, x0 + w, 0);
    g.addColorStop(0, 'rgba(79,240,255,0.15)');
    g.addColorStop(0.2, 'rgba(79,240,255,0.9)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.8, 'rgba(255,79,216,0.9)');
    g.addColorStop(1, 'rgba(255,79,216,0.15)');
    c.fillStyle = g;
    c.fillRect(x0, y - 1.2, w, 2.4);
    c.restore();

    // arrows under line
    c.globalAlpha = 0.24;
    c.fillStyle = '#9b84d6';
    for (let i = 0; i < LANES; i++) {
      const cx = x0 + i * this.laneW + this.laneW / 2;
      c.beginPath();
      c.moveTo(cx - 4, y + 8);
      c.lineTo(cx + 4, y + 8);
      c.lineTo(cx, y + 13);
      c.closePath();
      c.fill();
    }
    c.globalAlpha = 1;
  }

  drawParticles(c) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const a = 1 - p.life / p.max;
      c.globalAlpha = a;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      c.fill();
    }
    for (const r of this.rings) {
      const k = r.life / r.dur;
      c.globalAlpha = (1 - k) * 0.8;
      c.strokeStyle = `rgba(${r.color},${1 - k})`;
      c.lineWidth = r.w * (1 - k * 0.6);
      c.beginPath();
      c.arc(r.x, r.y, r.r + (r.max - r.r) * easeOut(k), 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  drawFloaters(c) {
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const f of this.floaters) {
      const k = f.life / f.max;
      const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      c.globalAlpha = Math.max(0, a);
      c.fillStyle = f.color;
      c.font = `900 ${f.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      c.shadowColor = f.color;
      c.shadowBlur = 16;
      c.fillText(f.text, f.x, f.y);
    }
    c.restore();
  }

  drawCombo(c, t) {
    if (this.combo < 3) return;
    const x = this.W / 2;
    const y = this.hitY - this.comboOffset;
    const pop = 1 + this.comboPop * 0.18;
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.globalAlpha = 0.95;
    const size = Math.min(46, this.laneW * 0.95, this.H * 0.13) * pop;
    c.font = `900 ${size}px system-ui, -apple-system, sans-serif`;
    c.fillStyle = 'rgba(255,255,255,0.95)';
    c.shadowColor = this.feverActive ? 'rgba(255,209,102,0.8)' : 'rgba(79,240,255,0.55)';
    c.shadowBlur = 22;
    c.fillText(String(this.combo), x, y);

    c.shadowBlur = 0;
    c.font = `700 ${8 * this.ui + 2}px "SF Mono", ui-monospace, monospace`;
    c.fillStyle = 'rgba(200,185,235,0.7)';
    c.letterSpacing = '3px';
    c.fillText('COMBO', x, y + size * 0.56);

    const mult = (1 + Math.min(this.combo, this.run.comboCap) * 0.02).toFixed(2);
    c.font = `700 ${9 * this.ui + 1}px "SF Mono", ui-monospace, monospace`;
    c.fillStyle = this.feverActive ? '#ffd166' : 'rgba(79,240,255,0.9)';
    c.fillText(`×${mult}`, x, y + size * 0.56 + 14);
    c.restore();
  }

  drawJudgement(c) {
    if (!this.judgeFx) return;
    const j = this.judgeFx;
    const k = j.life / j.max;
    const alpha = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
    const scale = 1 + this.judgePop * 0.18;
    c.save();
    c.globalAlpha = Math.max(0, alpha);
    c.translate(this.W / 2, this.hitY - this.judgeOffset - easeOut(Math.min(1, k * 1.5)) * 10);
    c.scale(scale, scale);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `900 ${j.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    c.letterSpacing = '2px';
    c.fillStyle = j.color;
    c.shadowColor = j.color;
    c.shadowBlur = 18;
    c.fillText(j.text, 0, 0);
    c.restore();
  }

  drawCountdown(c, t) {
    const beat = t / this.spb;
    let label = null;
    let k = 0;
    if (beat < 1) { label = 'READY'; k = beat; }
    else if (beat < 2) { label = '3'; k = beat - 1; }
    else if (beat < 3) { label = '2'; k = beat - 2; }
    else if (beat < 4) { label = '1'; k = beat - 3; }
    else if (beat < 4.7) { label = 'GO'; k = (beat - 4) / 0.7; }

    if (!label) return;
    const size = label === 'READY' ? Math.min(22 * this.ui, 30) : Math.min(this.W * 0.24, this.H * 0.3, 130);
    const scale = 1.18 - easeOut(clamp(k, 0, 1)) * 0.2;
    const alpha = label === 'GO' ? 1 - clamp((beat - 4) / 0.7, 0, 1) : 0.95;

    c.save();
    c.globalAlpha = alpha;
    c.translate(this.W / 2, this.H * 0.42);
    c.scale(scale, scale);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `900 ${size}px system-ui, -apple-system, sans-serif`;
    c.fillStyle = label === 'READY' ? '#cbb6ff' : '#ffffff';
    c.shadowColor = label === 'GO' ? 'rgba(166,255,77,0.9)' : 'rgba(79,240,255,0.8)';
    c.shadowBlur = 34;
    c.letterSpacing = label === 'READY' ? '6px' : '0px';
    c.fillText(label, 0, 0);
    c.restore();
  }
}
