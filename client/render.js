// client/render.js — весь рендер. Canvas2D, nearest-neighbour, ноль аллокаций
// в кадре: спрайтовые координаты в LUT, строки закэшированы заранее.

import {
  VIEW_W, VIEW_H, ROOM_W, ROOM_H, ROOM_TILES, TILE, WORLD_W, WORLD_H, ROOM_OX,
  MAX_ENTITIES,
  TL_FLOOR, TL_WALL, TL_ROCK, TL_PIT, TL_SPIKE, TL_DOOR, TL_DOOR_OPEN, TL_SECRET,
  TL_RUBBLE, TL_HATCH,
  T_NONE, T_ISAAC, T_MOB, T_TEAR, T_SHOT, T_PICKUP, T_BOMB,
  ST_ALIVE, ST_SHIELD, ST_CHARGE, ST_HURT, ST_AIR, ST_DOWN,
  M_BOSS, M_SPAWN,
  P_HEART, P_HALFHEART, P_COIN, P_KEY, P_BOMB, P_PEDESTAL,
  R_START, R_NORMAL, R_TREASURE, R_SHOP, R_BOSS, R_SECRET,
  SIDE_ISAAC, SIDE_MONSTER,
  CELL, CELL_COLS, TILE_BAND_Y, TILE_COLS, BIG, BIG_BAND_Y, BIG_COLS,
  S_ISAAC_BODY, S_ISAAC_HEAD, S_ISAAC_GHOST, S_ISAAC2_BODY, S_ISAAC2_HEAD, S_ISAAC2_GHOST,
  S_TEAR, S_MOB, S_SHOT, S_SHIELD_FX, S_CROWN, S_HEART, S_COIN, S_KEY, S_BOMB,
  S_BOMB_LIT, S_PEDESTAL, S_ITEM, S_BOOM, S_SPIRIT, S_SHADOW, S_RETICLE, S_LOCK, S_ARROW,
  TS_FLOOR, TS_WALL, TS_ROCK, TS_PIT, TS_SPIKE, TS_DOOR, TS_DOOR_OPEN, TS_RUBBLE,
  TS_HATCH, TS_FLOOR_SHOP, TS_FLOOR_BOSS, TS_FLOOR_TREASURE,
  B_BOSS, B_BLAST,
  EV_HIT, EV_MOB_DIE, EV_SHOOT, EV_EXPLODE, EV_PICKUP, EV_DOOR, EV_HURT,
  EV_ABILITY, EV_POSSESS, EV_ROCK, EV_BOSS_DIE, EV_SECRET, EV_DENY, EV_REVIVE,
  ITEM_PRICE, IT_COUNT,
} from '../shared/constants.js';

import { net, stats, roster, rosterN, beginFrame, entityVisible, entityX, entityY } from './net.js';
import { floorVar, decorN, decorX, decorY, decorK, mapN, mapX, mapY, mapKind, mapDoors, mapFlags, mapVisible } from './gen.js';
import {
  P_MAX, px, py, plife, pmax, pcol, psize,
  D_MAX, dx, dy, dlife, dval, dcol,
  CT_MAX, ctx_, cty, ctlife, ctbig, ctcol,
} from './pool.js';
import { input } from './input.js';

let ctx = null;
let atlas = null;
let W = VIEW_W, H = VIEW_H;

// ─── LUT координат в атласе ──────────────────────────────────────────────────
const sxS = new Int16Array(128), syS = new Int16Array(128);
const sxT = new Int16Array(16), syT = new Int16Array(16);
const sxB = new Int16Array(16), syB = new Int16Array(16);
for (let i = 0; i < 128; i++) { sxS[i] = (i % CELL_COLS) * CELL; syS[i] = ((i / CELL_COLS) | 0) * CELL; }
for (let i = 0; i < 16; i++) { sxT[i] = (i % TILE_COLS) * TILE; syT[i] = TILE_BAND_Y + ((i / TILE_COLS) | 0) * TILE; }
for (let i = 0; i < 16; i++) { sxB[i] = (i % BIG_COLS) * BIG; syB[i] = BIG_BAND_Y + ((i / BIG_COLS) | 0) * BIG; }

// тайл → спрайт
const TILE_SPR = new Uint8Array(16);
TILE_SPR[TL_WALL] = TS_WALL;
TILE_SPR[TL_ROCK] = TS_ROCK;
TILE_SPR[TL_PIT] = TS_PIT;
TILE_SPR[TL_SPIKE] = TS_SPIKE;
TILE_SPR[TL_DOOR] = TS_DOOR;
TILE_SPR[TL_DOOR_OPEN] = TS_DOOR_OPEN;
TILE_SPR[TL_SECRET] = TS_WALL;
TILE_SPR[TL_RUBBLE] = TS_RUBBLE;
TILE_SPR[TL_HATCH] = TS_HATCH;

// ─── цвета и строки (никаких конкатенаций в кадре) ───────────────────────────
const COL_BG = '#0a0709';
const COL_VOID = '#05040a';
const COL_HUD = '#0d0b12';
const COL_TXT = '#e8dcc8';
const COL_DIM = '#7a6f63';
const COL_ISAAC = '#8fd8ff';
const COL_MON = '#ff7a6a';
const COL_GOLD = '#ffd257';
const COL_RED = '#ff4d4d';
const COL_GREEN = '#7ee08a';
const PARTICLE_COLORS = ['#ff4d4d', '#ffd257', '#8fd8ff', '#e8dcc8', '#7ee08a', '#b06adf', '#5a4a3a', '#ffffff'];

const NUMS = [];
for (let i = 0; i < 256; i++) NUMS.push(String(i));
const T_TITLE = 'ISAAC ARENA';
const T_CONNECT = 'ПОДКЛЮЧЕНИЕ...';
const T_LOST = 'СВЯЗЬ ПОТЕРЯНА — F5';
const T_WIN_I = 'АЙЗЕКИ ПРОШЛИ БОССА';
const T_WIN_M = 'МОНСТРЫ ВЫИГРАЛИ';
const T_NEXT = 'НОВЫЙ РАУНД, СМЕНА СТОРОН';
const T_SPIRIT = 'ДУХ — ЖДЁМ ТЕЛО';
const T_DOWN = 'ТЫ ПОВЕРЖЕН';
const T_BOSS = 'БОСС';
const T_SHOP = 'МАГАЗИН';
const T_FREE = 'БЕСПЛАТНО';
const T_ISAACS = 'АЙЗЕКИ';
const T_MONSTERS = 'МОНСТРЫ';
const HELP = [
  'WASD — движение',
  'СТРЕЛКИ / ЛКМ — стрельба',
  'ПРОБЕЛ / ПКМ — способность',
  'SHIFT — рывок',
  'E — бомба',
  'M — звук, N — музыка, TAB — справка',
];
const ITEM_NAMES = [
  'УРОН+', 'СКОРОСТРЕЛ+', 'СКОРОСТЬ+', 'ДАЛЬНОСТЬ+', 'РАЗГОН СЛЁЗ+',
  'ПРОБИТИЕ', 'НАВЕДЕНИЕ', 'ЯД', 'ОТСКОК', 'ТРОЙНОЙ ВЫСТРЕЛ',
  'СЕРДЦЕ+', 'КРУПНЫЕ СЛЁЗЫ', 'БОМБЫ+5', 'УДАЧА',
];
const MOB_NAMES = ['ПОЛЗУН', 'ПЛЕВУН', 'ДЕЛИТЕЛЬ', 'ПРЫГУН', 'ЩИТОНОСЕЦ', 'ОСКОЛОК', 'БОСС'];

// порядок отрисовки сущностей по Y
const order = new Uint16Array(MAX_ENTITIES);
const orderY = new Float32Array(MAX_ENTITIES);

let fps = 60, fpsAcc = 0, fpsN = 0, fpsT = 0;
let shake = 0;

export function initRender(canvas, atlasImage) {
  ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  atlas = atlasImage;
  W = canvas.width;
  H = canvas.height;
}

export function addShake(v) { if (v > shake) shake = v; }

function spr(i, x, y) {
  ctx.drawImage(atlas, sxS[i], syS[i], CELL, CELL, x | 0, y | 0, CELL, CELL);
}
function sprFlip(i, x, y) {
  ctx.save();
  ctx.translate((x | 0) + CELL, y | 0);
  ctx.scale(-1, 1);
  ctx.drawImage(atlas, sxS[i], syS[i], CELL, CELL, 0, 0, CELL, CELL);
  ctx.restore();
}
function tspr(i, x, y) {
  ctx.drawImage(atlas, sxT[i], syT[i], TILE, TILE, x | 0, y | 0, TILE, TILE);
}
function bspr(i, x, y) {
  ctx.drawImage(atlas, sxB[i], syB[i], BIG, BIG, x | 0, y | 0, BIG, BIG);
}

// ─── главный кадр ────────────────────────────────────────────────────────────

export function render(now, dt) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  beginFrame(now);

  ctx.fillStyle = COL_VOID;
  ctx.fillRect(0, 0, W, H);

  let ox = ROOM_OX, oy = 0;
  if (shake > 0) {
    shake -= dt * 26;
    if (shake < 0) shake = 0;
    ox += ((Math.random() - 0.5) * shake) | 0;
    oy += ((Math.random() - 0.5) * shake) | 0;
  }

  drawRoom(ox, oy, now);
  drawEntities(ox, oy, now);
  drawCosmetic(ox, oy);
  drawParticles(ox, oy);
  drawDamage(ox, oy);
  drawHud(now);
  drawOverlays(now);
}

// ─── комната ─────────────────────────────────────────────────────────────────

function floorSprFor(kind, variant) {
  if (kind === R_SHOP) return TS_FLOOR_SHOP;
  if (kind === R_BOSS) return TS_FLOOR_BOSS;
  if (kind === R_TREASURE || kind === R_SECRET) return TS_FLOOR_TREASURE;
  return TS_FLOOR + variant;
}

function drawRoom(ox, oy, now) {
  const tiles = net.tiles;
  const kind = net.roomKind;
  ctx.fillStyle = COL_BG;
  ctx.fillRect(ox, oy, WORLD_W, WORLD_H);
  for (let ty = 0; ty < ROOM_H; ty++) {
    const py0 = oy + ty * TILE;
    for (let tx = 0; tx < ROOM_W; tx++) {
      const i = ty * ROOM_W + tx;
      const t = tiles[i];
      const pxx = ox + tx * TILE;
      if (t === TL_WALL || t === TL_SECRET) { tspr(TS_WALL, pxx, py0); continue; }
      tspr(floorSprFor(kind, floorVar[i]), pxx, py0);
      if (t !== TL_FLOOR) tspr(TILE_SPR[t], pxx, py0);
    }
  }
  // мелкий декор пола
  ctx.fillStyle = '#2a2027';
  for (let i = 0; i < decorN.n; i++) {
    const s = decorK[i] + 1;
    ctx.fillRect((ox + decorX[i]) | 0, (oy + decorY[i]) | 0, s, s);
  }
}

// ─── сущности ────────────────────────────────────────────────────────────────

function drawEntities(ox, oy, now) {
  const v = net.view;
  const frame = ((now / 140) | 0) & 1;
  let n = 0;
  const high = v.high;
  for (let i = 0; i < high; i++) {
    if (!entityVisible(i)) continue;
    const t = v.type[i];
    if (t === T_NONE) continue;
    order[n] = i;
    orderY[n] = (t === T_TEAR || t === T_SHOT) ? 1e6 : entityY(i);
    n++;
  }
  // сортировка вставками — сущностей десятки, аллокаций ноль
  for (let a = 1; a < n; a++) {
    const key = order[a], ky = orderY[a];
    let b = a - 1;
    while (b >= 0 && orderY[b] > ky) { order[b + 1] = order[b]; orderY[b + 1] = orderY[b]; b--; }
    order[b + 1] = key; orderY[b + 1] = ky;
  }

  for (let k = 0; k < n; k++) {
    const i = order[k];
    const t = v.type[i];
    let x = entityX(i), y = entityY(i);
    // локальная сущность рисуется по предсказанию
    if (i === net.entity && net.predOK) { x = net.px; y = net.py; }
    x += ox; y += oy;

    switch (t) {
      case T_ISAAC: drawIsaac(v, i, x, y, frame, now); break;
      case T_MOB: drawMob(v, i, x, y, frame, now); break;
      case T_TEAR: drawTear(v, i, x, y); break;
      case T_SHOT: spr(S_SHOT + (frame & 1), x - 8, y - 8); break;
      case T_PICKUP: drawPickup(v, i, x, y, now); break;
      case T_BOMB: {
        const blink = ((now / 90) | 0) & 1;
        spr(blink ? S_BOMB_LIT : S_BOMB, x - 8, y - 8);
        break;
      }
    }
  }
}

function drawIsaac(v, i, x, y, frame, now) {
  const variant = v.sub[i] & 1;
  const st = v.state[i];
  const face = (st >> 6) & 3;
  const moving = Math.abs(v.pvx[i]) + Math.abs(v.pvy[i]) > 40;
  spr(S_SHADOW, x - 8, y - 3);
  if (st & ST_DOWN) {
    spr(variant ? S_ISAAC2_GHOST : S_ISAAC_GHOST, x - 8, y - 10);
    return;
  }
  if ((st & ST_HURT) && (((now / 60) | 0) & 1)) return; // мигание i-frames
  const bodyBase = variant ? S_ISAAC2_BODY : S_ISAAC_BODY;
  const headBase = variant ? S_ISAAC2_HEAD : S_ISAAC_HEAD;
  spr(bodyBase + (moving ? frame : 0), x - 8, y - 6);
  const hi = face === 1 ? 1 : face === 0 ? 0 : 2;
  if (face === 2) sprFlip(headBase + hi, x - 8, y - 14);
  else spr(headBase + hi, x - 8, y - 14);
  // подпись владельца
  if (v.ctrl[i] > 0) {
    const r = roster[v.ctrl[i] - 1];
    if (r && r.used && r.nick) {
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = i === net.entity ? COL_GOLD : COL_DIM;
      ctx.fillText(r.nick, x, y - 17);
      ctx.textAlign = 'left';
    }
  }
}

function drawMob(v, i, x, y, frame, now) {
  const arch = v.sub[i];
  const st = v.state[i];
  const boss = arch === M_BOSS;
  let lift = 0;
  if (st & ST_AIR) lift = 6 + (v.extra[i] / 255) * 14;

  spr(S_SHADOW, x - 8, y - 2 + (boss ? 6 : 0));
  if (boss) {
    const ph = v.hp[i] * 2 < v.maxhp[i] ? 2 : frame;
    bspr(B_BOSS + ph, x - 16, y - 20 - lift);
  } else {
    spr(S_MOB + arch * 2 + frame, x - 8, y - 8 - lift);
  }
  if (st & ST_SHIELD) {
    const face = (st >> 6) & 3;
    const fx = face === 2 ? -9 : face === 3 ? 9 : 0;
    const fy = face === 1 ? -9 : face === 0 ? 9 : 0;
    spr(S_SHIELD_FX, x - 8 + fx, y - 8 + fy);
  }
  if (st & ST_CHARGE) {
    ctx.fillStyle = COL_RED;
    ctx.fillRect(x - 6, y - 16, 12, 1);
  }
  if (v.ctrl[i] > 0) {
    spr(S_CROWN, x - 8, y - 17 - lift);
    const r = roster[v.ctrl[i] - 1];
    if (r && r.used && r.nick) {
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = i === net.entity ? COL_GOLD : COL_MON;
      ctx.fillText(r.nick, x, y - 20 - lift);
      ctx.textAlign = 'left';
    }
  }
  // полоска здоровья
  if (!boss && v.hp[i] < v.maxhp[i]) {
    const wpx = 12;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - wpx / 2, y + 8, wpx, 2);
    ctx.fillStyle = COL_RED;
    ctx.fillRect(x - wpx / 2, y + 8, (wpx * v.hp[i] / v.maxhp[i]) | 0, 2);
  }
}

function drawTear(v, i, x, y) {
  const ex = v.extra[i];
  const big = (ex & 64) !== 0;
  const poison = (ex & 4) !== 0;
  spr(poison ? S_TEAR + 3 : (big ? S_TEAR + 2 : S_TEAR + (v.sub[i] & 1)), x - 8, y - 8);
}

function drawPickup(v, i, x, y, now) {
  const kind = v.sub[i];
  const bob = Math.sin(now / 320 + i) * 1.5;
  if (kind === P_PEDESTAL) {
    spr(S_PEDESTAL, x - 8, y - 4);
    const item = v.extra[i];
    spr(S_ITEM + (item < IT_COUNT ? item : 0), x - 8, y - 14 + bob);
    const price = ITEM_PRICE[item] || 0;
    if (net.roomKind === R_SHOP) {
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = stats.coins >= price ? COL_GOLD : COL_DIM;
      ctx.fillText(NUMS[price], x, y + 12);
      ctx.textAlign = 'left';
    }
    return;
  }
  let s = S_COIN;
  if (kind === P_HEART) s = S_HEART;
  else if (kind === P_HALFHEART) s = S_HEART + 1;
  else if (kind === P_KEY) s = S_KEY;
  else if (kind === P_BOMB) s = S_BOMB;
  spr(s, x - 8, y - 8 + bob);
}

// ─── косметические слёзы, частицы, урон ──────────────────────────────────────

function drawCosmetic(ox, oy) {
  for (let i = 0; i < CT_MAX; i++) {
    if (ctlife[i] <= 0) continue;
    spr(ctbig[i] ? S_TEAR + 2 : S_TEAR + (ctcol[i] & 1), ox + ctx_[i] - 8, oy + cty[i] - 8);
  }
}

function drawParticles(ox, oy) {
  for (let i = 0; i < P_MAX; i++) {
    const l = plife[i];
    if (l <= 0) continue;
    const s = psize[i] * (l / pmax[i] > 0.4 ? 1 : 0.6);
    ctx.fillStyle = PARTICLE_COLORS[pcol[i] & 7];
    ctx.fillRect((ox + px[i]) | 0, (oy + py[i]) | 0, s < 1 ? 1 : s | 0, s < 1 ? 1 : s | 0);
  }
}

function drawDamage(ox, oy) {
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i < D_MAX; i++) {
    if (dlife[i] <= 0) continue;
    ctx.fillStyle = dcol[i] ? COL_RED : COL_TXT;
    ctx.fillText(NUMS[dval[i]], ox + dx[i], oy + dy[i]);
  }
  ctx.textAlign = 'left';
}

// ─── HUD ─────────────────────────────────────────────────────────────────────

function drawHud(now) {
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';

  if (net.side === SIDE_ISAAC) drawIsaacHud();
  else drawMonsterHud(now);

  drawMinimap();
  drawRoster();

  // строка состояния
  ctx.fillStyle = COL_DIM;
  ctx.font = '6px monospace';
  ctx.fillText(NUMS[Math.min(255, Math.round(fps))], 2, VIEW_H - 2);
  ctx.fillText(NUMS[Math.min(255, Math.round(net.ping))], 20, VIEW_H - 2);
  ctx.fillText(NUMS[Math.min(255, Math.round(net.kbpsIn))], 40, VIEW_H - 2);
  ctx.fillStyle = '#3a3440';
  ctx.fillText('fps  ms  kbit', 2, VIEW_H - 9);
}

function drawIsaacHud() {
  const hearts = stats.hearts, maxH = stats.maxHearts;
  const rows = Math.ceil(maxH / 2 / 6);
  for (let i = 0; i < maxH / 2; i++) {
    const cx = 3 + (i % 6) * 11;
    const cy = 2 + ((i / 6) | 0) * 10;
    const filled = hearts - i * 2;
    spr(filled >= 2 ? S_HEART : filled === 1 ? S_HEART + 1 : S_HEART + 2, cx, cy);
  }
  const baseY = 2 + rows * 10;
  spr(S_COIN, 3, baseY);
  ctx.fillStyle = COL_TXT;
  ctx.fillText(NUMS[stats.coins], 15, baseY + 11);
  spr(S_BOMB, 3, baseY + 12);
  ctx.fillText(NUMS[stats.bombs], 15, baseY + 23);
  spr(S_KEY, 3, baseY + 24);
  ctx.fillText(NUMS[stats.keys], 15, baseY + 35);
}

function drawMonsterHud(now) {
  ctx.fillStyle = COL_MON;
  ctx.fillText(T_MONSTERS, 3, 9);
  // кулдаун способности
  const cd = stats.abilityCd;
  const barW = 44;
  ctx.fillStyle = '#000';
  ctx.fillRect(3, 12, barW, 5);
  ctx.fillStyle = cd > 0 ? '#5a4a3a' : COL_GOLD;
  const k = cd > 0 ? 1 - Math.min(1, cd / 6) : 1;
  ctx.fillRect(3, 12, (barW * k) | 0, 5);
  ctx.fillStyle = COL_DIM;
  ctx.font = '6px monospace';
  ctx.fillText('ПРОБЕЛ', 50, 17);
  // рывок
  ctx.fillStyle = '#000';
  ctx.fillRect(3, 19, barW, 4);
  ctx.fillStyle = stats.dashCd > 0 ? '#3a3440' : COL_ISAAC;
  const k2 = stats.dashCd > 0 ? 1 - Math.min(1, stats.dashCd / 1.6) : 1;
  ctx.fillRect(3, 19, (barW * k2) | 0, 4);
  ctx.fillStyle = COL_DIM;
  ctx.fillText('SHIFT', 50, 23);
  ctx.font = '7px monospace';

  // тело и здоровье
  const e = net.entity;
  if (e >= 0 && net.view.type[e] === T_MOB) {
    ctx.fillStyle = COL_TXT;
    ctx.fillText(MOB_NAMES[net.view.sub[e]] || '', 3, 32);
    const hp = net.view.hp[e], mx = net.view.maxhp[e] || 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(3, 34, 44, 4);
    ctx.fillStyle = COL_GREEN;
    ctx.fillRect(3, 34, (44 * hp / mx) | 0, 4);
  } else {
    ctx.fillStyle = COL_GOLD;
    ctx.fillText(T_SPIRIT, 3, 32);
  }
  // бюджет волны
  ctx.fillStyle = COL_DIM;
  ctx.font = '6px monospace';
  ctx.fillText('ВОЛНА', 3, 46);
  ctx.fillStyle = '#000';
  ctx.fillRect(26, 41, 30, 4);
  ctx.fillStyle = COL_MON;
  ctx.fillRect(26, 41, Math.min(30, stats.budget) | 0, 4);
  ctx.font = '7px monospace';
}

const MM_CELL = 8, MM_GAP = 1;
function drawMinimap() {
  const n = mapN.n;
  if (n === 0) return;
  const spanX = (mapN.maxX - mapN.minX + 1), spanY = (mapN.maxY - mapN.minY + 1);
  const wpx = spanX * (MM_CELL + MM_GAP), hpx = spanY * (MM_CELL + MM_GAP);
  const x0 = VIEW_W - wpx - 3, y0 = 3;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x0 - 2, y0 - 2, wpx + 4, hpx + 4);
  for (let i = 0; i < n; i++) {
    const vis = mapVisible(i);
    if (!vis) continue;
    const rx = x0 + (mapX[i] - mapN.minX) * (MM_CELL + MM_GAP);
    const ry = y0 + (mapY[i] - mapN.minY) * (MM_CELL + MM_GAP);
    const kind = mapKind[i];
    let col = vis === 2 ? '#4a4458' : '#241f2c';
    if (i === mapN.cur) col = COL_TXT;
    else if (kind === R_BOSS && vis === 2) col = COL_RED;
    else if (kind === R_SHOP && vis === 2) col = COL_GOLD;
    else if (kind === R_TREASURE && vis === 2) col = COL_ISAAC;
    else if (kind === R_SECRET) col = '#6a4a8a';
    ctx.fillStyle = col;
    ctx.fillRect(rx, ry, MM_CELL, MM_CELL);
    if (vis === 2 && (mapFlags[i] & 1) === 0 && i !== mapN.cur) {
      ctx.fillStyle = COL_RED;
      ctx.fillRect(rx + 3, ry + 3, 2, 2);
    }
  }
}

function drawRoster() {
  let y = VIEW_H - 40;
  ctx.font = '6px monospace';
  for (let i = 0; i < roster.length; i++) {
    const r = roster[i];
    if (!r.used) continue; // слоты бывают разрежены — идём по всем
    ctx.fillStyle = r.side === SIDE_ISAAC ? COL_ISAAC : COL_MON;
    if (r.slot === net.slot) ctx.fillStyle = COL_GOLD;
    let label = r.nick;
    if (r.flags & 1) label = r.nick; // бот
    ctx.fillText(label, VIEW_W - 74, y);
    if (r.flags & 1) { ctx.fillStyle = COL_DIM; ctx.fillText('ии', VIEW_W - 12, y); }
    else if (r.flags & 2) { ctx.fillStyle = COL_DIM; ctx.fillText('дух', VIEW_W - 16, y); }
    else if (r.flags & 4) { ctx.fillStyle = COL_RED; ctx.fillText('лёг', VIEW_W - 16, y); }
    y += 7;
  }
  ctx.font = '7px monospace';
}

// ─── оверлеи ─────────────────────────────────────────────────────────────────

function drawOverlays(now) {
  ctx.textAlign = 'center';
  if (net.status === 0) {
    dim();
    ctx.fillStyle = COL_TXT;
    ctx.font = '10px monospace';
    ctx.fillText(T_TITLE, VIEW_W / 2, VIEW_H / 2 - 8);
    ctx.font = '7px monospace';
    ctx.fillStyle = COL_DIM;
    ctx.fillText(T_CONNECT, VIEW_W / 2, VIEW_H / 2 + 6);
  } else if (net.status === 2) {
    dim();
    ctx.fillStyle = COL_RED;
    ctx.font = '9px monospace';
    ctx.fillText(T_LOST, VIEW_W / 2, VIEW_H / 2);
  } else if (net.winner >= 0) {
    dim();
    ctx.font = '11px monospace';
    ctx.fillStyle = net.winner === SIDE_ISAAC ? COL_ISAAC : COL_MON;
    ctx.fillText(net.winner === SIDE_ISAAC ? T_WIN_I : T_WIN_M, VIEW_W / 2, VIEW_H / 2 - 10);
    ctx.font = '7px monospace';
    ctx.fillStyle = COL_TXT;
    ctx.fillText(T_NEXT, VIEW_W / 2, VIEW_H / 2 + 6);
    ctx.fillStyle = COL_ISAAC;
    ctx.fillText(NUMS[net.scoreIsaac], VIEW_W / 2 - 20, VIEW_H / 2 + 20);
    ctx.fillStyle = COL_DIM;
    ctx.fillText(':', VIEW_W / 2, VIEW_H / 2 + 20);
    ctx.fillStyle = COL_MON;
    ctx.fillText(NUMS[net.scoreMonster], VIEW_W / 2 + 20, VIEW_H / 2 + 20);
  } else if (net.side === SIDE_MONSTER && stats.spirit > 0 && net.entity < 0) {
    ctx.fillStyle = COL_GOLD;
    ctx.font = '8px monospace';
    ctx.fillText(T_SPIRIT, VIEW_W / 2, 40);
    spr(S_SPIRIT, ROOM_OX + net.spiritX - 8, net.spiritY - 8);
  } else if (net.side === SIDE_ISAAC && (net.view.state[net.entity] & ST_DOWN)) {
    ctx.fillStyle = COL_RED;
    ctx.font = '9px monospace';
    ctx.fillText(T_DOWN, VIEW_W / 2, 40);
  }

  if (net.roomKind === R_BOSS) {
    drawBossBar();
  }

  if (input.helpOpen) {
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(60, 50, VIEW_W - 120, 100);
    ctx.fillStyle = COL_TXT;
    ctx.font = '7px monospace';
    for (let i = 0; i < HELP.length; i++) ctx.fillText(HELP[i], VIEW_W / 2, 66 + i * 12);
  }

  // прицел
  if (net.status === 1) {
    ctx.textAlign = 'left';
    spr(S_RETICLE, input.mx - 8, input.my - 8);
  }
  ctx.textAlign = 'left';
}

function drawBossBar() {
  const v = net.view;
  let boss = -1;
  for (let i = 0; i < v.high; i++) {
    if (v.present[i] && v.type[i] === T_MOB && v.sub[i] === M_BOSS) { boss = i; break; }
  }
  if (boss < 0) return;
  const w = 180, x = (VIEW_W - w) / 2, y = VIEW_H - 16;
  ctx.fillStyle = '#000';
  ctx.fillRect(x - 1, y - 1, w + 2, 7);
  ctx.fillStyle = COL_RED;
  ctx.fillRect(x, y, (w * v.hp[boss] / (v.maxhp[boss] || 1)) | 0, 5);
  ctx.fillStyle = COL_TXT;
  ctx.font = '6px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(T_BOSS, VIEW_W / 2, y - 3);
}

function dim() {
  ctx.fillStyle = 'rgba(6,4,8,0.72)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
}
