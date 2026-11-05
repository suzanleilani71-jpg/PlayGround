// Procedural chart + enemy generation.
// Everything is deterministic from (run seed, depth), so a run can be replayed.
import { mulberry32, randInt, pick, hash } from './util.js';

export const LANES = 4;
const PRE_ROLL_BEATS = 4;

const PREFIXES = ['GLASS', 'VOID', 'ECHO', 'NEON', 'ASH', 'PRISM', 'GRAVE', 'LUMEN', 'STATIC', 'CRIMSON', 'HOLLOW', 'IRON', 'SABLE', 'MIRROR', 'VELVET', 'CHROME'];
const NOUNS = ['WARDEN', 'WRAITH', 'ENGINE', 'SERAPH', 'HOUND', 'CANTOR', 'SPIRE', 'MAW', 'CHOIR', 'KNIGHT', 'PARASITE', 'HERALD', 'LATTICE', 'REVENANT', 'PILGRIM', 'MONOLITH'];
const BOSSES = ['THE SILENT CHOIR', 'MOTHER STATIC', 'THE LAST TEMPO', 'PRISM DEVOURER', 'KING CADENCE', 'THE HOLLOW BEAT', 'SAINT DECIBEL'];

const stepLanes = (n, start, dir) => Array.from({ length: n }, (_, i) => (start + dir * i + 8) % 4);

const PATTERNS = [
  {
    id: 'pulse', tier: 0, weight: 3,
    fn(rng) {
      const a = randInt(rng, 0, 3);
      const b = (a + 1 + randInt(rng, 0, 2)) % 4;
      const notes = [{ b: 0, l: a }, { b: 2, l: b }];
      if (rng() < 0.35) notes.push({ b: 3.5, l: randInt(rng, 0, 3) });
      return notes;
    }
  },
  {
    id: 'stair', tier: 0, weight: 2,
    fn(rng) {
      const dir = rng() < 0.5 ? 1 : -1;
      const start = dir > 0 ? randInt(rng, 0, 1) : randInt(rng, 2, 3);
      return stepLanes(4, start, dir).map((l, i) => ({ b: i, l }));
    }
  },
  {
    id: 'offbeat', tier: 0, weight: 2,
    fn(rng) {
      let l = randInt(rng, 0, 3);
      return [0.5, 1.5, 2.5, 3.5].map((b, i) => {
        if (i) l = (l + (rng() < 0.5 ? 1 : -1) + 4) % 4;
        return { b, l };
      });
    }
  },
  {
    id: 'sync', tier: 0, weight: 3,
    fn(rng) {
      const ls = [randInt(rng, 0, 3), randInt(rng, 0, 3), randInt(rng, 0, 3), randInt(rng, 0, 3)];
      return [0, 1.5, 2.5, 3.25].map((b, i) => ({ b, l: ls[i] }));
    }
  },
  {
    id: 'hold', tier: 0, weight: 2,
    fn(rng) {
      const holdLane = randInt(rng, 0, 3);
      const dur = rng() < 0.5 ? 2 : 2.5;
      const other = (holdLane + 1 + randInt(rng, 0, 2)) % 4;
      const other2 = (other + 1 + randInt(rng, 0, 2)) % 4;
      return [
        { b: 0, l: holdLane, hold: dur },
        { b: 1.5, l: other },
        { b: 2.5, l: other2 },
        { b: 3.5, l: other }
      ];
    }
  },
  {
    id: 'eighth', tier: 0, weight: 3,
    fn(rng) {
      const dir = rng() < 0.5 ? 1 : -1;
      const start = randInt(rng, 0, 3);
      return stepLanes(8, start, dir).map((l, i) => ({ b: i * 0.5, l }));
    }
  },
  {
    id: 'chord', tier: 1, weight: 2,
    fn(rng) {
      const pair = rng() < 0.5 ? [0, 2] : [1, 3];
      const flip = rng() < 0.5;
      const l1 = flip ? pair[1] : pair[0];
      const l2 = flip ? pair[0] : pair[1];
      const notes = [
        { b: 0, l: l1 }, { b: 0, l: l2 },
        { b: 2, l: l2 }, { b: 2, l: l1 }
      ];
      if (rng() < 0.5) notes.push({ b: 3.5, l: randInt(rng, 0, 3) });
      return notes;
    }
  },
  {
    id: 'gallop', tier: 1, weight: 2,
    fn(rng) {
      let l = randInt(rng, 0, 3);
      return [0, 0.75, 1.5, 2, 2.75, 3.5].map((b) => {
        const out = { b, l };
        l = (l + (rng() < 0.5 ? 1 : -1) + 4) % 4;
        return out;
      });
    }
  },
  {
    id: 'drive', tier: 2, weight: 2,
    fn(rng) {
      const dir = rng() < 0.5 ? 1 : -1;
      const lanes = stepLanes(8, randInt(rng, 0, 3), dir);
      const notes = lanes.map((l, i) => ({ b: i * 0.5, l }));
      notes.push({ b: 0, l: (lanes[0] + 2) % 4 });
      notes.push({ b: 2, l: (lanes[4] + 2) % 4 });
      return notes;
    }
  },
  {
    id: 'burst', tier: 2, weight: 2,
    fn(rng) {
      const dir = rng() < 0.5 ? 1 : -1;
      const lanes = stepLanes(8, randInt(rng, 0, 3), dir);
      const notes = [];
      for (let i = 0; i < 4; i++) notes.push({ b: i * 0.25, l: lanes[i] });
      for (let i = 0; i < 4; i++) notes.push({ b: 2 + i * 0.25, l: lanes[i + 4] });
      return notes;
    }
  },
  {
    id: 'finale', tier: 3, weight: 1.5,
    fn(rng) {
      const dir = rng() < 0.5 ? 1 : -1;
      const lanes = stepLanes(8, randInt(rng, 0, 3), dir);
      const notes = lanes.map((l, i) => ({ b: i * 0.25, l }));
      notes.push({ b: 2.5, l: (lanes[7] + 1) % 4 });
      notes.push({ b: 3, l: (lanes[7] + 2) % 4 });
      notes.push({ b: 3.5, l: (lanes[7] + 3) % 4 });
      return notes;
    }
  }
];

function buildNotes(rng, measures, tier, boss) {
  const notes = [];
  const laneFree = [-1, -1, -1, -1]; // earliest beat this lane may start a new note
  let lastPattern = '';
  let repeat = 0;

  for (let m = 0; m < measures; m++) {
    const base = m * 4;
    const pool = PATTERNS.filter(p => p.tier <= tier);
    let pat = null;
    for (let tries = 0; tries < 8; tries++) {
      const total = pool.reduce((s, p) => s + p.weight, 0);
      let r = rng() * total;
      for (const p of pool) {
        r -= p.weight;
        if (r <= 0) { pat = p; break; }
      }
      if (pat && !(pat.id === lastPattern && repeat >= 2)) break;
      pat = null;
    }
    pat = pat || pool[0];
    if (pat.id === lastPattern) repeat++; else { repeat = 0; lastPattern = pat.id; }

    const generated = pat.fn(rng);
    // occasional chord garnish on deeper floors
    if (tier >= 2 && rng() < 0.22) {
      const single = generated.find(n => n.b < 3.5 && !n.hold);
      if (single) {
        const extra = (single.l + 2) % 4;
        generated.push({ b: single.b, l: extra });
      }
    }

    const measureNotes = [];
    for (const n of generated.sort((a, b) => a.b - b.b)) {
      if (n.b >= 4) continue;
      const lane = n.l % 4;
      const absB = base + n.b;
      const gap = n.hold ? 0.42 : 0.3;
      if (absB < laneFree[lane]) continue;
      // don't double-book a lane on the exact same beat
      if (measureNotes.some(x => x.l === lane && Math.abs(x.b - n.b) < 0.001)) continue;
      const item = { beat: absB, lane, hold: n.hold || 0 };
      measureNotes.push({ b: n.b, l: lane, hold: n.hold || 0, beat: absB });
      notes.push(item);
      laneFree[lane] = absB + (n.hold || 0) + gap;
    }
  }

  notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  notes.forEach((n, i) => { n.id = i; });
  return notes;
}

export function makeChart(depth, seed) {
  const boss = depth % 5 === 0;
  const rng = mulberry32(hash(seed, depth, boss ? 0xb055 : 0x51ab));
  const tier = Math.min(3, Math.floor((depth - 1) / 4));
  const bpm = Math.min(156, Math.round(92 + (depth - 1) * 3.1 + (boss ? 4 : 0)));
  const spb = 60 / bpm;
  const measures = boss
    ? 12 + Math.min(3, Math.floor(depth / 6))
    : 9 + Math.min(3, Math.floor(depth / 5));
  const notes = buildNotes(rng, measures, tier, boss);
  const totalBeats = measures * 4;

  const attacks = [];
  const interval = boss ? 6 : 8;
  for (let b = 8; b < totalBeats - 2; b += interval) {
    attacks.push({ beat: b, dmg: Math.round(11 + depth * 0.6) });
  }

  const hpPerNote = 4.8 + depth * 0.32 + (boss ? 0.2 : 0);
  let hp = Math.round(notes.length * hpPerNote / 10) * 10;
  // never let the target be trivially below a clean clear
  hp = Math.max(120, hp);

  const name = boss
    ? BOSSES[(Math.floor(depth / 5) - 1) % BOSSES.length]
    : `${pick(rng, PREFIXES)} ${pick(rng, NOUNS)}`;

  return {
    depth, boss, tier, bpm, spb, measures, totalBeats,
    preRollBeats: PRE_ROLL_BEATS,
    notes, attacks, hp, name,
    hue: (hash(seed, depth, 7) % 360),
    shape: hash(seed, depth, 11) % 4,
    seed
  };
}

export { PRE_ROLL_BEATS };
