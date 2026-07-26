// tools/build.mjs — сборка клиента: атлас + esbuild-бандл + статика.
// Флаги: --watch (пересборка по изменению), --serve (поднять сервер рядом).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from './atlas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const ENTRY = path.join(ROOT, 'client', 'main.js');

const BUDGET_GZIP = 120 * 1024;
const BUDGET_ATLAS = 256 * 1024;

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

function copyStatic() {
  fs.mkdirSync(PUB, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'client', 'index.html'), path.join(PUB, 'index.html'));
}

function report() {
  const js = fs.readFileSync(path.join(PUB, 'main.js'));
  const html = fs.readFileSync(path.join(PUB, 'index.html'));
  const png = fs.readFileSync(path.join(PUB, 'atlas.png'));
  const gz = zlib.gzipSync(js, { level: 9 }).length + zlib.gzipSync(html, { level: 9 }).length;
  const total = gz + png.length;
  const ok = gz <= BUDGET_GZIP && png.length <= BUDGET_ATLAS;
  console.log(
    `[build] main.js ${(js.length / 1024).toFixed(1)} КБ → gzip ${(gz / 1024).toFixed(1)} КБ ` +
    `(бюджет ${BUDGET_GZIP / 1024} КБ) | atlas.png ${(png.length / 1024).toFixed(1)} КБ ` +
    `(бюджет ${BUDGET_ATLAS / 1024} КБ) | всего на проводе ${(total / 1024).toFixed(1)} КБ ${ok ? '✓' : '✗'}`);
  return { ok, gz, png: png.length, js: js.length, total };
}

async function main() {
  const esbuild = await import('esbuild');
  copyStatic();
  const a = buildAtlas();
  console.log(`[atlas] ${(a.bytes / 1024).toFixed(1)} КБ, палитра ${a.colors}, использовано ${a.used} цветов`);

  const opts = {
    entryPoints: [ENTRY],
    outfile: path.join(PUB, 'main.js'),
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'warning',
    treeShaking: true,
    charset: 'utf8',
  };

  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('[build] watch активен');
    // атлас пересобираем по изменению его исходника
    fs.watch(path.join(ROOT, 'tools'), (ev, f) => {
      if (f === 'atlas.mjs') {
        // повторный импорт с обходом кеша модулей
        import('./atlas.mjs?t=' + Date.now()).then((m) => {
          const r = m.buildAtlas();
          console.log(`[atlas] пересобран, ${(r.bytes / 1024).toFixed(1)} КБ`);
        }).catch((e) => console.error('[atlas]', e.message));
      }
    });
    fs.watch(path.join(ROOT, 'client'), (ev, f) => {
      if (f === 'index.html') { copyStatic(); console.log('[build] index.html обновлён'); }
    });
    // ждём первую сборку, чтобы отчёт был не пустой
    await new Promise((r) => setTimeout(r, 600));
    report();
    if (serve) startServer();
    return;
  }

  await esbuild.build(opts);
  const r = report();
  if (!r.ok) {
    console.error('[build] превышен бюджет размера');
    process.exit(1);
  }
  if (serve) startServer();
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
