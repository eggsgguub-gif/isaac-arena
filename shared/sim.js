// shared/sim.js — детерминированная симуляция: единственный источник правды
// по физике, коллизиям и генерации мира. Исполняется и на сервере (авторитет),
// и на клиенте (prediction + локальные косметические снаряды).
//
// Правила файла: ноль аллокаций после createWorld/createFloor, только for-циклы,
// только арифметика (никаких Math.exp/pow в детерминированных путях).

import {
  MAX_ENTITIES, ROOM_W, ROOM_H, TILE, WORLD_W, WORLD_H, ROOM_TILES,
  GRID_CELL, GRID_W, GRID_H, GRID_CELLS,
  TL_FLOOR, TL_WALL, TL_ROCK, TL_PIT, TL_SPIKE, TL_DOOR, TL_DOOR_OPEN, TL_SECRET,
  TL_RUBBLE, TL_HATCH, TILE_SOLID,
  T_NONE, T_ISAAC, T_MOB, T_TEAR, T_SHOT, T_PICKUP, T_BOMB, T_SPIRIT,
  ST_ALIVE, ST_FACE0, ST_FACE1,
  M_CRAWLER, M_SPITTER, M_SPLITTER, M_HOPPER, M_SHIELDER, M_SPAWN, M_BOSS,
  MOB_HP, MOB_R,
  TF_PIERCE, TF_BOUNCE, TF_HOME, TF_SPECTRAL,
  IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT,
  ACCEL, FRICTION,
  R_START, R_NORMAL, R_TREASURE, R_SHOP, R_BOSS, R_SECRET,
  FLOOR_MIN_ROOMS, FLOOR_MAX_ROOMS, FMAP_W, FMAP_H, FMAP_CELLS,
} from './constants.js';

export const MAX_ROOMS = 24;
export const ROOM_REC = 32; // байт на сериализованную комнату

// ─── ГСЧ ─────────────────────────────────────────────────────────────────────

/** mulberry32: 32-битный детерминированный ГСЧ. Возвращает функцию () => [0,1). */
export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Смешивание двух 32-битных значений в новый seed. */
export function hash2(a, b) {
  let h = (a ^ Math.imul(b ^ 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ─── мир (SoA) ───────────────────────────────────────────────────────────────

export function createWorld() {
  const w = {
    x: new Float32Array(MAX_ENTITIES),
    y: new Float32Array(MAX_ENTITIES),
    vx: new Float32Array(MAX_ENTITIES),
    vy: new Float32Array(MAX_ENTITIES),
    ax: new Float32Array(MAX_ENTITIES), // цель ИИ / точка приземления
    ay: new Float32Array(MAX_ENTITIES),
    dmg: new Float32Array(MAX_ENTITIES),
    ttl: new Float32Array(MAX_ENTITIES),
    cd: new Float32Array(MAX_ENTITIES), // основной кулдаун (стрельба/абилка)
    cd2: new Float32Array(MAX_ENTITIES), // вторичный (рывок / фаза)
    iframe: new Float32Array(MAX_ENTITIES),
    dash: new Float32Array(MAX_ENTITIES), // остаток времени рывка
    anim: new Float32Array(MAX_ENTITIES),
    type: new Uint8Array(MAX_ENTITIES),
    sub: new Uint8Array(MAX_ENTITIES), // архетип моба / вид пикапа
    sub2: new Uint8Array(MAX_ENTITIES), // доп. параметр (id предмета, цена)
    state: new Uint8Array(MAX_ENTITIES),
    hp: new Uint8Array(MAX_ENTITIES),
    maxhp: new Uint8Array(MAX_ENTITIES),
    ctrl: new Uint8Array(MAX_ENTITIES), // 0 = ИИ, иначе slot+1
    r: new Uint8Array(MAX_ENTITIES),
    flags: new Uint16Array(MAX_ENTITIES), // модификаторы снарядов
    owner: new Uint16Array(MAX_ENTITIES), // индекс владельца снаряда +1
    free: new Uint16Array(MAX_ENTITIES),
    freeN: 0,
    high: 0, // верхняя граница занятых индексов (для коротких циклов)
    grid: new Int32Array(GRID_CELLS + 1),
    gridCur: new Int32Array(GRID_CELLS + 1),
    gridItems: new Uint16Array(MAX_ENTITIES),
  };
  resetWorld(w);
  return w;
}

export function resetWorld(w) {
  w.type.fill(0);
  w.state.fill(0);
  w.ctrl.fill(0);
  w.flags.fill(0);
  w.owner.fill(0);
  w.freeN = MAX_ENTITIES;
  for (let i = 0; i < MAX_ENTITIES; i++) w.free[i] = MAX_ENTITIES - 1 - i;
  w.high = 0;
}

/** Выделяет сущность из пула. Возвращает индекс или -1. */
export function allocEntity(w, type) {
  if (w.freeN === 0) return -1;
  const i = w.free[--w.freeN];
  w.type[i] = type;
  w.x[i] = 0; w.y[i] = 0; w.vx[i] = 0; w.vy[i] = 0;
  w.ax[i] = 0; w.ay[i] = 0;
  w.dmg[i] = 0; w.ttl[i] = 0; w.cd[i] = 0; w.cd2[i] = 0;
  w.iframe[i] = 0; w.dash[i] = 0; w.anim[i] = 0;
  w.sub[i] = 0; w.sub2[i] = 0; w.state[i] = ST_ALIVE;
  w.hp[i] = 1; w.maxhp[i] = 1; w.ctrl[i] = 0; w.r[i] = 6;
  w.flags[i] = 0; w.owner[i] = 0;
  if (i >= w.high) w.high = i + 1;
  return i;
}

export function freeEntity(w, i) {
  if (w.type[i] === T_NONE) return;
  w.type[i] = T_NONE;
  w.state[i] = 0;
  w.ctrl[i] = 0;
  w.free[w.freeN++] = i;
  if (i === w.high - 1) {
    let h = w.high - 1;
    while (h > 0 && w.type[h - 1] === T_NONE) h--;
    w.high = h;
  }
}

/** Удаляет всё, кроме сущностей типа keepType (используется при смене комнаты). */
export function clearWorldExcept(w, keepType) {
  for (let i = 0; i < w.high; i++) {
    if (w.type[i] !== T_NONE && w.type[i] !== keepType) freeEntity(w, i);
  }
}

// ─── направление взгляда ─────────────────────────────────────────────────────

export function setFacing(w, i, dir) {
  w.state[i] = (w.state[i] & ~(ST_FACE0 | ST_FACE1)) | ((dir & 3) << 6);
}
export function getFacing(w, i) {
  return (w.state[i] >> 6) & 3;
}

// ─── тайлы и коллизии ────────────────────────────────────────────────────────

export function tileSolid(tiles, tx, ty, flying) {
  if (tx < 0 || ty < 0 || tx >= ROOM_W || ty >= ROOM_H) return 1;
  const s = TILE_SOLID[tiles[ty * ROOM_W + tx]];
  if (s === 1) return 1;
  if (s === 2 && !flying) return 1;
  return 0;
}

// скорость соскальзывания с угла тайла (px/с)
const SLIDE = 58;

/**
 * Двигает сущность с раздельным разрешением по осям.
 * При лёгком задевании угла тайла добавляет соскальзывание вдоль второй оси —
 * иначе игрок (и бот) намертво залипает на кромке ямы или камня.
 * Возвращает битовую маску касаний: 1 — стена по X, 2 — стена по Y.
 */
export function moveAndCollide(w, i, dt, tiles, flying) {
  // Если за тик проходим больше половины тайла, дробим шаг: иначе быстрая
  // сущность может перепрыгнуть камень целиком и оказаться за ним.
  const dist = (Math.abs(w.vx[i]) + Math.abs(w.vy[i])) * dt;
  if (dist <= TILE * 0.5) return moveStep(w, i, dt, tiles, flying);
  let steps = Math.ceil(dist / (TILE * 0.5));
  if (steps > 6) steps = 6;
  const sub = dt / steps;
  let hit = 0;
  for (let s = 0; s < steps; s++) hit |= moveStep(w, i, sub, tiles, flying);
  return hit;
}

function moveStep(w, i, dt, tiles, flying) {
  const r = w.r[i];
  let hit = 0;
  let slideY = 0, slideX = 0;

  // ── ось X
  let x = w.x[i] + w.vx[i] * dt;
  const y0 = w.y[i];
  if (w.vx[i] !== 0) {
    const ty0 = ((y0 - r) / TILE) | 0, ty1 = ((y0 + r) / TILE) | 0;
    const tx0 = ((x - r) / TILE) | 0, tx1 = ((x + r) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!tileSolid(tiles, tx, ty, flying)) continue;
        const left = tx * TILE, right = left + TILE;
        if (x + r > left && x - r < right) {
          if (w.vx[i] > 0) x = left - r - 0.01;
          else x = right + r + 0.01;
          hit |= 1;
          const top = ty * TILE, bot = top + TILE;
          const ovTop = y0 + r - top;   // насколько круг заходит на тайл сверху
          const ovBot = bot - (y0 - r); // ...и снизу
          if (ovTop > 0 && ovBot > 0) {
            if (ovTop <= ovBot && ovTop < r && slideY >= 0) slideY = -ovTop;
            else if (ovBot < ovTop && ovBot < r && slideY <= 0) slideY = ovBot;
          }
        }
      }
    }
  }
  if (x < r) { x = r; hit |= 1; }
  else if (x > WORLD_W - r) { x = WORLD_W - r; hit |= 1; }
  w.x[i] = x;

  // ── ось Y (плюс соскальзывание, если по X упёрлись углом)
  let dy = w.vy[i] * dt;
  if (dy === 0 && slideY !== 0) {
    const s = SLIDE * dt;
    dy = slideY < 0 ? -(s < -slideY ? s : -slideY + 0.1) : (s < slideY ? s : slideY + 0.1);
  }
  let y = w.y[i] + dy;
  if (dy !== 0) {
    const tx0 = ((x - r) / TILE) | 0, tx1 = ((x + r) / TILE) | 0;
    const ty0 = ((y - r) / TILE) | 0, ty1 = ((y + r) / TILE) | 0;
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (!tileSolid(tiles, tx, ty, flying)) continue;
        const top = ty * TILE, bot = top + TILE;
        if (y + r > top && y - r < bot) {
          if (dy > 0) y = top - r - 0.01;
          else y = bot + r + 0.01;
          hit |= 2;
          const left = tx * TILE, right = left + TILE;
          const ovL = x + r - left;
          const ovR = right - (x - r);
          if (ovL > 0 && ovR > 0) {
            if (ovL <= ovR && ovL < r && slideX >= 0) slideX = -ovL;
            else if (ovR < ovL && ovR < r && slideX <= 0) slideX = ovR;
          }
        }
      }
    }
  }
  if (y < r) { y = r; hit |= 2; }
  else if (y > WORLD_H - r) { y = WORLD_H - r; hit |= 2; }
  w.y[i] = y;

  // соскальзывание по X, если двигались только вертикально
  if (w.vx[i] === 0 && slideX !== 0) {
    const s = SLIDE * dt;
    let nx = x + (slideX < 0 ? -(s < -slideX ? s : -slideX + 0.1) : (s < slideX ? s : slideX + 0.1));
    if (nx < r) nx = r; else if (nx > WORLD_W - r) nx = WORLD_W - r;
    const t0 = ((nx - r) / TILE) | 0, t1 = ((nx + r) / TILE) | 0;
    const yt0 = ((y - r) / TILE) | 0, yt1 = ((y + r) / TILE) | 0;
    let blocked = 0;
    for (let tx = t0; tx <= t1 && !blocked; tx++) {
      for (let ty = yt0; ty <= yt1; ty++) {
        if (tileSolid(tiles, tx, ty, flying)) { blocked = 1; break; }
      }
    }
    if (!blocked) w.x[i] = nx;
  }

  return hit;
}

/**
 * Общий шаг движения по инпуту. Используется и предсказанием клиента,
 * и сервером — байт-в-байт одинаковый код.
 */
export function stepMotion(w, i, b0, speed, dt, tiles, flying) {
  if (w.dash[i] > 0) {
    w.dash[i] -= dt;
    return moveAndCollide(w, i, dt, tiles, flying);
  }
  let dx = 0, dy = 0;
  if (b0 & IN_LEFT) dx -= 1;
  if (b0 & IN_RIGHT) dx += 1;
  if (b0 & IN_UP) dy -= 1;
  if (b0 & IN_DOWN) dy += 1;
  if (dx !== 0 && dy !== 0) { dx *= 0.70710678; dy *= 0.70710678; }
  const moving = dx !== 0 || dy !== 0;
  let k = (moving ? ACCEL : FRICTION) * dt;
  if (k > 1) k = 1;
  w.vx[i] += (dx * speed - w.vx[i]) * k;
  w.vy[i] += (dy * speed - w.vy[i]) * k;
  if (moving) {
    if (dy < 0 && (dx === 0 || -dy >= Math.abs(dx))) setFacing(w, i, 1);
    else if (dy > 0 && (dx === 0 || dy >= Math.abs(dx))) setFacing(w, i, 0);
    else if (dx < 0) setFacing(w, i, 2);
    else setFacing(w, i, 3);
  }
  return moveAndCollide(w, i, dt, tiles, flying);
}

// ─── uniform grid 16×16 ──────────────────────────────────────────────────────

/** Пересобирает broadphase-сетку (counting sort, ноль аллокаций). */
export function buildGrid(w) {
  const g = w.grid, cur = w.gridCur;
  g.fill(0);
  const n = w.high;
  for (let i = 0; i < n; i++) {
    const t = w.type[i];
    if (t === T_NONE) continue;
    let cx = (w.x[i] / GRID_CELL) | 0, cy = (w.y[i] / GRID_CELL) | 0;
    if (cx < 0) cx = 0; else if (cx >= GRID_W) cx = GRID_W - 1;
    if (cy < 0) cy = 0; else if (cy >= GRID_H) cy = GRID_H - 1;
    g[cy * GRID_W + cx + 1]++;
  }
  for (let c = 0; c < GRID_CELLS; c++) g[c + 1] += g[c];
  for (let c = 0; c <= GRID_CELLS; c++) cur[c] = g[c];
  for (let i = 0; i < n; i++) {
    const t = w.type[i];
    if (t === T_NONE) continue;
    let cx = (w.x[i] / GRID_CELL) | 0, cy = (w.y[i] / GRID_CELL) | 0;
    if (cx < 0) cx = 0; else if (cx >= GRID_W) cx = GRID_W - 1;
    if (cy < 0) cy = 0; else if (cy >= GRID_H) cy = GRID_H - 1;
    w.gridItems[cur[cy * GRID_W + cx]++] = i;
  }
}

export function cellMin(v, cell, max) {
  let c = ((v) / cell) | 0;
  if (c < 0) c = 0; else if (c >= max) c = max - 1;
  return c;
}

// ─── снаряды ─────────────────────────────────────────────────────────────────

/**
 * Шаг снаряда: движение, отскок/пирсинг по стенам, самонаведение, время жизни.
 * Возвращает 1, если снаряд должен быть уничтожен.
 */
export function stepProjectile(w, i, dt, tiles) {
  const fl = w.flags[i];
  w.ttl[i] -= dt;
  if (w.ttl[i] <= 0) return 1;

  if (fl & TF_HOME) {
    // ищем ближайшую цель противоположной команды
    const isTear = w.type[i] === T_TEAR;
    let best = -1, bestD = 90 * 90;
    for (let j = 0; j < w.high; j++) {
      const t = w.type[j];
      if (isTear ? t !== T_MOB : t !== T_ISAAC) continue;
      if (!(w.state[j] & ST_ALIVE)) continue;
      const dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0) {
      const dx = w.x[best] - w.x[i], dy = w.y[best] - w.y[i];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const sp = Math.sqrt(w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]) || 1;
      const k = 5.0 * dt;
      let nx = w.vx[i] / sp + (dx / len) * k;
      let ny = w.vy[i] / sp + (dy / len) * k;
      const nl = Math.sqrt(nx * nx + ny * ny) || 1;
      w.vx[i] = (nx / nl) * sp;
      w.vy[i] = (ny / nl) * sp;
    }
  }

  if (fl & TF_SPECTRAL) {
    // призрачные слёзы игнорируют геометрию, но не границы комнаты
    const r = w.r[i];
    let x = w.x[i] + w.vx[i] * dt, y = w.y[i] + w.vy[i] * dt;
    if (x < r || x > WORLD_W - r || y < r || y > WORLD_H - r) return 1;
    w.x[i] = x; w.y[i] = y;
    return 0;
  }
  // снаряды перелетают ямы (flying = 1), но бьются о стены и камни
  const hit = moveAndCollide(w, i, dt, tiles, 1);
  if (hit) {
    if (fl & TF_BOUNCE) {
      if (hit & 1) w.vx[i] = -w.vx[i];
      if (hit & 2) w.vy[i] = -w.vy[i];
      w.flags[i] = fl & ~TF_BOUNCE; // один отскок
    } else {
      return 1;
    }
  }
  return 0;
}

// ─── урон ────────────────────────────────────────────────────────────────────

/** Списывает hp. Возвращает 1, если цель умерла на этом ударе. */
export function damage(w, i, amount) {
  let a = Math.round(amount);
  if (a < 1) a = 1;
  if (w.hp[i] <= a) { w.hp[i] = 0; return 1; }
  w.hp[i] -= a;
  return 0;
}

export function dist2(w, a, b) {
  const dx = w.x[a] - w.x[b], dy = w.y[a] - w.y[b];
  return dx * dx + dy * dy;
}

/** Круг-круг перекрытие с запасом pad. */
export function overlap(w, a, b, pad) {
  const rr = w.r[a] + w.r[b] + pad;
  const dx = w.x[a] - w.x[b], dy = w.y[a] - w.y[b];
  return dx * dx + dy * dy <= rr * rr;
}

// ─── генерация этажа ─────────────────────────────────────────────────────────

export function createFloor() {
  return {
    seed: 0,
    n: 0,
    start: 0,
    boss: 0,
    secret: -1,
    map: new Int16Array(FMAP_CELLS), // клетка карты → индекс комнаты, -1 нет
    rx: new Uint8Array(MAX_ROOMS),
    ry: new Uint8Array(MAX_ROOMS),
    kind: new Uint8Array(MAX_ROOMS),
    doors: new Uint8Array(MAX_ROOMS), // биты 0..3: up,down,left,right
    secretDoors: new Uint8Array(MAX_ROOMS), // те же биты — скрытые двери
    rseed: new Uint32Array(MAX_ROOMS),
    rec: new Uint8Array(MAX_ROOMS * ROOM_REC), // сериализация покинутых комнат
  };
}

const DX4 = new Int8Array([0, 0, -1, 1]);
const DY4 = new Int8Array([-1, 1, 0, 0]);
const OPP4 = new Uint8Array([1, 0, 3, 2]);
export { DX4, DY4, OPP4 };

/** Генерирует топологию этажа из seed. Полностью детерминированно. */
export function genFloor(f, seed) {
  f.seed = seed >>> 0;
  const rnd = mulberry32(f.seed);
  f.map.fill(-1);
  f.doors.fill(0);
  f.secretDoors.fill(0);
  f.rec.fill(0);
  f.secret = -1;

  const target = FLOOR_MIN_ROOMS + ((rnd() * (FLOOR_MAX_ROOMS - FLOOR_MIN_ROOMS + 1)) | 0);
  const cx = (FMAP_W / 2) | 0, cy = (FMAP_H / 2) | 0;
  let n = 0;
  f.rx[0] = cx; f.ry[0] = cy; f.kind[0] = R_START;
  f.map[cy * FMAP_W + cx] = 0;
  n = 1;

  // рост методом случайного соседа существующей комнаты
  let guard = 0;
  while (n < target && guard++ < 4000) {
    const from = (rnd() * n) | 0;
    const d = (rnd() * 4) | 0;
    const nx = f.rx[from] + DX4[d], ny = f.ry[from] + DY4[d];
    if (nx < 0 || ny < 0 || nx >= FMAP_W || ny >= FMAP_H) continue;
    const ci = ny * FMAP_W + nx;
    if (f.map[ci] >= 0) continue;
    // не более 2 соседей, чтобы этаж был «ветвистым», а не слипшимся
    let nb = 0;
    for (let k = 0; k < 4; k++) {
      const ax = nx + DX4[k], ay = ny + DY4[k];
      if (ax < 0 || ay < 0 || ax >= FMAP_W || ay >= FMAP_H) continue;
      if (f.map[ay * FMAP_W + ax] >= 0) nb++;
    }
    if (nb > 1 && rnd() < 0.75) continue;
    f.rx[n] = nx; f.ry[n] = ny; f.kind[n] = R_NORMAL;
    f.map[ci] = n;
    n++;
  }
  f.n = n;

  // связи (двери) между соседями по карте
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 4; d++) {
      const nx = f.rx[i] + DX4[d], ny = f.ry[i] + DY4[d];
      if (nx < 0 || ny < 0 || nx >= FMAP_W || ny >= FMAP_H) continue;
      if (f.map[ny * FMAP_W + nx] >= 0) f.doors[i] |= 1 << d;
    }
  }

  // тупики: комнаты ровно с одной дверью
  let bossIdx = -1, bossDist = -1;
  for (let i = 1; i < n; i++) {
    const dd = Math.abs(f.rx[i] - cx) + Math.abs(f.ry[i] - cy);
    let deg = 0;
    for (let d = 0; d < 4; d++) if (f.doors[i] & (1 << d)) deg++;
    if (deg === 1 && dd > bossDist) { bossDist = dd; bossIdx = i; }
  }
  if (bossIdx < 0) bossIdx = n - 1;
  f.kind[bossIdx] = R_BOSS;
  f.boss = bossIdx;
  f.start = 0;

  // магазин и сокровищница — другие тупики, иначе просто дальние комнаты
  let placed = 0;
  const wants = 2;
  for (let pass = 0; pass < 2 && placed < wants; pass++) {
    for (let i = n - 1; i >= 1 && placed < wants; i--) {
      if (f.kind[i] !== R_NORMAL) continue;
      let deg = 0;
      for (let d = 0; d < 4; d++) if (f.doors[i] & (1 << d)) deg++;
      if (pass === 0 && deg !== 1) continue;
      f.kind[i] = placed === 0 ? R_TREASURE : R_SHOP;
      placed++;
    }
  }

  // секретка: свободная клетка, граничащая с >= 2 комнатами
  let bestCell = -1, bestScore = 1;
  for (let ci = 0; ci < FMAP_CELLS; ci++) {
    if (f.map[ci] >= 0) continue;
    const x = ci % FMAP_W, y = (ci / FMAP_W) | 0;
    let score = 0, okNeighbor = 0;
    for (let d = 0; d < 4; d++) {
      const ax = x + DX4[d], ay = y + DY4[d];
      if (ax < 0 || ay < 0 || ax >= FMAP_W || ay >= FMAP_H) continue;
      const ri = f.map[ay * FMAP_W + ax];
      if (ri >= 0 && f.kind[ri] !== R_BOSS) { score++; okNeighbor = 1; }
    }
    if (okNeighbor && score > bestScore && n < MAX_ROOMS) { bestScore = score; bestCell = ci; }
  }
  if (bestCell >= 0 && n < MAX_ROOMS) {
    const x = bestCell % FMAP_W, y = (bestCell / FMAP_W) | 0;
    const si = n++;
    f.n = n;
    f.rx[si] = x; f.ry[si] = y; f.kind[si] = R_SECRET;
    f.map[bestCell] = si;
    f.secret = si;
    for (let d = 0; d < 4; d++) {
      const ax = x + DX4[d], ay = y + DY4[d];
      if (ax < 0 || ay < 0 || ax >= FMAP_W || ay >= FMAP_H) continue;
      const ri = f.map[ay * FMAP_W + ax];
      if (ri < 0 || ri === si || f.kind[ri] === R_BOSS) continue;
      f.doors[si] |= 1 << d;
      f.secretDoors[si] |= 1 << d;
      f.doors[ri] |= 1 << OPP4[d];
      f.secretDoors[ri] |= 1 << OPP4[d];
    }
  }

  for (let i = 0; i < n; i++) {
    f.rseed[i] = hash2(f.seed, i * 2654435761);
    // стартовая комната и служебные считаются зачищенными
    const cleared = (f.kind[i] === R_START || f.kind[i] === R_SHOP ||
      f.kind[i] === R_TREASURE || f.kind[i] === R_SECRET) ? 1 : 0;
    const o = i * ROOM_REC;
    f.rec[o] = cleared;
    f.rec[o + 1] = 0; // visited
  }
  return f;
}

export function roomAt(f, x, y) {
  if (x < 0 || y < 0 || x >= FMAP_W || y >= FMAP_H) return -1;
  return f.map[y * FMAP_W + x];
}
export function neighborRoom(f, idx, d) {
  return roomAt(f, f.rx[idx] + DX4[d], f.ry[idx] + DY4[d]);
}

// ─── сериализация комнаты в 32 байта ─────────────────────────────────────────
// [0] cleared, [1] visited, [2] flags, [3] loot, [4..20] маска разрушенных
// камней (135 бит), [21..31] резерв (взятые предметы, открытые секреты).

export function roomCleared(f, i) { return f.rec[i * ROOM_REC] !== 0; }
export function setRoomCleared(f, i, v) { f.rec[i * ROOM_REC] = v ? 1 : 0; }
export function roomVisited(f, i) { return f.rec[i * ROOM_REC + 1] !== 0; }
export function setRoomVisited(f, i, v) { f.rec[i * ROOM_REC + 1] = v ? 1 : 0; }
export function roomFlags(f, i) { return f.rec[i * ROOM_REC + 2]; }
export function setRoomFlag(f, i, bit) { f.rec[i * ROOM_REC + 2] |= bit; }
export const RF_LOOTED = 1;
export const RF_SECRET_OPEN = 2;
export const RF_ITEM_TAKEN = 4;

export function markRockBroken(f, i, tileIdx) {
  const o = i * ROOM_REC + 4 + (tileIdx >> 3);
  f.rec[o] |= 1 << (tileIdx & 7);
}
export function isRockBroken(f, i, tileIdx) {
  return (f.rec[i * ROOM_REC + 4 + (tileIdx >> 3)] >> (tileIdx & 7)) & 1;
}

// ─── генерация тайлов комнаты ────────────────────────────────────────────────

export const DOOR_TX = new Uint8Array([7, 7, 0, 14]);
export const DOOR_TY = new Uint8Array([0, 8, 4, 4]);

/**
 * Раскладывает тайлы текущей комнаты в переданный Uint8Array(135).
 * Полностью детерминированно от (floor.seed, idx) + записи о разрушениях.
 */
export function genRoomTiles(f, idx, tiles) {
  const kind = f.kind[idx];
  const rnd = mulberry32(f.rseed[idx]);
  for (let ty = 0; ty < ROOM_H; ty++) {
    for (let tx = 0; tx < ROOM_W; tx++) {
      const border = tx === 0 || ty === 0 || tx === ROOM_W - 1 || ty === ROOM_H - 1;
      tiles[ty * ROOM_W + tx] = border ? TL_WALL : TL_FLOOR;
    }
  }

  if (kind === R_NORMAL) {
    const pattern = (rnd() * 6) | 0;
    for (let ty = 2; ty < ROOM_H - 2; ty++) {
      for (let tx = 2; tx < ROOM_W - 2; tx++) {
        const i = ty * ROOM_W + tx;
        let put = 0;
        switch (pattern) {
          case 0: put = (tx % 4 === 2 && ty % 3 === 2) ? TL_ROCK : 0; break;
          case 1: put = ((tx === 4 || tx === 10) && ty >= 3 && ty <= 5) ? TL_ROCK : 0; break;
          case 2: put = (Math.abs(tx - 7) + Math.abs(ty - 4) === 3) ? TL_ROCK : 0; break;
          case 3: put = (ty === 4 && tx >= 4 && tx <= 10 && tx !== 7) ? TL_PIT : 0; break;
          case 4: put = ((tx === 3 || tx === 11) && (ty === 2 || ty === 6)) ? TL_ROCK : 0; break;
          case 5: put = (rnd() < 0.11) ? (rnd() < 0.25 ? TL_SPIKE : TL_ROCK) : 0; break;
        }
        if (put === TL_ROCK && rnd() < 0.18) put = TL_SPIKE;
        if (put) tiles[i] = put;
      }
    }
    // не заваливаем центр — там появляются игроки при входе
    tiles[4 * ROOM_W + 7] = TL_FLOOR;
  } else if (kind === R_SHOP) {
    for (let tx = 4; tx <= 10; tx += 3) tiles[2 * ROOM_W + tx] = TL_FLOOR;
  } else if (kind === R_BOSS) {
    for (let tx = 2; tx <= 12; tx += 10) {
      tiles[2 * ROOM_W + tx] = TL_ROCK;
      tiles[6 * ROOM_W + tx] = TL_ROCK;
    }
  }

  // восстановление разрушенных камней из 32-байтной записи
  for (let i = 0; i < ROOM_TILES; i++) {
    if ((tiles[i] === TL_ROCK || tiles[i] === TL_SPIKE) && isRockBroken(f, idx, i)) {
      tiles[i] = TL_RUBBLE;
    }
  }

  // двери
  const cleared = roomCleared(f, idx);
  const secretOpen = (roomFlags(f, idx) & RF_SECRET_OPEN) !== 0;
  for (let d = 0; d < 4; d++) {
    if (!(f.doors[idx] & (1 << d))) continue;
    const ti = DOOR_TY[d] * ROOM_W + DOOR_TX[d];
    const isSecret = (f.secretDoors[idx] & (1 << d)) !== 0;
    if (isSecret) {
      tiles[ti] = secretOpen ? TL_DOOR_OPEN : TL_SECRET;
    } else {
      tiles[ti] = cleared ? TL_DOOR_OPEN : TL_DOOR;
    }
    // расчищаем подход к двери
    const ax = DOOR_TX[d] + (DOOR_TX[d] === 0 ? 1 : DOOR_TX[d] === ROOM_W - 1 ? -1 : 0);
    const ay = DOOR_TY[d] + (DOOR_TY[d] === 0 ? 1 : DOOR_TY[d] === ROOM_H - 1 ? -1 : 0);
    const ai = ay * ROOM_W + ax;
    if (tiles[ai] !== TL_WALL) tiles[ai] = TL_FLOOR;
  }

  // люк после босса
  if (kind === R_BOSS && cleared) tiles[4 * ROOM_W + 7] = TL_HATCH;
  return tiles;
}

/** Центр тайла в мировых координатах. */
export function tileCX(tx) { return tx * TILE + TILE / 2; }
export function tileCY(ty) { return ty * TILE + TILE / 2; }

/**
 * Список врагов комнаты. Пишет в out тройки (kind, x, y), возвращает количество.
 * Детерминированно от rseed комнаты.
 */
export function genRoomSpawns(f, idx, out, floorNum) {
  const kind = f.kind[idx];
  if (kind !== R_NORMAL && kind !== R_BOSS) return 0;
  const rnd = mulberry32(f.rseed[idx] ^ 0x5bf03635);
  let n = 0;
  if (kind === R_BOSS) {
    out[0] = M_BOSS; out[1] = WORLD_W / 2; out[2] = WORLD_H / 2 - 10;
    return 1;
  }
  const count = 3 + ((rnd() * 3) | 0) + (floorNum > 1 ? 1 : 0);
  for (let k = 0; k < count && n < 12; k++) {
    let arch = (rnd() * 5) | 0;
    if (arch === M_SPLITTER && rnd() < 0.5) arch = M_CRAWLER;
    const tx = 2 + ((rnd() * (ROOM_W - 4)) | 0);
    const ty = 2 + ((rnd() * (ROOM_H - 4)) | 0);
    out[n * 3] = arch;
    out[n * 3 + 1] = tileCX(tx);
    out[n * 3 + 2] = tileCY(ty);
    n++;
  }
  return n;
}

/** Бюджет волны докидывания мобов под игроков-монстров. */
export function roomBudget(f, idx, floorNum) {
  const kind = f.kind[idx];
  if (kind === R_BOSS) return 14 + floorNum * 4;
  if (kind !== R_NORMAL) return 0;
  return 16 + floorNum * 6;
}

// ─── точки входа игроков ─────────────────────────────────────────────────────

/** Куда поставить игрока, вошедшего через дверь fromDir (сторона входа). */
export function entryX(fromDir) {
  if (fromDir === 2) return TILE * 1.7;
  if (fromDir === 3) return WORLD_W - TILE * 1.7;
  return WORLD_W / 2;
}
export function entryY(fromDir) {
  if (fromDir === 0) return TILE * 1.7;
  if (fromDir === 1) return WORLD_H - TILE * 1.7;
  return WORLD_H / 2;
}

/** Свободна ли точка (не в стене) — для безопасного спавна. */
export function freeSpot(tiles, x, y, r) {
  const tx = (x / TILE) | 0, ty = (y / TILE) | 0;
  if (tileSolid(tiles, tx, ty, 0)) return 0;
  if (tileSolid(tiles, ((x - r) / TILE) | 0, ty, 0)) return 0;
  if (tileSolid(tiles, ((x + r) / TILE) | 0, ty, 0)) return 0;
  if (tileSolid(tiles, tx, ((y - r) / TILE) | 0, 0)) return 0;
  if (tileSolid(tiles, tx, ((y + r) / TILE) | 0, 0)) return 0;
  return 1;
}

/** Ищет ближайшую свободную клетку по спирали от (x,y). Пишет в out[0..1]. */
export function nearestFree(tiles, x, y, r, out) {
  if (freeSpot(tiles, x, y, r)) { out[0] = x; out[1] = y; return 1; }
  for (let ring = 1; ring < 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const nx = x + dx * TILE, ny = y + dy * TILE;
        if (nx < r || ny < r || nx > WORLD_W - r || ny > WORLD_H - r) continue;
        if (freeSpot(tiles, nx, ny, r)) { out[0] = nx; out[1] = ny; return 1; }
      }
    }
  }
  out[0] = WORLD_W / 2; out[1] = WORLD_H / 2;
  return 0;
}

// ─── настройка моба ──────────────────────────────────────────────────────────

export function initMob(w, i, arch, x, y, floorNum) {
  w.type[i] = T_MOB;
  w.sub[i] = arch;
  w.x[i] = x; w.y[i] = y;
  w.vx[i] = 0; w.vy[i] = 0;
  w.r[i] = MOB_R[arch];
  let hp = MOB_HP[arch] + (floorNum - 1) * (arch === M_BOSS ? 40 : 2);
  if (hp > 255) hp = 255;
  w.hp[i] = hp;
  w.maxhp[i] = hp;
  w.state[i] = ST_ALIVE;
  w.cd[i] = 0.8;
  w.cd2[i] = 0;
  w.ttl[i] = 0;
  w.ctrl[i] = 0;
  w.anim[i] = 0;
  w.ax[i] = x; w.ay[i] = y;
  return i;
}

export { T_NONE, T_ISAAC, T_MOB, T_TEAR, T_SHOT, T_PICKUP, T_BOMB, T_SPIRIT };
