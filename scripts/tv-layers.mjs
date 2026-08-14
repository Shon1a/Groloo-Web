/* HOW MANY COMPOSITOR LAYERS THE TV HOME SCREEN IS HOLDING, AND HOW BIG THEY ARE.
 *
 *   node scripts/tv-layers.mjs --url=http://192.168.0.7:4173/
 *   node scripts/tv-layers.mjs --url=... --rows=virtual --previews=off
 *
 * WHY. Traced on the reference set, the worst frames on BOTH axes are dominated by compositor work
 * rather than JavaScript: `GPUTask` 45-120ms, a main-thread `Commit` at 60ms, and `Layerize` showing
 * up in frame after frame. Horizontal held presses bypass React entirely — no setState, no
 * reconcile — and still score about the same as deliberate ones, which is what says the bottleneck
 * is not the script.
 *
 * A layer census is the direct measurement of that. Each promoted layer is a texture the GPU holds
 * and re-uploads; `will-change: transform` on a per-row element multiplies it by the number of rows.
 * The brief asks to "promote only the currently moving surface, not every row", and this is how to
 * tell whether that is what is happening.
 *
 * TEXTURE BYTES ARE AN ESTIMATE: width x height x 4 for RGBA8888, which is what Skia usually
 * allocates. The engine may tile a large layer, may hold a lower-resolution copy, and may not have
 * rasterised a layer at all. Right to an order of magnitude, which is the precision the decision
 * needs.
 */
import { spawn, execSync } from 'node:child_process';
import WebSocket from 'ws';

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const URL_ = arg('url', 'http://192.168.0.7:4173/');
const PREVIEWS = arg('previews', 'on');
const ROWS_MODE = arg('rows', '');
const SCROLL = arg('scroll', '');
const TOP = Number(arg('top', '14'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sweep = () => { try { execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'ares-inspect\' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }"', { stdio: 'ignore' }); } catch { /* none */ } };
let insp = null;
const down = () => { if (insp) { try { execSync(`taskkill /PID ${insp.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } insp = null; } sweep(); };
for (const s of ['exit', 'SIGINT', 'SIGTERM']) process.on(s, down);

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.l = new Map();
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== undefined) { const q = this.p.get(m.id); if (!q) return; this.p.delete(m.id); if (m.error) q.reject(new Error(m.error.message)); else q.resolve(m.result); }
      else (this.l.get(m.method) || []).forEach((f) => f(m.params));
    });
    this.ws.on('close', () => this.failAll('socket closed'));
    this.ws.on('error', (e) => this.failAll(e.message));
  }
  open() { return new Promise((a, b) => { this.ws.once('open', a); this.ws.once('error', b); }); }
  on(m, f) { if (!this.l.has(m)) this.l.set(m, []); this.l.get(m).push(f); }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.p.delete(id); rej(new Error(`CDP timeout: ${m}`)); }, 30000);
      this.p.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method: m, params: p }));
    });
  }
  failAll(w) { const d = [...this.p.values()]; this.p.clear(); d.forEach((q) => q.reject(new Error(w))); }
  async eval(e, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  }
}

function openInspector() {
  return new Promise((resolve, reject) => {
    const p = spawn('ares-inspect', ['--device', 'tv', '--app', 'com.groloo.web'], { shell: true });
    insp = p; let buf = '', done = false;
    const tryR = async () => {
      if (done) return;
      const d = buf.match(/ws=([^\s]+)/); if (d) { done = true; return resolve(`ws://${d[1]}`); }
      const b = buf.match(/http:\/\/(localhost:\d+)/); if (!b) return;
      try { const l = await (await fetch(`http://${b[1]}/json/list`)).json(); const t = l.find((x) => x.webSocketDebuggerUrl); if (t) { done = true; resolve(t.webSocketDebuggerUrl); } } catch { /* not up */ }
    };
    p.stdout.on('data', (d) => { buf += d; tryR(); }); p.stderr.on('data', (d) => { buf += d; tryR(); });
    const iv = setInterval(tryR, 1000);
    setTimeout(() => { clearInterval(iv); if (!done) reject(new Error('no inspector')); }, 45000);
  });
}

const KEY = { ArrowDown: 40 };
async function press(cdp, key) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: KEY[key], nativeVirtualKeyCode: KEY[key] });
  }
}

sweep();
try { execSync('ares-launch --device tv com.groloo.web', { stdio: 'ignore' }); } catch { /* running */ }
await sleep(2500);
const cdp = new CDP(await openInspector());
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__GROLOO_PERF__ = true;' });
await cdp.send('Page.navigate', { url: URL_ });
await sleep(4000);
await cdp.eval(`(function(){
  var K='groloo.settings.v1'; var s={}; try{s=JSON.parse(localStorage.getItem(K)||'{}');}catch(e){}
  s.tvRowTrailers = ${PREVIEWS === 'on' ? 'true' : 'false'};
  localStorage.setItem(K, JSON.stringify(s));
  ${SCROLL ? `localStorage.setItem('groloo.tvscroll', ${JSON.stringify(SCROLL)});` : `localStorage.removeItem('groloo.tvscroll');`}
  ${ROWS_MODE ? `localStorage.setItem('groloo.tvrows', ${JSON.stringify(ROWS_MODE)});` : `localStorage.removeItem('groloo.tvrows');`}
})()`);
await cdp.send('Page.reload');
/* Past the auth round trip, for the same reason tv-measure waits: the page renders once on the
 * default row config and again on the signed-in user's. */
await sleep(19000);

const build = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.buildIdentity())'));
const sample = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.sample())'));
console.log(`\n  BUILD ${build.commit}${build.dirty ? '+dirty' : ' CLEAN'}  previews=${build.previews} scroll=${build.scroll} rows=${build.rows}`);
console.log(`  at rest: ${sample.rows} rows, ${sample.cards} cards, ${sample.imagesDecoded}/${sample.images} img, bitmap ~${sample.bitmapMb}MB\n`);

// Seat on a row so the census reflects a focused home screen rather than the hero.
for (let i = 0; i < 6; i++) {
  if (await cdp.eval(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.tv-spot'))`)) break;
  await press(cdp, 'ArrowDown'); await sleep(700);
}
await sleep(1500);

/* ---- WHAT THE PAGE ACTUALLY COSTS, from the engine rather than from layer arithmetic.
 * Layer bounds x 4 bytes is an UPPER bound — Chromium tiles large layers and only rasterises what
 * is near the viewport, so a 57.5MB "layer" may never be allocated in full. These are the counters
 * the engine keeps, which is what memory pressure is actually computed from. */
await cdp.send('Performance.enable');
const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const dom = await cdp.send('Memory.getDOMCounters').catch(() => null);
console.log('  ENGINE COUNTERS');
console.log(`    JS heap used   ${(metrics.JSHeapUsedSize / 1048576).toFixed(1)}MB   total ${(metrics.JSHeapTotalSize / 1048576).toFixed(1)}MB`);
console.log(`    DOM nodes      ${dom ? dom.nodes : '?'}   listeners ${dom ? dom.jsEventListeners : '?'}   documents ${dom ? dom.documents : '?'}`);
console.log(`    layout count   ${metrics.LayoutCount}   recalc ${metrics.RecalcStyleCount}`);
console.log(`    layout dur     ${(metrics.LayoutDuration || 0).toFixed(2)}s   recalc ${(metrics.RecalcStyleDuration || 0).toFixed(2)}s   script ${(metrics.ScriptDuration || 0).toFixed(2)}s
`);

let layers = [];
cdp.on('LayerTree.layerTreeDidChange', (p) => { if (p.layers) layers = p.layers; });
await cdp.send('LayerTree.enable');
await sleep(2500);

/* ---- OPTIONAL CSS PROBE ----------------------------------------------------------------------
 * `--css='<rules>'` injects a stylesheet and re-censuses, so a hypothesis about WHY a layer is the
 * size it is can be tested in seconds instead of a rebuild-and-reinstall cycle. Used to check
 * whether the rail's rounded clip is what stops Chromium clipping the strip's composited layer to
 * the rail's box — a rounded clip cannot be applied as a simple rect clip, so the layer stays its
 * full content width. */
const CSS = arg('css', '');
if (CSS) {
  await cdp.eval(`(function(){
    var s = document.getElementById('__probe_css') || document.createElement('style');
    s.id = '__probe_css'; s.textContent = ${JSON.stringify(CSS)};
    if (!s.parentNode) document.head.appendChild(s);
  })()`);
  await sleep(2500);
  /* Nudge the compositor so the layer tree is rebuilt with the new clip. */
  await press(cdp, 'ArrowDown'); await sleep(1200);
  await press(cdp, 'ArrowDown'); await sleep(2500);
}

if (!layers.length) {
  console.log('  LayerTree reported no layers (the domain may be unavailable on this build).');
  down(); process.exit(0);
}

const named = [];
let totalBytes = 0, drawing = 0;
for (const l of layers) {
  const bytes = (l.width || 0) * (l.height || 0) * 4;
  totalBytes += bytes;
  if (l.drawsContent) drawing++;
  let who = '(no backing node)';
  if (l.backendNodeId) {
    try {
      const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [l.backendNodeId] });
      const d = await cdp.send('DOM.describeNode', { nodeId: nodeIds[0] });
      const n = d.node;
      const cls = (n.attributes || []).reduce((acc, v, i, arr) => (arr[i - 1] === 'class' ? v : acc), '');
      who = `${(n.localName || n.nodeName || '?').toLowerCase()}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`;
    } catch { /* node may be gone */ }
  }
  named.push({ who, w: l.width, h: l.height, mb: bytes / 1048576, draws: !!l.drawsContent, paints: l.paintCount || 0 });
}

named.sort((a, b) => b.mb - a.mb);
console.log(`  LAYERS: ${layers.length} total, ${drawing} drawing content, ~${totalBytes / 1048576 | 0}MB of texture if all were rasterised\n`);
console.log(`  ${'element'.padEnd(46)}${'size'.padStart(13)}${'MB'.padStart(8)}${'paints'.padStart(8)}`);
console.log(`  ${'-'.repeat(75)}`);
for (const l of named.slice(0, TOP)) {
  console.log(`  ${l.who.slice(0, 44).padEnd(46)}${`${l.w}x${l.h}`.padStart(13)}${l.mb.toFixed(1).padStart(8)}${String(l.paints).padStart(8)}`);
}
/* The count that matters for "promote only the moving surface": how many layers exist per ROW. */
const perRow = named.filter((l) => /tv-spot/.test(l.who));
console.log(`\n  layers backed by a .tv-spot* element: ${perRow.length}  (${sample.rows} rows on screen)`);
down();
process.exit(0);
