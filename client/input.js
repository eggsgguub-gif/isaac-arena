// client/input.js — клавиатура, мышь и сенсор → 2 байта битов + угол прицела.
// Протокол один и тот же, поэтому телефон и ПК играют в одной сессии.

import {
  IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_SUP, IN_SDOWN, IN_SLEFT, IN_SRIGHT,
  IN2_FIRE, IN2_ABILITY, IN2_DASH, IN2_BOMB,
  VIEW_W, VIEW_H, ROOM_OX,
} from '../shared/constants.js';

export const input = {
  b0: 0, b1: 0,
  mx: VIEW_W / 2, my: VIEW_H / 2, // курсор во внутренних пикселях
  helpOpen: false,
  onMute: null,
  onMusic: null,
  onGesture: null,
};

// Определяем сенсор заранее, но и по первому реальному касанию тоже: так
// ноутбуки с тачскрином показывают стики только когда до экрана дотронулись.
export let isTouch = (typeof window !== 'undefined') &&
  (('ontouchstart' in window) || (navigator.maxTouchPoints | 0) > 0);

// ─── сенсорное управление ────────────────────────────────────────────────────
// Левая половина — плавающий стик движения, правая — стик прицела с автоогнём,
// в правом нижнем углу две кнопки действий.

export const STICK_R = 26;
const DEAD = 5;
export const BTN_A = { x: 441, y: 203, r: 25 }; // способность / бомба
export const BTN_B = { x: 387, y: 240, r: 20 }; // рывок

export const touch = {
  on: 0,
  moveId: -1, mbx: 0, mby: 0, mkx: 0, mky: 0, moveLive: 0,
  aimId: -1, abx: 0, aby: 0, akx: 0, aky: 0, aimLive: 0,
  aimAngle: 0, aimFire: 0,
  btnA: 0, btnAId: -1,
  btnB: 0, btnBId: -1,
};

const keys = Object.create(null);
let mouseL = false, mouseR = false;
let canvasEl = null;

// прямоугольник холста кэшируем: getBoundingClientRect в обработчике move
// дёргался бы до 60 раз в секунду и аллоцировал DOMRect на каждое движение
let rX = 0, rY = 0, rW = 1, rH = 1;
export function syncRect() {
  if (!canvasEl) return;
  const r = canvasEl.getBoundingClientRect();
  rX = r.left; rY = r.top;
  rW = r.width || 1; rH = r.height || 1;
}
function toX(clientX) { return (clientX - rX) / (rW / VIEW_W); }
function toY(clientY) { return (clientY - rY) / (rH / VIEW_H); }

function inCircle(x, y, c) {
  const dx = x - c.x, dy = y - c.y;
  return dx * dx + dy * dy <= c.r * c.r * 1.35; // немного щедрее пальцу
}

export function initInput(canvas) {
  canvasEl = canvas;
  syncRect();
  window.addEventListener('resize', syncRect);
  window.addEventListener('orientationchange', syncRect);
  window.addEventListener('scroll', syncRect, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) { e.preventDefault(); return; }
    keys[e.code] = 1;
    if (e.code === 'KeyM' && input.onMute) input.onMute();
    if (e.code === 'KeyN' && input.onMusic) input.onMusic();
    if (e.code === 'Tab') input.helpOpen = !input.helpOpen;
    if (BLOCK[e.code]) e.preventDefault();
    fireGesture();
  }, { passive: false });

  window.addEventListener('keyup', (e) => {
    keys[e.code] = 0;
    if (BLOCK[e.code]) e.preventDefault();
  }, { passive: false });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = 0;
    mouseL = false; mouseR = false;
    releaseAllTouches();
  });

  canvas.addEventListener('mousemove', (e) => {
    input.mx = toX(e.clientX);
    input.my = toY(e.clientY);
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) mouseL = true;
    if (e.button === 2) mouseR = true;
    fireGesture();
    e.preventDefault();
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseL = false;
    if (e.button === 2) mouseR = false;
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── сенсор
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
}

const BLOCK = {
  ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1, Tab: 1,
};

let gestureDone = false;
function fireGesture() {
  if (gestureDone) return;
  gestureDone = true;
  if (input.onGesture) input.onGesture();
}

function releaseAllTouches() {
  touch.moveId = -1; touch.aimId = -1;
  touch.moveLive = 0; touch.aimLive = 0;
  touch.btnA = 0; touch.btnB = 0;
  touch.btnAId = -1; touch.btnBId = -1;
  touch.on = 0;
}

function onTouchStart(e) {
  e.preventDefault();
  fireGesture();
  syncRect();
  isTouch = true;
  touch.on = 1;
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const x = toX(t.clientX), y = toY(t.clientY);
    if (touch.btnAId < 0 && inCircle(x, y, BTN_A)) { touch.btnAId = t.identifier; touch.btnA = 1; continue; }
    if (touch.btnBId < 0 && inCircle(x, y, BTN_B)) { touch.btnBId = t.identifier; touch.btnB = 1; continue; }
    if (x < VIEW_W / 2) {
      if (touch.moveId >= 0) continue;
      touch.moveId = t.identifier;
      touch.mbx = x; touch.mby = y; touch.mkx = x; touch.mky = y;
      touch.moveLive = 1;
    } else {
      if (touch.aimId >= 0) continue;
      touch.aimId = t.identifier;
      touch.abx = x; touch.aby = y; touch.akx = x; touch.aky = y;
      touch.aimLive = 1;
    }
  }
}

function onTouchMove(e) {
  e.preventDefault();
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const x = toX(t.clientX), y = toY(t.clientY);
    if (t.identifier === touch.moveId) { touch.mkx = x; touch.mky = y; }
    else if (t.identifier === touch.aimId) { touch.akx = x; touch.aky = y; }
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++) {
    const id = list[i].identifier;
    if (id === touch.moveId) { touch.moveId = -1; touch.moveLive = 0; }
    else if (id === touch.aimId) { touch.aimId = -1; touch.aimLive = 0; }
    else if (id === touch.btnAId) { touch.btnAId = -1; touch.btnA = 0; }
    else if (id === touch.btnBId) { touch.btnBId = -1; touch.btnB = 0; }
  }
  if (touch.moveId < 0 && touch.aimId < 0 && touch.btnAId < 0 && touch.btnBId < 0) touch.on = 0;
}

/** Ограничивает отклонение стика радиусом STICK_R. Пишет в out. */
export function stickVec(bx, by, kx, ky, out) {
  let dx = kx - bx, dy = ky - by;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > STICK_R) { dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R; }
  out[0] = dx; out[1] = dy; out[2] = d;
  return d;
}

const vec = new Float32Array(3);

/** Собирает биты инпута. Вызывается раз в тик симуляции (30 Гц). */
export function sampleInput() {
  let b0 = 0, b1 = 0;

  // ── клавиатура
  if (keys.KeyW || keys.KeyZ) b0 |= IN_UP;
  if (keys.KeyS) b0 |= IN_DOWN;
  if (keys.KeyA || keys.KeyQ) b0 |= IN_LEFT;
  if (keys.KeyD) b0 |= IN_RIGHT;
  if (keys.ArrowUp) b0 |= IN_SUP;
  if (keys.ArrowDown) b0 |= IN_SDOWN;
  if (keys.ArrowLeft) b0 |= IN_SLEFT;
  if (keys.ArrowRight) b0 |= IN_SRIGHT;
  if (mouseL) b1 |= IN2_FIRE;
  if (mouseR || keys.Space) b1 |= IN2_ABILITY;
  if (keys.ShiftLeft || keys.ShiftRight) b1 |= IN2_DASH;
  if (keys.KeyE) b1 |= IN2_BOMB;

  // ── сенсор: стик движения → те же 8 направлений, что и клавиши
  if (touch.moveLive) {
    stickVec(touch.mbx, touch.mby, touch.mkx, touch.mky, vec);
    if (vec[0] < -DEAD) b0 |= IN_LEFT; else if (vec[0] > DEAD) b0 |= IN_RIGHT;
    if (vec[1] < -DEAD) b0 |= IN_UP; else if (vec[1] > DEAD) b0 |= IN_DOWN;
  }

  // ── сенсор: стик прицела задаёт угол и держит огонь
  touch.aimFire = 0;
  if (touch.aimLive) {
    const d = stickVec(touch.abx, touch.aby, touch.akx, touch.aky, vec);
    if (d > DEAD * 1.6) {
      let a = Math.atan2(vec[1], vec[0]);
      if (a < 0) a += Math.PI * 2;
      touch.aimAngle = a;
      touch.aimFire = 1;
      b1 |= IN2_FIRE;
    }
  }

  // ── сенсор: кнопки. Айзек читает только бомбу, монстр — только способность,
  // поэтому одна кнопка безопасно выставляет оба бита.
  if (touch.btnA) { b1 |= IN2_ABILITY | IN2_BOMB; }
  if (touch.btnB) b1 |= IN2_DASH;

  input.b0 = b0;
  input.b1 = b1;
  return b0;
}

/** Активно ли сенсорное прицеливание — тогда угол берём от стика, не от мыши. */
export function touchAiming() { return touch.aimFire === 1; }

/** Курсор в мировых координатах комнаты. */
export function aimWorldX() { return input.mx - ROOM_OX; }
export function aimWorldY() { return input.my; }
