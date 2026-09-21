/* A DESKTOP PROXY FOR THE TELEVISION — for A/B'ing two TV builds WITHOUT the set.
 *
 *   node scripts/tv-bench-local.mjs --dist=dist-tv --label=after
 *   node scripts/tv-bench-local.mjs --dist=../dist-tv-BEFORE --label=before --throttle=4 --rounds=2
 *   node scripts/tv-bench-local.mjs --dist=dist-tv --label=after --snap        (structural walk)
 *   node scripts/tv-bench-local.mjs --compare=a.json,b.json                     (diff two --snap files)
 *   node scripts/tv-bench-local.mjs --dist=dist-tv --label=after --soak=30     (a 30-minute session, sampled per minute)
 *
 * WHAT IT IS AND IS NOT. The real numbers come from `scripts/tv-measure.mjs` on the LG set, and
 * nothing here replaces them — a desktop GPU and a 4-core ARM panel do not drop the same frames.
 * What a desktop CAN answer exactly, because they are facts about the page and not about the
 * hardware, is everything structural: how many tiles a row holds, how wide the strip's promoted
 * layer is, how many style recalcs and layouts a press costs, how many images are decoded, and —
 * the one that matters most for a refactor — whether the walk shows the SAME artwork at the SAME
 * positions before and after. `--snap` records that walk step by step and `--compare` diffs two.
 *
 * DETERMINISM. `/api/*` is answered from screenshots/fixtures.json (the same recorded bytes the
 * screenshot suite uses), so both arms render the same catalogue. Images are fetched once from the
 * network and then served from a disk cache keyed by URL, so both arms decode identical bytes and a
 * CDN hiccup cannot land on one arm. The service worker is blocked — it would otherwise fetch
 * around the interception. The build's own perf probe (lib/tvPerf.ts) is armed through
 * `window.__GROLOO_PERF__`, so both arms are scored by the code the television is scored by.
 *
 * `--throttle=N` applies CDP CPU throttling. It makes a desktop drop frames the way a set does,
 * roughly, and it is only for RELATIVE comparison between two arms in one session. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const DIST = arg('dist', 'dist-tv');
const LABEL = arg('label', 'run');
const THROTTLE = Number(arg('throttle', '1'));
const ROUNDS = Number(arg('rounds', '1'));
const PREVIEWS = arg('previews', 'off');
const OUT = arg('out', 'perf-results/local');
const CACHE = arg('cache', join(tmpdir(), 'groloo-imgcache'));
const HEADLESS = flag('headless');
const SNAP = flag('snap');
const COMPARE = arg('compare', '');
const DPR = Number(arg('dpr', '2'));
const SOAK = Number(arg('soak', '0'));   // minutes of continuous navigation, sampled once a minute
/* `--ls='k=v,k2=v2'` — the experiment keys, exactly as scripts/tv-measure.mjs takes them, so an arm
 * can be run against ONE build here and then against the same build on the set without rewriting
 * it. Two dists compared is two binaries; one dist with the arm flipped is a comparison. */
const LS_ARM = arg('ls', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- --compare: diff two --snap files and exit ------------------------------------------------ */
if (COMPARE) {
  const [a, b] = COMPARE.split(',');
  const A = JSON.parse(await readFile(a, 'utf8')), B = JSON.parse(await readFile(b, 'utf8'));
  let bad = 0;
  const steps = Math.max(A.steps.length, B.steps.length);
  for (let i = 0; i < steps; i++) {
    const x = A.steps[i], y = B.steps[i];
    if (!x || !y) { console.log(`step ${i}: only in ${x ? 'A' : 'B'}`); bad++; continue; }
    const mid = /@\d+ms/.test(x.what);          // mid-transition samples land a few px apart run to run
    const tol = mid ? 60 : 2;
    const tx = (m) => Number(((m || '').match(/matrix\(([^)]+)\)/) || [])[1]?.split(',')[4] || 0);
    const srcs = (v) => v.map((t) => t.src).join('|');
    const xs = (v) => v.map((t) => t.x);
    const sx = srcs(x.visible), sy = srcs(y.visible);
    const xOk = xs(x.visible).length === xs(y.visible).length && xs(x.visible).every((v, i) => Math.abs(v - xs(y.visible)[i]) <= tol);
    /* The strip's transform is NOT part of the verdict: it is the strip's coordinate origin, and
     * the window build lets it run on by whole laps where the double-copy build hopped back. What
     * the viewer sees is the tiles — their pictures and where they sit — and those are compared
     * exactly. The transform is printed when it differs by more than a lap so a real drift shows. */
    const same = sx === sy && xOk && x.billboard === y.billboard && JSON.stringify(x.peek) === JSON.stringify(y.peek)
      && x.heroLabel === y.heroLabel;
    if (!same) {
      bad++;
      console.log(`step ${i} (${x.what}) DIFFERS`);
      if (Math.abs(tx(x.stripTransform) - tx(y.stripTransform)) > tol) console.log(`   strip  A=${x.stripTransform}  B=${y.stripTransform}`);
      if (x.billboard !== y.billboard) console.log(`   billboard  A=${x.billboard}\n              B=${y.billboard}`);
      if (x.heroLabel !== y.heroLabel) console.log(`   label  A=${x.heroLabel}  B=${y.heroLabel}`);
      if (sx !== sy || !xOk) {
        console.log('   visible A:', x.visible.map((t) => `${t.x}:${t.w}:${t.src.split('/').pop()}`).join(' '));
        console.log('   visible B:', y.visible.map((t) => `${t.x}:${t.w}:${t.src.split('/').pop()}`).join(' '));
      }
      if (JSON.stringify(x.peek) !== JSON.stringify(y.peek)) console.log(`   peek A=${JSON.stringify(x.peek)} B=${JSON.stringify(y.peek)}`);
    }
  }
  console.log(`\n${steps - bad} identical, ${bad} different steps  (A=${A.label} tiles/row ${A.tilesPerRow}, B=${B.label} tiles/row ${B.tilesPerRow})`);
  process.exit(bad ? 1 : 0);
}

/* ---- static server for the built app ---------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain', '.map': 'application/json',
};
const distDir = isAbsolute(DIST) ? DIST : join(ROOT, DIST);
if (!existsSync(join(distDir, 'index.html'))) { console.error(`no build at ${distDir}`); process.exit(1); }
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(distDir, path);
  try { if (!(await stat(file)).isFile()) file = join(distDir, 'index.html'); }
  catch { file = join(distDir, 'index.html'); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---- fixtures + image cache -------------------------------------------------------------------- */
const fixtures = JSON.parse(await readFile(join(ROOT, 'screenshots/fixtures.json'), 'utf8'));
await mkdir(CACHE, { recursive: true });
const isAppApi = (u) => (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname.endsWith('.onrender.com')) && u.pathname.startsWith('/api/');
const isImage = (u) => u.hostname === 'image.tmdb.org' || /\/(crop|img|logo)\//.test(u.pathname) && !u.hostname.startsWith('127.');

async function routeAll(context) {
  await context.route(/youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com|imdb/, (r) => r.abort());
  await context.route(() => true, async (r) => {
    const u = new URL(r.request().url());
    if (isAppApi(u)) {
      /* The row preview: the recorded fixtures carry no trailer endpoint, so every rest would find
       * nothing to play and the media pipeline — the most expensive thing on the set — would never
       * be exercised. The demo clip shipped in the build stands in as every title's trailer. */
      if (u.pathname.startsWith("/api/imdb-trailer/")) {
        const url = `${BASE}/assets/demo.mp4`;
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url, urls: { '720p': url }, runtime: 30 }) });
      }
      const key = u.pathname + u.search;
      const hit = fixtures[key] ?? (u.pathname === '/api/home' ? fixtures['/api/home?lang=en&logos=1'] : undefined);
      return r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: hit ?? '{}' });
    }
    if (isImage(u)) {
      const k = createHash('sha1').update(u.href).digest('hex');
      const f = join(CACHE, k);
      if (existsSync(f) && existsSync(f + '.ct')) {
        return r.fulfill({ status: 200, contentType: await readFile(f + '.ct', 'utf8'), body: await readFile(f) });
      }
      try {
        const res = await r.fetch();
        const body = await res.body();
        const ct = res.headers()['content-type'] || 'image/jpeg';
        if (res.status() === 200) { await writeFile(f, body); await writeFile(f + '.ct', ct); }
        return r.fulfill({ status: res.status(), contentType: ct, body });
      } catch { return r.abort(); }
    }
    return r.continue();
  });
}

/* ---- in-page helpers (strings, evaluated in the app) ------------------------------------------ */
const IN_ROW = `!!(document.activeElement && document.activeElement.closest('.tv-spot'))`;
const SAMPLE = `window.__gperf ? window.__gperf.sample() : null`;
/* The focused row's strip: how many tiles, how wide the promoted layer would be. */
const ROW_SHAPE = `(() => {
  const row = document.activeElement && document.activeElement.closest('.tv-spot');
  if (!row) return null;
  const strip = row.querySelector('.tv-spot-strip');
  const tiles = strip ? strip.querySelectorAll('.tv-spot-thumb') : [];
  let minL = Infinity, maxR = -Infinity;
  for (const t of tiles) { const r = t.getBoundingClientRect(); if (r.left < minL) minL = r.left; if (r.right > maxR) maxR = r.right; }
  return {
    tiles: tiles.length,
    stripContentWidth: tiles.length ? Math.round(maxR - minL) : 0,
    imgs: strip ? strip.querySelectorAll('img').length : 0,
    withSrc: strip ? [...strip.querySelectorAll('img')].filter((i) => !!i.getAttribute('src')).length : 0,
    active: strip ? strip.style.getPropertyValue('--active') : '',
    allTiles: document.querySelectorAll('.tv-spot-thumb').length,
    nodes: document.getElementsByTagName('*').length,
  };
})()`;
/* What is on screen in the focused row right now — the equivalence fingerprint for --snap. */
const VISIBLE = `(() => {
  const row = document.activeElement && document.activeElement.closest('.tv-spot');
  if (!row) return null;
  const rail = row.querySelector('.tv-spot-rail').getBoundingClientRect();
  const hero = row.querySelector('.tv-spot-hero');
  const heroR = hero.getBoundingClientRect();
  const strip = row.querySelector('.tv-spot-strip');
  const visible = [];
  for (const t of strip.querySelectorAll('.tv-spot-thumb')) {
    const r = t.getBoundingClientRect();
    if (r.right <= heroR.right + 1 || r.left >= rail.right - 1) continue;
    const img = t.querySelector('img');
    visible.push({ x: Math.round(r.left), w: Math.round(r.width), src: img ? (img.getAttribute('src') || img.dataset.src || '') : (t.classList.contains('is-seeall') ? 'END' : ''), label: t.getAttribute('aria-label') || '' });
  }
  const on = row.querySelector('.tv-spot-layer.on .art-photo');
  const peek = [...row.querySelectorAll('.tv-spot-previmg')].map((i) => i.getAttribute('src').split('/').pop());
  return {
    stripTransform: getComputedStyle(strip).transform,
    visible,
    billboard: on ? (on.style.backgroundImage || '').split('/').pop() : (row.querySelector('.tv-spot-layer.on .tv-spot-blank') ? 'END' : ''),
    peek,
    heroLabel: hero.getAttribute('aria-label') || '',
  };
})()`;

async function waitSettled(page, { quietFor = 6, minMs = 4000, timeoutMs = 90000 } = {}) {
  const t0 = Date.now();
  let lastDecoded = -1, lastRows = -1, quiet = 0;
  for (;;) {
    const s = await page.evaluate(SAMPLE);
    if (s && s.rows > 0) {
      if (s.imagesDecoded === lastDecoded && s.rows === lastRows) quiet++;
      else { quiet = 0; lastDecoded = s.imagesDecoded; lastRows = s.rows; }
      if (quiet >= quietFor && Date.now() - t0 >= minMs) return s;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`never settled (rows=${s?.rows} decoded=${s?.imagesDecoded})`);
    await sleep(300);
  }
}

async function intoRow(page) {
  for (let i = 0; i < 6 && !(await page.evaluate(IN_ROW)); i++) {
    await page.keyboard.press('ArrowDown');
    await sleep(700);
  }
  if (!(await page.evaluate(IN_ROW))) throw new Error('could not focus a row');
}

async function openPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR, serviceWorkers: 'block', reducedMotion: 'no-preference',
  });
  await routeAll(context);
  await context.addInitScript(({ previews, lsArm }) => {
    window.__GROLOO_PERF__ = true;
    try {
      const s = JSON.parse(localStorage.getItem('groloo.settings.v1') || '{}');
      s.tvRowTrailers = previews === 'on';
      localStorage.setItem('groloo.settings.v1', JSON.stringify(s));
    } catch { /* no storage */ }
    for (const pair of String(lsArm).split(',').filter(Boolean)) {
      const i = pair.indexOf('=');
      try { localStorage.setItem(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); } catch { /* no storage */ }
    }
  }, { previews: PREVIEWS, lsArm: LS_ARM });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  let layers = [];
  await cdp.send('LayerTree.enable').catch(() => {});
  cdp.on('LayerTree.layerTreeDidChange', (p) => { if (p.layers) layers = p.layers; });
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  return { context, page, cdp, layers: () => layers };
}

const metrics = async (cdp) => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return m;
};
const delta = (a, b, keys) => Object.fromEntries(keys.map((k) => [k, Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 1000) / 1000]));
const DELTA_KEYS = ['RecalcStyleCount', 'RecalcStyleDuration', 'LayoutCount', 'LayoutDuration', 'ScriptDuration', 'TaskDuration', 'JSEventListeners'];

function layerCensus(layers) {
  const drawn = layers.filter((l) => l.drawsContent).map((l) => ({ w: l.width, h: l.height, paints: l.paintCount, id: l.layerId }));
  drawn.sort((a, b) => b.w * b.h - a.w * a.h);
  const bytes = drawn.reduce((s, l) => s + l.w * l.h * 4, 0);
  return { count: layers.length, drawing: drawn.length, estMb: Math.round(bytes / 1048576), top: drawn.slice(0, 8) };
}

/* ---- one block: arm the probe, drive keys, score ------------------------------------------------ */
async function block(page, cdp, label, drive) {
  await page.evaluate(() => { window.__gperf.reset(); });
  await page.evaluate((l) => window.__gperf.tag(l), label);
  const m0 = await metrics(cdp);
  const t0 = Date.now();
  await drive();
  await sleep(500);                                   // let the last press's 400ms window close
  const m1 = await metrics(cdp);
  const wall = Date.now() - t0;
  const perf = await page.evaluate((l) => window.__gperf.summary([l])[0], label);
  const idle = label === 'idle' ? await page.evaluate(() => window.__gperf.idleStats()) : null;
  const shape = await page.evaluate(ROW_SHAPE);
  const sample = await page.evaluate(SAMPLE);
  const d = delta(m0, m1, DELTA_KEYS);
  const n = Math.max(1, perf.presses);
  return {
    label, wallMs: wall,
    frames: idle ? { ...idle } : {
      presses: perf.presses, p50: perf.p50, p95: perf.p95, p99: perf.p99, worst: perf.worstFrame,
      within: perf.within, onTimePct: perf.onTimePct, dropped: perf.droppedFrames, over67: perf.framesOver67,
      maxRunOver50: perf.maxRunOver50, latencyP50: perf.latencyMedian, latencyP95: perf.latencyP95, stallMean: perf.stallMean,
    },
    perPress: { recalcs: +(d.RecalcStyleCount / n).toFixed(2), styleMs: +((d.RecalcStyleDuration * 1000) / n).toFixed(2), layouts: +(d.LayoutCount / n).toFixed(2), layoutMs: +((d.LayoutDuration * 1000) / n).toFixed(2), scriptMs: +((d.ScriptDuration * 1000) / n).toFixed(2), taskMs: +((d.TaskDuration * 1000) / n).toFixed(2) },
    totals: d, nodes: m1.Nodes, jsHeapMb: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    row: shape, sample,
  };
}

const press = async (page, key, n, gap) => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(gap); } };
const hold = async (page, key, n, gap) => { for (let i = 0; i < n; i++) { await page.keyboard.down(key); await sleep(gap); } await page.keyboard.up(key); };

/* ---- --snap: the structural walk --------------------------------------------------------------- */
async function snapRun(browser) {
  const { context, page } = await openPage(browser);
  await intoRow(page);
  await sleep(1500);
  const steps = [];
  const rec = async (what) => {
    const v = await page.evaluate(VISIBLE);
    if (v) steps.push({ what, ...v });
    else steps.push({ what, lost: await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}.${a?.className}`; }) });
  };
  const shape = await page.evaluate(ROW_SHAPE);
  await rec('rest');
  for (let i = 0; i < 14; i++) { await page.keyboard.press('ArrowRight'); await sleep(120); await rec(`right${i}@120ms`); await sleep(780); await rec(`right${i}`); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowLeft'); await sleep(120); await rec(`left${i}@120ms`); await sleep(780); await rec(`left${i}`); }
  /* A hold: sample mid-glide every step, then the rest after release. */
  for (let i = 0; i < 26; i++) { await page.keyboard.down('ArrowRight'); await sleep(160); await rec(`held${i}@160ms`); await sleep(170); }
  await page.keyboard.up('ArrowRight');
  await sleep(900);
  await rec('afterHold');
  for (let i = 0; i < 8; i++) { await page.keyboard.down('ArrowLeft'); await sleep(160); await rec(`heldLeft${i}@160ms`); await sleep(170); }
  await page.keyboard.up('ArrowLeft');
  await sleep(900);
  await rec('afterHoldLeft');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowLeft'); await sleep(900); await rec(`leftAfterHold${i}`); }
  /* Down a row and back: the row must be exactly where it was left. */
  await page.keyboard.press('ArrowDown'); await sleep(1200);
  await page.keyboard.press('ArrowUp'); await sleep(1200);
  await rec('afterDownUp');
  const shapeEnd = (await page.evaluate(ROW_SHAPE)) || { tiles: -1, stripContentWidth: -1 };
  await context.close();
  return { label: LABEL, dist: DIST, tilesPerRow: shape.tiles, tilesPerRowEnd: shapeEnd.tiles, stripWidthEnd: shapeEnd.stripContentWidth, steps };
}


/* ---- --soak: does the page stay the same size after half an hour of use? ------------------------
 * The television is left open for hours, and the notes record dropped frames drifting from 28% to
 * ~50% over an hour of testing. What can be counted from here: live DOM nodes (the engine's own
 * count, which includes detached nodes still in memory, against the document's element count),
 * images and decoded images, videos, running animations, event listeners, the JS heap after a
 * forced GC, and the idle frame distribution. Each loop is vertical walking, a held horizontal
 * walk, deliberate presses, and the detail screen opened and closed with OK / Back. */
async function soakRun(browser) {
  const { context, page, cdp, layers } = await openPage(browser);
  await cdp.send('HeapProfiler.enable').catch(() => {});
  await intoRow(page);
  const samples = [];
  const sample = async (minute) => {
    await sleep(1500);
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(300);
    const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
    const m = await metrics(cdp);
    await page.evaluate(() => { window.__gperf.reset(); });
    await sleep(3000);
    const idle = await page.evaluate(() => window.__gperf.idleStats());
    const s = await page.evaluate(SAMPLE);
    const inPage = await page.evaluate(() => ({
      elements: document.getElementsByTagName('*').length,
      animations: document.getAnimations().length,
      tiles: document.querySelectorAll('.tv-spot-thumb').length,
      overlays: document.querySelectorAll('.overlay.open').length,
      focus: document.activeElement ? document.activeElement.className.slice(0, 30) : '',
    }));
    const row = { minute, liveNodes: dom.nodes, documents: dom.documents, listeners: dom.jsEventListeners, elements: inPage.elements, detachedApprox: (dom.nodes ?? 0) - inPage.elements,
      tiles: inPage.tiles, animations: inPage.animations, images: s.images, decoded: s.imagesDecoded, bitmapMb: s.bitmapMb, videos: s.videos, preview: s.previewMounted,
      heapMb: +(m.JSHeapUsedSize / 1048576).toFixed(1), longTasks: s.longTasks, longWorst: s.longTaskWorst, idleP95: idle.p95, idleWorst: idle.worstFrame, idleOnTime: idle.onTimePct,
      layers: layerCensus(layers()).drawing, overlays: inPage.overlays, focus: inPage.focus };
    samples.push(row);
    console.log(`  min ${String(minute).padStart(2)}  nodes ${row.liveNodes} (doc ${row.elements}, ~detached ${row.detachedApprox})  listeners ${row.listeners}  tiles ${row.tiles}  anim ${row.animations}  img ${row.decoded}/${row.images} ~${row.bitmapMb}MB  video ${row.videos}  heap ${row.heapMb}MB  longtask ${row.longTasks}/${row.longWorst}ms  idle p95 ${row.idleP95} worst ${row.idleWorst}  layers ${row.layers}  focus ${row.focus}`);
  };
  await sample(0);
  const t0 = Date.now();
  let minute = 1;
  /* Focus can leave the rows — Up off the first row reaches the hero and the nav bar, where a
   * Right changes the route. Every phase starts by making sure the remote is on a home row,
   * without reloading (a reload would reset the very session being measured). */
  const ensureRow = async () => {
    if (await page.evaluate(() => location.hash !== '#/' && location.hash !== '')) {
      await page.evaluate(() => { location.hash = '#/'; });
      await sleep(1200);
    }
    if (!(await page.evaluate(IN_ROW))) await intoRow(page);
  };
  while (Date.now() - t0 < SOAK * 60000) {
    const loopStart = Date.now();
    await ensureRow();
    await press(page, 'ArrowDown', 4, 700);
    await hold(page, 'ArrowRight', 20, 330); await sleep(900);
    await press(page, 'ArrowLeft', 4, 700);
    /* OK opens the title, Back closes it — one overlay per press, asserted. */
    await page.keyboard.press('Enter');
    const opened = await page.waitForSelector('.overlay.open', { timeout: 6000 }).then(() => true).catch(() => false);
    if (opened) {
      await sleep(1500);
      const open = await page.evaluate(() => document.querySelectorAll('.overlay.open').length);
      if (open > 1) throw new Error(`${open} overlays open`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.overlay.open', { state: 'detached', timeout: 6000 }).catch(() => {});
      await sleep(600);
    }
    await ensureRow();
    await press(page, 'ArrowUp', 3, 700);
    await ensureRow();
    await hold(page, 'ArrowDown', 5, 450); await sleep(700);
    await hold(page, 'ArrowUp', 4, 450); await sleep(700);
    await ensureRow();
    await press(page, 'ArrowRight', 5, 600);
    if (Date.now() - t0 >= minute * 60000) { await sample(minute); minute++; }
    if (Date.now() - loopStart < 500) await sleep(500);
  }
  await sample(minute);
  await context.close();
  return samples;
}

/* ---- main ---------------------------------------------------------------------------------------- */
const browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS });
await mkdir(join(ROOT, OUT), { recursive: true });
try {
  if (SOAK) {
    const samples = await soakRun(browser);
    const file = join(ROOT, OUT, `soak-${LABEL}.json`);
    await writeFile(file, JSON.stringify({ label: LABEL, dist: DIST, minutes: SOAK, samples }, null, 1));
    console.log(`→ ${file}`);
  } else if (SNAP) {
    const r = await snapRun(browser);
    const file = join(ROOT, OUT, `snap-${LABEL}.json`);
    await writeFile(file, JSON.stringify(r, null, 1));
    console.log(`snap: ${r.steps.length} steps, ${r.tilesPerRow} tiles/row at rest, ${r.tilesPerRowEnd} after the walk (strip ${r.stripWidthEnd}px) → ${file}`);
  } else {
    const rounds = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { context, page, cdp, layers } = await openPage(browser);
      const settled = await page.evaluate(SAMPLE);
      await intoRow(page);
      await sleep(1500);
      const blocks = [];
      blocks.push(await block(page, cdp, 'idle', () => sleep(3000)));
      blocks.push(await block(page, cdp, 'horiz-deliberate', () => press(page, 'ArrowRight', 12, 900)));
      blocks.push(await block(page, cdp, 'horiz-held', () => hold(page, 'ArrowRight', 24, 330)));
      await sleep(1200);
      blocks.push(await block(page, cdp, 'horiz-back', () => press(page, 'ArrowLeft', 6, 900)));
      blocks.push(await block(page, cdp, 'vert-deliberate', async () => { await press(page, 'ArrowDown', 6, 900); await press(page, 'ArrowUp', 6, 900); }));
      blocks.push(await block(page, cdp, 'vert-held', async () => { await hold(page, 'ArrowDown', 6, 450); await sleep(800); await hold(page, 'ArrowUp', 6, 450); }));
      const census = layerCensus(layers());
      const final = await page.evaluate(SAMPLE);
      const m = await metrics(cdp);
      rounds.push({ round, settled, blocks, layers: census, final, nodes: m.Nodes, jsHeapMb: +(m.JSHeapUsedSize / 1048576).toFixed(1) });
      await context.close();
    }
    const out = { label: LABEL, dist: DIST, throttle: THROTTLE, previews: PREVIEWS, dpr: DPR, at: new Date().toISOString(), rounds };
    const file = join(ROOT, OUT, `bench-${LABEL}.json`);
    await writeFile(file, JSON.stringify(out, null, 1));
    /* A compact table on stdout. */
    for (const r of rounds) {
      console.log(`\n== ${LABEL} round ${r.round}  rows ${r.settled.rows}  tiles ${r.final ? document_tiles(r) : '?'}  layers ${r.layers.drawing}/${r.layers.count} ~${r.layers.estMb}MB  nodes ${r.nodes}  heap ${r.jsHeapMb}MB  bitmap ~${r.final.bitmapMb}MB  img ${r.final.imagesDecoded}/${r.final.images}`);
      console.log('  biggest layers: ' + r.layers.top.slice(0, 4).map((l) => `${l.w}x${l.h} (p${l.paints})`).join(', '));
      for (const b of r.blocks) {
        const f = b.frames;
        if (b.label === 'idle') { console.log(`  ${b.label.padEnd(16)} frames ${f.frames}  p50 ${f.p50}  p95 ${f.p95}  worst ${f.worstFrame}  on-time ${f.onTimePct}%`); continue; }
        console.log(`  ${b.label.padEnd(16)} n=${f.presses}  p50 ${f.p50}  p95 ${f.p95}  p99 ${f.p99}  worst ${f.worst}  on-time ${f.onTimePct}%  >67 ${f.over67}  drop ${f.dropped}  lat ${f.latencyP50}/${f.latencyP95}  | per press: recalc ${b.perPress.recalcs} (${b.perPress.styleMs}ms) layout ${b.perPress.layouts} (${b.perPress.layoutMs}ms) script ${b.perPress.scriptMs}ms task ${b.perPress.taskMs}ms | row tiles ${b.row?.tiles} strip ${b.row?.stripContentWidth}px src ${b.row?.withSrc}/${b.row?.imgs}`);
      }
    }
    console.log(`\n→ ${file}`);
  }
} finally {
  await browser.close();
  server.close();
}
function document_tiles(r) { return r.blocks[r.blocks.length - 1]?.row?.allTiles ?? '?'; }
