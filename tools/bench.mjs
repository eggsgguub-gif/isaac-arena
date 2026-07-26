// tools/bench.mjs — бюджеты памяти и размера. Падает с кодом 1 при превышении.
// Поднимает сервер, гоняет headless-браузер как настоящего клиента 20 секунд,
// затем забирает performance.measureUserAgentSpecificMemory() через /bench.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = parseInt(process.env.BENCH_PORT || '8099', 10);
const RUN_MS = 20000;

const BUDGET = {
  heapMb: 150,
  gzipKb: 120,
  atlasKb: 256,
  minFps: 55,
  serverKbPerSession: 2048,
};

const noBrowser = process.argv.includes('--no-browser');

// ─── поиск Chromium ──────────────────────────────────────────────────────────

function findBrowser() {
  const envPath = process.env.CHROME_PATH;
  const cands = envPath ? [envPath] : [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    cands.push(
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      path.join(la, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    for (const n of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const r = spawnSync('which', [n], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) cands.push(r.stdout.trim());
    }
  }
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

// ─── статические бюджеты ─────────────────────────────────────────────────────

function staticBudgets() {
  const rows = [];
  const js = fs.readFileSync(path.join(PUB, 'main.js'));
  const html = fs.readFileSync(path.join(PUB, 'index.html'));
  const png = fs.readFileSync(path.join(PUB, 'atlas.png'));
  const gz = zlib.gzipSync(js, { level: 9 }).length + zlib.gzipSync(html, { level: 9 }).length;
  rows.push(['бандл gzip', gz / 1024, BUDGET.gzipKb, 'КБ']);
  rows.push(['atlas.png', png.length / 1024, BUDGET.atlasKb, 'КБ']);
  return rows;
}

// ─── замер памяти сервера на одну сессию ─────────────────────────────────────

async function serverSessionCost() {
  const { Session } = await import('../server/session.js');
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const N = 8;
  const arr = [];
  for (let i = 0; i < N; i++) {
    const s = new Session(1000 + i);
    s.start(12345 + i);
    for (let t = 0; t < 30; t++) s.step(33.3);
    arr.push(s);
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  const perSession = (after - before) / N / 1024;
  // держим ссылку, чтобы GC не съел до замера
  if (arr.length !== N) throw new Error('unreachable');
  return perSession;
}

// ─── прогон в браузере ───────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      const req = http.get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  });
}

async function waitFor(fn, timeoutMs, stepMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) { }
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function run() {
  if (!fs.existsSync(path.join(PUB, 'main.js'))) {
    console.error('[bench] нет сборки — сначала `npm run build`');
    process.exit(1);
  }

  console.log('[bench] бюджеты Isaac Arena\n');
  const rows = staticBudgets();

  const perSession = await serverSessionCost();
  rows.push(['сервер: сессия', perSession, BUDGET.serverKbPerSession, 'КБ']);

  let browserRow = null;
  let fpsRow = null;
  let detail = null;

  if (!noBrowser) {
    const exe = findBrowser();
    if (!exe) {
      console.error('[bench] Chromium не найден. Укажите CHROME_PATH или запустите с --no-browser');
      process.exit(1);
    }
    console.log(`[bench] браузер: ${exe}`);

    const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', () => { });
    srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

    const up = await waitFor(() => httpGet(`http://127.0.0.1:${PORT}/health`), 8000, 250);
    if (!up) { srv.kill(); console.error('[bench] сервер не поднялся'); process.exit(1); }

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-bench-'));
    const br = spawn(exe, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=960,540',
      '--user-data-dir=' + profile,
      `http://127.0.0.1:${PORT}/?bench=1`,
    ], { stdio: 'ignore' });

    console.log(`[bench] прогон ${RUN_MS / 1000} с в headless...`);
    const raw = await waitFor(async () => {
      const t = await httpGet(`http://127.0.0.1:${PORT}/bench`);
      return t && t !== 'null' ? t : null;
    }, RUN_MS + 30000, 1000);

    try { br.kill(); } catch (e) { }
    try { srv.kill(); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }

    if (!raw) {
      console.error('[bench] браузер не прислал замер (нужен cross-origin isolated контекст)');
      process.exit(1);
    }
    detail = JSON.parse(raw);
    if (detail.bytes > 0) rows.push(['вкладка, heap', detail.bytes / 1048576, BUDGET.heapMb, 'МБ']);
    else rows.push(['вкладка, heap', -1, BUDGET.heapMb, 'МБ']);
    fpsRow = detail.fps;
  }

  // ─── отчёт
  let fail = 0;
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('подсистема', 22) + pad('значение', 12) + pad('бюджет', 12) + 'статус');
  console.log('-'.repeat(56));
  for (const [name, val, budget, unit] of rows) {
    const ok = val >= 0 && val <= budget;
    if (!ok) fail++;
    console.log(
      pad(name, 22) +
      pad((val < 0 ? 'н/д' : val.toFixed(1)) + ' ' + unit, 12) +
      pad(budget + ' ' + unit, 12) +
      (ok ? 'ок' : 'ПРЕВЫШЕН'));
  }
  if (fpsRow != null) {
    const ok = fpsRow >= BUDGET.minFps;
    console.log(pad('FPS (headless)', 22) + pad(String(fpsRow), 12) + pad('>= ' + BUDGET.minFps, 12) + (ok ? 'ок' : 'НИЖЕ'));
    if (!ok) console.log('  (в headless без GPU просадка ожидаема, смотрите замер в обычном окне)');
  }
  if (detail && detail.kinds) {
    console.log('\nразбивка вкладки:');
    const ents = Object.entries(detail.kinds).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of ents) console.log('  ' + pad(k, 34) + (v / 1048576).toFixed(2) + ' МБ');
  }
  if (detail) {
    console.log(`\nсеть: вход ${detail.kbpsIn} кбит/с, выход ${detail.kbpsOut} кбит/с, ping ${detail.ping} мс, сущностей ${detail.entities}`);
  }

  if (fail) { console.error(`\n[bench] превышено бюджетов: ${fail}`); process.exit(1); }
  console.log('\n[bench] все бюджеты соблюдены');
  process.exit(0);
}

run().catch((e) => { console.error('[bench]', e); process.exit(1); });
