// client/main.js — точка входа: загрузка атласа, масштаб, игровой цикл.
// Симуляция клиента идёт фиксированными шагами 30 Гц, рендер — 60 FPS.

import {
  VIEW_W, VIEW_H, DT, ROOM_OX,
  EV_HIT, EV_MOB_DIE, EV_SHOOT, EV_EXPLODE, EV_PICKUP, EV_DOOR, EV_HURT,
  EV_ABILITY, EV_POSSESS, EV_ROCK, EV_BOSS_DIE, EV_SECRET, EV_DENY, EV_REVIVE,
  SIDE_ISAAC, SIDE_MONSTER,
} from '../shared/constants.js';

import { net, stats, connect, simStep, decayError, projectileHidden } from './net.js';
import * as pool from './pool.js';
import { initRender, render, addShake } from './render.js';
import { initInput, input, isTouch, touch, sampleInput, touchAiming, aimWorldX, aimWorldY, syncRect } from './input.js';
import {
  stepParticles, stepDamage, stepCosmetic, burst, spawnParticle, spawnDamage,
  eqUsed, eqKind, eqX, eqY, eqP, eqDue, EQ_MAX,
} from './pool.js';
import {
  initAudio, sfx, toggleMute, toggleMusic,
  SFX_SHOOT, SFX_HIT, SFX_DIE, SFX_EXPLODE, SFX_PICKUP, SFX_HURT, SFX_DOOR,
  SFX_ABILITY, SFX_POSSESS, SFX_DENY, SFX_BOSS, SFX_WIN, SFX_LOSE, SFX_ROCK, SFX_SECRET,
} from './audio.js';

const canvas = document.getElementById('c');
const wrap = document.getElementById('wrap');
canvas.width = VIEW_W;
canvas.height = VIEW_H;

// ─── масштаб: целочисленный, transform: scale() + pixelated ──────────────────

function resize() {
  const sx = window.innerWidth / VIEW_W;
  const sy = window.innerHeight / VIEW_H;
  let s = Math.min(sx, sy);
  // на ПК целые множители — ни одного размытого пикселя;
  // на телефоне важнее занять экран, там дробный масштаб незаметен
  if (!isTouch && s > 1) s = Math.floor(s);
  if (s < 0.4) s = 0.4;
  canvas.style.transform = 'scale(' + s + ')';
  syncRect();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));
resize();

// ─── загрузка атласа ─────────────────────────────────────────────────────────

const atlas = new Image();
atlas.src = 'atlas.png';

function boot() {
  initRender(canvas, atlas);
  initInput(canvas);
  input.onMute = () => { toggleMute(); };
  input.onMusic = () => { toggleMusic(); };
  input.onGesture = () => { initAudio(); };
  connect();
  // отладочный доступ из консоли: состояние, принудительный кадр, пулы
  window.__ia = {
    net, stats, input, pool,
    hidden: projectileHidden,
    draw: () => frame(performance.now(), 1 / 60),
  };
  const el = document.getElementById('boot');
  if (el) el.remove();
  requestAnimationFrame(loop);
}

if (atlas.complete && atlas.naturalWidth > 0) boot();
else {
  atlas.onload = boot;
  atlas.onerror = () => {
    const el = document.getElementById('boot');
    if (el) el.textContent = 'atlas.png не найден — npm run build';
  };
}

// ─── игровой цикл ────────────────────────────────────────────────────────────

let last = performance.now();
let acc = 0;
const STEP_MS = DT * 1000;

function loop(now) {
  requestAnimationFrame(loop);
  let dtMs = now - last;
  last = now;
  if (dtMs > 250) dtMs = 250; // вкладка была свёрнута — не догоняем сотнями шагов
  acc += dtMs;

  let guard = 0;
  while (acc >= STEP_MS && guard++ < 5) {
    acc -= STEP_MS;
    sampleInput();
    simStep(input.b0, input.b1, computeAim());
  }
  // доля незавершённого шага: по ней рендер сглаживает своего игрока до 60 FPS
  net.alpha = acc / STEP_MS;

  frame(now, dtMs / 1000);
}

function frame(now, dt) {
  drainEvents(now);
  stepParticles(dt);
  stepDamage(dt);
  stepCosmetic(dt, net.tiles);
  decayError(dt);
  render(now, dt);
}

function computeAim() {
  // на сенсоре направление задаёт правый стик, на ПК — курсор
  if (touchAiming()) return touch.aimAngle;
  const ax = aimWorldX() - net.px;
  const ay = aimWorldY() - net.py;
  if (ax === 0 && ay === 0) return net.aimAngle;
  let a = Math.atan2(ay, ax);
  if (a < 0) a += Math.PI * 2;
  return a;
}

// ─── события сервера → частицы и звук ────────────────────────────────────────

function drainEvents(now) {
  for (let i = 0; i < EQ_MAX; i++) {
    if (!eqUsed[i]) continue;
    if (eqDue[i] > now) continue;
    eqUsed[i] = 0;
    const k = eqKind[i], x = eqX[i], y = eqY[i], p = eqP[i];
    switch (k) {
      case EV_HIT:
        if (p === 255) { burst(x, y, 3, 40, 0.18, 2, 1); }
        else { burst(x, y, 5, 70, 0.25, 0, 2); spawnDamage(x, y - 8, p, 0); sfx(SFX_HIT); }
        break;
      case EV_MOB_DIE:
        burst(x, y, 12, 110, 0.5, 0, 2);
        sfx(SFX_DIE);
        addShake(1.5);
        break;
      case EV_SHOOT:
        sfx(SFX_SHOOT, p);
        break;
      case EV_EXPLODE:
        burst(x, y, 24, 170, 0.65, p ? 4 : 1, 3);
        sfx(SFX_EXPLODE);
        addShake(p ? 2.5 : 5);
        break;
      case EV_PICKUP:
        burst(x, y, 6, 50, 0.35, p === 1 ? 1 : 3, 1);
        sfx(SFX_PICKUP);
        break;
      case EV_DOOR:
        sfx(SFX_DOOR);
        break;
      case EV_HURT:
        burst(x, y, 10, 90, 0.4, 0, 2);
        addShake(3);
        if (p === net.slot) sfx(SFX_HURT); else sfx(SFX_HIT);
        break;
      case EV_ABILITY:
        burst(x, y, 8, 80, 0.3, 5, 2);
        sfx(SFX_ABILITY, p);
        break;
      case EV_POSSESS:
        burst(x, y, 14, 100, 0.5, 5, 2);
        sfx(SFX_POSSESS);
        break;
      case EV_ROCK:
        burst(x, y, 8, 70, 0.4, 4, 2);
        sfx(SFX_ROCK);
        break;
      case EV_BOSS_DIE:
        burst(x, y, 40, 200, 1.2, 1, 3);
        sfx(SFX_BOSS);
        addShake(8);
        break;
      case EV_SECRET:
        burst(x, y, 16, 90, 0.6, 5, 2);
        sfx(SFX_SECRET);
        break;
      case EV_DENY:
        sfx(SFX_DENY);
        break;
      case EV_REVIVE:
        burst(x, y, 18, 80, 0.7, 2, 2);
        sfx(SFX_PICKUP);
        break;
    }
  }
}

// ─── режим замера (npm run bench) ────────────────────────────────────────────
// Страница играет как обычный клиент, затем сама отправляет замер на /bench.

if (location.search.indexOf('bench=1') >= 0) {
  const t0 = performance.now();
  let frames = 0;
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => {
    const seconds = (performance.now() - t0) / 1000;
    const finish = (bytes, kinds) => {
      const body = JSON.stringify({
        bytes: bytes,
        kinds: kinds,
        fps: Math.round((frames / seconds) * 10) / 10,
        entities: net.view.high,
        ping: Math.round(net.ping),
        kbpsIn: Math.round(net.kbpsIn),
        kbpsOut: Math.round(net.kbpsOut),
        side: net.side,
        room: net.roomIdx,
      });
      fetch('/bench', { method: 'POST', body: body }).catch(() => { });
    };
    if (performance.measureUserAgentSpecificMemory) {
      performance.measureUserAgentSpecificMemory().then((m) => {
        const kinds = {};
        for (let i = 0; i < m.breakdown.length; i++) {
          const b = m.breakdown[i];
          const key = (b.types && b.types.length ? b.types.join('+') : 'other');
          kinds[key] = (kinds[key] || 0) + b.bytes;
        }
        finish(m.bytes, kinds);
      }).catch(() => finish(-1, null));
    } else {
      finish(performance.memory ? performance.memory.usedJSHeapSize : -1, null);
    }
  }, 20000);
}

// ─── реакция на конец раунда ─────────────────────────────────────────────────

let lastWinner = -1;
setInterval(() => {
  if (net.winner !== lastWinner) {
    lastWinner = net.winner;
    if (net.winner >= 0) sfx(net.winner === net.side ? SFX_WIN : SFX_LOSE);
  }
}, 200);
