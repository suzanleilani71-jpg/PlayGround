// Roguelike upgrade pool ("resonances"). Each is deterministic and stackable.
import { mulberry32, hash } from './util.js';

export const UPGRADES = [
  {
    id: 'amp', name: 'Amp Stack', kind: 'OFFENSE', icon: '▲', color: 'cyan', max: 5,
    desc: r => `+14% note damage. Current: ×${r.damageMult.toFixed(2)}`,
    apply: r => { r.damageMult += 0.14; }
  },
  {
    id: 'metro', name: 'Metronome', kind: 'TEMPO', icon: '◷', color: 'cyan', max: 3,
    desc: r => `+16% timing windows. Current: ×${r.windowMult.toFixed(2)}`,
    apply: r => { r.windowMult = Math.min(2.2, r.windowMult + 0.16); }
  },
  {
    id: 'aegis', name: 'Aegis Plate', kind: 'DEFENSE', icon: '⬡', color: 'amber', max: 3,
    desc: r => `+8 max shield and +30% shield gain. Current: ◈${r.shieldMax}`,
    apply: r => { r.shieldMax += 8; r.shieldGainMult += 0.3; }
  },
  {
    id: 'siphon', name: 'Siphon', kind: 'SUSTAIN', icon: '✚', color: 'lime', max: 3,
    desc: r => `Perfect hits restore ${(r.lifesteal + 0.55).toFixed(2)} HP.`,
    apply: r => { r.lifesteal += 0.55; }
  },
  {
    id: 'adrenaline', name: 'Adrenaline', kind: 'TEMPO', icon: '⚡', color: 'pink', max: 2,
    desc: r => `+45% fever charge. Current: ×${r.feverGain.toFixed(2)}`,
    apply: r => { r.feverGain += 0.45; }
  },
  {
    id: 'headstart', name: 'Head Start', kind: 'TEMPO', icon: '✦', color: 'pink', max: 2,
    desc: r => `Begin each battle with ${Math.min(80, r.startFever + 35)}% fever.`,
    apply: r => { r.startFever = Math.min(80, r.startFever + 35); }
  },
  {
    id: 'vitality', name: 'Vitality', kind: 'SUSTAIN', icon: '❤', color: 'lime', max: 4,
    desc: r => `+20 max HP and heal 20 now. Current: ${r.maxHp} HP.`,
    apply: r => { r.maxHp += 20; r.hp = Math.min(r.maxHp, r.hp + 20); }
  },
  {
    id: 'crowd', name: 'Crowd Surge', kind: 'OFFENSE', icon: '∞', color: 'violet', max: 2,
    desc: r => `+25 combo cap. Current: ${r.comboCap + 25} combo.`,
    apply: r => { r.comboCap += 25; }
  },
  {
    id: 'encore', name: 'Encore', kind: 'DEFENSE', icon: '↺', color: 'amber', max: 2,
    desc: r => `Survive one fatal blow. Charges: ${r.revives + 1}.`,
    apply: r => { r.revives += 1; }
  },
  {
    id: 'overdrive', name: 'Overdrive', kind: 'OFFENSE', icon: '☄', color: 'pink', max: 2,
    desc: r => `Fever damage ×2.4. Current: ×${r.feverDamage.toFixed(1)}`,
    apply: r => { r.feverDamage = Math.min(3, r.feverDamage + 0.6); }
  },
  {
    id: 'bastion', name: 'Bastion', kind: 'DEFENSE', icon: '⛨', color: 'amber', max: 3,
    desc: r => `Start each battle with ${r.startShield + 15} shield.`,
    apply: r => { r.startShield += 15; }
  },
  {
    id: 'hype', name: 'Hype Train', kind: 'SCORE', icon: '★', color: 'violet', max: 4,
    desc: r => `+25% score. Current: ×${r.scoreMult.toFixed(2)}`,
    apply: r => { r.scoreMult += 0.25; }
  },
  {
    id: 'rebound', name: 'Rebound', kind: 'DEFENSE', icon: '⤺', color: 'lime', max: 3,
    desc: r => `-20% miss and strike damage. Current: -${Math.round((1 - r.missMult) * 100)}%`,
    apply: r => { r.missMult = Math.max(0.45, r.missMult - 0.2); }
  },
  {
    id: 'flow', name: 'Flow State', kind: 'TEMPO', icon: '≋', color: 'cyan', max: 3,
    desc: r => `+8% damage and +8% timing windows.`,
    apply: r => { r.damageMult += 0.08; r.windowMult = Math.min(2.2, r.windowMult + 0.08); }
  },
  {
    id: 'afterburn', name: 'Afterburn', kind: 'OFFENSE', icon: '✷', color: 'pink', max: 2,
    desc: r => `Hold notes deal +80% damage. Current: ×${r.holdBonus.toFixed(1)} → ×${(r.holdBonus + 0.8).toFixed(1)}`,
    apply: r => { r.holdBonus += 0.8; }
  }
];

export function makeRun(seed) {
  return {
    seed,
    depth: 1,
    score: 0,
    hp: 100,
    maxHp: 100,
    damageMult: 1,
    windowMult: 1,
    shieldMax: 30,
    shieldGainMult: 1,
    lifesteal: 0,
    feverGain: 1,
    startFever: 0,
    comboCap: 50,
    revives: 0,
    feverDamage: 1.8,
    startShield: 0,
    scoreMult: 1,
    missMult: 1,
    holdBonus: 1,
    upgrades: [],
    bestCombo: 0,
    notesHit: 0,
    notesTotal: 0,
    startedAt: Date.now()
  };
}

export function offerUpgrades(run, depth) {
  const rng = mulberry32(hash(run.seed, depth, 0x9e3779b9));
  const counts = {};
  for (const u of run.upgrades) counts[u.id] = (counts[u.id] || 0) + 1;
  const pool = UPGRADES.filter(u => (counts[u.id] || 0) < u.max);
  const out = [];
  const bag = [...pool];
  while (out.length < 3 && bag.length) {
    const i = Math.floor(rng() * bag.length);
    out.push(bag.splice(i, 1)[0]);
  }
  // tiny nudge: if none are offensive, swap the last for an offensive option when possible
  if (out.length && !out.some(u => u.kind === 'OFFENSE')) {
    const alt = bag.find(u => u.kind === 'OFFENSE');
    if (alt) out[out.length - 1] = alt;
  }
  return out;
}
