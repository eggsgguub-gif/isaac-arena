// server/matchmaker.js — вход без кодов и лобби. Пул сессий, единый тик 30 Гц.

import { Session } from './session.js';
import {
  TICK_RATE, MAX_PLAYERS, MAX_ISAACS, MAX_SESSIONS_PER_IP,
} from '../shared/constants.js';

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '0.0.0.0';
}

const POOL_INIT = 4;
const POOL_MAX = 64;
const IDLE_KILL_MS = 45000;

export class Matchmaker {
  constructor() {
    this.pool = [];
    for (let i = 0; i < POOL_INIT; i++) this.pool.push(new Session(i));
    this.ipConns = new Map();
    this.timer = null;
    this.acc = 0;
    this.last = 0;
    this.stepMs = 1000 / TICK_RATE;
    this.tickCount = 0;
    this.busyMs = 0;
    this.busyAvg = 0;
  }

  /**
   * Подключает игрока сразу же: подходящая идущая сессия → свободная из пула →
   * новая. Никаких экранов ожидания.
   */
  joinAny(conn) {
    const ip = conn.ip;
    const n = this.ipConns.get(ip) || 0;
    // на loopback лимит не действует: иначе не протестировать 5 клиентов локально
    if (n >= MAX_SESSIONS_PER_IP && !isLoopback(ip)) return null;

    let target = null;
    // 1. идущая сессия с местом
    for (let i = 0; i < this.pool.length; i++) {
      const s = this.pool[i];
      if (!s.running) continue;
      if (s.humanCount() >= MAX_PLAYERS) continue;
      target = s;
      break;
    }
    // 2. свободная сессия из пула
    if (!target) {
      for (let i = 0; i < this.pool.length; i++) {
        if (!this.pool[i].running) { target = this.pool[i]; break; }
      }
    }
    // 3. расширяем пул
    if (!target && this.pool.length < POOL_MAX) {
      target = new Session(this.pool.length);
      this.pool.push(target);
    }
    if (!target) return null;

    if (!target.running) {
      const seed = (Date.now() ^ (target.id * 2654435761) ^ ((Math.random() * 0xffffffff) | 0)) >>> 0;
      target.start(seed);
    }

    const slot = target.addPlayer(conn, conn.uuid, ip);
    if (!slot) return null;
    conn.session = target;
    conn.slot = slot.index;
    this.ipConns.set(ip, n + 1);
    return slot;
  }

  leave(conn) {
    if (!conn.session) return;
    const s = conn.session;
    const p = s.slots[conn.slot];
    if (p && p.ws === conn) s.removePlayer(p);
    conn.session = null;
    conn.slot = -1;
    const n = (this.ipConns.get(conn.ip) || 1) - 1;
    if (n <= 0) this.ipConns.delete(conn.ip); else this.ipConns.set(conn.ip, n);
  }

  start() {
    this.last = Date.now();
    this.timer = setInterval(() => this.pump(), Math.max(1, (this.stepMs / 2) | 0));
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Догоняющий фиксированный шаг: не даёт симуляции плыть от джиттера таймера. */
  pump() {
    const now = Date.now();
    let delta = now - this.last;
    if (delta > 250) delta = 250; // после заморозки процесса не отматываем
    this.last = now;
    this.acc += delta;
    let guard = 0;
    while (this.acc >= this.stepMs && guard++ < 8) {
      this.acc -= this.stepMs;
      const t0 = process.hrtime.bigint();
      this.tickAll();
      const t1 = process.hrtime.bigint();
      this.busyMs = Number(t1 - t0) / 1e6;
      this.busyAvg += (this.busyMs - this.busyAvg) * 0.05;
      this.tickCount++;
    }
  }

  tickAll() {
    const now = Date.now();
    for (let i = 0; i < this.pool.length; i++) {
      const s = this.pool[i];
      if (!s.running) continue;
      if (s.humanCount() === 0 && now - s.lastActivity > IDLE_KILL_MS) {
        s.running = false;
        continue;
      }
      if (s.humanCount() > 0) s.lastActivity = now;
      s.step(this.stepMs);
    }
  }

  stats() {
    let running = 0, players = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const s = this.pool[i];
      if (!s.running) continue;
      running++;
      players += s.humanCount();
    }
    return {
      sessions: running,
      pool: this.pool.length,
      players,
      tick: this.tickCount,
      tickMs: Math.round(this.busyAvg * 1000) / 1000,
      rssMb: Math.round(process.memoryUsage().rss / 104857.6) / 10,
    };
  }
}
