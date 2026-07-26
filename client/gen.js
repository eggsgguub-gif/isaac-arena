// client/gen.js — детерминированный декор комнаты и данные мини-карты.
// Тайлы приходят с сервера (в них учтены разрушения), здесь только внешний вид.

import { mulberry32, hash2 } from '../shared/sim.js';
import {
  ROOM_W, ROOM_H, ROOM_TILES, TILE,
  TL_FLOOR, TL_WALL, TL_ROCK, TL_PIT, TL_SPIKE, TL_DOOR, TL_DOOR_OPEN, TL_SECRET,
  TL_RUBBLE, TL_HATCH,
  R_START, R_NORMAL, R_TREASURE, R_SHOP, R_BOSS, R_SECRET,
  FMAP_W, FMAP_H,
} from '../shared/constants.js';

// вариант тайла пола на каждую клетку (0..2) и мелкий мусор
export const floorVar = new Uint8Array(ROOM_TILES);
export const decorN = { n: 0 };
export const decorX = new Float32Array(64);
export const decorY = new Float32Array(64);
export const decorK = new Uint8Array(64);

export function buildRoomDecor(floorSeed, roomIdx, kind, tiles) {
  const rnd = mulberry32(hash2(floorSeed, roomIdx * 2654435761 + 17));
  for (let i = 0; i < ROOM_TILES; i++) {
    const r = rnd();
    floorVar[i] = r < 0.72 ? 0 : r < 0.9 ? 1 : 2;
  }
  let n = 0;
  const count = kind === R_BOSS ? 26 : 16;
  for (let k = 0; k < count && n < 64; k++) {
    const tx = 1 + ((rnd() * (ROOM_W - 2)) | 0);
    const ty = 1 + ((rnd() * (ROOM_H - 2)) | 0);
    if (tiles[ty * ROOM_W + tx] !== TL_FLOOR) continue;
    decorX[n] = tx * TILE + rnd() * TILE;
    decorY[n] = ty * TILE + rnd() * TILE;
    decorK[n] = (rnd() * 3) | 0;
    n++;
  }
  decorN.n = n;
}

// ─── мини-карта ──────────────────────────────────────────────────────────────
// Раскладка приходит в S_ROOM; здесь храним её в плоских массивах.

export const MAP_MAX = 24;
export const mapN = { n: 0, cur: 0, start: 0, boss: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
export const mapX = new Uint8Array(MAP_MAX);
export const mapY = new Uint8Array(MAP_MAX);
export const mapKind = new Uint8Array(MAP_MAX);
export const mapDoors = new Uint8Array(MAP_MAX);
export const mapSecret = new Uint8Array(MAP_MAX);
export const mapFlags = new Uint8Array(MAP_MAX);

export function setMapRoom(i, x, y, kind, doors, secret, flags) {
  if (i >= MAP_MAX) return;
  mapX[i] = x; mapY[i] = y; mapKind[i] = kind;
  mapDoors[i] = doors; mapSecret[i] = secret; mapFlags[i] = flags;
}

export function finishMap(n, cur, start, boss) {
  mapN.n = n; mapN.cur = cur; mapN.start = start; mapN.boss = boss;
  let minX = 255, minY = 255, maxX = 0, maxY = 0;
  for (let i = 0; i < n; i++) {
    // на карте показываем только посещённые и соседние с посещёнными
    if (mapX[i] < minX) minX = mapX[i];
    if (mapY[i] < minY) minY = mapY[i];
    if (mapX[i] > maxX) maxX = mapX[i];
    if (mapY[i] > maxY) maxY = mapY[i];
  }
  mapN.minX = minX; mapN.minY = minY; mapN.maxX = maxX; mapN.maxY = maxY;
}

/** Показывать ли комнату на карте: посещённые + соседи посещённых. */
export function mapVisible(i) {
  if (mapFlags[i] & 2) return 2; // посещена
  for (let j = 0; j < mapN.n; j++) {
    if (!(mapFlags[j] & 2)) continue;
    const dx = Math.abs(mapX[i] - mapX[j]), dy = Math.abs(mapY[i] - mapY[j]);
    if (dx + dy === 1 && mapKind[i] !== R_SECRET) return 1; // известна как соседняя
  }
  return 0;
}
