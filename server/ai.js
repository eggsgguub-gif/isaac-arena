// server/ai.js — поведение мобов: серверный ИИ для незанятых мобов и общие
// реализации способностей (их же вызывают игроки-монстры, но с множителем ×0.7).
// Ноль аллокаций: только арифметика над SoA-массивами сессии.

import {
  T_ISAAC, T_MOB, T_SHOT,
  ST_ALIVE, ST_SHIELD, ST_CHARGE, ST_AIR, ST_DOWN,
  M_CRAWLER, M_SPITTER, M_SPLITTER, M_HOPPER, M_SHIELDER, M_SPAWN, M_BOSS,
  MOB_SPEED, MOB_ABILITY_CD, MOB_DASH_CD,
  PLAYER_MOB_DMG_MUL, DASH_SPEED, DASH_TIME,
  WORLD_W, WORLD_H, TILE,
  EV_ABILITY, EV_SHOOT,
  ACCEL, FRICTION,
} from '../shared/constants.js';
import { setFacing, moveAndCollide, tileSolid } from '../shared/sim.js';

const CHARGE_WINDUP = 0.35;
const HOP_TIME = 0.55;

// ─── низкоуровневые помощники ────────────────────────────────────────────────

function steer(w, i, tx, ty, speed, dt) {
  let dx = tx - w.x[i], dy = ty - w.y[i];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1) { dx = 0; dy = 0; } else { dx /= d; dy /= d; }
  let k = ACCEL * dt;
  if (k > 1) k = 1;
  w.vx[i] += (dx * speed - w.vx[i]) * k;
  w.vy[i] += (dy * speed - w.vy[i]) * k;
  if (dx !== 0 || dy !== 0) {
    if (Math.abs(dx) > Math.abs(dy)) setFacing(w, i, dx < 0 ? 2 : 3);
    else setFacing(w, i, dy < 0 ? 1 : 0);
  }
}

function brake(w, i, dt) {
  let k = FRICTION * dt;
  if (k > 1) k = 1;
  w.vx[i] += (0 - w.vx[i]) * k;
  w.vy[i] += (0 - w.vy[i]) * k;
}

function pickWander(S, i) {
  const w = S.w;
  const r = S.rnd();
  const r2 = S.rnd();
  w.ax[i] = TILE * 1.5 + r * (WORLD_W - TILE * 3);
  w.ay[i] = TILE * 1.5 + r2 * (WORLD_H - TILE * 3);
  w.ttl[i] = 1.2 + S.rnd() * 1.6;
}

// ─── способности (общие для ИИ и игроков) ────────────────────────────────────

/**
 * Применяет способность архетипа. dirx/diry — нормаль направления.
 * isPlayer включает множитель урона 0.7. Возвращает 1, если способность ушла.
 */
export function useAbility(S, i, dirx, diry, isPlayer) {
  const w = S.w;
  if (w.cd[i] > 0) return 0;
  const arch = w.sub[i];
  const mul = isPlayer ? PLAYER_MOB_DMG_MUL : 1;
  const len = Math.sqrt(dirx * dirx + diry * diry) || 1;
  dirx /= len; diry /= len;

  switch (arch) {
    case M_CRAWLER: {
      w.state[i] |= ST_CHARGE;
      w.cd2[i] = CHARGE_WINDUP;
      w.ax[i] = dirx; w.ay[i] = diry;
      w.dmg[i] = 2 * mul;
      break;
    }
    case M_SPITTER: {
      // дуговой снаряд: три плевка с разной кривизной
      for (let k = -1; k <= 1; k++) {
        const a = Math.atan2(diry, dirx) + k * 0.22;
        const s = S.spawnShot(w.x[i], w.y[i], Math.cos(a) * 92, Math.sin(a) * 92, 1 * mul, 2.2, i);
        if (s >= 0) { w.cd2[s] = k * 1.9; w.sub[s] = 1; }
      }
      S.pushEvent(EV_SHOOT, w.x[i], w.y[i], 1);
      break;
    }
    case M_SPLITTER: {
      // добровольное деление: два осколка и минус 40% hp
      const half = (w.hp[i] * 0.6) | 0;
      w.hp[i] = half < 1 ? 1 : half;
      S.spawnMob(M_SPAWN, w.x[i] - 12, w.y[i], isPlayer ? 1 : 0);
      S.spawnMob(M_SPAWN, w.x[i] + 12, w.y[i], isPlayer ? 1 : 0);
      break;
    }
    case M_HOPPER: {
      w.state[i] |= ST_AIR;
      w.cd2[i] = HOP_TIME;
      let tx = w.x[i] + dirx * 96, ty = w.y[i] + diry * 96;
      if (tx < TILE) tx = TILE; else if (tx > WORLD_W - TILE) tx = WORLD_W - TILE;
      if (ty < TILE) ty = TILE; else if (ty > WORLD_H - TILE) ty = WORLD_H - TILE;
      w.ax[i] = tx; w.ay[i] = ty;
      w.dmg[i] = 1.5 * mul;
      break;
    }
    case M_SHIELDER: {
      w.state[i] |= ST_SHIELD;
      w.cd2[i] = 1.5;
      if (Math.abs(dirx) > Math.abs(diry)) setFacing(w, i, dirx < 0 ? 2 : 3);
      else setFacing(w, i, diry < 0 ? 1 : 0);
      break;
    }
    case M_SPAWN: {
      w.dash[i] = DASH_TIME;
      w.vx[i] = dirx * DASH_SPEED * 1.1;
      w.vy[i] = diry * DASH_SPEED * 1.1;
      break;
    }
    case M_BOSS: {
      // радиальный залп
      const base = Math.atan2(diry, dirx);
      for (let k = 0; k < 10; k++) {
        const a = base + (k * Math.PI * 2) / 10;
        S.spawnShot(w.x[i], w.y[i], Math.cos(a) * 76, Math.sin(a) * 76, 1 * mul, 3.0, i);
      }
      S.pushEvent(EV_SHOOT, w.x[i], w.y[i], 2);
      break;
    }
  }
  w.cd[i] = MOB_ABILITY_CD[arch];
  S.pushEvent(EV_ABILITY, w.x[i], w.y[i], arch);
  return 1;
}

/** Рывок — есть у любого архетипа, отдельный кулдаун. */
export function useDash(S, i, dirx, diry) {
  const w = S.w;
  if (w.cd2[i] > 0 && (w.state[i] & (ST_CHARGE | ST_AIR))) return 0;
  if (w.dash[i] > 0) return 0;
  if (w.iframe[i] > 0) return 0; // у мобов iframe — таймер кулдауна рывка
  const len = Math.sqrt(dirx * dirx + diry * diry);
  if (len < 0.01) return 0;
  w.dash[i] = DASH_TIME;
  w.vx[i] = (dirx / len) * DASH_SPEED;
  w.vy[i] = (diry / len) * DASH_SPEED;
  w.iframe[i] = MOB_DASH_CD;
  return 1;
}

/** Базовая атака моба (не способность) — вызывается только ИИ. */
function basicAttack(S, i, tx, ty) {
  const w = S.w;
  const arch = w.sub[i];
  const dx = tx - w.x[i], dy = ty - w.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  if (arch === M_SPITTER) {
    S.spawnShot(w.x[i], w.y[i], (dx / d) * 88, (dy / d) * 88, 1, 2.0, i);
    S.pushEvent(EV_SHOOT, w.x[i], w.y[i], 0);
    w.cd2[i] = 1.6 + S.rnd() * 0.8;
  } else if (arch === M_BOSS) {
    const spread = S.w.hp[i] * 2 < S.w.maxhp[i] ? 5 : 3;
    const base = Math.atan2(dy, dx);
    for (let k = 0; k < spread; k++) {
      const a = base + (k - (spread - 1) / 2) * 0.2;
      S.spawnShot(w.x[i], w.y[i], Math.cos(a) * 84, Math.sin(a) * 84, 1, 2.6, i);
    }
    S.pushEvent(EV_SHOOT, w.x[i], w.y[i], 2);
    w.cd2[i] = 1.4 + S.rnd() * 0.6;
  }
}

// ─── главный шаг ИИ ──────────────────────────────────────────────────────────

/** Ведёт незанятого игроком моба. Игроки-монстры сюда не попадают. */
export function stepMobAI(S, i, dt) {
  const w = S.w;
  const arch = w.sub[i];
  const speed = MOB_SPEED[arch];

  // общие таймеры
  if (w.cd[i] > 0) w.cd[i] -= dt;
  if (w.cd2[i] > 0) w.cd2[i] -= dt;
  if (w.iframe[i] > 0) w.iframe[i] -= dt;
  w.anim[i] += dt;

  // фазы, которые перехватывают управление
  if (w.state[i] & ST_AIR) return stepAirborne(S, i, dt);
  if ((w.state[i] & ST_CHARGE) && w.cd2[i] <= 0) {
    w.state[i] &= ~ST_CHARGE;
    w.dash[i] = 0.45;
    w.vx[i] = w.ax[i] * DASH_SPEED * 1.15;
    w.vy[i] = w.ay[i] * DASH_SPEED * 1.15;
  }
  if (w.state[i] & ST_CHARGE) { brake(w, i, dt); moveAndCollide(w, i, dt, S.tiles, 0); return; }
  if ((w.state[i] & ST_SHIELD) && w.cd2[i] <= 0) w.state[i] &= ~ST_SHIELD;

  if (w.dash[i] > 0) {
    w.dash[i] -= dt;
    const hit = moveAndCollide(w, i, dt, S.tiles, 0);
    if (hit) { w.dash[i] = 0; w.vx[i] *= -0.2; w.vy[i] *= -0.2; }
    return;
  }

  const tgt = S.nearestIsaac(w.x[i], w.y[i]);
  if (tgt < 0) {
    w.ttl[i] -= dt;
    if (w.ttl[i] <= 0) pickWander(S, i);
    steer(w, i, w.ax[i], w.ay[i], speed * 0.5, dt);
    moveAndCollide(w, i, dt, S.tiles, 0);
    return;
  }

  const tx = w.x[tgt], ty = w.y[tgt];
  const dx = tx - w.x[i], dy = ty - w.y[i];
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  switch (arch) {
    case M_CRAWLER:
    case M_SPAWN: {
      steer(w, i, tx, ty, speed, dt);
      if (arch === M_CRAWLER && dist < 120 && dist > 26 && w.cd[i] <= 0) {
        useAbility(S, i, dx / dist, dy / dist, 0);
      }
      break;
    }
    case M_SPITTER: {
      const want = 92;
      if (dist > want + 18) steer(w, i, tx, ty, speed, dt);
      else if (dist < want - 18) steer(w, i, w.x[i] - dx, w.y[i] - dy, speed, dt);
      else {
        // стрейф по кругу
        steer(w, i, w.x[i] - dy * 0.6, w.y[i] + dx * 0.6, speed * 0.7, dt);
      }
      if (w.cd2[i] <= 0 && dist < 200) basicAttack(S, i, tx, ty);
      if (w.cd[i] <= 0 && dist < 160 && S.rnd() < 0.5) useAbility(S, i, dx / dist, dy / dist, 0);
      break;
    }
    case M_SPLITTER: {
      steer(w, i, tx, ty, speed, dt);
      if (w.cd[i] <= 0 && dist < 90 && w.hp[i] > 3) useAbility(S, i, dx / dist, dy / dist, 0);
      break;
    }
    case M_HOPPER: {
      if (w.cd[i] <= 0 && dist < 190) {
        useAbility(S, i, dx / dist, dy / dist, 0);
      } else {
        brake(w, i, dt);
      }
      break;
    }
    case M_SHIELDER: {
      steer(w, i, tx, ty, speed, dt);
      if (Math.abs(dx) > Math.abs(dy)) setFacing(w, i, dx < 0 ? 2 : 3);
      else setFacing(w, i, dy < 0 ? 1 : 0);
      if (w.cd[i] <= 0 && dist < 130) useAbility(S, i, dx / dist, dy / dist, 0);
      break;
    }
    case M_BOSS: {
      const phase = w.hp[i] * 2 < w.maxhp[i] ? 1 : 0;
      const want = phase ? 70 : 100;
      if (dist > want) steer(w, i, tx, ty, speed * (phase ? 1.4 : 1), dt);
      else steer(w, i, w.x[i] - dy * 0.5, w.y[i] + dx * 0.5, speed, dt);
      if (w.cd2[i] <= 0) basicAttack(S, i, tx, ty);
      if (w.cd[i] <= 0) {
        useAbility(S, i, dx / dist, dy / dist, 0);
        if (phase) {
          S.spawnMob(M_SPAWN, w.x[i] - 20, w.y[i] + 14, 0);
          S.spawnMob(M_SPAWN, w.x[i] + 20, w.y[i] + 14, 0);
        }
      }
      break;
    }
  }
  moveAndCollide(w, i, dt, S.tiles, 0);
}

/** Полёт Прыгуна: неуязвим, летит над препятствиями, при приземлении — AoE. */
export function stepAirborne(S, i, dt) {
  const w = S.w;
  w.cd2[i] -= dt;
  const t = w.cd2[i] / HOP_TIME;
  const k = 1 - (t < 0 ? 0 : t);
  const sx = w.ax[i], sy = w.ay[i];
  const dx = sx - w.x[i], dy = sy - w.y[i];
  const rem = w.cd2[i] > 0.001 ? w.cd2[i] : 0.001;
  w.vx[i] = dx / rem;
  w.vy[i] = dy / rem;
  w.x[i] += w.vx[i] * dt;
  w.y[i] += w.vy[i] * dt;
  w.anim[i] = k;
  if (w.cd2[i] <= 0) {
    w.state[i] &= ~ST_AIR;
    w.vx[i] = 0; w.vy[i] = 0;
    // если приземлились в стену — выталкиваем
    if (tileSolid(S.tiles, (w.x[i] / TILE) | 0, (w.y[i] / TILE) | 0, 0)) {
      S.placeFree(i);
    }
    S.landingAoe(i, 44, w.dmg[i] > 0 ? w.dmg[i] : 3);
  }
}

/** Управление мобом от игрока: движение уже сделано, здесь только таймеры. */
export function stepPlayerMobTimers(S, i, dt) {
  const w = S.w;
  if (w.cd[i] > 0) w.cd[i] -= dt;
  if (w.iframe[i] > 0) w.iframe[i] -= dt;
  w.anim[i] += dt;
  if ((w.state[i] & ST_SHIELD) && w.cd2[i] > 0) {
    w.cd2[i] -= dt;
    if (w.cd2[i] <= 0) w.state[i] &= ~ST_SHIELD;
  } else if (w.state[i] & ST_CHARGE) {
    w.cd2[i] -= dt;
    if (w.cd2[i] <= 0) {
      w.state[i] &= ~ST_CHARGE;
      w.dash[i] = 0.45;
      w.vx[i] = w.ax[i] * DASH_SPEED * 1.15;
      w.vy[i] = w.ay[i] * DASH_SPEED * 1.15;
    }
  } else if (w.cd2[i] > 0) {
    w.cd2[i] -= dt;
  }
}
