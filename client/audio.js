// client/audio.js — весь звук синтезируется в рантайме: осцилляторы + шум.
// Ни одного аудиофайла, ни одного сетевого запроса.

let ac = null;
let master = null;
let musicGain = null;
let noiseBuf = null;
let started = false;
let muted = false;
let musicOn = true;

// ограничитель: не больше N звуков за окно, иначе каша и лишний GC
let budget = 0;
let budgetT = 0;

export const SFX_SHOOT = 0;
export const SFX_HIT = 1;
export const SFX_DIE = 2;
export const SFX_EXPLODE = 3;
export const SFX_PICKUP = 4;
export const SFX_HURT = 5;
export const SFX_DOOR = 6;
export const SFX_ABILITY = 7;
export const SFX_POSSESS = 8;
export const SFX_DENY = 9;
export const SFX_BOSS = 10;
export const SFX_WIN = 11;
export const SFX_LOSE = 12;
export const SFX_ROCK = 13;
export const SFX_SECRET = 14;

export function audioReady() { return started && !!ac; }

export function initAudio() {
  if (started) { if (ac && ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC({ latencyHint: 'interactive' });
  master = ac.createGain();
  master.gain.value = 0.5;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 8;
  master.connect(comp);
  comp.connect(ac.destination);

  musicGain = ac.createGain();
  musicGain.gain.value = 0.16;
  musicGain.connect(master);

  // один буфер белого шума на всю игру
  const len = (ac.sampleRate * 0.5) | 0;
  noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

  started = true;
  startMusic();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

export function toggleMusic() {
  musicOn = !musicOn;
  if (musicGain) musicGain.gain.value = musicOn ? 0.16 : 0;
  return musicOn;
}

function tone(freq, dur, type, vol, slideTo, delay) {
  const t0 = ac.currentTime + (delay || 0);
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, vol, filterFreq, sweepTo, delay) {
  const t0 = ac.currentTime + (delay || 0);
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(filterFreq, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
  f.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t0);
  s.stop(t0 + dur + 0.02);
}

/** Проигрывает эффект. param уточняет вариант (например, архетип моба). */
export function sfx(kind, param) {
  if (!started || muted || !ac) return;
  const now = performance.now();
  if (now - budgetT > 60) { budgetT = now; budget = 0; }
  if (++budget > 7) return;

  switch (kind) {
    case SFX_SHOOT:
      tone(560 + (param || 0) * 11, 0.09, 'square', 0.10, 220);
      break;
    case SFX_HIT:
      noise(0.07, 0.16, 1400, 500);
      break;
    case SFX_DIE:
      tone(180, 0.22, 'sawtooth', 0.14, 60);
      noise(0.18, 0.14, 700, 180);
      break;
    case SFX_EXPLODE:
      noise(0.42, 0.34, 420, 60);
      tone(80, 0.36, 'sine', 0.24, 30);
      break;
    case SFX_PICKUP:
      tone(720, 0.06, 'square', 0.11, 900);
      tone(1080, 0.08, 'square', 0.09, 1300, 0.05);
      break;
    case SFX_HURT:
      tone(300, 0.16, 'sawtooth', 0.2, 110);
      noise(0.1, 0.12, 900, 300);
      break;
    case SFX_DOOR:
      tone(140, 0.3, 'triangle', 0.16, 220);
      noise(0.2, 0.1, 300, 900);
      break;
    case SFX_ABILITY:
      tone(300 + (param || 0) * 60, 0.16, 'triangle', 0.14, 700 + (param || 0) * 40);
      break;
    case SFX_POSSESS:
      tone(160, 0.24, 'sine', 0.2, 620);
      tone(240, 0.2, 'square', 0.08, 900, 0.04);
      break;
    case SFX_DENY:
      tone(180, 0.1, 'square', 0.12, 120);
      break;
    case SFX_BOSS:
      tone(70, 0.9, 'sawtooth', 0.26, 40);
      noise(0.8, 0.2, 300, 80);
      break;
    case SFX_WIN:
      for (let i = 0; i < 4; i++) tone(440 * Math.pow(1.26, i), 0.18, 'square', 0.13, 0, i * 0.11);
      break;
    case SFX_LOSE:
      for (let i = 0; i < 4; i++) tone(440 / Math.pow(1.22, i), 0.22, 'sawtooth', 0.13, 0, i * 0.13);
      break;
    case SFX_ROCK:
      noise(0.16, 0.18, 800, 200);
      break;
    case SFX_SECRET:
      tone(600, 0.1, 'square', 0.12, 1200);
      tone(900, 0.14, 'square', 0.1, 1800, 0.09);
      break;
  }
}

// ─── музыка: два голоса, восьмишаговый паттерн ───────────────────────────────

const BASS = [0, 0, 7, 0, 5, 0, 3, 7];
const ARP = [12, 15, 19, 15, 17, 19, 22, 19];
const ROOT = 55; // A1
let step = 0;
let nextTime = 0;
let musicTimer = 0;

function noteHz(semi) { return ROOT * Math.pow(2, semi / 12); }

function scheduleMusic() {
  if (!started || !ac) return;
  const spb = 0.1428; // ~105 BPM, шестнадцатые
  while (nextTime < ac.currentTime + 0.25) {
    const t = nextTime;
    const s = step & 7;
    // бас
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(noteHz(BASS[s]), t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + spb * 0.9);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + spb);
    // арпеджио через шаг
    if ((step & 1) === 0) {
      const o2 = ac.createOscillator();
      const g2 = ac.createGain();
      o2.type = 'square';
      o2.frequency.setValueAtTime(noteHz(ARP[s] + 12), t);
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + spb * 0.7);
      o2.connect(g2); g2.connect(musicGain);
      o2.start(t); o2.stop(t + spb);
    }
    nextTime += spb;
    step++;
  }
}

function startMusic() {
  nextTime = ac.currentTime + 0.1;
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = setInterval(scheduleMusic, 90);
}
