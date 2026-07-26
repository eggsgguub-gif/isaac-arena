// shared/constants.js — единственный словарь чисел для клиента, сервера и билд-скриптов.
// Ничего не аллоцирует в рантайме: только примитивы и замороженные таблицы.

// ─── такт и время ────────────────────────────────────────────────────────────
export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const INTERP_DELAY = 100; // мс, буфер интерполяции чужих сущностей
export const SNAPSHOT_HISTORY = 8; // кольцо позиций для интерполяции
export const INPUT_HISTORY = 64; // кольцо инпутов для reconciliation

// ─── экран и мир ─────────────────────────────────────────────────────────────
export const VIEW_W = 480;
export const VIEW_H = 270;
export const ROOM_W = 15; // тайлов
export const ROOM_H = 9;
export const TILE = 30; // px
export const WORLD_W = ROOM_W * TILE; // 450
export const WORLD_H = ROOM_H * TILE; // 270
export const ROOM_OX = ((VIEW_W - WORLD_W) / 2) | 0; // 15 — отступ комнаты по X
export const ROOM_TILES = ROOM_W * ROOM_H; // 135

// uniform grid для broadphase столкновений
export const GRID_CELL = 16;
export const GRID_W = Math.ceil(WORLD_W / GRID_CELL); // 29
export const GRID_H = Math.ceil(WORLD_H / GRID_CELL); // 17
export const GRID_CELLS = GRID_W * GRID_H; // 493

export const MAX_ENTITIES = 512;
export const MAX_PLAYERS = 5;
export const MAX_ISAACS = 2;
export const MAX_MONSTERS = 3;

// ─── тайлы ───────────────────────────────────────────────────────────────────
export const TL_FLOOR = 0;
export const TL_WALL = 1;
export const TL_ROCK = 2;
export const TL_PIT = 3;
export const TL_SPIKE = 4;
export const TL_DOOR = 5; // закрытая дверь (твёрдая)
export const TL_DOOR_OPEN = 6; // открытая дверь (проход + триггер)
export const TL_SECRET = 7; // скрытая дверь, выглядит как стена, ломается бомбой
export const TL_RUBBLE = 8; // разрушенный камень (проходим)
export const TL_HATCH = 9; // люк-выход из боссовой комнаты

// твёрдость тайла: 0 — проходим, 1 — блокирует всё, 2 — блокирует только наземных
export const TILE_SOLID = new Uint8Array([0, 1, 1, 2, 0, 1, 0, 1, 0, 0]);

// ─── типы сущностей ──────────────────────────────────────────────────────────
export const T_NONE = 0;
export const T_ISAAC = 1;
export const T_MOB = 2;
export const T_TEAR = 3; // снаряд Айзека
export const T_SHOT = 4; // снаряд моба
export const T_PICKUP = 5;
export const T_BOMB = 6;
export const T_SPIRIT = 7; // дух игрока-монстра без тела

// ─── битовые флаги state (Uint8) ─────────────────────────────────────────────
export const ST_ALIVE = 1;
export const ST_SHIELD = 2; // Щитоносец держит блок
export const ST_CHARGE = 4; // Ползун разгоняется
export const ST_HURT = 8; // мигание урона / i-frames
export const ST_AIR = 16; // Прыгун в воздухе (неуязвим, летит)
export const ST_DOWN = 32; // Айзек лежит (0 сердец, ждёт подъёма)
export const ST_FACE0 = 64; // 2 бита направления: 0 down,1 up,2 left,3 right
export const ST_FACE1 = 128;

// ─── архетипы мобов (поле sub у T_MOB) ───────────────────────────────────────
export const M_CRAWLER = 0; // Ползун
export const M_SPITTER = 1; // Плевун
export const M_SPLITTER = 2; // Делитель
export const M_HOPPER = 3; // Прыгун
export const M_SHIELDER = 4; // Щитоносец
export const M_SPAWN = 5; // осколок Делителя
export const M_BOSS = 6; // босс этажа
export const MOB_KINDS = 7;

// hp, радиус, скорость, контактный урон (в половинках сердца), стоимость волны
export const MOB_HP = new Uint8Array([6, 5, 8, 5, 10, 3, 90]);
export const MOB_R = new Uint8Array([6, 6, 7, 6, 7, 4, 13]);
export const MOB_SPEED = new Float32Array([46, 30, 34, 40, 26, 52, 30]);
export const MOB_TOUCH = new Uint8Array([1, 1, 1, 1, 1, 1, 2]);
export const MOB_COST = new Uint8Array([2, 3, 3, 3, 4, 1, 20]);
export const MOB_ABILITY_CD = new Float32Array([2.4, 2.0, 6.0, 3.2, 4.0, 2.0, 3.0]);
export const MOB_DASH_CD = 1.6;

// ─── снаряды ─────────────────────────────────────────────────────────────────
export const TF_PIERCE = 1;
export const TF_HOME = 2;
export const TF_POISON = 4;
export const TF_BOUNCE = 8;
export const TF_SPECTRAL = 16;
export const TF_TRIPLE = 32;

// ─── предметы (пассивки) ─────────────────────────────────────────────────────
export const IT_COUNT = 14;
export const IT_DAMAGE = 0;
export const IT_FIRERATE = 1;
export const IT_SPEED = 2;
export const IT_RANGE = 3;
export const IT_SHOTSPEED = 4;
export const IT_PIERCE = 5;
export const IT_HOME = 6;
export const IT_POISON = 7;
export const IT_BOUNCE = 8;
export const IT_TRIPLE = 9;
export const IT_HEART = 10;
export const IT_BIGTEAR = 11;
export const IT_BOMBS = 12;
export const IT_LUCK = 13;

// цена в магазине (монеты)
export const ITEM_PRICE = new Uint8Array([15, 15, 10, 10, 10, 20, 20, 15, 15, 25, 3, 20, 5, 12]);

// ─── типы комнат ─────────────────────────────────────────────────────────────
export const R_START = 0;
export const R_NORMAL = 1;
export const R_TREASURE = 2;
export const R_SHOP = 3;
export const R_BOSS = 4;
export const R_SECRET = 5;

// ─── типы пикапов (поле sub у T_PICKUP) ──────────────────────────────────────
export const P_HEART = 0;
export const P_HALFHEART = 1;
export const P_COIN = 2;
export const P_KEY = 3;
export const P_BOMB = 4;
export const P_PEDESTAL = 5; // предмет на пьедестале, sub2 = id предмета

// ─── стороны ─────────────────────────────────────────────────────────────────
export const SIDE_ISAAC = 0;
export const SIDE_MONSTER = 1;

// ─── биты инпута ─────────────────────────────────────────────────────────────
export const IN_UP = 1;
export const IN_DOWN = 2;
export const IN_LEFT = 4;
export const IN_RIGHT = 8;
export const IN_SUP = 16;
export const IN_SDOWN = 32;
export const IN_SLEFT = 64;
export const IN_SRIGHT = 128;
// второй байт — действия
export const IN2_FIRE = 1; // стрельба по курсору
export const IN2_ABILITY = 2;
export const IN2_DASH = 4;
export const IN2_BOMB = 8;

// ─── баланс Айзека ───────────────────────────────────────────────────────────
export const ISAAC_R = 6;
export const ISAAC_BASE_SPEED = 78;
export const ISAAC_BASE_DAMAGE = 3.5;
export const ISAAC_BASE_FIRERATE = 2.6; // выстрелов в секунду
export const ISAAC_BASE_RANGE = 0.62; // секунд жизни слезы
export const ISAAC_BASE_SHOTSPEED = 150;
export const ISAAC_MAX_HEARTS = 12; // половинок = 6 сердец
export const ISAAC_IFRAMES = 0.8;
export const ISAAC_DOWN_TIME = 8.0; // сек до самоподъёма, если напарник жив
export const ACCEL = 12; // множитель приближения к целевой скорости
export const FRICTION = 9;

// ─── баланс монстров ─────────────────────────────────────────────────────────
export const PLAYER_MOB_DMG_MUL = 0.7; // урон игрока-монстра относительно ИИ
export const PLAYER_MOB_HP_MUL = 1.35; // компенсация за отсутствие числа
export const REPOSSESS_MS = 250; // максимум до переселения
export const SPIRIT_TIME = 3.0; // сек в режиме духа
export const DASH_SPEED = 210;
export const DASH_TIME = 0.18;

// ─── бомбы ───────────────────────────────────────────────────────────────────
export const BOMB_FUSE = 1.5;
export const BOMB_RADIUS = 42;
export const BOMB_DAMAGE = 24;

// ─── этаж ────────────────────────────────────────────────────────────────────
export const FLOOR_MIN_ROOMS = 10;
export const FLOOR_MAX_ROOMS = 14;
export const FMAP_W = 9; // сетка карты этажа
export const FMAP_H = 8;
export const FMAP_CELLS = FMAP_W * FMAP_H;
export const ROUND_RESTART_MS = 5000;

// ─── сеть ────────────────────────────────────────────────────────────────────
export const PROTOCOL_VERSION = 3;
export const MAX_PACKET = 8192;
export const MAX_IN_PPS = 90; // rate-limit: пакетов в секунду с клиента
export const MAX_SESSIONS_PER_IP = 6;
export const POS_SCALE = 16; // фиксированная точка позиций (1/16 px)
export const VEL_SCALE = 8;

// ─── атлас (общая раскладка для tools/atlas.mjs и client/render.js) ──────────
export const A_W = 256;
export const A_H = 256;
export const CELL = 16; // мелкие спрайты
export const CELL_COLS = 16;
export const CELL_ROWS = 8; // y: 0..127
export const TILE_BAND_Y = 128; // тайлы 30×30
export const TILE_COLS = 8;
export const TILE_ROWS = 2; // y: 128..187
export const BIG = 32; // крупные спрайты
export const BIG_BAND_Y = 188;
export const BIG_COLS = 8;
export const BIG_ROWS = 2; // y: 188..251

// индексы мелких спрайтов
export const S_ISAAC_BODY = 0; // +0,+1 кадры ходьбы
export const S_ISAAC_HEAD = 2; // +0 down, +1 up, +2 side
export const S_ISAAC_GHOST = 5;
export const S_ISAAC2_BODY = 6;
export const S_ISAAC2_HEAD = 8;
export const S_ISAAC2_GHOST = 11;
export const S_TEAR = 12; // +0 small, +1 mid, +2 big, +3 poison
export const S_MOB = 16; // архетип*2 + кадр, 7 архетипов → 16..29
export const S_SHOT = 30; // +0,+1
export const S_SHIELD_FX = 32;
export const S_CROWN = 33;
export const S_HEART = 34; // +0 full, +1 half, +2 empty
export const S_COIN = 37;
export const S_KEY = 38;
export const S_BOMB = 39;
export const S_BOMB_LIT = 40;
export const S_PEDESTAL = 41;
export const S_ITEM = 42; // +0..13 иконки предметов
export const S_BOOM = 56; // +0,+1,+2
export const S_SPIRIT = 59;
export const S_SHADOW = 60;
export const S_RETICLE = 61;
export const S_LOCK = 62;
export const S_ARROW = 63;

// индексы тайлов 30×30
export const TS_FLOOR = 0; // +0,+1,+2 варианты
export const TS_WALL = 3;
export const TS_ROCK = 4;
export const TS_PIT = 5;
export const TS_SPIKE = 6;
export const TS_DOOR = 7;
export const TS_DOOR_OPEN = 8;
export const TS_RUBBLE = 9;
export const TS_HATCH = 10;
export const TS_FLOOR_SHOP = 11;
export const TS_FLOOR_BOSS = 12;
export const TS_FLOOR_TREASURE = 13;

// индексы крупных спрайтов
export const B_BOSS = 0; // +0,+1,+2
export const B_BLAST = 3;

// ─── события (S_EVENT) ───────────────────────────────────────────────────────
export const EV_HIT = 0;
export const EV_MOB_DIE = 1;
export const EV_SHOOT = 2;
export const EV_EXPLODE = 3;
export const EV_PICKUP = 4;
export const EV_DOOR = 5;
export const EV_HURT = 6;
export const EV_ABILITY = 7;
export const EV_POSSESS = 8;
export const EV_ROCK = 9;
export const EV_BOSS_DIE = 10;
export const EV_SECRET = 11;
export const EV_DENY = 12;
export const EV_REVIVE = 13;
