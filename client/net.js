// client/net.js — бинарный транспорт, предсказание, сверка и интерполяция.
// Единственное место, где клиент трогает сеть.

import {
  MAX_ENTITIES, ROOM_TILES, INTERP_DELAY, SNAPSHOT_HISTORY, INPUT_HISTORY,
  DT, POS_SCALE, PROTOCOL_VERSION, ROOM_OX,
  T_NONE, T_ISAAC, T_MOB, T_TEAR, T_SHOT, T_PICKUP, T_BOMB,
  ST_ALIVE, ST_AIR, ST_CHARGE, ST_DOWN,
  MOB_SPEED, M_BOSS, M_SPITTER,
  SIDE_ISAAC, SIDE_MONSTER,
  IN_SUP, IN_SDOWN, IN_SLEFT, IN_SRIGHT, IN2_FIRE,
  TF_TRIPLE,
  ISAAC_BASE_SPEED, ISAAC_BASE_FIRERATE, ISAAC_BASE_SHOTSPEED, ISAAC_BASE_RANGE,
  WORLD_W, WORLD_H,
} from '../shared/constants.js';

import {
  createWorld, allocEntity, stepMotion, mulberry32,
} from '../shared/sim.js';

import {
  C_HELLO, C_INPUT, C_PING,
  S_WELCOME, S_ROSTER, S_ROOM, S_SNAP, S_EVENTS, S_STATS, S_ROUND, S_PONG, S_KICK,
  createNetView, clearNetView, decodeSnapshot, nickOf,
  writeHello, writeInput, writePing,
} from '../shared/protocol.js';

import { setMapRoom, finishMap, buildRoomDecor } from './gen.js';
import {
  spawnCosmeticTear, stepCosmetic, clearCosmetic, clearParticles, clearDamage,
  queueEvent, clearEvents,
} from './pool.js';

// ─── состояние ───────────────────────────────────────────────────────────────

export const net = {
  ws: null,
  status: 0, // 0 подключение, 1 в игре, 2 обрыв
  kickReason: -1,
  slot: -1,
  side: SIDE_ISAAC,
  entity: -1,
  sessionId: 0,
  nick: '',
  scoreIsaac: 0,
  scoreMonster: 0,
  view: createNetView(),
  tiles: new Uint8Array(ROOM_TILES),
  floorSeed: 0,
  roomIdx: 0,
  roomKind: 0,
  floorNum: 1,
  winner: -1,
  roundTimer: 0,
  ping: 60,
  bytesIn: 0,
  bytesOut: 0,
  kbpsIn: 0,
  kbpsOut: 0,
  seq: 0,
  ack: 0,
  renderAck: 0,
  serverTick: 0,
  // предсказанная позиция локальной сущности
  predOK: 0,
  px: WORLD_W / 2,
  py: WORLD_H / 2,
  ppx: WORLD_W / 2,
  ppy: WORLD_H / 2,
  alpha: 0,   // доля текущего шага симуляции, для плавного кадра
  errX: 0,    // визуальная поправка сверки, гасится за ~120 мс
  errY: 0,
  aimAngle: 0,
  spiritX: WORLD_W / 2,
  spiritY: WORLD_H / 2,
};

export const stats = {
  side: 0, entity: -1, hearts: 12, maxHearts: 12, bombs: 1, keys: 1, coins: 0,
  itemMask: 0, damage: 3.5, firerate: 2.6, speed: ISAAC_BASE_SPEED, range: 0.62,
  shotspeed: ISAAC_BASE_SHOTSPEED, abilityCd: 0, dashCd: 0, spirit: 0,
  budget: 0, floorNum: 1,
};

export const ROSTER_MAX = 5;
export const roster = [];
for (let i = 0; i < ROSTER_MAX; i++) {
  roster.push({ used: 0, slot: i, side: 0, adj: 0, noun: 0, entity: -1, ping: 0, flags: 0, nick: '' });
}
export const rosterN = { n: 0 };

// ─── история снапшотов ───────────────────────────────────────────────────────

const histX = [], histY = [], histP = [];
const histT = new Float64Array(SNAPSHOT_HISTORY);
const histAck = new Uint16Array(SNAPSHOT_HISTORY);
for (let i = 0; i < SNAPSHOT_HISTORY; i++) {
  histX.push(new Float32Array(MAX_ENTITIES));
  histY.push(new Float32Array(MAX_ENTITIES));
  histP.push(new Uint8Array(MAX_ENTITIES));
}
let histHead = -1, histCount = 0;

// кадр интерполяции, выбранный на текущий кадр рендера
let iA = -1, iB = -1, iT = 0;

// ─── история инпутов для сверки ──────────────────────────────────────────────

const inSeq = new Uint16Array(INPUT_HISTORY);
const inB0 = new Uint8Array(INPUT_HISTORY);
const inB1 = new Uint8Array(INPUT_HISTORY);
const inAim = new Uint8Array(INPUT_HISTORY);
let inHead = 0, inCount = 0;

// ─── мир предсказания (индекс 0 — локальная сущность) ────────────────────────

const cw = createWorld();
const LOCAL = allocEntity(cw, T_ISAAC);
cw.r[LOCAL] = 6;

// ─── буферы пакетов ──────────────────────────────────────────────────────────

const outBuf = new ArrayBuffer(32);
const outDv = new DataView(outBuf);
const outU8 = new Uint8Array(outBuf);
let fireCd = 0;
let monFireCd = 0;
let lastPing = 0;
let bytesWindow = 0, bytesWinIn = 0, bytesWinOut = 0;

// ─── подключение ─────────────────────────────────────────────────────────────

function getUuid() {
  let hex = null;
  try { hex = localStorage.getItem('ia_uuid'); } catch (e) { }
  const u = new Uint8Array(16);
  if (hex && hex.length === 32) {
    for (let i = 0; i < 16; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
    return u;
  }
  crypto.getRandomValues(u);
  let s = '';
  for (let i = 0; i < 16; i++) s += u[i].toString(16).padStart(2, '0');
  try { localStorage.setItem('ia_uuid', s); } catch (e) { }
  return u;
}

const myUuid = getUuid();

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  net.ws = ws;
  net.status = 0;

  ws.onopen = () => {
    const len = writeHello(outDv, myUuid);
    ws.send(outU8.subarray(0, len));
    net.status = 1;
  };
  ws.onmessage = (ev) => onPacket(new DataView(ev.data), new Uint8Array(ev.data));
  ws.onclose = () => { net.status = 2; };
  ws.onerror = () => { };
}

export function reconnect() {
  if (net.ws) { try { net.ws.close(); } catch (e) { } }
  clearNetView(net.view);
  histHead = -1; histCount = 0;
  inHead = 0; inCount = 0;
  connect();
}

// ─── разбор пакетов ──────────────────────────────────────────────────────────

function onPacket(dv, u8) {
  net.bytesIn += u8.length;
  bytesWinIn += u8.length;
  const type = dv.getUint8(0);

  switch (type) {
    case S_WELCOME: {
      net.sessionId = dv.getUint16(2);
      net.slot = dv.getUint8(4);
      net.side = dv.getUint8(5);
      net.entity = dv.getInt16(6);
      const adj = dv.getUint8(9), noun = dv.getUint8(10);
      net.nick = nickOf(adj, noun);
      net.scoreIsaac = dv.getUint8(11);
      net.scoreMonster = dv.getUint8(12);
      net.status = 1;
      net.winner = -1;
      fireCd = 0;
      break;
    }
    case S_ROSTER: {
      const n = dv.getUint8(1);
      let off = 2;
      for (let i = 0; i < ROSTER_MAX; i++) roster[i].used = 0;
      for (let k = 0; k < n; k++) {
        const slot = dv.getUint8(off++);
        const r = roster[slot < ROSTER_MAX ? slot : 0];
        r.used = 1;
        r.slot = slot;
        r.side = dv.getUint8(off++);
        const adj = dv.getUint8(off++), noun = dv.getUint8(off++);
        if (r.adj !== adj || r.noun !== noun || !r.nick) r.nick = nickOf(adj, noun);
        r.adj = adj; r.noun = noun;
        r.entity = dv.getInt16(off); off += 2;
        r.ping = dv.getUint8(off++);
        r.flags = dv.getUint8(off++);
      }
      rosterN.n = n;
      break;
    }
    case S_ROOM: {
      net.floorSeed = dv.getUint32(1);
      const newRoom = dv.getUint8(5);
      const changed = newRoom !== net.roomIdx;
      net.roomIdx = newRoom;
      net.roomKind = dv.getUint8(6);
      net.floorNum = dv.getUint8(7);
      const n = dv.getUint8(8);
      const start = dv.getUint8(9), boss = dv.getUint8(10);
      let off = 11;
      for (let i = 0; i < n; i++) {
        const x = dv.getUint8(off++), y = dv.getUint8(off++), kind = dv.getUint8(off++);
        const doors = dv.getUint8(off++), sec = dv.getUint8(off++), fl = dv.getUint8(off++);
        setMapRoom(i, x, y, kind, doors, sec, fl);
      }
      finishMap(n, newRoom, start, boss);
      for (let i = 0; i < ROOM_TILES; i++) net.tiles[i] = dv.getUint8(off++);
      buildRoomDecor(net.floorSeed, net.roomIdx, net.roomKind, net.tiles);
      if (changed) {
        histHead = -1; histCount = 0;
        clearParticles(); clearDamage(); clearCosmetic(); clearEvents();
        net.predOK = 0;
      }
      break;
    }
    case S_SNAP: {
      const full = dv.getUint8(1) & 1;
      net.serverTick = dv.getUint32(2);
      net.ack = dv.getUint16(6);
      if (full) clearNetView(net.view);
      const h = (histHead + 1) % SNAPSHOT_HISTORY;
      decodeSnapshot(net.view, dv, 8, histX[h], histY[h], histP[h]);
      histT[h] = performance.now();
      histAck[h] = net.ack;
      histHead = h;
      if (histCount < SNAPSHOT_HISTORY) histCount++;
      reconcile();
      break;
    }
    case S_EVENTS: {
      const n = dv.getUint8(1);
      let off = 2;
      const due = performance.now() + INTERP_DELAY;
      for (let k = 0; k < n; k++) {
        const kind = dv.getUint8(off++);
        const x = dv.getUint16(off) / 8; off += 2;
        const y = dv.getUint16(off) / 8; off += 2;
        const p = dv.getUint8(off++);
        queueEvent(kind, x, y, p, due);
      }
      break;
    }
    case S_STATS: {
      stats.side = dv.getUint8(1);
      stats.entity = dv.getInt16(2);
      stats.hearts = dv.getUint8(4);
      stats.maxHearts = dv.getUint8(5);
      stats.bombs = dv.getUint8(6);
      stats.keys = dv.getUint8(7);
      stats.coins = dv.getUint8(8);
      stats.itemMask = dv.getUint16(9);
      stats.damage = dv.getUint8(11) / 10;
      stats.firerate = dv.getUint8(12) / 10;
      stats.speed = dv.getUint8(13);
      stats.range = dv.getUint8(14) / 100;
      stats.shotspeed = dv.getUint8(15) * 2;
      stats.abilityCd = dv.getUint8(16) / 20;
      stats.dashCd = dv.getUint8(17) / 20;
      stats.spirit = dv.getUint8(18) / 20;
      stats.budget = dv.getUint8(19);
      stats.floorNum = dv.getUint8(20);
      net.spiritX = dv.getUint16(21);
      net.spiritY = dv.getUint16(23);
      net.side = stats.side;
      if (net.entity !== stats.entity) {
        net.entity = stats.entity;
        net.predOK = 0;
      }
      break;
    }
    case S_ROUND: {
      net.winner = dv.getUint8(1);
      net.roundTimer = dv.getUint16(2);
      net.scoreIsaac = dv.getUint8(4);
      net.scoreMonster = dv.getUint8(5);
      break;
    }
    case S_PONG: {
      const t = dv.getUint32(1);
      const rtt = (performance.now() | 0) - t;
      if (rtt >= 0 && rtt < 5000) net.ping = net.ping * 0.8 + rtt * 0.2;
      break;
    }
    case S_KICK: {
      net.kickReason = dv.getUint8(1);
      net.status = 2;
      break;
    }
  }
}

// ─── предсказание и сверка ───────────────────────────────────────────────────

function localSpeed() {
  const e = net.entity;
  if (e < 0) return ISAAC_BASE_SPEED;
  const v = net.view;
  if (v.type[e] === T_MOB) return MOB_SPEED[v.sub[e]] * 1.12;
  return stats.speed || ISAAC_BASE_SPEED;
}

/** Можно ли предсказывать: спецсостояния (полёт, разгон) считает только сервер. */
function predictable() {
  const e = net.entity;
  if (e < 0) return 0;
  const v = net.view;
  if (!v.present[e]) return 0;
  const st = v.state[e];
  if (st & (ST_AIR | ST_CHARGE | ST_DOWN)) return 0;
  return 1;
}

const MAX_ERR = 40; // больше — значит рассинхрон, там честнее мгновенный снап

function reconcile() {
  const e = net.entity;
  const v = net.view;
  if (e < 0 || !v.present[e] || !predictable()) { net.predOK = 0; return; }

  const hadPred = net.predOK;
  const oldX = net.px, oldY = net.py;

  cw.x[LOCAL] = v.px[e] / POS_SCALE;
  cw.y[LOCAL] = v.py[e] / POS_SCALE;
  cw.vx[LOCAL] = v.pvx[e] / 8;
  cw.vy[LOCAL] = v.pvy[e] / 8;
  cw.r[LOCAL] = v.type[e] === T_MOB ? mobRadius(v.sub[e]) : 6;

  // повтор неподтверждённых инпутов
  const speed = localSpeed();
  for (let k = 0; k < inCount; k++) {
    const idx = (inHead - inCount + k + INPUT_HISTORY * 2) % INPUT_HISTORY;
    const d = (inSeq[idx] - net.ack) & 0xffff;
    if (d === 0 || d > 32768) continue;
    stepMotion(cw, LOCAL, inB0[idx], speed, DT, net.tiles, 0);
  }
  net.px = cw.x[LOCAL];
  net.py = cw.y[LOCAL];

  // Расхождение не показываем скачком: прячем его в визуальную поправку и
  // гасим за пару кадров. Иначе толчок от моба или потерянный тик выглядят
  // как телепорт сквозь стену.
  if (hadPred) {
    let dx = oldX - net.px, dy = oldY - net.py;
    if (dx * dx + dy * dy > MAX_ERR * MAX_ERR) { dx = 0; dy = 0; }
    net.errX += dx;
    net.errY += dy;
    if (net.errX > MAX_ERR) net.errX = MAX_ERR; else if (net.errX < -MAX_ERR) net.errX = -MAX_ERR;
    if (net.errY > MAX_ERR) net.errY = MAX_ERR; else if (net.errY < -MAX_ERR) net.errY = -MAX_ERR;
  } else {
    net.errX = 0; net.errY = 0;
  }
  // схлопываем отрезок интерполяции: поправка уже держит картинку на месте
  net.ppx = net.px;
  net.ppy = net.py;
  net.predOK = 1;
}

/** Гасит визуальную поправку. Вызывается раз в кадр рендера. */
export function decayError(dt) {
  let k = 1 - dt * 14;
  if (k < 0) k = 0;
  net.errX *= k;
  net.errY *= k;
  if (net.errX < 0.05 && net.errX > -0.05) net.errX = 0;
  if (net.errY < 0.05 && net.errY > -0.05) net.errY = 0;
}

// последняя отданная рендеру позиция — чтобы смена источника не давала скачка
let lastSrc = -1, lastRX = 0, lastRY = 0;

/**
 * Позиция локальной сущности для кадра: предсказание, сглаженное между шагами
 * симуляции, плюс затухающая поправка сверки.
 */
export function localRenderPos(out) {
  const e = net.entity;
  let src, tx, ty;
  if (net.predOK) {
    src = 0;
    const a = net.alpha;
    tx = net.ppx + (net.px - net.ppx) * a;
    ty = net.ppy + (net.py - net.ppy) * a;
  } else if (e >= 0 && entityVisible(e)) {
    src = 1;
    tx = entityX(e);
    ty = entityY(e);
  } else {
    src = 2;
    tx = net.px; ty = net.py;
  }
  // переключение источника (например, начался рывок) прячем в ту же поправку
  if (src !== lastSrc && lastSrc >= 0) {
    const dx = lastRX - tx, dy = lastRY - ty;
    if (dx * dx + dy * dy <= MAX_ERR * MAX_ERR) { net.errX += dx; net.errY += dy; }
  }
  lastSrc = src;
  lastRX = tx; lastRY = ty;
  out[0] = tx + net.errX;
  out[1] = ty + net.errY;
}

const MOB_R_LOCAL = new Uint8Array([6, 6, 7, 6, 7, 4, 13]);
function mobRadius(sub) { return MOB_R_LOCAL[sub] || 6; }

/**
 * Один шаг симуляции клиента (30 Гц): собрать инпут, предсказать, отправить.
 * b0/b1/aim приходят из input.js через main.js.
 */
export function simStep(b0, b1, aimAngle) {
  if (net.status !== 1 || !net.ws || net.ws.readyState !== 1) return;

  net.seq = (net.seq + 1) & 0xffff;
  const aim = ((aimAngle / (Math.PI * 2)) * 256) & 255;
  net.aimAngle = aimAngle;

  // запись в кольцо инпутов
  inSeq[inHead] = net.seq;
  inB0[inHead] = b0;
  inB1[inHead] = b1;
  inAim[inHead] = aim;
  inHead = (inHead + 1) % INPUT_HISTORY;
  if (inCount < INPUT_HISTORY) inCount++;

  // предсказание движения
  net.ppx = net.px;
  net.ppy = net.py;
  if (predictable()) {
    if (!net.predOK) {
      const v = net.view, e = net.entity;
      cw.x[LOCAL] = v.px[e] / POS_SCALE;
      cw.y[LOCAL] = v.py[e] / POS_SCALE;
      cw.vx[LOCAL] = v.pvx[e] / 8;
      cw.vy[LOCAL] = v.pvy[e] / 8;
      cw.r[LOCAL] = v.type[e] === T_MOB ? mobRadius(v.sub[e]) : 6;
      net.ppx = cw.x[LOCAL];
      net.ppy = cw.y[LOCAL];
      net.predOK = 1;
    }
    stepMotion(cw, LOCAL, b0, localSpeed(), DT, net.tiles, 0);
    net.px = cw.x[LOCAL];
    net.py = cw.y[LOCAL];
  } else {
    const e = net.entity, v = net.view;
    if (e >= 0 && v.present[e]) { net.px = v.px[e] / POS_SCALE; net.py = v.py[e] / POS_SCALE; }
    else { net.px = net.spiritX; net.py = net.spiritY; }
    net.ppx = net.px; net.ppy = net.py;
  }

  // Мгновенный отклик на выстрел: рисуем свою слезу сразу, не дожидаясь RTT.
  // Живёт она ровно до того кадра, в котором на экран выходит серверная —
  // сигнал даёт ack отрисовываемого снапшота, поэтому разрыва не бывает.
  const ent = net.entity;
  if (net.side === SIDE_ISAAC && ent >= 0 && net.view.type[ent] === T_ISAAC) {
    fireCd -= DT;
    let sx = 0, sy = 0;
    if (b0 & IN_SLEFT) sx -= 1;
    if (b0 & IN_SRIGHT) sx += 1;
    if (b0 & IN_SUP) sy -= 1;
    if (b0 & IN_SDOWN) sy += 1;
    if (sx === 0 && sy === 0 && (b1 & IN2_FIRE)) { sx = Math.cos(aimAngle); sy = Math.sin(aimAngle); }
    if ((sx !== 0 || sy !== 0) && fireCd <= 0) {
      const len = Math.sqrt(sx * sx + sy * sy) || 1;
      sx /= len; sy /= len;
      const base = Math.atan2(sy, sx);
      const triple = (stats.itemMask & (1 << 9)) !== 0;
      const big = (stats.itemMask & (1 << 11)) !== 0 ? 1 : 0;
      const sp = stats.shotspeed;
      const life = stats.range || ISAAC_BASE_RANGE;
      // сервер добавляет слезе часть скорости стрелка — повторяем, иначе
      // на бегу локальная и серверная слёзы расходятся вбок
      const ivx = cw.vx[LOCAL] * 0.32, ivy = cw.vy[LOCAL] * 0.32;
      if (triple) {
        for (let k = -1; k <= 1; k++) {
          const a = base + k * 0.17;
          spawnCosmeticTear(net.px, net.py, Math.cos(a) * sp + ivx, Math.sin(a) * sp + ivy, life, net.seq, big, net.slot & 1, 0);
        }
      } else {
        spawnCosmeticTear(net.px, net.py, sx * sp + ivx, sy * sp + ivy, life, net.seq, big, net.slot & 1, 0);
      }
      fireCd = 1 / (stats.firerate || ISAAC_BASE_FIRERATE);
    }
  } else if (net.side === SIDE_MONSTER && ent >= 0 && net.view.type[ent] === T_MOB) {
    // у Плевуна и босса базовая атака тоже должна отзываться мгновенно
    const arch = net.view.sub[ent];
    monFireCd -= DT;
    if ((b1 & IN2_FIRE) && monFireCd <= 0 && (arch === M_SPITTER || arch === M_BOSS)) {
      spawnCosmeticTear(net.px, net.py, Math.cos(aimAngle) * 88, Math.sin(aimAngle) * 88,
        2.0, net.seq, 0, 0, 1);
      monFireCd = arch === M_BOSS ? 0.8 : 1.1;
    }
  }

  const len = writeInput(outDv, net.seq, b0, b1, aim);
  net.ws.send(outU8.subarray(0, len));
  net.bytesOut += len;
  bytesWinOut += len;

  const now = performance.now();
  if (now - lastPing > 1000) {
    lastPing = now;
    const pl = writePing(outDv, now | 0);
    net.ws.send(outU8.subarray(0, pl));
    net.bytesOut += pl;
    bytesWinOut += pl;
  }
  if (now - bytesWindow > 1000) {
    bytesWindow = now;
    net.kbpsIn = (bytesWinIn * 8) / 1000;
    net.kbpsOut = (bytesWinOut * 8) / 1000;
    bytesWinIn = 0; bytesWinOut = 0;
  }
}

// ─── интерполяция ────────────────────────────────────────────────────────────

/** Выбирает пару кадров под текущее время рендера. Вызывать раз в кадр. */
export function beginFrame(nowMs) {
  iA = -1; iB = -1; iT = 0;
  if (histCount === 0) return;
  const target = nowMs - INTERP_DELAY;
  const oldest = (histHead - histCount + 1 + SNAPSHOT_HISTORY) % SNAPSHOT_HISTORY;
  if (target >= histT[histHead]) { iA = histHead; iB = histHead; }
  else if (target <= histT[oldest]) { iA = oldest; iB = oldest; }
  else {
    for (let k = 1; k < histCount; k++) {
      const a = (histHead - k + SNAPSHOT_HISTORY) % SNAPSHOT_HISTORY;
      const b = (histHead - k + 1 + SNAPSHOT_HISTORY) % SNAPSHOT_HISTORY;
      if (histT[a] <= target && target <= histT[b]) {
        iA = a; iB = b;
        iT = (target - histT[a]) / (histT[b] - histT[a]);
        break;
      }
    }
    if (iA < 0) { iA = histHead; iB = histHead; }
  }
  if (iT < 0) iT = 0; else if (iT > 1) iT = 1;
  net.renderAck = histAck[iA];
}

/** Виден ли объект в текущем интерполируемом кадре. */
export function entityVisible(id) {
  if (iA < 0) return 0;
  return histP[iA][id] || (iB !== iA && histP[iB][id]);
}

export function entityX(id) {
  if (iA < 0) return 0;
  const a = histP[iA][id] ? histX[iA][id] : histX[iB][id];
  if (iB === iA || !histP[iB][id] || !histP[iA][id]) return a;
  return a + (histX[iB][id] - a) * iT;
}

export function entityY(id) {
  if (iA < 0) return 0;
  const a = histP[iA][id] ? histY[iA][id] : histY[iB][id];
  if (iB === iA || !histP[iB][id] || !histP[iA][id]) return a;
  return a + (histY[iB][id] - a) * iT;
}

export function viewHigh() { return net.view.high; }
