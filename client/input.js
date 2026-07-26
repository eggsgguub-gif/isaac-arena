// client/input.js — клавиатура и мышь → 2 байта битов + угол прицела.
// Состояние читается по событиям, в кадре не аллоцируется ничего.

import {
  IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_SUP, IN_SDOWN, IN_SLEFT, IN_SRIGHT,
  IN2_FIRE, IN2_ABILITY, IN2_DASH, IN2_BOMB,
  VIEW_W, VIEW_H, ROOM_OX,
} from '../shared/constants.js';

export const view = { scale: 1, ox: 0, oy: 0 };
export const input = {
  b0: 0, b1: 0,
  mx: VIEW_W / 2, my: VIEW_H / 2, // координаты курсора во внутренних пикселях
  wheel: 0,
  helpOpen: false,
  onMute: null,
  onMusic: null,
  onGesture: null,
};

const keys = Object.create(null);
let mouseL = false, mouseR = false;

export function initInput(canvas) {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) { e.preventDefault(); return; }
    keys[e.code] = 1;
    if (e.code === 'KeyM' && input.onMute) input.onMute();
    if (e.code === 'KeyN' && input.onMusic) input.onMusic();
    if (e.code === 'Tab') { input.helpOpen = !input.helpOpen; }
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
  });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    input.mx = (e.clientX - r.left) / (r.width / VIEW_W);
    input.my = (e.clientY - r.top) / (r.height / VIEW_H);
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
  canvas.addEventListener('touchstart', fireGesture, { passive: true });
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

/** Собирает биты инпута. Вызывается раз в тик симуляции (30 Гц). */
export function sampleInput() {
  let b0 = 0, b1 = 0;
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
  input.b0 = b0;
  input.b1 = b1;
  return b0;
}

/** Курсор в мировых координатах комнаты. */
export function aimWorldX() { return input.mx - ROOM_OX; }
export function aimWorldY() { return input.my; }
