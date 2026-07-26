// tools/atlas.mjs — процедурная генерация спрайтшита в PNG-8.
// Ни одного бинарного ассета в репозитории: всё рисуется кодом, палитра ≤ 64
// цветов, PNG собирается вручную (IHDR/PLTE/tRNS/IDAT/IEND) через node:zlib.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  A_W, A_H, CELL, CELL_COLS, TILE, TILE_BAND_Y, TILE_COLS, BIG, BIG_BAND_Y, BIG_COLS,
  S_ISAAC_BODY, S_ISAAC_HEAD, S_ISAAC_GHOST, S_ISAAC2_BODY, S_ISAAC2_HEAD, S_ISAAC2_GHOST,
  S_TEAR, S_MOB, S_SHOT, S_SHIELD_FX, S_CROWN, S_HEART, S_COIN, S_KEY, S_BOMB,
  S_BOMB_LIT, S_PEDESTAL, S_ITEM, S_BOOM, S_SPIRIT, S_SHADOW, S_RETICLE, S_LOCK, S_ARROW,
  TS_FLOOR, TS_WALL, TS_ROCK, TS_PIT, TS_SPIKE, TS_DOOR, TS_DOOR_OPEN, TS_RUBBLE,
  TS_HATCH, TS_FLOOR_SHOP, TS_FLOOR_BOSS, TS_FLOOR_TREASURE,
  B_BOSS, B_BLAST, IT_COUNT,
} from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'atlas.png');

// ─── палитра (индекс 0 — прозрачный) ─────────────────────────────────────────

const PAL = [
  [0, 0, 0],        // 0  прозрачный
  [8, 6, 10],       // 1  контур
  [26, 20, 32],     // 2  тень объекта
  [42, 34, 48],     // 3  пол тёмный
  [58, 48, 64],     // 4  пол средний
  [74, 62, 80],     // 5  пол светлый
  [36, 28, 40],     // 6  стена тёмная
  [58, 46, 60],     // 7  стена средняя
  [87, 72, 90],     // 8  стена светлая
  [74, 64, 72],     // 9  камень тёмный
  [106, 92, 102],   // 10 камень
  [138, 124, 134],  // 11 камень светлый
  [200, 154, 106],  // 12 кожа тёмная
  [240, 200, 154],  // 13 кожа
  [255, 230, 200],  // 14 кожа светлая
  [138, 32, 32],    // 15 красный тёмный
  [212, 58, 58],    // 16 красный
  [255, 106, 106],  // 17 красный светлый
  [42, 74, 138],    // 18 синий тёмный
  [74, 138, 212],   // 19 синий
  [143, 216, 255],  // 20 синий светлый
  [42, 106, 58],    // 21 зелёный тёмный
  [74, 168, 90],    // 22 зелёный
  [126, 224, 138],  // 23 зелёный светлый
  [168, 122, 32],   // 24 золото тёмное
  [224, 176, 64],   // 25 золото
  [255, 210, 87],   // 26 золото светлое
  [74, 42, 106],    // 27 фиолет тёмный
  [122, 74, 168],   // 28 фиолет
  [176, 106, 223],  // 29 фиолет светлый
  [240, 232, 220],  // 30 белый
  [122, 111, 99],   // 31 серый
  [58, 42, 26],     // 32 коричневый тёмный
  [90, 74, 58],     // 33 коричневый
  [138, 122, 90],   // 34 коричневый светлый
  [160, 74, 74],    // 35 плоть тёмная
  [212, 106, 106],  // 36 плоть
  [255, 154, 154],  // 37 плоть светлая
  [58, 106, 42],    // 38 слизь тёмная
  [106, 168, 74],   // 39 слизь
  [154, 216, 106],  // 40 слизь светлая
  [216, 208, 192],  // 41 кость
  [0, 0, 0],        // 42 тень (полупрозрачная через tRNS)
  [10, 8, 16],      // 43 яма тёмная
  [22, 18, 30],     // 44 яма
  [106, 216, 216],  // 45 циан
  [224, 122, 48],   // 46 оранжевый
  [224, 106, 176],  // 47 розовый
  [58, 68, 80],     // 48 сталь тёмная
  [90, 106, 122],   // 49 сталь
  [138, 154, 170],  // 50 сталь светлая
  [240, 224, 96],   // 51 жёлтый
  [42, 20, 24],     // 52 бордовый фон
  [150, 60, 150],   // 53 маджента
  [24, 60, 60],     // 54 тёмный циан
  [190, 190, 200],  // 55 светло-серый
];
const ALPHA = new Uint8Array(PAL.length).fill(255);
ALPHA[0] = 0;
ALPHA[42] = 96; // мягкая тень

// ─── холст с индексами палитры ───────────────────────────────────────────────

const img = new Uint8Array(A_W * A_H); // 0 = прозрачный

let OX = 0, OY = 0;
function p(x, y, c) {
  const ax = OX + x, ay = OY + y;
  if (ax < 0 || ay < 0 || ax >= A_W || ay >= A_H) return;
  img[ay * A_W + ax] = c;
}
function get(x, y) {
  const ax = OX + x, ay = OY + y;
  if (ax < 0 || ay < 0 || ax >= A_W || ay >= A_H) return 0;
  return img[ay * A_W + ax];
}
function rect(x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p(x + i, y + j, c);
}
function disc(cx, cy, r, c) {
  const r2 = r * r;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      if (i * i + j * j <= r2) p(cx + i, cy + j, c);
    }
  }
}
function ellipse(cx, cy, rx, ry, c) {
  for (let j = -ry; j <= ry; j++) {
    for (let i = -rx; i <= rx; i++) {
      if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) p(cx + i, cy + j, c);
    }
  }
}
/** Обводит непрозрачные пиксели в прямоугольнике контуром c. */
function outline(x0, y0, w, h, c) {
  const copy = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) copy.push(get(x0 + i, y0 + j));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (copy[j * w + i] !== 0) continue;
      const up = j > 0 ? copy[(j - 1) * w + i] : 0;
      const dn = j < h - 1 ? copy[(j + 1) * w + i] : 0;
      const lf = i > 0 ? copy[j * w + i - 1] : 0;
      const rt = i < w - 1 ? copy[j * w + i + 1] : 0;
      if ((up && up !== c) || (dn && dn !== c) || (lf && lf !== c) || (rt && rt !== c)) p(x0 + i, y0 + j, c);
    }
  }
}

function mul32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function atSmall(i) { OX = (i % CELL_COLS) * CELL; OY = ((i / CELL_COLS) | 0) * CELL; }
function atTile(i) { OX = (i % TILE_COLS) * TILE; OY = TILE_BAND_Y + ((i / TILE_COLS) | 0) * TILE; }
function atBig(i) { OX = (i % BIG_COLS) * BIG; OY = BIG_BAND_Y + ((i / BIG_COLS) | 0) * BIG; }

// ─── персонажи ───────────────────────────────────────────────────────────────

function isaacBody(idx, frame, cDark, cMid, cLite) {
  atSmall(idx);
  // туловище-подгузник
  rect(5, 6, 6, 3, cLite);
  rect(5, 9, 6, 2, 30);
  // ноги
  if (frame === 0) {
    rect(4, 11, 3, 3, cMid);
    rect(9, 11, 3, 3, cMid);
  } else {
    rect(3, 11, 3, 2, cMid);
    rect(10, 11, 3, 4, cMid);
  }
  rect(4, 14, 3, 1, cDark);
  rect(9, 14, 3, 1, cDark);
  outline(2, 4, 12, 12, 1);
}

function isaacHead(idx, dir, cDark, cMid, cLite) {
  atSmall(idx);
  // голова
  ellipse(8, 8, 6, 5, cMid);
  ellipse(8, 7, 5, 4, cLite);
  rect(3, 10, 11, 2, cDark);
  if (dir === 0) { // вниз — глаза с грустью
    rect(5, 7, 2, 2, 1);
    rect(10, 7, 2, 2, 1);
    rect(5, 9, 2, 1, 20);
    rect(10, 9, 2, 1, 20);
  } else if (dir === 2) { // вбок
    rect(9, 7, 2, 2, 1);
    rect(12, 7, 1, 2, 1);
  }
  outline(1, 2, 14, 12, 1);
}

function ghost(idx, cMid) {
  atSmall(idx);
  ellipse(8, 8, 5, 5, cMid);
  rect(3, 11, 10, 3, cMid);
  p(4, 14, 0); p(7, 14, 0); p(10, 14, 0); p(12, 14, 0);
  rect(5, 6, 2, 2, 1);
  rect(9, 6, 2, 2, 1);
  outline(2, 2, 12, 13, 1);
}

// ─── мобы ────────────────────────────────────────────────────────────────────

function mobCrawler(idx, f) {
  atSmall(idx);
  ellipse(8, 9 + f, 5, 4, 35);
  ellipse(8, 8 + f, 4, 3, 36);
  rect(5, 6 + f, 2, 2, 1);
  rect(9, 6 + f, 2, 2, 1);
  // лапки
  rect(2, 11 + f, 3, 1, 35);
  rect(11, 11 + f, 3, 1, 35);
  rect(3, 12 + f, 1, 2, 15);
  rect(12, 12 + f, 1, 2, 15);
  outline(1, 3, 14, 12, 1);
}

function mobSpitter(idx, f) {
  atSmall(idx);
  ellipse(8, 9, 5, 5 - f, 38);
  ellipse(8, 8, 4, 3, 39);
  // пасть
  rect(5, 11, 6, 2, 1);
  rect(6, 12, 1, 1, 40);
  rect(9, 12, 1, 1, 40);
  rect(5, 5, 2, 2, 30);
  rect(9, 5, 2, 2, 30);
  rect(6, 6, 1, 1, 1);
  rect(10, 6, 1, 1, 1);
  outline(1, 2, 14, 13, 1);
}

function mobSplitter(idx, f) {
  atSmall(idx);
  ellipse(8, 9, 6, 5 + f, 27);
  ellipse(7, 8, 4, 3, 28);
  ellipse(10, 10, 3, 2, 29);
  rect(5, 7, 2, 2, 1);
  rect(10, 7, 2, 2, 1);
  rect(6, 12, 5, 1, 27);
  outline(0, 2, 16, 14, 1);
}

function mobHopper(idx, f) {
  atSmall(idx);
  const y = f ? 6 : 8;
  ellipse(8, y, 5, 4, 22);
  ellipse(8, y - 1, 4, 3, 23);
  rect(5, y - 2, 2, 2, 30);
  rect(9, y - 2, 2, 2, 30);
  rect(6, y - 1, 1, 1, 1);
  rect(10, y - 1, 1, 1, 1);
  // лапы
  rect(3, y + 3, 3, 2, 21);
  rect(10, y + 3, 3, 2, 21);
  outline(1, 1, 14, 14, 1);
}

function mobShielder(idx, f) {
  atSmall(idx);
  ellipse(9, 9, 4, 5, 48);
  ellipse(9, 8, 3, 4, 49);
  rect(7, 6, 2, 2, 17);
  rect(11, 6, 1, 2, 17);
  // щит слева
  rect(2, 3 + f, 3, 11, 50);
  rect(3, 4 + f, 1, 9, 55);
  rect(2, 8 + f, 3, 1, 25);
  outline(1, 1, 14, 14, 1);
}

function mobSpawn(idx, f) {
  atSmall(idx);
  ellipse(8, 9 + f, 3, 3, 15);
  ellipse(8, 8 + f, 2, 2, 16);
  rect(6, 7 + f, 1, 1, 1);
  rect(9, 7 + f, 1, 1, 1);
  outline(3, 4, 10, 10, 1);
}

function mobBossSmall(idx, f) {
  atSmall(idx);
  ellipse(8, 9, 6, 5, 35);
  ellipse(8, 8, 5, 4, 36);
  rect(4, 6, 3, 3, 30);
  rect(9, 6, 3, 3, 30);
  rect(5, 7, 1, 2, 16);
  rect(10, 7, 1, 2, 16);
  rect(5, 12, 6, 2, 15);
  outline(0, 2, 16, 14, 1);
}

// ─── босс 32×32 ──────────────────────────────────────────────────────────────

function boss(idx, variant) {
  atBig(idx);
  const body = variant === 2 ? 15 : 35;
  const lite = variant === 2 ? 16 : 36;
  const bob = variant === 1 ? 1 : 0;
  // туша
  ellipse(16, 19 + bob, 12, 10, body);
  ellipse(16, 17 + bob, 10, 8, lite);
  // складки
  rect(6, 22 + bob, 20, 1, body);
  rect(8, 25 + bob, 16, 1, body);
  // глаза
  disc(11, 14 + bob, 3, 30);
  disc(21, 14 + bob, 3, 30);
  disc(11, 15 + bob, 1, 1);
  disc(21, 15 + bob, 1, 1);
  if (variant === 2) { p(11, 14 + bob, 16); p(21, 14 + bob, 16); }
  // пасть
  rect(10, 22 + bob, 12, 3, 1);
  for (let i = 0; i < 5; i++) p(11 + i * 2, 22 + bob, 41);
  for (let i = 0; i < 5; i++) p(11 + i * 2, 24 + bob, 41);
  // рожки
  rect(4, 8 + bob, 2, 4, 41);
  rect(26, 8 + bob, 2, 4, 41);
  outline(0, 2, 32, 30, 1);
}

// ─── снаряды и мелочь ────────────────────────────────────────────────────────

function tear(idx, r, cDark, cMid, cLite) {
  atSmall(idx);
  disc(8, 8, r, cMid);
  disc(8, 8, r - 1, cLite);
  p(7 - (r > 3 ? 1 : 0), 7 - (r > 3 ? 1 : 0), 30);
  disc(8, 8 + r, 0, cDark);
  outline(8 - r - 1, 8 - r - 1, r * 2 + 3, r * 2 + 3, 1);
}

function shot(idx, f) {
  atSmall(idx);
  disc(8, 8, 3 + f, 27);
  disc(8, 8, 2 + f, 29);
  p(7, 7, 30);
  outline(3, 3, 10, 10, 1);
}

function shieldFx(idx) {
  atSmall(idx);
  for (let j = 0; j < 14; j++) {
    p(6, 1 + j, 50);
    p(7, 1 + j, 55);
  }
  p(6, 0, 25); p(6, 15, 25);
}

function crown(idx) {
  atSmall(idx);
  rect(4, 8, 8, 3, 25);
  p(4, 5, 26); p(4, 6, 26); p(4, 7, 26);
  p(8, 4, 26); p(8, 5, 26); p(8, 6, 26); p(8, 7, 26);
  p(11, 5, 26); p(11, 6, 26); p(11, 7, 26);
  rect(5, 9, 6, 1, 24);
  outline(3, 3, 10, 10, 1);
}

function heart(idx, kind) {
  atSmall(idx);
  const fill = kind === 2 ? 2 : 16;
  const lite = kind === 2 ? 6 : 17;
  const shape = [
    '..XX..XX..',
    '.XXXXXXXX.',
    'XXXXXXXXXX',
    'XXXXXXXXXX',
    'XXXXXXXXXX',
    '.XXXXXXXX.',
    '..XXXXXX..',
    '...XXXX...',
    '....XX....',
  ];
  for (let j = 0; j < shape.length; j++) {
    for (let i = 0; i < shape[j].length; i++) {
      if (shape[j][i] !== 'X') continue;
      const half = kind === 1 && i >= 5;
      p(3 + i, 3 + j, half ? 2 : (j < 3 && i > 1 && i < 4 ? lite : fill));
    }
  }
  outline(1, 1, 14, 14, 1);
}

function coin(idx) {
  atSmall(idx);
  disc(8, 8, 5, 24);
  disc(8, 8, 4, 25);
  disc(8, 7, 2, 26);
  rect(7, 5, 2, 7, 24);
  outline(2, 2, 12, 12, 1);
}

function key(idx) {
  atSmall(idx);
  disc(6, 6, 3, 25);
  disc(6, 6, 1, 0);
  rect(7, 8, 2, 6, 25);
  rect(9, 11, 3, 1, 25);
  rect(9, 13, 2, 1, 25);
  outline(2, 2, 12, 13, 1);
}

function bomb(idx, lit) {
  atSmall(idx);
  disc(8, 10, 5, 48);
  disc(7, 9, 3, 49);
  p(6, 8, 55);
  rect(8, 3, 2, 3, 33);
  if (lit) { p(9, 1, 26); p(10, 2, 46); p(8, 1, 51); }
  outline(2, 0, 13, 16, 1);
}

function pedestal(idx) {
  atSmall(idx);
  rect(3, 8, 10, 3, 8);
  rect(5, 11, 6, 3, 7);
  rect(3, 14, 10, 2, 6);
  rect(4, 8, 8, 1, 11);
  outline(2, 7, 12, 9, 1);
}

const ITEM_COL = [16, 26, 20, 23, 45, 55, 29, 40, 19, 17, 36, 30, 48, 51];
const ITEM_GLYPH = [
  'up', 'dots', 'arrowR', 'ring', 'bolt', 'bar', 'eye', 'drop',
  'zig', 'trident', 'heart', 'big', 'square', 'star',
];

function itemIcon(idx, k) {
  atSmall(idx);
  const c = ITEM_COL[k];
  disc(8, 8, 5, 2);
  disc(8, 8, 4, c);
  const g = ITEM_GLYPH[k];
  if (g === 'up') { rect(7, 5, 2, 6, 30); p(6, 6, 30); p(10, 6, 30); }
  else if (g === 'dots') { p(6, 6, 1); p(10, 6, 1); p(6, 10, 1); p(10, 10, 1); p(8, 8, 30); }
  else if (g === 'arrowR') { rect(5, 8, 6, 1, 30); p(9, 6, 30); p(10, 7, 30); p(9, 10, 30); p(10, 9, 30); }
  else if (g === 'ring') { disc(8, 8, 3, 30); disc(8, 8, 2, c); }
  else if (g === 'bolt') { p(9, 5, 30); p(8, 6, 30); p(8, 7, 30); p(9, 8, 30); p(7, 9, 30); p(7, 10, 30); }
  else if (g === 'bar') { rect(5, 7, 7, 2, 30); }
  else if (g === 'eye') { ellipse(8, 8, 4, 2, 30); disc(8, 8, 1, 1); }
  else if (g === 'drop') { disc(8, 9, 2, 30); p(8, 5, 30); p(8, 6, 30); p(7, 7, 30); p(9, 7, 30); }
  else if (g === 'zig') { p(6, 6, 30); p(7, 7, 30); p(8, 6, 30); p(9, 7, 30); p(10, 6, 30); rect(6, 9, 5, 1, 30); }
  else if (g === 'trident') { rect(5, 6, 1, 5, 30); rect(8, 5, 1, 6, 30); rect(11, 6, 1, 5, 30); }
  else if (g === 'heart') { rect(6, 7, 5, 2, 30); rect(7, 9, 3, 1, 30); p(8, 10, 30); }
  else if (g === 'big') { disc(8, 8, 3, 30); }
  else if (g === 'square') { rect(6, 6, 5, 5, 30); rect(7, 7, 3, 3, c); }
  else if (g === 'star') { p(8, 4, 30); rect(7, 6, 3, 3, 30); rect(5, 7, 7, 1, 30); p(6, 10, 30); p(10, 10, 30); }
  outline(2, 2, 12, 12, 1);
}

function boom(idx, stage) {
  atSmall(idx);
  const r = 3 + stage * 2;
  disc(8, 8, r, 46);
  disc(8, 8, r - 1, 26);
  if (stage === 2) { disc(8, 8, r - 3, 51); }
  outline(0, 0, 16, 16, 1);
}

function spirit(idx) {
  atSmall(idx);
  ellipse(8, 7, 4, 4, 45);
  ellipse(8, 6, 3, 3, 20);
  rect(5, 10, 6, 3, 45);
  p(5, 13, 45); p(8, 13, 45); p(11, 13, 45);
  rect(6, 5, 1, 2, 1);
  rect(9, 5, 1, 2, 1);
}

function shadowSpr(idx) {
  atSmall(idx);
  ellipse(8, 12, 6, 2, 42);
}

function reticle(idx) {
  atSmall(idx);
  rect(7, 2, 2, 3, 30);
  rect(7, 11, 2, 3, 30);
  rect(2, 7, 3, 2, 30);
  rect(11, 7, 3, 2, 30);
  p(8, 8, 17);
}

function lock(idx) {
  atSmall(idx);
  rect(4, 8, 8, 6, 25);
  rect(6, 4, 4, 4, 24);
  rect(7, 5, 2, 3, 0);
  p(8, 10, 1); p(8, 11, 1);
  outline(3, 3, 10, 12, 1);
}

function arrow(idx) {
  atSmall(idx);
  rect(7, 4, 2, 9, 30);
  p(6, 5, 30); p(5, 6, 30); p(9, 5, 30); p(10, 6, 30);
}

// ─── тайлы 30×30 ─────────────────────────────────────────────────────────────

function floorTile(idx, variant, base, mid, lite) {
  atTile(idx);
  const rnd = mul32(1337 + variant * 77 + base * 13);
  rect(0, 0, TILE, TILE, base);
  for (let i = 0; i < 40; i++) {
    const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0;
    p(x, y, rnd() < 0.5 ? mid : base);
  }
  if (variant === 1) {
    for (let i = 0; i < 8; i++) { const x = (rnd() * 26) | 0, y = (rnd() * 26) | 0; rect(x, y, 2, 1, lite); }
  } else if (variant === 2) {
    disc(((rnd() * 20) | 0) + 5, ((rnd() * 20) | 0) + 5, 3, mid);
    disc(((rnd() * 20) | 0) + 5, ((rnd() * 20) | 0) + 5, 2, lite);
  }
  // едва заметная сетка
  for (let i = 0; i < TILE; i++) { p(i, 0, mid); p(0, i, mid); }
}

function wallTile(idx) {
  atTile(idx);
  const rnd = mul32(4242);
  rect(0, 0, TILE, TILE, 6);
  // кирпичи
  for (let row = 0; row < 3; row++) {
    const y = row * 10;
    rect(0, y, TILE, 9, 7);
    for (let bx = (row % 2) * -7; bx < TILE; bx += 14) rect(bx + 13, y, 1, 9, 6);
    rect(0, y + 9, TILE, 1, 6);
    for (let i = 0; i < 12; i++) p((rnd() * TILE) | 0, y + ((rnd() * 9) | 0), 8);
  }
  rect(0, 0, TILE, 1, 8);
}

function rockTile(idx) {
  atTile(idx);
  disc(15, 17, 11, 9);
  disc(14, 15, 9, 10);
  disc(12, 13, 5, 11);
  const rnd = mul32(99);
  for (let i = 0; i < 22; i++) p(((rnd() * 22) | 0) + 4, ((rnd() * 22) | 0) + 4, 9);
  outline(2, 4, 26, 26, 1);
}

function rubbleTile(idx) {
  atTile(idx);
  const rnd = mul32(555);
  for (let i = 0; i < 9; i++) {
    const x = ((rnd() * 22) | 0) + 4, y = ((rnd() * 12) | 0) + 14;
    disc(x, y, 2 + ((rnd() * 2) | 0), 9);
    p(x, y - 1, 10);
  }
}

function pitTile(idx) {
  atTile(idx);
  rect(0, 0, TILE, TILE, 44);
  ellipse(15, 16, 13, 12, 43);
  rect(0, 0, TILE, 3, 2);
  for (let i = 0; i < TILE; i++) p(i, 2, 44);
}

function spikeTile(idx) {
  atTile(idx);
  rect(0, 0, TILE, TILE, 3);
  for (let k = 0; k < 4; k++) {
    const cx = 5 + k * 7;
    for (let j = 0; j < 9; j++) {
      const w = 1 + ((8 - j) >> 1);
      rect(cx - (w >> 1), 20 - j, w, 1, j > 5 ? 55 : 50);
    }
    rect(cx - 3, 21, 6, 2, 48);
  }
}

function doorTile(idx, open) {
  atTile(idx);
  rect(0, 0, TILE, TILE, 6);
  if (open) {
    rect(4, 2, 22, 26, 1);
    rect(6, 4, 18, 24, 43);
    rect(6, 4, 18, 2, 2);
  } else {
    rect(3, 1, 24, 28, 32);
    rect(5, 3, 20, 24, 33);
    for (let i = 0; i < 4; i++) rect(5, 4 + i * 6, 20, 1, 32);
    rect(13, 12, 5, 6, 25);
    rect(14, 14, 3, 3, 24);
    outline(2, 0, 27, 30, 1);
  }
}

function hatchTile(idx) {
  atTile(idx);
  rect(0, 0, TILE, TILE, 3);
  disc(15, 15, 12, 48);
  disc(15, 15, 10, 49);
  disc(15, 15, 4, 43);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    p(15 + Math.round(Math.cos(a) * 8), 15 + Math.round(Math.sin(a) * 8), 55);
  }
  outline(1, 1, 28, 28, 1);
}

// ─── сборка листа ────────────────────────────────────────────────────────────

function drawAll() {
  // Айзеки
  isaacBody(S_ISAAC_BODY, 0, 12, 13, 14);
  isaacBody(S_ISAAC_BODY + 1, 1, 12, 13, 14);
  isaacHead(S_ISAAC_HEAD, 0, 12, 13, 14);
  isaacHead(S_ISAAC_HEAD + 1, 1, 12, 13, 14);
  isaacHead(S_ISAAC_HEAD + 2, 2, 12, 13, 14);
  ghost(S_ISAAC_GHOST, 20);

  isaacBody(S_ISAAC2_BODY, 0, 35, 36, 37);
  isaacBody(S_ISAAC2_BODY + 1, 1, 35, 36, 37);
  isaacHead(S_ISAAC2_HEAD, 0, 35, 36, 37);
  isaacHead(S_ISAAC2_HEAD + 1, 1, 35, 36, 37);
  isaacHead(S_ISAAC2_HEAD + 2, 2, 35, 36, 37);
  ghost(S_ISAAC2_GHOST, 29);

  // слёзы
  tear(S_TEAR, 2, 18, 19, 20);
  tear(S_TEAR + 1, 3, 18, 19, 20);
  tear(S_TEAR + 2, 4, 18, 19, 30);
  tear(S_TEAR + 3, 3, 38, 39, 40);

  // мобы
  mobCrawler(S_MOB + 0, 0); mobCrawler(S_MOB + 1, 1);
  mobSpitter(S_MOB + 2, 0); mobSpitter(S_MOB + 3, 1);
  mobSplitter(S_MOB + 4, 0); mobSplitter(S_MOB + 5, 1);
  mobHopper(S_MOB + 6, 0); mobHopper(S_MOB + 7, 1);
  mobShielder(S_MOB + 8, 0); mobShielder(S_MOB + 9, 1);
  mobSpawn(S_MOB + 10, 0); mobSpawn(S_MOB + 11, 1);
  mobBossSmall(S_MOB + 12, 0); mobBossSmall(S_MOB + 13, 1);

  shot(S_SHOT, 0); shot(S_SHOT + 1, 1);
  shieldFx(S_SHIELD_FX);
  crown(S_CROWN);
  heart(S_HEART, 0); heart(S_HEART + 1, 1); heart(S_HEART + 2, 2);
  coin(S_COIN);
  key(S_KEY);
  bomb(S_BOMB, 0);
  bomb(S_BOMB_LIT, 1);
  pedestal(S_PEDESTAL);
  for (let k = 0; k < IT_COUNT; k++) itemIcon(S_ITEM + k, k);
  boom(S_BOOM, 0); boom(S_BOOM + 1, 1); boom(S_BOOM + 2, 2);
  spirit(S_SPIRIT);
  shadowSpr(S_SHADOW);
  reticle(S_RETICLE);
  lock(S_LOCK);
  arrow(S_ARROW);

  // тайлы
  floorTile(TS_FLOOR, 0, 3, 4, 5);
  floorTile(TS_FLOOR + 1, 1, 3, 4, 5);
  floorTile(TS_FLOOR + 2, 2, 3, 4, 5);
  wallTile(TS_WALL);
  rockTile(TS_ROCK);
  pitTile(TS_PIT);
  spikeTile(TS_SPIKE);
  doorTile(TS_DOOR, 0);
  doorTile(TS_DOOR_OPEN, 1);
  rubbleTile(TS_RUBBLE);
  hatchTile(TS_HATCH);
  floorTile(TS_FLOOR_SHOP, 1, 32, 33, 34);
  floorTile(TS_FLOOR_BOSS, 2, 52, 15, 35);
  floorTile(TS_FLOOR_TREASURE, 1, 27, 28, 29);

  // босс
  boss(B_BOSS, 0);
  boss(B_BOSS + 1, 1);
  boss(B_BOSS + 2, 2);
  atBig(B_BLAST);
  disc(16, 16, 15, 46);
  disc(16, 16, 11, 26);
  disc(16, 16, 6, 51);
}

// ─── PNG-8 ───────────────────────────────────────────────────────────────────

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

function encodePng8() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(A_W, 0);
  ihdr.writeUInt32BE(A_H, 4);
  ihdr[8] = 8;  // бит на пиксель
  ihdr[9] = 3;  // цветовой тип: палитра
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = Buffer.alloc(PAL.length * 3);
  for (let i = 0; i < PAL.length; i++) {
    plte[i * 3] = PAL[i][0];
    plte[i * 3 + 1] = PAL[i][1];
    plte[i * 3 + 2] = PAL[i][2];
  }

  // tRNS обрезаем по последнему индексу с alpha < 255
  let lastAlpha = 0;
  for (let i = 0; i < ALPHA.length; i++) if (ALPHA[i] !== 255) lastAlpha = i;
  const trns = Buffer.from(ALPHA.subarray(0, lastAlpha + 1));

  // фильтр 0 (None) на каждую строку
  const raw = Buffer.alloc((A_W + 1) * A_H);
  for (let y = 0; y < A_H; y++) {
    raw[y * (A_W + 1)] = 0;
    for (let x = 0; x < A_W; x++) raw[y * (A_W + 1) + 1 + x] = img[y * A_W + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── запуск ──────────────────────────────────────────────────────────────────

export function buildAtlas() {
  img.fill(0);
  drawAll();
  const png = encodePng8();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  let used = 0;
  const seen = new Uint8Array(256);
  for (let i = 0; i < img.length; i++) if (!seen[img[i]]) { seen[img[i]] = 1; used++; }
  return { bytes: png.length, colors: PAL.length, used };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('atlas.mjs')) {
  const r = buildAtlas();
  console.log(`[atlas] ${A_W}×${A_H} PNG-8, ${(r.bytes / 1024).toFixed(1)} КБ, палитра ${r.colors} (использовано ${r.used})`);
}
