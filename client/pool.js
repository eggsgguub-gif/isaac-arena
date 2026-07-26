// client/pool.js — все временные объекты клиента живут здесь и только здесь.
// Кольцевые буферы фиксированного размера, ноль аллокаций после загрузки.

import { tileSolid } from '../shared/sim.js';
import { TILE } from '../shared/constants.js';

export const P_MAX = 256;
export const px = new Float32Array(P_MAX);
export const py = new Float32Array(P_MAX);
export const pvx = new Float32Array(P_MAX);
export const pvy = new Float32Array(P_MAX);
export const plife = new Float32Array(P_MAX);
export const pmax = new Float32Array(P_MAX);
export const pcol = new Uint8Array(P_MAX);
export const psize = new Uint8Array(P_MAX);
export const pgrav = new Float32Array(P_MAX);
let pcur = 0;

/** Ищет свободный слот рядом с курсором; если все заняты — частица не рождается. */
export function spawnParticle(x, y, vx, vy, life, col, size, grav) {
  let i = -1;
  for (let k = 0; k < 12; k++) {
    const c = (pcur + k) % P_MAX;
    if (plife[c] <= 0) { i = c; pcur = (c + 1) % P_MAX; break; }
  }
  if (i < 0) return -1; // лимит достигнут — молча пропускаем
  px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy;
  plife[i] = life; pmax[i] = life;
  pcol[i] = col; psize[i] = size; pgrav[i] = grav;
  return i;
}

export function burst(x, y, n, speed, life, col, size) {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 6.28318 + Math.random() * 0.7;
    const s = speed * (0.45 + Math.random() * 0.75);
    spawnParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.7 + Math.random() * 0.6), col, size, 0);
  }
}

export function stepParticles(dt) {
  for (let i = 0; i < P_MAX; i++) {
    if (plife[i] <= 0) continue;
    plife[i] -= dt;
    if (plife[i] <= 0) { plife[i] = 0; continue; }
    px[i] += pvx[i] * dt;
    py[i] += pvy[i] * dt;
    pvx[i] *= 0.92;
    pvy[i] = pvy[i] * 0.92 + pgrav[i] * dt;
  }
}

export function clearParticles() {
  plife.fill(0);
  pcur = 0;
}

// ─── всплывающие числа урона ─────────────────────────────────────────────────

export const D_MAX = 24;
export const dx = new Float32Array(D_MAX);
export const dy = new Float32Array(D_MAX);
export const dlife = new Float32Array(D_MAX);
export const dval = new Uint8Array(D_MAX);
export const dcol = new Uint8Array(D_MAX);
let dcur = 0;

export function spawnDamage(x, y, val, col) {
  for (let k = 0; k < D_MAX; k++) {
    const c = (dcur + k) % D_MAX;
    if (dlife[c] <= 0) {
      dcur = (c + 1) % D_MAX;
      dx[c] = x; dy[c] = y; dlife[c] = 0.65; dval[c] = val > 255 ? 255 : val; dcol[c] = col;
      return;
    }
  }
}

export function stepDamage(dt) {
  for (let i = 0; i < D_MAX; i++) {
    if (dlife[i] <= 0) continue;
    dlife[i] -= dt;
    dy[i] -= 22 * dt;
  }
}

export function clearDamage() { dlife.fill(0); dcur = 0; }

// ─── косметические слёзы (мгновенный отклик на выстрел) ──────────────────────
// Живут до тех пор, пока сервер не подтвердит инпут, которым они выпущены.

export const CT_MAX = 40;
export const ctx_ = new Float32Array(CT_MAX);
export const cty = new Float32Array(CT_MAX);
export const ctvx = new Float32Array(CT_MAX);
export const ctvy = new Float32Array(CT_MAX);
export const ctlife = new Float32Array(CT_MAX);
export const ctseq = new Uint16Array(CT_MAX);
export const ctbig = new Uint8Array(CT_MAX);
export const ctcol = new Uint8Array(CT_MAX);
export const ctkind = new Uint8Array(CT_MAX); // 0 слеза Айзека, 1 снаряд моба
let ctcur = 0;

export function spawnCosmeticTear(x, y, vx, vy, life, seq, big, col, kind) {
  for (let k = 0; k < CT_MAX; k++) {
    const c = (ctcur + k) % CT_MAX;
    if (ctlife[c] <= 0) {
      ctcur = (c + 1) % CT_MAX;
      ctx_[c] = x; cty[c] = y; ctvx[c] = vx; ctvy[c] = vy;
      ctlife[c] = life; ctseq[c] = seq; ctbig[c] = big; ctcol[c] = col;
      ctkind[c] = kind || 0;
      return;
    }
  }
}

export function stepCosmetic(dt, ack, tiles) {
  for (let i = 0; i < CT_MAX; i++) {
    if (ctlife[i] <= 0) continue;
    // сервер уже показывает настоящую слезу за этот инпут — гасим локальную
    const d = (ack - ctseq[i]) & 0xffff;
    if (d < 32768) { ctlife[i] = 0; continue; }
    ctlife[i] -= dt;
    ctx_[i] += ctvx[i] * dt;
    cty[i] += ctvy[i] * dt;
    // о стену и камень гасим сами, иначе слеза красиво улетает сквозь них
    if (tiles && tileSolid(tiles, (ctx_[i] / TILE) | 0, (cty[i] / TILE) | 0, 1)) ctlife[i] = 0;
  }
}

export function clearCosmetic() { ctlife.fill(0); ctcur = 0; }

// ─── очередь событий с задержкой под интерполяцию ────────────────────────────

export const EQ_MAX = 128;
export const eqKind = new Uint8Array(EQ_MAX);
export const eqX = new Float32Array(EQ_MAX);
export const eqY = new Float32Array(EQ_MAX);
export const eqP = new Uint8Array(EQ_MAX);
export const eqDue = new Float64Array(EQ_MAX);
export const eqUsed = new Uint8Array(EQ_MAX);
let eqCur = 0;

export function queueEvent(kind, x, y, param, dueMs) {
  for (let k = 0; k < EQ_MAX; k++) {
    const c = (eqCur + k) % EQ_MAX;
    if (!eqUsed[c]) {
      eqCur = (c + 1) % EQ_MAX;
      eqUsed[c] = 1; eqKind[c] = kind; eqX[c] = x; eqY[c] = y; eqP[c] = param; eqDue[c] = dueMs;
      return;
    }
  }
}

export function clearEvents() { eqUsed.fill(0); eqCur = 0; }
