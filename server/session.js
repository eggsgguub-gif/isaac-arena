// server/session.js — авторитетная сессия. Один процесс держит пул сессий,
// каждая живёт целиком в TypedArray и не аллоцирует в тике.

import {
  TICK_RATE, DT, MAX_ENTITIES, MAX_PLAYERS, MAX_ISAACS, MAX_MONSTERS,
  ROOM_W, ROOM_H, TILE, WORLD_W, WORLD_H, ROOM_TILES,
  GRID_CELL, GRID_W, GRID_H,
  TL_FLOOR, TL_ROCK, TL_SPIKE, TL_DOOR, TL_DOOR_OPEN, TL_SECRET, TL_RUBBLE, TL_HATCH, TL_PIT,
  T_NONE, T_ISAAC, T_MOB, T_TEAR, T_SHOT, T_PICKUP, T_BOMB,
  ST_ALIVE, ST_SHIELD, ST_CHARGE, ST_HURT, ST_AIR, ST_DOWN,
  M_CRAWLER, M_SPITTER, M_SPLITTER, M_HOPPER, M_SHIELDER, M_SPAWN, M_BOSS,
  MOB_HP, MOB_R, MOB_SPEED, MOB_TOUCH, MOB_COST,
  TF_PIERCE, TF_HOME, TF_POISON, TF_BOUNCE, TF_TRIPLE,
  IT_COUNT, IT_DAMAGE, IT_FIRERATE, IT_SPEED, IT_RANGE, IT_SHOTSPEED, IT_PIERCE,
  IT_HOME, IT_POISON, IT_BOUNCE, IT_TRIPLE, IT_HEART, IT_BIGTEAR, IT_BOMBS, IT_LUCK,
  ITEM_PRICE,
  R_START, R_NORMAL, R_TREASURE, R_SHOP, R_BOSS, R_SECRET,
  P_HEART, P_HALFHEART, P_COIN, P_KEY, P_BOMB, P_PEDESTAL,
  SIDE_ISAAC, SIDE_MONSTER,
  IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_SUP, IN_SDOWN, IN_SLEFT, IN_SRIGHT,
  IN2_FIRE, IN2_ABILITY, IN2_DASH, IN2_BOMB,
  ISAAC_R, ISAAC_BASE_SPEED, ISAAC_BASE_DAMAGE, ISAAC_BASE_FIRERATE, ISAAC_BASE_RANGE,
  ISAAC_BASE_SHOTSPEED, ISAAC_MAX_HEARTS, ISAAC_IFRAMES, ISAAC_DOWN_TIME,
  PLAYER_MOB_DMG_MUL, PLAYER_MOB_HP_MUL, SPIRIT_TIME,
  BOMB_FUSE, BOMB_RADIUS, BOMB_DAMAGE,
  ROUND_RESTART_MS, MAX_PACKET, PROTOCOL_VERSION,
  EV_HIT, EV_MOB_DIE, EV_SHOOT, EV_EXPLODE, EV_PICKUP, EV_DOOR, EV_HURT,
  EV_ABILITY, EV_POSSESS, EV_ROCK, EV_BOSS_DIE, EV_SECRET, EV_DENY, EV_REVIVE,
} from '../shared/constants.js';

import {
  createWorld, resetWorld, allocEntity, freeEntity, createFloor, genFloor,
  genRoomTiles, genRoomSpawns, roomBudget, mulberry32, hash2,
  stepMotion, moveAndCollide, stepProjectile, damage, buildGrid, cellMin,
  setFacing, getFacing, initMob, nearestFree, freeSpot, tileCX, tileCY, tileSolid,
  roomCleared, setRoomCleared, roomVisited, setRoomVisited, roomFlags, setRoomFlag,
  markRockBroken, RF_LOOTED, RF_SECRET_OPEN, RF_ITEM_TAKEN,
  neighborRoom, DOOR_TX, DOOR_TY, DX4, DY4, OPP4, MAX_ROOMS,
} from '../shared/sim.js';

import {
  S_WELCOME, S_ROSTER, S_ROOM, S_SNAP, S_EVENTS, S_STATS, S_ROUND, S_PONG, S_KICK,
  createNetView, clearNetView, encodeSnapshot, nickFromUuid,
} from '../shared/protocol.js';

import { stepMobAI, stepAirborne, stepPlayerMobTimers, useAbility, useDash } from './ai.js';

const MAX_EVENTS = 48;
const STATS_EVERY = 6; // тиков между пакетами статистики
const IDLE_AI = 5; // сек без инпута — тело временно берёт ИИ, чтобы комната жила
const KNOCK_CAP = 200; // потолок скорости после толчка, px/с

// ─── слот игрока ─────────────────────────────────────────────────────────────

class Slot {
  constructor(index) {
    this.index = index;
    this.used = false;
    this.bot = false;
    this.ws = null;
    this.ip = '';
    this.uuid = new Uint8Array(16);
    this.adj = 0;
    this.noun = 0;
    this.side = index < MAX_ISAACS ? SIDE_ISAAC : SIDE_MONSTER;
    this.entity = -1;

    this.b0 = 0; this.b1 = 0; this.prevB1 = 0; this.aim = 0;
    this.seq = 0; this.ack = 0;
    this.idle = 0;
    this.ping = 60;
    this.needFull = true;
    this.pps = 0; this.ppsTick = 0;

    // статы Айзека
    this.hearts = 12; this.maxHearts = 12; // в половинках: 6 сердец
    this.bombs = 1; this.keys = 1; this.coins = 0;
    this.items = new Uint8Array(IT_COUNT);
    this.itemMask = 0;
    this.damage = ISAAC_BASE_DAMAGE;
    this.firerate = ISAAC_BASE_FIRERATE;
    this.range = ISAAC_BASE_RANGE;
    this.speed = ISAAC_BASE_SPEED;
    this.shotspeed = ISAAC_BASE_SHOTSPEED;
    this.tearFlags = 0;
    this.fireCd = 0;
    this.dmgAcc = 0;
    this.downTimer = 0;

    // монстр
    this.spirit = 0;
    this.respawn = 0;
    this.spiritX = WORLD_W / 2;
    this.spiritY = WORLD_H / 2;

    // ИИ-бот
    this.botTimer = 0;
    this.botDoor = -1;
    this.botStuck = 0;
    this.botDetour = 0;
    this.botDetourT = 0;
    this.botLastX = 0;
    this.botLastY = 0;
    this.statsDirty = true;
  }

  resetStats() {
    this.hearts = 12; this.maxHearts = 12; // в половинках: 6 сердец
    this.bombs = 1; this.keys = 1; this.coins = 0;
    this.items.fill(0);
    this.itemMask = 0;
    this.damage = ISAAC_BASE_DAMAGE;
    this.firerate = ISAAC_BASE_FIRERATE;
    this.range = ISAAC_BASE_RANGE;
    this.speed = ISAAC_BASE_SPEED;
    this.shotspeed = ISAAC_BASE_SHOTSPEED;
    this.tearFlags = 0;
    this.fireCd = 0;
    this.dmgAcc = 0;
    this.downTimer = 0;
    this.spirit = 0;
    this.respawn = 0;
    this.statsDirty = true;
  }
}

// поле extra снапшота — по одному байту на сущность, смысл зависит от типа
function extraOf(w, i) {
  const t = w.type[i];
  if (t === T_TEAR) return (w.flags[i] & 63) | (w.r[i] > 4 ? 64 : 0);
  if (t === T_MOB) {
    if (w.state[i] & ST_AIR) { let h = (w.anim[i] * 255) | 0; return h < 0 ? 0 : h > 255 ? 255 : h; }
    return (w.dash[i] > 0 ? 1 : 0) | (w.cd[i] > 0 ? 2 : 0);
  }
  if (t === T_PICKUP) return w.sub2[i];
  if (t === T_BOMB) return (w.ttl[i] * 60) | 0;
  if (t === T_SHOT) {
    // слот стрелка (+1), 0 — стрелял ИИ. Клиенту это нужно, чтобы узнать
    // свой снаряд и не рисовать его дважды поверх локального предсказания.
    const o = w.owner[i];
    return o > 0 ? w.ctrl[o - 1] : 0;
  }
  return 0;
}

// ─── сессия ──────────────────────────────────────────────────────────────────

export class Session {
  constructor(id) {
    this.id = id;
    this.w = createWorld();
    this.f = createFloor();
    this.tiles = new Uint8Array(ROOM_TILES);
    this.slots = new Array(MAX_PLAYERS);
    for (let i = 0; i < MAX_PLAYERS; i++) this.slots[i] = new Slot(i);

    this.base = createNetView();
    this.kfBase = createNetView();
    this.buf = new Uint8Array(MAX_PACKET);
    this.dv = new DataView(this.buf.buffer);
    this.kfBuf = new Uint8Array(MAX_PACKET);
    this.kfDv = new DataView(this.kfBuf.buffer);

    this.evKind = new Uint8Array(MAX_EVENTS);
    this.evX = new Float32Array(MAX_EVENTS);
    this.evY = new Float32Array(MAX_EVENTS);
    this.evP = new Uint8Array(MAX_EVENTS);
    this.evN = 0;

    this.spawnBuf = new Float32Array(48);
    this.tmp = new Float32Array(2);
    this.isaacEnt = new Int16Array(MAX_ISAACS);
    // очередь и разметка для BFS-навигации ботов по этажу
    this.bfsQ = new Int16Array(MAX_ROOMS);
    this.bfsFirst = new Int8Array(MAX_ROOMS);
    this.bfsSeen = new Uint8Array(MAX_ROOMS);

    this.rndState = 1;
    this.running = false;
    this.tick = 0;
    this.room = 0;
    this.floorNum = 1;
    this.budget = 0;
    this.endTimer = 0;
    this.winner = -1;
    this.scoreIsaac = 0;
    this.scoreMonster = 0;
    this.roomChanged = false;
    this.rosterDirty = true;
    this.lastActivity = Date.now();
    this.playerCount = 0;
  }

  rnd() {
    let a = (this.rndState + 0x6d2b79f5) >>> 0;
    this.rndState = a;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ── жизненный цикл ─────────────────────────────────────────────────────────

  start(seed) {
    this.rndState = seed >>> 0 || 1;
    this.running = true;
    this.tick = 0;
    this.floorNum = 1;
    this.winner = -1;
    this.endTimer = 0;
    resetWorld(this.w);
    genFloor(this.f, seed);
    clearNetView(this.base);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      p.resetStats();
      p.entity = -1;
      p.needFull = true;
    }
    // всегда два Айзека: свободные слоты занимает ИИ
    for (let i = 0; i < MAX_ISAACS; i++) {
      const p = this.slots[i];
      p.side = SIDE_ISAAC;
      if (!p.used) { p.used = true; p.bot = true; p.ws = null; p.adj = (i * 7) & 31; p.noun = (i * 13 + 5) & 31; }
    }
    this.enterRoom(this.f.start, 255);
    this.rosterDirty = true;
  }

  /**
   * Мгновенный рестарт: новый seed и смена сторон. Бывшие монстры получают
   * приоритет на слоты Айзеков (2 из 3), бывшие Айзеки уходят в монстры.
   */
  restart() {
    const humans = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && !p.bot && p.ws) {
        humans.push({ ws: p.ws, ip: p.ip, uuid: p.uuid.slice(0), adj: p.adj, noun: p.noun, side: p.side, ping: p.ping });
      }
    }
    // сначала бывшие монстры → они станут Айзеками
    humans.sort((a, b) => b.side - a.side);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      p.used = false; p.bot = false; p.ws = null; p.entity = -1;
    }
    for (let k = 0; k < humans.length && k < MAX_PLAYERS; k++) {
      const h = humans[k];
      const p = this.slots[k];
      p.used = true; p.bot = false;
      p.ws = h.ws; p.ip = h.ip; p.adj = h.adj; p.noun = h.noun;
      p.uuid.set(h.uuid);
      p.ping = h.ping;
      p.side = k < MAX_ISAACS ? SIDE_ISAAC : SIDE_MONSTER;
      p.needFull = true; p.seq = 0; p.ack = 0;
      p.b0 = 0; p.b1 = 0; p.prevB1 = 0; p.aim = 0;
      if (p.ws) p.ws.slot = k;
    }
    this.playerCount = humans.length;
    const seed = (Date.now() ^ (this.id * 2654435761) ^ ((this.rnd() * 0xffffffff) | 0)) >>> 0;
    this.start(seed);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && p.ws) { this.sendWelcome(p); this.sendRoom(p); }
    }
  }

  // ── работа с комнатой ──────────────────────────────────────────────────────

  enterRoom(idx, fromDir) {
    const w = this.w, f = this.f;
    this.room = idx;
    setRoomVisited(f, idx, 1);
    for (let i = 0; i < w.high; i++) if (w.type[i] !== T_NONE) freeEntity(w, i);
    genRoomTiles(f, idx, this.tiles);

    // враги комнаты
    const kind = f.kind[idx];
    if (!roomCleared(f, idx)) {
      const n = genRoomSpawns(f, idx, this.spawnBuf, this.floorNum);
      for (let k = 0; k < n; k++) {
        const arch = this.spawnBuf[k * 3] | 0;
        nearestFree(this.tiles, this.spawnBuf[k * 3 + 1], this.spawnBuf[k * 3 + 2], MOB_R[arch], this.tmp);
        this.spawnMob(arch, this.tmp[0], this.tmp[1], 0);
      }
    }
    this.budget = roomBudget(f, idx, this.floorNum);

    // лут комнат
    if (kind === R_TREASURE && !(roomFlags(f, idx) & RF_ITEM_TAKEN)) {
      this.spawnPedestal(WORLD_W / 2, WORLD_H / 2, this.pickItem(idx * 31 + 7), 0);
    } else if (kind === R_SHOP) {
      const s0 = hash2(f.rseed[idx], 1);
      this.spawnPedestal(TILE * 4.5, WORLD_H / 2 - 12, this.pickItem(s0), 1);
      this.spawnPickup(TILE * 7.5, WORLD_H / 2 - 12, P_BOMB, 5);
      this.spawnPickup(TILE * 10.5, WORLD_H / 2 - 12, P_HEART, 6);
    } else if (kind === R_SECRET && !(roomFlags(f, idx) & RF_LOOTED)) {
      this.spawnPickup(WORLD_W / 2 - 24, WORLD_H / 2, P_COIN, 0);
      this.spawnPickup(WORLD_W / 2, WORLD_H / 2, P_BOMB, 0);
      this.spawnPickup(WORLD_W / 2 + 24, WORLD_H / 2, P_KEY, 0);
      setRoomFlag(f, idx, RF_LOOTED);
    }

    // расстановка Айзеков
    let ex = WORLD_W / 2, ey = WORLD_H / 2;
    if (fromDir < 4) {
      const od = OPP4[fromDir];
      ex = tileCX(DOOR_TX[od]); ey = tileCY(DOOR_TY[od]);
      ex += DX4[od] * -TILE * 1.1; ey += DY4[od] * -TILE * 1.1;
    }
    let placed = 0;
    for (let i = 0; i < MAX_ISAACS; i++) {
      const p = this.slots[i];
      if (!p.used) { p.entity = -1; continue; }
      nearestFree(this.tiles, ex + (placed === 0 ? -10 : 10), ey, ISAAC_R, this.tmp);
      p.entity = this.spawnIsaac(p, this.tmp[0], this.tmp[1]);
      placed++;
    }
    // переселение монстров
    for (let i = MAX_ISAACS; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      p.entity = -1;
      if (p.used) { p.spirit = 0.001; }
    }
    this.roomChanged = true;
    this.checkClear(1);
  }

  pickItem(seed) {
    const r = mulberry32(hash2(this.f.seed, seed))();
    return (r * IT_COUNT) | 0;
  }

  // ── спавнеры ───────────────────────────────────────────────────────────────

  spawnIsaac(p, x, y) {
    const w = this.w;
    const i = allocEntity(w, T_ISAAC);
    if (i < 0) return -1;
    w.x[i] = x; w.y[i] = y;
    w.r[i] = ISAAC_R;
    w.hp[i] = p.hearts;
    w.maxhp[i] = p.maxHearts;
    w.ctrl[i] = p.index + 1;
    w.sub[i] = p.index;
    w.state[i] = ST_ALIVE;
    w.iframe[i] = 1.0;
    if (p.hearts <= 0) { w.state[i] |= ST_DOWN; p.downTimer = ISAAC_DOWN_TIME; }
    return i;
  }

  spawnMob(arch, x, y, forPlayer) {
    const w = this.w;
    const i = allocEntity(w, T_MOB);
    if (i < 0) return -1;
    nearestFree(this.tiles, x, y, MOB_R[arch], this.tmp);
    initMob(w, i, arch, this.tmp[0], this.tmp[1], this.floorNum);
    // запас hp игроку добавляет attach() — здесь не трогаем, иначе множитель
    // применится дважды
    return i;
  }

  spawnShot(x, y, vx, vy, dmg, ttl, owner) {
    const w = this.w;
    const i = allocEntity(w, T_SHOT);
    if (i < 0) return -1;
    w.x[i] = x; w.y[i] = y; w.vx[i] = vx; w.vy[i] = vy;
    w.r[i] = 3;
    w.dmg[i] = dmg;
    w.ttl[i] = ttl;
    w.owner[i] = owner + 1;
    w.state[i] = ST_ALIVE;
    return i;
  }

  spawnTear(p, e, dirx, diry) {
    const w = this.w;
    const i = allocEntity(w, T_TEAR);
    if (i < 0) return -1;
    w.x[i] = w.x[e]; w.y[i] = w.y[e];
    const sp = p.shotspeed;
    w.vx[i] = dirx * sp + w.vx[e] * 0.32;
    w.vy[i] = diry * sp + w.vy[e] * 0.32;
    w.r[i] = p.items[IT_BIGTEAR] ? 5 : 3;
    w.dmg[i] = p.damage;
    w.ttl[i] = p.range;
    w.flags[i] = p.tearFlags;
    w.owner[i] = e + 1;
    w.sub[i] = p.index;
    w.state[i] = ST_ALIVE;
    return i;
  }

  spawnPickup(x, y, kind, price) {
    const w = this.w;
    const i = allocEntity(w, T_PICKUP);
    if (i < 0) return -1;
    nearestFree(this.tiles, x, y, 5, this.tmp);
    w.x[i] = this.tmp[0]; w.y[i] = this.tmp[1];
    w.r[i] = 5;
    w.sub[i] = kind;
    w.sub2[i] = 0;
    w.dmg[i] = price;
    w.state[i] = ST_ALIVE;
    return i;
  }

  spawnPedestal(x, y, itemId, price) {
    const w = this.w;
    const i = allocEntity(w, T_PICKUP);
    if (i < 0) return -1;
    nearestFree(this.tiles, x, y, 6, this.tmp);
    w.x[i] = this.tmp[0]; w.y[i] = this.tmp[1];
    w.r[i] = 6;
    w.sub[i] = P_PEDESTAL;
    w.sub2[i] = itemId;
    w.dmg[i] = price ? ITEM_PRICE[itemId] : 0;
    w.state[i] = ST_ALIVE;
    return i;
  }

  spawnBomb(x, y, owner) {
    const w = this.w;
    const i = allocEntity(w, T_BOMB);
    if (i < 0) return -1;
    w.x[i] = x; w.y[i] = y;
    w.r[i] = 5;
    w.ttl[i] = BOMB_FUSE;
    w.owner[i] = owner + 1;
    w.state[i] = ST_ALIVE;
    return i;
  }

  pushEvent(kind, x, y, param) {
    if (this.evN >= MAX_EVENTS) return;
    const n = this.evN++;
    this.evKind[n] = kind;
    this.evX[n] = x;
    this.evY[n] = y;
    this.evP[n] = param & 255;
  }

  placeFree(i) {
    nearestFree(this.tiles, this.w.x[i], this.w.y[i], this.w.r[i], this.tmp);
    this.w.x[i] = this.tmp[0];
    this.w.y[i] = this.tmp[1];
  }

  nearestIsaac(x, y) {
    const w = this.w;
    let best = -1, bestD = 1e9;
    for (let i = 0; i < w.high; i++) {
      if (w.type[i] !== T_ISAAC) continue;
      if (w.state[i] & ST_DOWN) continue;
      const dx = w.x[i] - x, dy = w.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ── урон ───────────────────────────────────────────────────────────────────

  /** amount в половинках сердца, дробное (множитель ×0.7 у игроков-монстров). */
  hurtIsaac(e, amount) {
    const w = this.w;
    if (w.type[e] !== T_ISAAC) return;
    if (w.state[e] & ST_DOWN) return;
    if (w.iframe[e] > 0) return;
    const p = this.slots[w.ctrl[e] - 1];
    if (!p || !p.used) return;
    p.dmgAcc += amount;
    let whole = Math.floor(p.dmgAcc);
    if (whole < 1) whole = 1; // любой удар снимает минимум полсердца
    p.dmgAcc -= whole;
    if (p.dmgAcc < 0) p.dmgAcc = 0;
    p.hearts -= whole;
    if (p.hearts < 0) p.hearts = 0;
    w.hp[e] = p.hearts;
    w.iframe[e] = ISAAC_IFRAMES;
    w.state[e] |= ST_HURT;
    p.statsDirty = true;
    this.pushEvent(EV_HURT, w.x[e], w.y[e], p.index);
    if (p.hearts <= 0) {
      w.state[e] |= ST_DOWN;
      w.vx[e] = 0; w.vy[e] = 0;
      p.downTimer = ISAAC_DOWN_TIME;
      this.pushEvent(EV_MOB_DIE, w.x[e], w.y[e], 200);
      this.checkRoundEnd();
    }
  }

  hurtMob(i, amount, byPlayerSlot, dirx, diry) {
    const w = this.w;
    if (w.type[i] !== T_MOB) return 0;
    if (w.state[i] & ST_AIR) return 0;
    // Щитоносец блокирует фронтальный урон
    if (w.state[i] & ST_SHIELD) {
      const fdir = getFacing(w, i);
      const fx = fdir === 2 ? -1 : fdir === 3 ? 1 : 0;
      const fy = fdir === 1 ? -1 : fdir === 0 ? 1 : 0;
      if (dirx * fx + diry * fy < -0.15) {
        this.pushEvent(EV_DENY, w.x[i], w.y[i], 0);
        return 0;
      }
    }
    const dead = damage(w, i, amount);
    // param события — величина урона (255 зарезервирован под удар о стену)
    let shown = Math.round(amount);
    if (shown < 1) shown = 1; else if (shown > 200) shown = 200;
    this.pushEvent(EV_HIT, w.x[i], w.y[i], shown);
    if (dead) this.killMob(i);
    return dead;
  }

  killMob(i) {
    const w = this.w;
    const arch = w.sub[i];
    const x = w.x[i], y = w.y[i];
    const ctrl = w.ctrl[i];
    if (arch === M_BOSS) {
      this.pushEvent(EV_BOSS_DIE, x, y, 0);
      freeEntity(w, i);
      if (ctrl) this.onPossessedDeath(this.slots[ctrl - 1]);
      this.endRound(SIDE_ISAAC);
      return;
    }
    this.pushEvent(EV_MOB_DIE, x, y, arch);
    if (arch === M_SPLITTER) {
      freeEntity(w, i);
      const a = this.spawnMob(M_SPAWN, x - 10, y, 0);
      const b = this.spawnMob(M_SPAWN, x + 10, y, 0);
      if (ctrl) {
        const p = this.slots[ctrl - 1];
        if (p && p.used && a >= 0) { this.attach(p, a); return; }
        if (p) this.onPossessedDeath(p);
      }
      return;
    }
    freeEntity(w, i);
    if (this.rnd() < 0.28) this.dropLoot(x, y);
    if (ctrl) this.onPossessedDeath(this.slots[ctrl - 1]);
  }

  dropLoot(x, y) {
    const r = this.rnd();
    let kind = P_COIN;
    if (r < 0.34) kind = P_COIN;
    else if (r < 0.56) kind = P_HALFHEART;
    else if (r < 0.7) kind = P_BOMB;
    else if (r < 0.8) kind = P_KEY;
    else return;
    this.spawnPickup(x, y, kind, 0);
  }

  landingAoe(i, radius, dmg) {
    const w = this.w;
    const x = w.x[i], y = w.y[i];
    this.pushEvent(EV_EXPLODE, x, y, 1);
    const r2 = radius * radius;
    for (let j = 0; j < w.high; j++) {
      if (w.type[j] !== T_ISAAC) continue;
      const dx = w.x[j] - x, dy = w.y[j] - y;
      if (dx * dx + dy * dy > r2) continue;
      this.hurtIsaac(j, dmg);
    }
  }

  explode(x, y, ownerEnt) {
    const w = this.w;
    this.pushEvent(EV_EXPLODE, x, y, 0);
    const r2 = BOMB_RADIUS * BOMB_RADIUS;
    for (let j = 0; j < w.high; j++) {
      const t = w.type[j];
      if (t === T_NONE) continue;
      const dx = w.x[j] - x, dy = w.y[j] - y;
      if (dx * dx + dy * dy > r2) continue;
      if (t === T_MOB) {
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        this.hurtMob(j, BOMB_DAMAGE, 0, -dx / d, -dy / d);
      } else if (t === T_ISAAC) {
        this.hurtIsaac(j, 1);
      }
    }
    // разрушение камней и открытие секреток
    const tx0 = ((x - BOMB_RADIUS) / TILE) | 0, tx1 = ((x + BOMB_RADIUS) / TILE) | 0;
    const ty0 = ((y - BOMB_RADIUS) / TILE) | 0, ty1 = ((y + BOMB_RADIUS) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || ty < 0 || tx >= ROOM_W || ty >= ROOM_H) continue;
        const ti = ty * ROOM_W + tx;
        const cx = tileCX(tx), cy = tileCY(ty);
        const dx = cx - x, dy = cy - y;
        if (dx * dx + dy * dy > r2 * 1.3) continue;
        const t = this.tiles[ti];
        if (t === TL_ROCK || t === TL_SPIKE) {
          this.tiles[ti] = TL_RUBBLE;
          markRockBroken(this.f, this.room, ti);
          this.pushEvent(EV_ROCK, cx, cy, 0);
        } else if (t === TL_SECRET) {
          this.tiles[ti] = TL_DOOR_OPEN;
          setRoomFlag(this.f, this.room, RF_SECRET_OPEN);
          const d = this.doorDirOfTile(tx, ty);
          if (d >= 0) {
            const nb = neighborRoom(this.f, this.room, d);
            if (nb >= 0) setRoomFlag(this.f, nb, RF_SECRET_OPEN);
          }
          this.pushEvent(EV_SECRET, cx, cy, 0);
          this.roomChanged = true;
        }
      }
    }
  }

  /**
   * Куда идти боту: ближайшая незачищенная комната, иначе босс.
   * Возвращает направление двери из текущей комнаты или -1.
   */
  botNavDir() {
    const f = this.f;
    const q = this.bfsQ, first = this.bfsFirst, seen = this.bfsSeen;
    seen.fill(0);
    let head = 0, tail = 0;
    q[tail++] = this.room;
    seen[this.room] = 1;
    first[this.room] = -1;
    let fallback = -1;
    while (head < tail) {
      const cur = q[head++];
      if (cur !== this.room) {
        const kind = f.kind[cur];
        // цель первого выбора: есть чем заняться
        if (!roomCleared(f, cur) && kind !== R_BOSS) return first[cur];
        if (kind === R_TREASURE && !(roomFlags(f, cur) & RF_ITEM_TAKEN)) return first[cur];
        if (kind === R_BOSS && fallback < 0) fallback = first[cur];
      }
      for (let d = 0; d < 4; d++) {
        if (!(f.doors[cur] & (1 << d))) continue;
        if (f.secretDoors[cur] & (1 << d)) continue; // секретки боты не ищут
        const nb = neighborRoom(f, cur, d);
        if (nb < 0 || seen[nb]) continue;
        seen[nb] = 1;
        first[nb] = cur === this.room ? d : first[cur];
        q[tail++] = nb;
      }
    }
    return fallback;
  }

  doorDirOfTile(tx, ty) {
    for (let d = 0; d < 4; d++) if (DOOR_TX[d] === tx && DOOR_TY[d] === ty) return d;
    return -1;
  }

  // ── вселение ───────────────────────────────────────────────────────────────

  attach(p, e) {
    const w = this.w;
    p.entity = e;
    p.spirit = 0;
    w.ctrl[e] = p.index + 1;
    // идемпотентно: считаем от базовой таблицы, а не от текущего maxhp
    if (w.sub[e] !== M_BOSS) {
      const base = MOB_HP[w.sub[e]] + (this.floorNum - 1) * 2;
      let hp = (base * PLAYER_MOB_HP_MUL) | 0;
      if (hp > 255) hp = 255;
      if (hp < 1) hp = 1;
      const ratio = w.maxhp[e] > 0 ? w.hp[e] / w.maxhp[e] : 1;
      w.maxhp[e] = hp;
      let cur = Math.round(hp * ratio);
      if (cur < 1) cur = 1; else if (cur > hp) cur = hp;
      w.hp[e] = cur;
    }
    w.cd[e] = 1.0;
    this.pushEvent(EV_POSSESS, w.x[e], w.y[e], p.index);
    p.statsDirty = true;
  }

  /** Ближайший свободный моб к точке. */
  freeMobNear(x, y) {
    const w = this.w;
    let best = -1, bestD = 1e9;
    for (let i = 0; i < w.high; i++) {
      if (w.type[i] !== T_MOB || w.ctrl[i] !== 0) continue;
      if (!(w.state[i] & ST_ALIVE)) continue;
      const dx = w.x[i] - x, dy = w.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  countPlayerMobs() {
    let n = 0;
    for (let i = MAX_ISAACS; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && p.entity >= 0) n++;
    }
    return n;
  }

  onPossessedDeath(p) {
    if (!p || !p.used) return;
    const w = this.w;
    if (p.entity >= 0) {
      p.spiritX = w.x[p.entity];
      p.spiritY = w.y[p.entity];
    }
    p.entity = -1;
    p.respawn = 0.12; // короткая пауза на эффект смерти, переселение < 250 мс
    p.spirit = 0;
    p.statsDirty = true;
  }

  /** Пытается переселить монстра: свободный моб → спавн по бюджету → дух. */
  tryRepossess(p, dt) {
    if (p.entity >= 0) return;
    if (p.respawn > 0) { p.respawn -= dt; return; }
    if (p.spirit > 0) { p.spirit -= dt; if (p.spirit < 0) p.spirit = 0; }
    if (this.countPlayerMobs() >= MAX_MONSTERS) return;

    const near = this.freeMobNear(p.spiritX, p.spiritY);
    if (near >= 0) { this.attach(p, near); return; }

    const kind = this.f.kind[this.room];
    if ((kind === R_NORMAL || kind === R_BOSS) && !roomCleared(this.f, this.room)) {
      const arch = this.pickSpawnArch();
      if (MOB_COST[arch] <= this.budget) {
        this.budget -= MOB_COST[arch];
        const e = this.spawnMob(arch, p.spiritX, p.spiritY, 1);
        if (e >= 0) { this.attach(p, e); return; }
      }
    }
    // бюджет исчерпан — режим духа до следующей возможности
    if (p.spirit <= 0) { p.spirit = SPIRIT_TIME; p.statsDirty = true; }
  }

  pickSpawnArch() {
    const r = this.rnd();
    if (r < 0.3) return M_CRAWLER;
    if (r < 0.52) return M_SPITTER;
    if (r < 0.68) return M_HOPPER;
    if (r < 0.84) return M_SHIELDER;
    return M_SPLITTER;
  }

  // ── зачистка комнаты и двери ───────────────────────────────────────────────

  checkClear(silent) {
    const w = this.w, f = this.f;
    if (roomCleared(f, this.room)) return;
    for (let i = 0; i < w.high; i++) if (w.type[i] === T_MOB) return;
    setRoomCleared(f, this.room, 1);
    this.budget = 0;
    // открыть двери
    for (let d = 0; d < 4; d++) {
      if (!(f.doors[this.room] & (1 << d))) continue;
      const ti = DOOR_TY[d] * ROOM_W + DOOR_TX[d];
      if (this.tiles[ti] === TL_DOOR) this.tiles[ti] = TL_DOOR_OPEN;
    }
    if (f.kind[this.room] === R_NORMAL && !(roomFlags(f, this.room) & RF_LOOTED)) {
      setRoomFlag(f, this.room, RF_LOOTED);
      if (this.rnd() < 0.55) this.dropLoot(WORLD_W / 2, WORLD_H / 2);
    }
    this.roomChanged = true;
    if (!silent) this.pushEvent(EV_DOOR, WORLD_W / 2, WORLD_H / 2, 1);
  }

  checkDoors() {
    const w = this.w, f = this.f;
    if (!roomCleared(f, this.room)) return;
    for (let i = 0; i < w.high; i++) {
      if (w.type[i] !== T_ISAAC) continue;
      if (w.state[i] & ST_DOWN) continue;
      const x = w.x[i], y = w.y[i];
      for (let d = 0; d < 4; d++) {
        if (!(f.doors[this.room] & (1 << d))) continue;
        const ti = DOOR_TY[d] * ROOM_W + DOOR_TX[d];
        if (this.tiles[ti] !== TL_DOOR_OPEN) continue;
        const cx = tileCX(DOOR_TX[d]), cy = tileCY(DOOR_TY[d]);
        if (Math.abs(x - cx) > 13 || Math.abs(y - cy) > 13) continue;
        const nb = neighborRoom(f, this.room, d);
        if (nb < 0) continue;
        this.pushEvent(EV_DOOR, cx, cy, 0);
        this.enterRoom(nb, OPP4[d]);
        return;
      }
    }
  }

  // ── конец раунда ───────────────────────────────────────────────────────────

  checkRoundEnd() {
    if (this.winner >= 0) return;
    const w = this.w;
    let alive = 0, any = 0;
    for (let i = 0; i < MAX_ISAACS; i++) {
      const p = this.slots[i];
      if (!p.used) continue;
      any++;
      if (p.hearts > 0) alive++;
    }
    if (any > 0 && alive === 0) this.endRound(SIDE_MONSTER);
  }

  endRound(winner) {
    if (this.winner >= 0) return;
    this.winner = winner;
    this.endTimer = ROUND_RESTART_MS;
    if (winner === SIDE_ISAAC) this.scoreIsaac++; else this.scoreMonster++;
    this.sendRound();
  }

  // ── главный тик ────────────────────────────────────────────────────────────

  step(dtMs) {
    if (!this.running) return;
    const dt = DT;
    this.tick++;
    this.evN = 0;
    const w = this.w;

    if (this.winner >= 0) {
      this.endTimer -= dtMs;
      if (this.endTimer <= 0) { this.restart(); return; }
    }

    // 1. игроки — ack выставляется в момент применения инпута, а не приёма
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const p = this.slots[s];
      if (!p.used) continue;
      p.ack = p.seq;
      if (p.side === SIDE_ISAAC) this.stepIsaacSlot(p, dt);
      else this.stepMonsterSlot(p, dt);
    }

    // 2. ИИ мобов
    for (let i = 0; i < w.high; i++) {
      if (w.type[i] !== T_MOB || w.ctrl[i] !== 0) continue;
      stepMobAI(this, i, dt);
    }

    // 3. снаряды, бомбы, пикапы
    this.stepProjectiles(dt);

    // 4. столкновения
    buildGrid(w);
    this.collide(dt);

    // 5. комната
    this.checkClear(0);
    if (this.winner < 0) this.checkDoors();

    // 6. переселение монстров
    for (let s = MAX_ISAACS; s < MAX_PLAYERS; s++) {
      const p = this.slots[s];
      if (p.used && p.entity < 0 && this.winner < 0) this.tryRepossess(p, dt);
    }

    // 7. рассылка
    this.broadcast();
  }

  stepIsaacSlot(p, dt) {
    const w = this.w;
    let e = p.entity;
    if (e < 0 || w.type[e] !== T_ISAAC) {
      nearestFree(this.tiles, WORLD_W / 2, WORLD_H / 2, ISAAC_R, this.tmp);
      p.entity = e = this.spawnIsaac(p, this.tmp[0], this.tmp[1]);
      if (e < 0) return;
    }
    p.idle += dt;
    if (p.bot || p.idle > IDLE_AI) botIsaac(this, p, dt);

    if (w.iframe[e] > 0) {
      w.iframe[e] -= dt;
      if (w.iframe[e] <= 0) w.state[e] &= ~ST_HURT;
    }

    if (w.state[e] & ST_DOWN) {
      p.downTimer -= dt;
      w.vx[e] *= 0.85; w.vy[e] *= 0.85;
      moveAndCollide(w, e, dt, this.tiles, 0);
      // поднимаем, если напарник жив или вышло время
      let mateAlive = 0;
      for (let i = 0; i < MAX_ISAACS; i++) {
        const q = this.slots[i];
        if (q !== p && q.used && q.hearts > 0) mateAlive = 1;
      }
      if (p.downTimer <= 0 && mateAlive) {
        p.hearts = 1; p.dmgAcc = 0;
        w.hp[e] = 1;
        w.state[e] &= ~ST_DOWN;
        w.iframe[e] = 1.5;
        p.statsDirty = true;
        this.pushEvent(EV_REVIVE, w.x[e], w.y[e], p.index);
      }
      return;
    }

    stepMotion(w, e, p.b0, p.speed, dt, this.tiles, 0);

    // шипы под ногами
    const tx = (w.x[e] / TILE) | 0, ty = (w.y[e] / TILE) | 0;
    if (tx >= 0 && ty >= 0 && tx < ROOM_W && ty < ROOM_H &&
      this.tiles[ty * ROOM_W + tx] === TL_SPIKE) this.hurtIsaac(e, 1);

    // стрельба
    p.fireCd -= dt;
    let sx = 0, sy = 0;
    if (p.b0 & IN_SLEFT) sx -= 1;
    if (p.b0 & IN_SRIGHT) sx += 1;
    if (p.b0 & IN_SUP) sy -= 1;
    if (p.b0 & IN_SDOWN) sy += 1;
    if (sx === 0 && sy === 0 && (p.b1 & IN2_FIRE)) {
      const a = (p.aim / 256) * Math.PI * 2;
      sx = Math.cos(a); sy = Math.sin(a);
    }
    if ((sx !== 0 || sy !== 0) && p.fireCd <= 0) {
      const len = Math.sqrt(sx * sx + sy * sy) || 1;
      sx /= len; sy /= len;
      const base = Math.atan2(sy, sx);
      if (p.tearFlags & TF_TRIPLE) {
        for (let k = -1; k <= 1; k++) {
          const a = base + k * 0.17;
          this.spawnTear(p, e, Math.cos(a), Math.sin(a));
        }
      } else {
        this.spawnTear(p, e, sx, sy);
      }
      p.fireCd = 1 / p.firerate;
      if (Math.abs(sx) > Math.abs(sy)) setFacing(w, e, sx < 0 ? 2 : 3);
      else setFacing(w, e, sy < 0 ? 1 : 0);
      this.pushEvent(EV_SHOOT, w.x[e], w.y[e], 10 + p.index);
    }

    // бомба (по фронту нажатия)
    if ((p.b1 & IN2_BOMB) && !(p.prevB1 & IN2_BOMB) && p.bombs > 0) {
      p.bombs--;
      p.statsDirty = true;
      this.spawnBomb(w.x[e], w.y[e], e);
    }
    p.prevB1 = p.b1;
  }

  stepMonsterSlot(p, dt) {
    const w = this.w;
    const e = p.entity;
    if (e < 0 || w.type[e] !== T_MOB) {
      if (e >= 0) { p.entity = -1; }
      if (p.spirit > 0) {
        // свободная камера духа
        let dx = 0, dy = 0;
        if (p.b0 & IN_LEFT) dx -= 1;
        if (p.b0 & IN_RIGHT) dx += 1;
        if (p.b0 & IN_UP) dy -= 1;
        if (p.b0 & IN_DOWN) dy += 1;
        p.spiritX += dx * 120 * dt;
        p.spiritY += dy * 120 * dt;
        if (p.spiritX < 8) p.spiritX = 8; else if (p.spiritX > WORLD_W - 8) p.spiritX = WORLD_W - 8;
        if (p.spiritY < 8) p.spiritY = 8; else if (p.spiritY > WORLD_H - 8) p.spiritY = WORLD_H - 8;
        p.spirit -= dt;
      }
      p.prevB1 = p.b1;
      return;
    }
    if (w.ctrl[e] !== p.index + 1) w.ctrl[e] = p.index + 1;

    // игрок отвернулся — телом временно управляет серверный ИИ
    p.idle += dt;
    if (p.idle > IDLE_AI) { stepMobAI(this, e, dt); p.prevB1 = p.b1; return; }

    const arch = w.sub[e];
    stepPlayerMobTimers(this, e, dt);

    if (w.state[e] & ST_AIR) { stepAirborne(this, e, dt); p.prevB1 = p.b1; return; }
    if (w.state[e] & ST_CHARGE) { moveAndCollide(w, e, dt, this.tiles, 0); p.prevB1 = p.b1; return; }

    if (w.dash[e] > 0) {
      w.dash[e] -= dt;
      const hit = moveAndCollide(w, e, dt, this.tiles, 0);
      if (hit) { w.dash[e] = 0; w.vx[e] *= -0.2; w.vy[e] *= -0.2; }
    } else {
      let sp = MOB_SPEED[arch] * 1.12; // небольшой бонус за ручное управление
      if (w.state[e] & ST_SHIELD) sp *= 0.55;
      stepMotion(w, e, p.b0, sp, dt, this.tiles, 0);
    }

    const a = (p.aim / 256) * Math.PI * 2;
    const ax = Math.cos(a), ay = Math.sin(a);
    if ((p.b1 & IN2_ABILITY) && !(p.prevB1 & IN2_ABILITY)) useAbility(this, e, ax, ay, 1);
    if ((p.b1 & IN2_DASH) && !(p.prevB1 & IN2_DASH)) {
      let dx = 0, dy = 0;
      if (p.b0 & IN_LEFT) dx -= 1;
      if (p.b0 & IN_RIGHT) dx += 1;
      if (p.b0 & IN_UP) dy -= 1;
      if (p.b0 & IN_DOWN) dy += 1;
      if (dx === 0 && dy === 0) { dx = ax; dy = ay; }
      useDash(this, e, dx, dy);
    }
    // Плевун стреляет базовой атакой по кнопке огня
    if ((p.b1 & IN2_FIRE) && w.cd2[e] <= 0 && (arch === M_SPITTER || arch === M_BOSS)) {
      const dmg = 1 * PLAYER_MOB_DMG_MUL;
      this.spawnShot(w.x[e], w.y[e], ax * 88, ay * 88, dmg, 2.0, e);
      w.cd2[e] = arch === M_BOSS ? 0.8 : 1.1;
      this.pushEvent(EV_SHOOT, w.x[e], w.y[e], 0);
    }
    p.prevB1 = p.b1;
  }

  stepProjectiles(dt) {
    const w = this.w;
    for (let i = 0; i < w.high; i++) {
      const t = w.type[i];
      if (t === T_TEAR) {
        if (stepProjectile(w, i, dt, this.tiles)) { this.pushEvent(EV_HIT, w.x[i], w.y[i], 255); freeEntity(w, i); }
      } else if (t === T_SHOT) {
        if (w.sub[i] === 1 && w.cd2[i] !== 0) {
          // дуговой снаряд Плевуна: поворот вектора скорости
          const r = w.cd2[i] * dt;
          const c = Math.cos(r), s = Math.sin(r);
          const vx = w.vx[i], vy = w.vy[i];
          w.vx[i] = vx * c - vy * s;
          w.vy[i] = vx * s + vy * c;
        }
        if (stepProjectile(w, i, dt, this.tiles)) freeEntity(w, i);
      } else if (t === T_BOMB) {
        w.ttl[i] -= dt;
        w.vx[i] *= 0.9; w.vy[i] *= 0.9;
        moveAndCollide(w, i, dt, this.tiles, 0);
        if (w.ttl[i] <= 0) { const x = w.x[i], y = w.y[i]; freeEntity(w, i); this.explode(x, y, 0); }
      } else if (t === T_PICKUP) {
        w.vx[i] *= 0.86; w.vy[i] *= 0.86;
        if (w.vx[i] !== 0 || w.vy[i] !== 0) moveAndCollide(w, i, dt, this.tiles, 1);
      }
    }
  }

  /**
   * Столкновения. Слёзы ищут мобов через uniform grid 16×16, всё, что бьётся
   * об Айзеков, идёт по короткому списку isaacEnt (их максимум два).
   */
  collide(dt) {
    const w = this.w;

    // актуальный список сущностей Айзеков
    let ni = 0;
    for (let s = 0; s < MAX_ISAACS; s++) {
      const p = this.slots[s];
      const e = p.used ? p.entity : -1;
      this.isaacEnt[ni++] = (e >= 0 && w.type[e] === T_ISAAC && !(w.state[e] & ST_DOWN)) ? e : -1;
    }
    while (ni < MAX_ISAACS) this.isaacEnt[ni++] = -1;

    for (let i = 0; i < w.high; i++) {
      const t = w.type[i];
      if (t === T_NONE) continue;

      // ── слеза → мобы (broadphase по сетке)
      if (t === T_TEAR) {
        if (w.cd[i] > 0) { w.cd[i] -= dt; continue; }
        const pad = w.r[i] + 14;
        const cx0 = cellMin(w.x[i] - pad, GRID_CELL, GRID_W);
        const cx1 = cellMin(w.x[i] + pad, GRID_CELL, GRID_W);
        const cy0 = cellMin(w.y[i] - pad, GRID_CELL, GRID_H);
        const cy1 = cellMin(w.y[i] + pad, GRID_CELL, GRID_H);
        let gone = 0;
        for (let cy = cy0; cy <= cy1 && !gone; cy++) {
          for (let cx = cx0; cx <= cx1 && !gone; cx++) {
            const c = cy * GRID_W + cx;
            const from = w.grid[c], to = w.grid[c + 1];
            for (let k = from; k < to; k++) {
              const j = w.gridItems[k];
              if (w.type[j] !== T_MOB) continue;
              const rr = w.r[i] + w.r[j];
              const dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
              const dd = dx * dx + dy * dy;
              if (dd > rr * rr) continue;
              const d = Math.sqrt(dd) || 1;
              this.hurtMob(j, w.dmg[i], w.sub[i], dx / d, dy / d);
              if (w.flags[i] & TF_POISON) this.hurtMob(j, 1, w.sub[i], dx / d, dy / d);
              if (w.flags[i] & TF_PIERCE) {
                w.cd[i] = 0.15; // пирсинг не наносит урон каждый кадр
              } else {
                freeEntity(w, i);
                gone = 1;
              }
              break;
            }
          }
        }
        continue;
      }

      // ── вражеский снаряд → Айзеки
      if (t === T_SHOT) {
        for (let k = 0; k < MAX_ISAACS; k++) {
          const j = this.isaacEnt[k];
          if (j < 0) continue;
          const rr = w.r[i] + w.r[j];
          const dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
          if (dx * dx + dy * dy > rr * rr) continue;
          this.hurtIsaac(j, w.dmg[i]);
          freeEntity(w, i);
          break;
        }
        continue;
      }

      // ── контактный урон мобов
      if (t === T_MOB) {
        if (w.state[i] & ST_AIR) continue;
        const touch = MOB_TOUCH[w.sub[i]];
        const mul = w.ctrl[i] ? PLAYER_MOB_DMG_MUL : 1;
        const chargeBonus = w.dash[i] > 0 ? 1.6 : 1;
        for (let k = 0; k < MAX_ISAACS; k++) {
          const j = this.isaacEnt[k];
          if (j < 0) continue;
          const rr = w.r[i] + w.r[j] - 1;
          const dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
          const dd = dx * dx + dy * dy;
          if (dd > rr * rr) continue;
          // Толчок даём только вместе с уроном. Иначе он копился каждый тик
          // касания и разгонял Айзека до скорости, на которой шаг за кадр
          // перескакивал тайл целиком — игрока буквально выносило сквозь стену.
          const landed = w.iframe[j] <= 0;
          this.hurtIsaac(j, touch * mul * chargeBonus);
          if (!landed) continue;
          const d = Math.sqrt(dd) || 1;
          w.vx[j] += (dx / d) * 90;
          w.vy[j] += (dy / d) * 90;
          const sp = Math.sqrt(w.vx[j] * w.vx[j] + w.vy[j] * w.vy[j]);
          if (sp > KNOCK_CAP) {
            w.vx[j] = (w.vx[j] / sp) * KNOCK_CAP;
            w.vy[j] = (w.vy[j] / sp) * KNOCK_CAP;
          }
        }
        continue;
      }

      // ── подбор предметов
      if (t === T_PICKUP) {
        for (let k = 0; k < MAX_ISAACS; k++) {
          const j = this.isaacEnt[k];
          if (j < 0) continue;
          const rr = w.r[i] + w.r[j];
          const dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
          if (dx * dx + dy * dy > rr * rr) continue;
          if (this.takePickup(i, j)) break;
        }
      }
    }
  }

  takePickup(i, e) {
    const w = this.w;
    const p = this.slots[w.ctrl[e] - 1];
    if (!p || !p.used) return 0;
    const kind = w.sub[i];
    const price = w.dmg[i] | 0;
    if (price > 0 && p.coins < price) {
      if ((this.tick & 15) === 0) this.pushEvent(EV_DENY, w.x[i], w.y[i], 1);
      return 0;
    }
    if (kind === P_PEDESTAL) {
      const item = w.sub2[i];
      this.applyItem(p, item);
      if (this.f.kind[this.room] === R_TREASURE) setRoomFlag(this.f, this.room, RF_ITEM_TAKEN);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 100 + item);
    } else if (kind === P_HEART) {
      if (p.hearts >= p.maxHearts) return 0;
      p.hearts = Math.min(p.maxHearts, p.hearts + 2);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 0);
    } else if (kind === P_HALFHEART) {
      if (p.hearts >= p.maxHearts) return 0;
      p.hearts = Math.min(p.maxHearts, p.hearts + 1);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 0);
    } else if (kind === P_COIN) {
      p.coins = Math.min(99, p.coins + 1);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 1);
    } else if (kind === P_KEY) {
      p.keys = Math.min(99, p.keys + 1);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 2);
    } else if (kind === P_BOMB) {
      p.bombs = Math.min(99, p.bombs + 1);
      this.pushEvent(EV_PICKUP, w.x[i], w.y[i], 3);
    }
    if (price > 0) p.coins -= price;
    w.hp[e] = p.hearts;
    w.maxhp[e] = p.maxHearts;
    p.statsDirty = true;
    freeEntity(w, i);
    return 1;
  }

  applyItem(p, id) {
    p.items[id]++;
    p.itemMask |= 1 << id;
    switch (id) {
      case IT_DAMAGE: p.damage += 1.2; break;
      case IT_FIRERATE: p.firerate += 0.55; break;
      case IT_SPEED: p.speed += 9; break;
      case IT_RANGE: p.range += 0.16; break;
      case IT_SHOTSPEED: p.shotspeed += 26; break;
      case IT_PIERCE: p.tearFlags |= TF_PIERCE; break;
      case IT_HOME: p.tearFlags |= TF_HOME; break;
      case IT_POISON: p.tearFlags |= TF_POISON; break;
      case IT_BOUNCE: p.tearFlags |= TF_BOUNCE; break;
      case IT_TRIPLE: p.tearFlags |= TF_TRIPLE; p.damage -= 0.5; break;
      case IT_HEART:
        p.maxHearts = Math.min(ISAAC_MAX_HEARTS, p.maxHearts + 2);
        p.hearts = Math.min(p.maxHearts, p.hearts + 2); break;
      case IT_BIGTEAR: p.damage += 0.8; p.shotspeed -= 12; break;
      case IT_BOMBS: p.bombs += 5; break;
      case IT_LUCK: p.firerate += 0.2; p.damage += 0.4; break;
    }
    if (p.damage < 1) p.damage = 1;
    if (p.firerate > 9) p.firerate = 9;
    p.statsDirty = true;
  }

  // ── сеть ───────────────────────────────────────────────────────────────────

  addPlayer(ws, uuid, ip) {
    let idx = -1;
    // сначала слот Айзека (боты вытесняются), иначе слот монстра
    for (let i = 0; i < MAX_ISAACS; i++) {
      const p = this.slots[i];
      if (!p.used || p.bot) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = MAX_ISAACS; i < MAX_PLAYERS; i++) {
        if (!this.slots[i].used) { idx = i; break; }
      }
    }
    if (idx < 0) return null;
    const p = this.slots[idx];
    const wasBot = p.bot;
    p.used = true;
    p.bot = false;
    p.ws = ws;
    p.ip = ip;
    p.uuid.set(uuid);
    const nk = nickFromUuid(uuid);
    p.adj = nk >> 8;
    p.noun = nk & 255;
    p.side = idx < MAX_ISAACS ? SIDE_ISAAC : SIDE_MONSTER;
    p.needFull = true;
    p.seq = 0; p.ack = 0; p.b0 = 0; p.b1 = 0; p.prevB1 = 0; p.aim = 0;
    p.pps = 0; p.idle = 0;
    if (!wasBot) p.resetStats();
    if (p.side === SIDE_MONSTER) { p.entity = -1; p.spirit = 0.001; p.spiritX = WORLD_W / 2; p.spiritY = WORLD_H / 2; }
    this.playerCount++;
    this.rosterDirty = true;
    this.lastActivity = Date.now();
    this.sendWelcome(p);
    this.sendRoom(p);
    return p;
  }

  removePlayer(p) {
    if (!p.used) return;
    if (p.side === SIDE_ISAAC) {
      // сущность мгновенно переходит под ИИ
      p.bot = true;
      p.ws = null;
      p.b0 = 0; p.b1 = 0;
      p.botTimer = 0;
    } else {
      if (p.entity >= 0) { this.w.ctrl[p.entity] = 0; p.entity = -1; }
      p.used = false;
      p.ws = null;
    }
    this.playerCount--;
    if (this.playerCount < 0) this.playerCount = 0;
    this.rosterDirty = true;
  }

  humanCount() {
    let n = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) if (this.slots[i].used && !this.slots[i].bot) n++;
    return n;
  }

  send(p, u8, len) {
    if (!p.ws) return;
    p.ws.sendBin(u8, len);
  }

  sendWelcome(p) {
    const dv = this.dv;
    dv.setUint8(0, S_WELCOME);
    dv.setUint8(1, PROTOCOL_VERSION);
    dv.setUint16(2, this.id);
    dv.setUint8(4, p.index);
    dv.setUint8(5, p.side);
    dv.setInt16(6, p.entity);
    dv.setUint8(8, TICK_RATE);
    dv.setUint8(9, p.adj);
    dv.setUint8(10, p.noun);
    dv.setUint8(11, this.scoreIsaac);
    dv.setUint8(12, this.scoreMonster);
    this.send(p, this.buf, 13);
  }

  sendRoster() {
    const dv = this.dv;
    dv.setUint8(0, S_ROSTER);
    let n = 0, off = 2;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (!p.used) continue;
      dv.setUint8(off++, p.index);
      dv.setUint8(off++, p.side);
      dv.setUint8(off++, p.adj);
      dv.setUint8(off++, p.noun);
      dv.setInt16(off, p.entity); off += 2;
      dv.setUint8(off++, p.ping > 255 ? 255 : p.ping);
      dv.setUint8(off++, (p.bot ? 1 : 0) | (p.entity < 0 && p.side === 1 ? 2 : 0) | (p.hearts <= 0 && p.side === 0 ? 4 : 0));
      n++;
    }
    dv.setUint8(1, n);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && p.ws) this.send(p, this.buf, off);
    }
  }

  sendRoom(only) {
    const dv = this.dv, f = this.f;
    dv.setUint8(0, S_ROOM);
    dv.setUint32(1, f.seed);
    dv.setUint8(5, this.room);
    dv.setUint8(6, f.kind[this.room]);
    dv.setUint8(7, this.floorNum);
    dv.setUint8(8, f.n);
    dv.setUint8(9, f.start);
    dv.setUint8(10, f.boss);
    let off = 11;
    for (let i = 0; i < f.n; i++) {
      dv.setUint8(off++, f.rx[i]);
      dv.setUint8(off++, f.ry[i]);
      dv.setUint8(off++, f.kind[i]);
      dv.setUint8(off++, f.doors[i]);
      dv.setUint8(off++, f.secretDoors[i]);
      dv.setUint8(off++, (roomCleared(f, i) ? 1 : 0) | (roomVisited(f, i) ? 2 : 0) | (roomFlags(f, i) << 2));
    }
    // текущая раскладка тайлов — короче, чем повторять генератор с учётом разрушений
    for (let i = 0; i < ROOM_TILES; i++) dv.setUint8(off++, this.tiles[i]);
    if (only) { this.send(only, this.buf, off); return; }
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && p.ws) this.send(p, this.buf, off);
    }
  }

  sendRound() {
    const dv = this.dv;
    dv.setUint8(0, S_ROUND);
    dv.setUint8(1, this.winner);
    dv.setUint16(2, ROUND_RESTART_MS);
    dv.setUint8(4, this.scoreIsaac);
    dv.setUint8(5, this.scoreMonster);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (p.used && p.ws) this.send(p, this.buf, 6);
    }
  }

  sendStats(p) {
    const dv = this.dv;
    const w = this.w;
    dv.setUint8(0, S_STATS);
    dv.setUint8(1, p.side);
    dv.setInt16(2, p.entity);
    dv.setUint8(4, p.hearts);
    dv.setUint8(5, p.maxHearts);
    dv.setUint8(6, p.bombs > 99 ? 99 : p.bombs);
    dv.setUint8(7, p.keys > 99 ? 99 : p.keys);
    dv.setUint8(8, p.coins > 99 ? 99 : p.coins);
    dv.setUint16(9, p.itemMask);
    dv.setUint8(11, Math.min(255, (p.damage * 10) | 0));
    dv.setUint8(12, Math.min(255, (p.firerate * 10) | 0));
    dv.setUint8(13, Math.min(255, p.speed | 0));
    dv.setUint8(14, Math.min(255, (p.range * 100) | 0));
    dv.setUint8(15, Math.min(255, (p.shotspeed / 2) | 0));
    const e = p.entity;
    const cd = e >= 0 && w.type[e] === T_MOB ? w.cd[e] : 0;
    const dcd = e >= 0 && w.type[e] === T_MOB ? w.iframe[e] : 0;
    dv.setUint8(16, Math.min(255, Math.max(0, (cd * 20) | 0)));
    dv.setUint8(17, Math.min(255, Math.max(0, (dcd * 20) | 0)));
    dv.setUint8(18, Math.min(255, Math.max(0, (p.spirit * 20) | 0)));
    dv.setUint8(19, this.budget > 255 ? 255 : this.budget);
    dv.setUint8(20, this.floorNum);
    dv.setUint16(21, Math.round(p.spiritX));
    dv.setUint16(23, Math.round(p.spiritY));
    this.send(p, this.buf, 25);
  }

  broadcast() {
    const dv = this.dv, w = this.w;
    if (this.roomChanged) { this.sendRoom(null); this.roomChanged = false; }
    if (this.rosterDirty) { this.sendRoster(); this.rosterDirty = false; }

    // общий дельта-снапшот (WS = TCP, порядок гарантирован → одна база на сессию)
    dv.setUint8(0, S_SNAP);
    dv.setUint8(1, 0);
    dv.setUint32(2, this.tick);
    // байты 6..7 — ack, патчатся под каждого клиента
    const end = encodeSnapshot(w, this.base, extraOf, dv, 8, false);

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (!p.used || !p.ws) continue;
      if (p.needFull) {
        p.needFull = false;
        clearNetView(this.kfBase);
        const kdv = this.kfDv;
        kdv.setUint8(0, S_SNAP);
        kdv.setUint8(1, 1);
        kdv.setUint32(2, this.tick);
        kdv.setUint16(6, p.ack);
        const kend = encodeSnapshot(w, this.kfBase, extraOf, kdv, 8, true);
        this.send(p, this.kfBuf, kend);
      } else {
        dv.setUint16(6, p.ack);
        this.send(p, this.buf, end);
      }
    }

    // события
    if (this.evN > 0) {
      dv.setUint8(0, S_EVENTS);
      dv.setUint8(1, this.evN);
      let off = 2;
      for (let k = 0; k < this.evN; k++) {
        dv.setUint8(off++, this.evKind[k]);
        let ex = Math.round(this.evX[k] * 8), ey = Math.round(this.evY[k] * 8);
        if (ex < 0) ex = 0; else if (ex > 65535) ex = 65535;
        if (ey < 0) ey = 0; else if (ey > 65535) ey = 65535;
        dv.setUint16(off, ex); off += 2;
        dv.setUint16(off, ey); off += 2;
        dv.setUint8(off++, this.evP[k]);
      }
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const p = this.slots[i];
        if (p.used && p.ws) this.send(p, this.buf, off);
      }
    }

    // статистика — 5 Гц или по изменению
    const statsTick = (this.tick % STATS_EVERY) === 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.slots[i];
      if (!p.used || !p.ws) continue;
      if (statsTick || p.statsDirty) { this.sendStats(p); p.statsDirty = false; }
    }
  }

  // ── приём инпута ───────────────────────────────────────────────────────────

  onInput(p, seq, b0, b1, aim) {
    // античит: seq должен расти (с учётом переполнения u16)
    const d = (seq - p.seq) & 0xffff;
    if (d === 0 || d > 32768) return;
    p.seq = seq;
    p.b0 = b0;
    p.b1 = b1;
    p.aim = aim;
    p.idle = 0; // управление мгновенно возвращается человеку
    this.lastActivity = Date.now();
  }
}

// ─── ИИ-Айзек (бот) ──────────────────────────────────────────────────────────
// Бот пишет те же инпут-биты, что и человек, — дальше общий код.

/** Свободна ли линия выстрела (ямы не мешают, камни и стены — да). */
function losClear(S, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(d / 8);
  for (let k = 1; k < steps; k++) {
    const x = x0 + (dx * k) / steps, y = y0 + (dy * k) / steps;
    if (tileSolid(S.tiles, (x / TILE) | 0, (y / TILE) | 0, 1)) return 0;
  }
  return 1;
}

function botIsaac(S, p, dt) {
  const w = S.w;
  const e = p.entity;
  if (e < 0) return;
  p.botTimer -= dt;
  let b0 = 0, b1 = 0;

  // ближайший моб
  let tgt = -1, bestD = 1e9;
  for (let i = 0; i < w.high; i++) {
    if (w.type[i] !== T_MOB) continue;
    const dx = w.x[i] - w.x[e], dy = w.y[i] - w.y[e];
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; tgt = i; }
  }

  if (tgt >= 0) {
    const dx = w.x[tgt] - w.x[e], dy = w.y[tgt] - w.y[e];
    const dist = Math.sqrt(bestD) || 1;
    const los = losClear(S, w.x[e], w.y[e], w.x[tgt], w.y[tgt]);
    if (!los) {
      // линия огня перекрыта камнем — обходим боком, не расстреливая стену
      if (Math.abs(dx) > Math.abs(dy)) b0 |= (p.botDoor & 1) ? IN_UP : IN_DOWN;
      else b0 |= (p.botDoor & 1) ? IN_LEFT : IN_RIGHT;
      if (dist > 120) { b0 |= dx > 0 ? IN_RIGHT : IN_LEFT; }
      if (p.botTimer <= 0) { p.botDoor = (S.rnd() * 4) | 0; p.botTimer = 0.8 + S.rnd(); }
    } else {
      // держим дистанцию 80
      if (dist < 62) {
        if (dx > 0) b0 |= IN_LEFT; else b0 |= IN_RIGHT;
        if (dy > 0) b0 |= IN_UP; else b0 |= IN_DOWN;
      } else if (dist > 105) {
        if (dx > 0) b0 |= IN_RIGHT; else b0 |= IN_LEFT;
        if (dy > 0) b0 |= IN_DOWN; else b0 |= IN_UP;
      } else if (p.botTimer <= 0) {
        p.botDoor = (S.rnd() * 4) | 0;
        p.botTimer = 0.7 + S.rnd();
      }
      if (p.botTimer > 0 && dist >= 62 && dist <= 105) {
        if (p.botDoor === 0) b0 |= IN_UP; else if (p.botDoor === 1) b0 |= IN_DOWN;
        else if (p.botDoor === 2) b0 |= IN_LEFT; else b0 |= IN_RIGHT;
      }
      // стрельба по доминирующей оси
      if (Math.abs(dx) > Math.abs(dy)) b0 |= dx < 0 ? IN_SLEFT : IN_SRIGHT;
      else b0 |= dy < 0 ? IN_SUP : IN_SDOWN;
    }
  } else {
    // комната пуста — идём к ближайшей открытой двери / к пикапу
    let px = -1, bd = 1e9;
    for (let i = 0; i < w.high; i++) {
      if (w.type[i] !== T_PICKUP || w.dmg[i] > 0) continue;
      const dx = w.x[i] - w.x[e], dy = w.y[i] - w.y[e];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; px = i; }
    }
    let tx, ty;
    if (px >= 0) { tx = w.x[px]; ty = w.y[px]; }
    else {
      if (p.botTimer <= 0 || p.botDoor < 0) {
        let d = S.botNavDir();
        // если BFS ничего не даёт — идём в любую открытую дверь
        if (d < 0 || S.tiles[DOOR_TY[d] * ROOM_W + DOOR_TX[d]] !== TL_DOOR_OPEN) {
          d = -1;
          for (let k = 0; k < 4; k++) {
            if (S.tiles[DOOR_TY[k] * ROOM_W + DOOR_TX[k]] === TL_DOOR_OPEN) { d = k; break; }
          }
        }
        p.botDoor = d;
        p.botTimer = 1.5;
      }
      if (p.botDoor >= 0) { tx = tileCX(DOOR_TX[p.botDoor]); ty = tileCY(DOOR_TY[p.botDoor]); }
      else { tx = WORLD_W / 2; ty = WORLD_H / 2; }
    }
    if (tx - w.x[e] > 5) b0 |= IN_RIGHT; else if (tx - w.x[e] < -5) b0 |= IN_LEFT;
    if (ty - w.y[e] > 5) b0 |= IN_DOWN; else if (ty - w.y[e] < -5) b0 |= IN_UP;
  }

  // упёрлись в геометрию — уходим в обход, сохраняя биты стрельбы.
  // Считаем именно смещение: скорость может быть полной, а движения нет.
  const moved = Math.abs(w.x[e] - p.botLastX) + Math.abs(w.y[e] - p.botLastY);
  p.botLastX = w.x[e];
  p.botLastY = w.y[e];
  if ((b0 & 15) !== 0 && moved < 0.5) p.botStuck += dt; else p.botStuck -= dt * 2;
  if (p.botStuck < 0) p.botStuck = 0;
  if (p.botStuck > 0.4 && p.botDetourT <= 0) {
    p.botDetourT = 0.7;
    p.botDetour = (S.rnd() * 4) | 0;
    p.botStuck = 0;
  }
  if (p.botDetourT > 0) {
    p.botDetourT -= dt;
    b0 = (b0 & 240) | (1 << p.botDetour);
  }

  p.b0 = b0;
  p.b1 = b1;
}
