// server/index.js — один процесс: статика + WebSocket + тик сессий.
// Транспорт: uWebSockets.js, если он собран под платформу, иначе встроенный
// минимальный RFC6455 поверх node:http (ноль зависимостей).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { Matchmaker } from './matchmaker.js';
import { C_HELLO, C_INPUT, C_PING, S_PONG, S_KICK, K_FLOOD, K_IPLIMIT, K_PROTOCOL, nickFromUuid } from '../shared/protocol.js';
import { PROTOCOL_VERSION, MAX_IN_PPS } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '8080', 10);

// ─── статика в памяти ────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const files = new Map(); // '/path' → { body, gz, type }

function loadStatic() {
  files.clear();
  if (!fs.existsSync(PUB)) {
    console.error('[static] нет каталога public/ — выполните `npm run build`');
    return;
  }
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full, prefix + name + '/'); continue; }
      const ext = path.extname(name).toLowerCase();
      const body = fs.readFileSync(full);
      const etag = '"' + crypto.createHash('sha1').update(body).digest('base64').slice(0, 16) + '"';
      const rec = { body, gz: null, etag, type: MIME[ext] || 'application/octet-stream' };
      if (ext === '.js' || ext === '.html' || ext === '.json') {
        rec.gz = zlib.gzipSync(body, { level: 9 });
      }
      files.set('/' + prefix + name, rec);
      if (name === 'index.html') files.set('/' + prefix, rec);
    }
  };
  walk(PUB, '');
  let total = 0;
  for (const [, r] of files) total += (r.gz || r.body).length;
  console.log(`[static] загружено ${files.size} путей, ${(total / 1024).toFixed(1)} КБ на проводе`);
}
loadStatic();

const mm = new Matchmaker();
mm.start();

let benchResult = null;

const SEC_HEADERS = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['X-Content-Type-Options', 'nosniff'],
];

// ─── соединение (общий интерфейс для обоих транспортов) ──────────────────────

class Conn {
  constructor(ip, sendFn, closeFn) {
    this.ip = ip;
    this._send = sendFn;
    this._close = closeFn;
    this.session = null;
    this.slot = -1;
    this.uuid = new Uint8Array(16);
    this.hello = false;
    this.pps = 0;
    this.ppsWindow = Date.now();
    this.closed = false;
    for (let i = 0; i < 16; i++) this.uuid[i] = (Math.random() * 256) | 0;
  }
  sendBin(u8, len) {
    if (this.closed) return;
    this._send(u8, len);
  }
  kick(reason) {
    const b = new Uint8Array(2);
    b[0] = S_KICK; b[1] = reason;
    this.sendBin(b, 2);
    this.closed = true;
    this._close();
  }
}

function onMessage(conn, u8, len) {
  // rate-limit: скользящее окно в 1 секунду
  const now = Date.now();
  if (now - conn.ppsWindow > 1000) { conn.ppsWindow = now; conn.pps = 0; }
  if (++conn.pps > MAX_IN_PPS) { conn.kick(K_FLOOD); return; }
  if (len < 1) return;

  const type = u8[0];
  if (type === C_HELLO) {
    if (len < 18) return;
    if (u8[1] !== PROTOCOL_VERSION) { conn.kick(K_PROTOCOL); return; }
    for (let i = 0; i < 16; i++) conn.uuid[i] = u8[2 + i];
    conn.hello = true;
    const s = conn.session;
    if (s && conn.slot >= 0) {
      const p = s.slots[conn.slot];
      if (p && p.ws === conn) {
        p.uuid.set(conn.uuid);
        const nk = nickFromUuid(conn.uuid);
        p.adj = nk >> 8;
        p.noun = nk & 255;
        s.rosterDirty = true;
        s.sendWelcome(p);
      }
    }
    return;
  }

  if (type === C_INPUT) {
    if (len < 6) return;
    const s = conn.session;
    if (!s || conn.slot < 0) return;
    const p = s.slots[conn.slot];
    if (!p || p.ws !== conn) return;
    const seq = (u8[1] << 8) | u8[2];
    s.onInput(p, seq, u8[3], u8[4], u8[5]);
    return;
  }

  if (type === C_PING) {
    if (len < 5) return;
    const out = pongBuf;
    out[0] = S_PONG;
    out[1] = u8[1]; out[2] = u8[2]; out[3] = u8[3]; out[4] = u8[4];
    const s = conn.session;
    const tick = s ? s.tick : 0;
    out[5] = (tick >>> 8) & 255;
    out[6] = tick & 255;
    conn.sendBin(out, 7);
    return;
  }
}
const pongBuf = new Uint8Array(8);

function onOpen(conn) {
  // вход без кодов: слот выдаётся сразу на хендшейке
  const slot = mm.joinAny(conn);
  if (!slot) { conn.kick(K_IPLIMIT); return; }
}

function onClose(conn) {
  conn.closed = true;
  mm.leave(conn);
}

// ─── HTTP-обработчики ────────────────────────────────────────────────────────

function httpRoute(urlPath) {
  if (urlPath === '/health') return null;
  return files.get(urlPath) || (urlPath === '/' ? files.get('/index.html') : null);
}

function healthBody() {
  const st = mm.stats();
  return JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ...st });
}

// ─── запуск: uWebSockets.js или встроенный фолбэк ────────────────────────────

let uws = null;
try {
  const mod = await import('uWebSockets.js');
  uws = mod.default || mod;
} catch (e) {
  uws = null;
}

if (uws) {
  startUws();
} else {
  console.log('[net] uWebSockets.js недоступен — включён встроенный WS-транспорт');
  startNode();
}

function startUws() {
  const conns = new Map();
  const app = uws.App();

  app.ws('/ws', {
    compression: uws.DISABLED,
    maxPayloadLength: 1024,
    idleTimeout: 32,
    maxBackpressure: 1024 * 512,
    upgrade: (res, req, ctx) => {
      const ip = Buffer.from(res.getRemoteAddressAsText()).toString();
      res.upgrade({ ip },
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        ctx);
    },
    open: (ws) => {
      const ip = ws.getUserData().ip;
      const conn = new Conn(ip,
        (u8, len) => { try { ws.send(u8.subarray(0, len), true, false); } catch (e) { } },
        () => { try { ws.end(1000); } catch (e) { } });
      conns.set(ws, conn);
      onOpen(conn);
    },
    message: (ws, msg) => {
      const conn = conns.get(ws);
      if (!conn) return;
      onMessage(conn, new Uint8Array(msg), msg.byteLength);
    },
    close: (ws) => {
      const conn = conns.get(ws);
      if (conn) onClose(conn);
      conns.delete(ws);
    },
  });

  app.get('/health', (res) => {
    res.writeStatus('200 OK').writeHeader('Content-Type', 'application/json').end(healthBody());
  });

  app.post('/bench', (res) => {
    let chunks = [];
    res.onAborted(() => { });
    res.onData((ab, isLast) => {
      chunks.push(Buffer.from(ab.slice(0)));
      if (isLast) {
        try { benchResult = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { benchResult = { error: 'bad json' }; }
        res.writeStatus('200 OK').end('ok');
      }
    });
  });

  app.get('/bench', (res) => {
    res.writeStatus('200 OK').writeHeader('Content-Type', 'application/json').end(JSON.stringify(benchResult || null));
  });

  app.any('/*', (res, req) => {
    const url = req.getUrl();
    const acceptsGz = (req.getHeader('accept-encoding') || '').indexOf('gzip') >= 0;
    const rec = httpRoute(url);
    if (!rec) { res.writeStatus('404 Not Found').end('not found'); return; }
    if (req.getHeader('if-none-match') === rec.etag) {
      res.writeStatus('304 Not Modified').writeHeader('ETag', rec.etag).end();
      return;
    }
    res.writeStatus('200 OK');
    for (const [k, v] of SEC_HEADERS) res.writeHeader(k, v);
    res.writeHeader('Content-Type', rec.type);
    res.writeHeader('ETag', rec.etag);
    // no-cache = всегда ревалидировать; ETag превращает это в дешёвый 304.
    // Иначе браузер держит устаревший ES-модуль и правки «не приезжают».
    res.writeHeader('Cache-Control', 'no-cache');
    if (rec.gz && acceptsGz) { res.writeHeader('Content-Encoding', 'gzip'); res.end(rec.gz); }
    else res.end(rec.body);
  });

  app.listen('0.0.0.0', PORT, (token) => {
    if (token) console.log(`[net] uWebSockets.js слушает :${PORT}`);
    else { console.error('[net] порт занят'); process.exit(1); }
  });
}

// ─── встроенный WebSocket (RFC 6455), только то, что нужно игре ──────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function startNode() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(healthBody());
      return;
    }
    if (url === '/bench') {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try { benchResult = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { benchResult = { error: 'bad json' }; }
          res.writeHead(200); res.end('ok');
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(benchResult || null));
      return;
    }
    const rec = httpRoute(url);
    if (!rec) { res.writeHead(404); res.end('not found'); return; }
    if (req.headers['if-none-match'] === rec.etag) {
      res.writeHead(304, { ETag: rec.etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    const acceptsGz = (req.headers['accept-encoding'] || '').indexOf('gzip') >= 0;
    const head = { 'Content-Type': rec.type, ETag: rec.etag };
    for (const [k, v] of SEC_HEADERS) head[k] = v;
    head['Cache-Control'] = 'no-cache';
    if (rec.gz && acceptsGz) { head['Content-Encoding'] = 'gzip'; res.writeHead(200, head); res.end(rec.gz); }
    else { res.writeHead(200, head); res.end(rec.body); }
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.url || '').split('?')[0] !== '/ws') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.remoteAddress || '?';
    const conn = new Conn(ip,
      (u8, len) => wsSend(socket, u8, len),
      () => { try { socket.end(); } catch (e) { } });

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      // разбор кадров
      for (;;) {
        if (buf.length < 2) break;
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > 65536) { socket.destroy(); return; }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len);
        if (masked) {
          for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
        }
        buf = buf.subarray(off + len);
        if (opcode === 0x8) { onClose(conn); socket.end(); return; }
        else if (opcode === 0x9) { wsFrame(socket, payload, 0xa); }
        else if (opcode === 0x1 || opcode === 0x2) {
          onMessage(conn, payload, len);
          if (conn.closed) { socket.end(); return; }
        }
      }
    });
    const done = () => { if (!conn.closed) { conn.closed = true; onClose(conn); } };
    socket.on('close', done);
    socket.on('error', done);
    socket.on('end', done);

    onOpen(conn);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[net] node:http + встроенный WS слушает :${PORT}`);
  });
}

function wsSend(socket, u8, len) {
  wsFrame(socket, u8.subarray(0, len), 0x2);
}

function wsFrame(socket, payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2 + len);
    head[0] = 0x80 | opcode;
    head[1] = len;
    Buffer.from(payload.buffer, payload.byteOffset, len).copy(head, 2);
  } else {
    head = Buffer.allocUnsafe(4 + len);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
    Buffer.from(payload.buffer, payload.byteOffset, len).copy(head, 4);
  }
  if (socket.writable) socket.write(head);
}

// ─── завершение ──────────────────────────────────────────────────────────────

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[net] остановка');
    mm.stop();
    process.exit(0);
  });
}

process.on('uncaughtException', (e) => {
  console.error('[fatal]', e && e.stack ? e.stack : e);
});
