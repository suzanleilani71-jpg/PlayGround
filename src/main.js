import { AudioEngine } from './audio.js';
import { makeChart } from './chart.js';
import { Battle } from './battle.js';
import { makeRun, offerUpgrades, UPGRADES } from './upgrades.js';
import { fmt } from './util.js';

const $ = (id) => document.getElementById(id);
const audio = new AudioEngine();

const screens = {
  title: $('screen-title'),
  battle: $('screen-battle'),
  reward: $('screen-reward'),
  over: $('screen-over')
};

const el = {
  depthVal: $('depthVal'),
  hpFill: $('hpFill'),
  hpGhost: $('hpGhost'),
  hpText: $('hpText'),
  shieldText: $('shieldText'),
  action: $('attackStatus'),
  scoreVal: $('scoreVal'),
  comboMini: $('comboMini'),
  enemyName: $('enemyName'),
  bossTag: $('bossTag'),
  enemyHpText: $('enemyHpText'),
  enemyFill: $('enemyFill'),
  feverBtn: $('feverBtn'),
  feverPct: $('feverPct'),
  feverBanner: $('feverBanner'),
  coach: $('coach'),
  bottomTip: $('bottomTip'),
  laneHints: [...document.querySelectorAll('.lane-hints span')],
  pauseBtn: $('pauseBtn'),
  pauseModal: $('pauseModal'),
  howModal: $('howModal')
};

const BEST_KEY = 'beatfall.best.v1';
let best = loadBest();
let run = null;
let battle = null;
let selectedOffer = null;
let offers = [];
let lastEnemyKey = '';
let coachTimer = null;

function loadBest() {
  try {
    const raw = JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
    return { depth: raw.depth || 0, score: raw.score || 0 };
  } catch { return { depth: 0, score: 0 }; }
}
function saveBest() {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* */ }
}

function showScreen(name) {
  for (const [k, node] of Object.entries(screens)) node.classList.toggle('active', k === name);
  window.scrollTo(0, 0);
  if (name !== 'battle') hideCoach();
}

function refreshBestOnTitle() {
  $('bestDepth').textContent = best.depth ? String(best.depth).padStart(2, '0') : '—';
  $('bestScore').textContent = best.score ? fmt.format(best.score) : '—';
}

function updateBest() {
  let changed = false;
  if (run) {
    if (run.depth > best.depth) { best.depth = run.depth; changed = true; }
    if (run.score > best.score) { best.score = run.score; changed = true; }
  }
  if (changed) saveBest();
  refreshBestOnTitle();
}

// ------------------------------------------------------------------ battle
async function startNewRun() {
  audio.click();
  await audio.init();
  if (battle) { const b = battle; battle = null; b.destroy(); }
  const seed = Math.floor(Math.random() * 1e9);
  run = makeRun(seed);
  selectedOffer = null;
  offers = [];
  startBattle();
}

function startBattle() {
  showScreen('battle');
  selectedOffer = null;
  offers = [];
  el.coach.classList.remove('show');
  el.feverBanner.classList.remove('show');
  el.feverBtn.classList.remove('ready', 'active');
  el.feverBtn.disabled = true;
  el.feverBtn.style.setProperty('--p', '0');

  const chart = makeChart(run.depth, run.seed);
  lastEnemyKey = chart.name + chart.depth;

  el.depthVal.textContent = String(run.depth).padStart(2, '0');
  el.enemyName.textContent = chart.name;
  el.bossTag.classList.toggle('hidden', !chart.boss);
  el.enemyHpText.textContent = `${chart.hp} / ${chart.hp}`;
  el.enemyFill.style.transform = 'scaleX(1)';
  el.scoreVal.textContent = fmt.format(run.score);
  el.hpText.textContent = Math.round(run.hp);
  el.hpFill.style.transform = `scaleX(${Math.max(0, run.hp / run.maxHp)})`;
  el.hpGhost.style.transform = `scaleX(${Math.max(0, run.hp / run.maxHp)})`;
  el.shieldText.textContent = `◈ ${Math.min(run.startShield, run.shieldMax)}`;
  el.comboMini.textContent = 'COMBO ×1.00';
  el.action.textContent = 'STABLE';
  el.action.classList.remove('warn');
  el.bottomTip.textContent = 'HIT THE LINE';
  el.laneHints.forEach(s => s.classList.remove('on'));

  if (battle) { const b = battle; battle = null; b.destroy(); }

  battle = new Battle({
    run, chart, audio,
    canvas: $('gameCanvas'),
    onHud: updateHud,
    onCoach: showCoach,
    onEnd: handleBattleEnd
  });
  battle.optsEscape = openPause;
  updateFeverButton({ fever: run.startFever, feverActive: false, state: 'intro' }, true);
  battle.start();
}

function updateHud(s) {
  const hpPct = Math.max(0, Math.min(1, s.hp / s.maxHp));
  el.hpFill.style.transform = `scaleX(${hpPct})`;
  el.hpGhost.style.transform = `scaleX(${hpPct})`;
  el.hpText.textContent = Math.ceil(s.hp);
  el.shieldText.textContent = `◈ ${s.shield}`;
  el.enemyFill.style.transform = `scaleX(${Math.max(0, s.enemyHp / s.enemyMax)})`;
  el.enemyHpText.textContent = `${fmt.format(s.enemyHp)} / ${fmt.format(s.enemyMax)}`;
  el.scoreVal.textContent = fmt.format(s.score);
  el.comboMini.textContent = s.combo > 0 ? `${s.combo} HIT · ×${s.mult.toFixed(2)}` : 'COMBO ×1.00';

  if (s.attackIn != null && s.attackIn < 2.05 && s.attackIn > 0 && s.state === 'play') {
    el.action.textContent = s.attackIn < 0.55 ? 'STRIKE!' : `STRIKE ${Math.ceil(s.attackIn)}`;
    el.action.classList.add('warn');
  } else {
    el.action.textContent = s.state === 'victory' ? 'CLEARED' : s.state === 'defeat' ? 'FLATLINE' : 'STABLE';
    el.action.classList.remove('warn');
  }

  if (s.state === 'play' || s.state === 'intro') {
    if (s.feverActive) el.bottomTip.textContent = 'FEVER ACTIVE — GO HARD';
    else if (s.fever >= 100) el.bottomTip.textContent = 'FEVER READY — TAP IT';
    else if (hpPct < 0.3) el.bottomTip.textContent = 'LOW HP — HOLD THE LINE';
    else el.bottomTip.textContent = s.revives > 0 ? `ENCORE ×${s.revives}` : 'HIT THE LINE';
  }

  updateFeverButton(s);
}

function updateFeverButton(s, force = false) {
  const active = !!s.feverActive;
  const ready = !active && s.fever >= 100;
  el.feverBtn.classList.toggle('ready', ready);
  el.feverBtn.classList.toggle('active', active);
  const p = active ? 100 : Math.max(0, Math.min(100, s.fever || 0));
  if (force || p !== Number(el.feverBtn.dataset.p || -1)) {
    el.feverBtn.style.setProperty('--p', String(p));
    el.feverBtn.dataset.p = String(p);
  }
  el.feverPct.textContent = active ? 'ACTIVE' : ready ? 'READY' : `${Math.floor(p)}%`;
  el.feverBtn.disabled = !ready;
  if (active !== el.feverBtn.dataset.active) {
    el.feverBtn.dataset.active = active ? '1' : '0';
    clearTimeout(el.feverBanner._t);
    if (active) {
      el.feverBanner.classList.add('show');
      el.feverBanner._t = setTimeout(() => el.feverBanner.classList.remove('show'), 1900);
    } else {
      el.feverBanner.classList.remove('show');
    }
  }
}

function showCoach(text, index) {
  el.coach.textContent = text;
  el.coach.classList.add('show');
  clearTimeout(coachTimer);
  coachTimer = setTimeout(() => el.coach.classList.remove('show'), index === 0 ? 3400 : 3000);
}
function hideCoach() {
  clearTimeout(coachTimer);
  el.coach.classList.remove('show');
}

function handleBattleEnd(result, stats) {
  if (!run) return;
  run.hp = stats.hp;
  const b = battle;
  battle = null;
  setTimeout(() => b?.destroy(), 40);

  if (result === 'victory') {
    updateBest();
    const heal = Math.round(run.maxHp * 0.2);
    run.hp = Math.min(run.maxHp, run.hp + heal);
    showReward(stats, heal);
  } else {
    updateBest();
    showGameOver(stats);
  }
}

// ------------------------------------------------------------------ reward
function showReward(stats, heal) {
  showScreen('reward');
  $('rewardDepth').textContent = String(run.depth).padStart(2, '0');
  $('rewardSub').innerHTML = `<b>+${heal} HP</b> recovered · choose one resonance`;
  $('rewardStats').innerHTML = `
    <span>SCORE <b>${fmt.format(stats.score)}</b></span>
    <span>COMBO <b>${stats.maxCombo}</b></span>
    <span>CLEAR BONUS <b>+${fmt.format(stats.clearBonus)}</b></span>
    <span>HP <b>${Math.round(run.hp)}/${run.maxHp}</b></span>`;

  offers = offerUpgrades(run, run.depth);
  selectedOffer = null;
  const cards = $('cards');
  cards.innerHTML = '';
  const counts = {};
  for (const u of run.upgrades) counts[u.id] = (counts[u.id] || 0) + 1;

  for (const up of offers) {
    const stack = counts[up.id] || 0;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.id = up.id;
    const pips = Array.from({ length: up.max }, (_, i) => `<i class="${i < stack ? 'on' : ''}"></i>`).join('');
    card.innerHTML = `
      <span class="ico ${up.color}">${up.icon}</span>
      <span class="txt">
        <span class="name">${up.name}</span>
        <span class="desc">${up.desc(run)}</span>
      </span>
      <span class="stacks">${pips}</span>
      <span class="tagline">${up.kind}${stack ? ` · OWNED ×${stack}` : ''}</span>`;
    card.addEventListener('click', () => selectOffer(up, card));
    cards.appendChild(card);
  }

  $('descendBtn').disabled = true;
  $('descendBtn').textContent = 'SELECT A RESONANCE';
  renderOwned();
}

function selectOffer(up, card) {
  selectedOffer = up;
  audio.ui();
  for (const c of $('cards').children) c.classList.toggle('selected', c === card);
  const btn = $('descendBtn');
  btn.disabled = false;
  btn.textContent = `DESCEND TO DEPTH ${String(run.depth + 1).padStart(2, '0')}`;
}

function renderOwned() {
  const counts = {};
  for (const u of run.upgrades) counts[u.id] = (counts[u.id] || 0) + 1;
  const box = $('ownedChips');
  const entries = Object.entries(counts);
  box.innerHTML = entries.length
    ? entries.map(([id, n]) => {
      const up = UPGRADES.find(o => o.id === id) || null;
      const name = up ? up.name : id;
      return `<span>${name}${n > 1 ? ` <b>×${n}</b>` : ''}</span>`;
    }).join('')
    : '<span>NO RESONANCES YET</span>';
}

function descend() {
  if (!selectedOffer || !run) return;
  audio.click();
  selectedOffer.apply(run);
  run.upgrades.push({ id: selectedOffer.id, name: selectedOffer.name });
  run.depth++;
  selectedOffer = null;
  startBattle();
}

// ------------------------------------------------------------------ game over
function showGameOver(stats) {
  showScreen('over');
  const accuracy = run.judged ? Math.round((run.weighted / run.judged) * 100) : 0;
  $('overDepth').textContent = String(run.depth).padStart(2, '0');
  $('overScore').textContent = fmt.format(run.score);
  $('overCombo').textContent = String(run.bestCombo || stats.maxCombo);
  $('overAcc').textContent = `${accuracy}%`;
  $('overBest').textContent = `BEST DEPTH ${String(best.depth).padStart(2, '0')} · BEST SCORE ${fmt.format(best.score)}`;

  const messages = [
    'The tower keeps its rhythm. You do not.',
    'The bassline buries another challenger.',
    'You hit the floor before the final bar.',
    'Depth is a debt. The tower always collects.',
    'One more descent? The seed is already waiting.'
  ];
  $('overSub').textContent = messages[Math.floor(Math.random() * messages.length)];
  updateBest();
  refreshBestOnTitle();
}

// ------------------------------------------------------------------ pause
function openPause() {
  if (!battle || battle.paused || battle.state === 'victory' || battle.state === 'defeat') return;
  battle.pause();
  el.pauseModal.classList.remove('hidden');
  $('soundBtn').textContent = `SOUND: ${audio.enabled ? 'ON' : 'OFF'}`;
}
function closePause() {
  el.pauseModal.classList.add('hidden');
  if (battle) battle.resume();
}
function quitRun() {
  el.pauseModal.classList.add('hidden');
  updateBest();
  if (battle) { const b = battle; battle = null; b.destroy(); }
  refreshBestOnTitle();
  showScreen('title');
}

// ------------------------------------------------------------------ wiring
$('startBtn').addEventListener('click', () => {
  startNewRun().catch(err => console.error(err));
});
$('howBtn').addEventListener('click', () => { audio.ui(); el.howModal.classList.remove('hidden'); });
$('howClose').addEventListener('click', () => { audio.ui(); el.howModal.classList.add('hidden'); });
$('howModal').addEventListener('click', (e) => { if (e.target === el.howModal) el.howModal.classList.add('hidden'); });

el.pauseBtn.addEventListener('click', () => { audio.ui(); openPause(); });
$('resumeBtn').addEventListener('click', () => { audio.ui(); closePause(); });
$('quitBtn').addEventListener('click', () => { audio.ui(); quitRun(); });
$('soundBtn').addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  $('soundBtn').textContent = `SOUND: ${audio.enabled ? 'ON' : 'OFF'}`;
  if (audio.enabled) audio.ui();
});
$('pauseModal').addEventListener('click', (e) => {
  if (e.target === el.pauseModal) closePause();
});

$('feverBtn').addEventListener('click', () => {
  if (!battle) return;
  if (battle.fever >= 100 && !battle.feverActive) battle.activateFever();
  else { audio.ui(); if (battle.fever >= 99.5) battle.activateFever(); }
});

$('descendBtn').addEventListener('click', descend);

$('retryBtn').addEventListener('click', () => { startNewRun().catch(err => console.error(err)); });
$('homeBtn').addEventListener('click', () => {
  audio.ui();
  refreshBestOnTitle();
  showScreen('title');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) openPause();
});

// physio: no long-press / context menu on the play surface
$('gameCanvas').addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.howModal.classList.contains('hidden')) el.howModal.classList.add('hidden');
    else if (!el.pauseModal.classList.contains('hidden')) closePause();
    else openPause();
  }
});

// lane key hints
const keyMap = { d: 0, f: 1, j: 2, k: 3 };
window.addEventListener('keydown', (e) => {
  const lane = keyMap[e.key.toLowerCase()];
  if (lane != null) el.laneHints[lane]?.classList.add('on');
});
window.addEventListener('keyup', (e) => {
  const lane = keyMap[e.key.toLowerCase()];
  if (lane != null) el.laneHints[lane]?.classList.remove('on');
});
window.addEventListener('blur', () => el.laneHints.forEach(s => s.classList.remove('on')));

// ------------------------------------------------------------------ backdrop
const bg = $('bgCanvas');
const bctx = bg.getContext('2d');
let bgStars = [];
let bgRaf = 0;
let bgLast = 0;

function sizeBg() {
  const dpr = Math.min(1.6, window.devicePixelRatio || 1);
  bg.width = Math.round(innerWidth * dpr);
  bg.height = Math.round(innerHeight * dpr);
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(140, (innerWidth * innerHeight) / 9000));
  bgStars = Array.from({ length: n }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 1.5 + 0.3,
    a: Math.random() * 0.55 + 0.12,
    sp: Math.random() * 0.012 + 0.002,
    tw: Math.random() * Math.PI * 2
  }));
}
function drawBg(ts) {
  bgRaf = requestAnimationFrame(drawBg);
  if (document.hidden) return;
  const dt = Math.min(50, ts - bgLast || 16);
  bgLast = ts;
  const W = innerWidth, H = innerHeight;
  bctx.clearRect(0, 0, W, H);
  const t = ts / 1000;
  for (const s of bgStars) {
    s.y += s.sp * dt * 0.06;
    if (s.y > 1.02) { s.y = -0.02; s.x = Math.random(); }
    const tw = 0.6 + 0.4 * Math.sin(t * 1.3 + s.tw);
    bctx.globalAlpha = s.a * tw;
    bctx.fillStyle = s.r > 1.2 ? '#ffd7f7' : '#bfe9ff';
    bctx.beginPath();
    bctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
    bctx.fill();
  }
  bctx.globalAlpha = 1;

  // faint drifting dust streaks
  bctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const x = ((t * (8 + i * 5) + i * 380) % (W + 300)) - 150;
    const y = H * (0.18 + i * 0.24) + Math.sin(t * 0.6 + i) * 26;
    const g = bctx.createLinearGradient(x - 90, 0, x + 90, 0);
    g.addColorStop(0, 'rgba(139,92,255,0)');
    g.addColorStop(0.5, `rgba(${i % 2 ? '255,79,216' : '79,240,255'},0.05)`);
    g.addColorStop(1, 'rgba(139,92,255,0)');
    bctx.fillStyle = g;
    bctx.fillRect(x - 90, y, 180, 1);
  }
  bctx.globalCompositeOperation = 'source-over';
}

window.addEventListener('resize', () => {
  sizeBg();
  if (battle) battle.resize();
});
window.addEventListener('orientationchange', () => setTimeout(() => {
  sizeBg();
  if (battle) battle.resize();
}, 320));

sizeBg();
bgRaf = requestAnimationFrame(drawBg);
refreshBestOnTitle();

// Dev hook: harmless read-only handle used for automated playtesting.
let autoTimer = null;
function setAutoPlay(on) {
  clearInterval(autoTimer);
  autoTimer = null;
  if (!on) return;
  autoTimer = setInterval(() => {
    const b = battle;
    if (!b || b.paused) return;
    const t = b.songTime();
    for (const n of b.notes) {
      if (n.head === 'pending' && Math.abs(n.time - t) < 0.03) {
        b.laneHold[n.lane]++;
        b.pressLane(n.lane);
      }
    }
    if (b.fever >= 100 && !b.feverActive) b.activateFever();
  }, 7);
}
window.__BEATFALL__ = {
  get battle() { return battle; },
  get run() { return run; },
  get audio() { return audio; },
  startNewRun,
  startBattle,
  setAutoPlay
};
