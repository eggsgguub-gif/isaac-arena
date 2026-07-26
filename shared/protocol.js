// shared/protocol.js — бинарный протокол. Ни одной строки в рантайме:
// ники собираются из индексов таблиц, всё остальное — числа в DataView.

import { MAX_ENTITIES, POS_SCALE, VEL_SCALE } from './constants.js';

// ─── типы пакетов ────────────────────────────────────────────────────────────
export const C_HELLO = 0x01;
export const C_INPUT = 0x02;
export const C_PING = 0x03;

export const S_WELCOME = 0x81;
export const S_ROSTER = 0x82;
export const S_ROOM = 0x83;
export const S_SNAP = 0x84;
export const S_EVENTS = 0x85;
export const S_STATS = 0x86;
export const S_ROUND = 0x87;
export const S_PONG = 0x88;
export const S_KICK = 0x89;

// ─── маски полей снапшота ────────────────────────────────────────────────────
export const F_POS = 1;
export const F_VEL = 2;
export const F_META = 4;
export const F_HP = 8;
export const F_STATE = 16;
export const F_EXTRA = 32;
export const F_NEW = 64;
export const F_DEL = 128;
export const F_ALL = F_POS | F_VEL | F_META | F_HP | F_STATE | F_EXTRA;

// ─── причины кика ────────────────────────────────────────────────────────────
export const K_PROTOCOL = 0;
export const K_FLOOD = 1;
export const K_IPLIMIT = 2;
export const K_FULL = 3;

// ─── ники ────────────────────────────────────────────────────────────────────
export const NICK_ADJ = [
  'Злой', 'Гнилой', 'Тихий', 'Красный', 'Пыльный', 'Мокрый', 'Старый', 'Слепой',
  'Голодный', 'Кривой', 'Дерзкий', 'Немой', 'Хмурый', 'Липкий', 'Ржавый', 'Тощий',
  'Толстый', 'Хитрый', 'Больной', 'Святой', 'Пустой', 'Мятый', 'Резкий', 'Тухлый',
  'Смелый', 'Бледный', 'Косой', 'Жадный', 'Шумный', 'Скользкий', 'Ледяной', 'Чумной',
];
export const NICK_NOUN = [
  'Палец', 'Зуб', 'Червь', 'Глаз', 'Пепел', 'Гвоздь', 'Пирог', 'Крюк',
  'Ноготь', 'Комок', 'Кулак', 'Череп', 'Хвост', 'Клык', 'Пузырь', 'Шип',
  'Мешок', 'Уголь', 'Прыщ', 'Ломоть', 'Осколок', 'Клубок', 'Сгусток', 'Огарок',
  'Ковчег', 'Каблук', 'Локоть', 'Свисток', 'Фитиль', 'Обрубок', 'Сухарь', 'Кувшин',
];

export function nickOf(adj, noun) {
  return NICK_ADJ[adj & 31] + ' ' + NICK_NOUN[noun & 31];
}

/** Детерминированно выводит индексы ника из 16-байтного UUID клиента. */
export function nickFromUuid(uuid) {
  let a = 0, b = 0;
  for (let i = 0; i < 16; i += 2) { a = (a + uuid[i] * (i + 3)) & 255; b = (b + uuid[i + 1] * (i + 5)) & 255; }
  return ((a & 31) << 8) | (b & 31);
}

// ─── сетевое представление мира (общая форма для encode/decode) ──────────────

export function createNetView() {
  return {
    px: new Uint16Array(MAX_ENTITIES),
    py: new Uint16Array(MAX_ENTITIES),
    pvx: new Int16Array(MAX_ENTITIES),
    pvy: new Int16Array(MAX_ENTITIES),
    type: new Uint8Array(MAX_ENTITIES),
    sub: new Uint8Array(MAX_ENTITIES),
    ctrl: new Uint8Array(MAX_ENTITIES),
    hp: new Uint8Array(MAX_ENTITIES),
    maxhp: new Uint8Array(MAX_ENTITIES),
    state: new Uint8Array(MAX_ENTITIES),
    extra: new Uint8Array(MAX_ENTITIES),
    present: new Uint8Array(MAX_ENTITIES),
    high: 0,
  };
}

export function clearNetView(v) {
  v.present.fill(0);
  v.type.fill(0);
  v.high = 0;
}

function q16(v) {
  let q = Math.round(v * POS_SCALE);
  if (q < 0) q = 0; else if (q > 65535) q = 65535;
  return q;
}
function qv(v) {
  let q = Math.round(v * VEL_SCALE);
  if (q < -32768) q = -32768; else if (q > 32767) q = 32767;
  return q;
}

/**
 * Пишет дельту мира w относительно base в dv начиная с off.
 * base обновляется на месте. Возвращает новый offset.
 * Заголовок пакета пишет вызывающая сторона; здесь только count + записи.
 */
export function encodeSnapshot(w, base, extraOf, dv, off, full) {
  const countOff = off;
  off += 2;
  let count = 0;
  const n = MAX_ENTITIES;
  for (let i = 0; i < n; i++) {
    const t = w.type[i];
    const was = base.present[i];
    if (t === 0) {
      if (was) {
        base.present[i] = 0;
        base.type[i] = 0;
        dv.setUint16(off, i); off += 2;
        dv.setUint8(off++, F_DEL);
        count++;
      }
      continue;
    }
    const px = q16(w.x[i]), py = q16(w.y[i]);
    const vx = qv(w.vx[i]), vy = qv(w.vy[i]);
    const ex = extraOf(w, i);
    let mask = 0;
    if (!was || full) {
      mask = F_ALL | F_NEW;
    } else {
      if (px !== base.px[i] || py !== base.py[i]) mask |= F_POS;
      if (vx !== base.pvx[i] || vy !== base.pvy[i]) mask |= F_VEL;
      if (t !== base.type[i] || w.sub[i] !== base.sub[i] || w.ctrl[i] !== base.ctrl[i]) mask |= F_META;
      if (w.hp[i] !== base.hp[i] || w.maxhp[i] !== base.maxhp[i]) mask |= F_HP;
      if (w.state[i] !== base.state[i]) mask |= F_STATE;
      if (ex !== base.extra[i]) mask |= F_EXTRA;
    }
    if (mask === 0) continue;
    dv.setUint16(off, i); off += 2;
    dv.setUint8(off++, mask);
    if (mask & F_POS) { dv.setUint16(off, px); dv.setUint16(off + 2, py); off += 4; base.px[i] = px; base.py[i] = py; }
    if (mask & F_VEL) { dv.setInt16(off, vx); dv.setInt16(off + 2, vy); off += 4; base.pvx[i] = vx; base.pvy[i] = vy; }
    if (mask & F_META) {
      dv.setUint8(off++, t); dv.setUint8(off++, w.sub[i]); dv.setUint8(off++, w.ctrl[i]);
      base.type[i] = t; base.sub[i] = w.sub[i]; base.ctrl[i] = w.ctrl[i];
    }
    if (mask & F_HP) { dv.setUint8(off++, w.hp[i]); dv.setUint8(off++, w.maxhp[i]); base.hp[i] = w.hp[i]; base.maxhp[i] = w.maxhp[i]; }
    if (mask & F_STATE) { dv.setUint8(off++, w.state[i]); base.state[i] = w.state[i]; }
    if (mask & F_EXTRA) { dv.setUint8(off++, ex); base.extra[i] = ex; }
    base.present[i] = 1;
    count++;
  }
  dv.setUint16(countOff, count);
  return off;
}

/**
 * Применяет дельту к сетевому представлению v. Позиции новых/изменённых
 * сущностей пишутся также в outX/outY (кадр истории для интерполяции).
 * Возвращает новый offset.
 */
export function decodeSnapshot(v, dv, off, outX, outY, outPresent) {
  const count = dv.getUint16(off); off += 2;
  for (let k = 0; k < count; k++) {
    const id = dv.getUint16(off); off += 2;
    const mask = dv.getUint8(off++);
    if (mask & F_DEL) {
      v.present[id] = 0;
      v.type[id] = 0;
      continue;
    }
    if (mask & F_POS) { v.px[id] = dv.getUint16(off); v.py[id] = dv.getUint16(off + 2); off += 4; }
    if (mask & F_VEL) { v.pvx[id] = dv.getInt16(off); v.pvy[id] = dv.getInt16(off + 2); off += 4; }
    if (mask & F_META) { v.type[id] = dv.getUint8(off++); v.sub[id] = dv.getUint8(off++); v.ctrl[id] = dv.getUint8(off++); }
    if (mask & F_HP) { v.hp[id] = dv.getUint8(off++); v.maxhp[id] = dv.getUint8(off++); }
    if (mask & F_STATE) { v.state[id] = dv.getUint8(off++); }
    if (mask & F_EXTRA) { v.extra[id] = dv.getUint8(off++); }
    v.present[id] = 1;
    if (id >= v.high) v.high = id + 1;
  }
  // снимок позиций для истории интерполяции
  for (let i = 0; i < MAX_ENTITIES; i++) {
    if (v.present[i]) {
      outX[i] = v.px[i] / POS_SCALE;
      outY[i] = v.py[i] / POS_SCALE;
      outPresent[i] = 1;
    } else {
      outPresent[i] = 0;
    }
  }
  return off;
}

// ─── мелкие писатели/читатели ────────────────────────────────────────────────

export function writeHello(dv, uuid) {
  dv.setUint8(0, C_HELLO);
  dv.setUint8(1, 3); // PROTOCOL_VERSION дублируется здесь намеренно
  for (let i = 0; i < 16; i++) dv.setUint8(2 + i, uuid[i]);
  return 18;
}

export function writeInput(dv, seq, b0, b1, aim) {
  dv.setUint8(0, C_INPUT);
  dv.setUint16(1, seq);
  dv.setUint8(3, b0);
  dv.setUint8(4, b1);
  dv.setUint8(5, aim);
  return 6;
}

export function writePing(dv, t) {
  dv.setUint8(0, C_PING);
  dv.setUint32(1, t >>> 0);
  return 5;
}
