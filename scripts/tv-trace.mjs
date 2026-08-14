/* WHAT THE TELEVISION WAS ACTUALLY DOING DURING THE WORST FRAMES.
 *
 *   node scripts/tv-trace.mjs --url=http://192.168.0.7:4173/ --axis=vertical --presses=20
 *   node scripts/tv-trace.mjs --url=... --axis=horizontal --cadence=held --previews=off --label=x
 *
 * WHY THIS EXISTS. tv-measure.mjs says a frame took 142ms. It cannot say WHY, and every previous
 * round of this investigation guessed at the why and got it wrong at least once — the row's eleven
 * animations were removed on a styling theory and the worst frame did not move by a millisecond,
 * because the real cost was a media pipeline with no CSS surface to remove. A frame-time histogram
 * is a symptom. This is the diagnosis.
 *
 * HOW IT CORRELATES, which is the only subtle part. Chromium trace events carry `ts` in MICROSECONDS
 * on an internal monotonic clock; the probe records frames in `performance.now()` MILLISECONDS. The
 * two have no fixed relationship, so the page emits `console.timeStamp('gsync')` at a moment whose
 * `performance.now()` it also reports. That single event appears in the trace with a `ts`, which
 * pins the two clocks together. Everything after is arithmetic.
 *
 * WHAT IT REPORTS. For each of the worst frames, every trace event overlapping that frame's window,
 * grouped into the categories a decision would actually be made from — JavaScript, React
 * render/commit, style recalculation, layout, paint, composite, image decode, media, GC, network —
 * with the single largest contributor named. Uncategorised events are reported as themselves rather
 * than silently dropped, because an unknown task in a 142ms frame is the most interesting thing on
 * the screen.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DEVICE = arg('device', 'tv');
const APP = arg('app', 'com.groloo.web');
const URL_ = arg('url', 'http://192.168.0.7:4173/');
const AXIS = arg('axis', 'vertical');
const CADENCE = arg('cadence', 'deliberate');
const PRESSES = Number(arg('presses', '20'));
const PREVIEWS = arg('previews', 'on');
const SCROLL = arg('scroll', '');
const ROWS_MODE = arg('rows', '');
const LABEL = arg('label', `${AXIS}-${CADENCE}`);
const TOPN = Number(arg('top', '10'));
const OUT = arg('out', 'perf-results');
const COLD = process.argv.includes('--cold');
/* `--css='<rules>'` — an ablation arm without a rebuild. Injected into every document so it
 * survives the reload the driver performs after writing the localStorage arms. */
const CSS_ARM = arg('css', '');
const REQUEST_TIMEOUT_MS = 60000;

const GAP = CADENCE === 'held' ? 240 : CADENCE === 'settled' ? 5000 : 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- tunnel hygiene: identical to tv-measure.mjs, and for the same reason (OpenSSH 6.1 session
 * cap on the set — leak a few and it stops completing handshakes at all). */
const sweepInspectors = () => {
  try {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | '
      + 'Where-Object { $_.CommandLine -match \'ares-inspect\' } | '
      + 'ForEach-Object { taskkill /PID $_.ProcessId /T /F }"', { stdio: 'ignore' });
  } catch { /* nothing to sweep */ }
};
let inspector = null;
const shutdown = () => {
  if (inspector) {
    try { execSync(`taskkill /PID ${inspector.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    inspector = null;
  }
  sweepInspectors();
};
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => { shutdown(); if (err instanceof Error) { console.error(err); process.exit(1); } });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
    });
    this.ws.on('close', (c) => this.failAll(`CDP socket closed by the television (code ${c})`));
    this.ws.on('error', (e) => this.failAll(`CDP socket error: ${e.message}`));
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  failAll(why) { const d = Array.from(this.pending.values()); this.pending.clear(); for (const p of d) p.reject(new Error(why)); }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
    return r.result.value;
  }
}

function openInspector() {
  return new Promise((resolve, reject) => {
    const p = spawn('ares-inspect', ['--device', DEVICE, '--app', APP], { shell: true });
    inspector = p; let buf = '', done = false;
    const tryResolve = async () => {
      if (done) return;
      const direct = buf.match(/ws=([^\s]+)/);
      if (direct) { done = true; return resolve(`ws://${direct[1]}`); }
      const base = buf.match(/http:\/\/(localhost:\d+)/);
      if (!base) return;
      try {
        const list = await (await fetch(`http://${base[1]}/json/list`)).json();
        const page = list.find((t) => t.webSocketDebuggerUrl);
        if (page) { done = true; resolve(page.webSocketDebuggerUrl); }
      } catch { /* not up yet */ }
    };
    const onData = (d) => { buf += d.toString(); tryResolve(); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', (c) => { if (!done) reject(new Error(`ares-inspect exited (${c})\n${buf}`)); });
    const poll = setInterval(tryResolve, 1000);
    setTimeout(() => { clearInterval(poll); if (!done) reject(new Error('no inspector URL after 45s')); }, 45000);
  });
}

const KEYCODE = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Enter: 13 };
async function press(cdp, key) {
  const code = KEYCODE[key];
  const down = key === 'Enter' ? { type: 'keyDown', text: '\r', unmodifiedText: '\r' } : { type: 'rawKeyDown' };
  await cdp.send('Input.dispatchKeyEvent', { ...down, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

/* ---- HOW A TRACE EVENT BECOMES AN ANSWER -----------------------------------------------------
 * The names are Chromium's, and they are grouped the way a decision gets made rather than the way
 * the renderer is architected. `UpdateLayoutTree` really is style recalculation (it was renamed
 * from RecalculateStyles years ago and both appear depending on the milestone), and both are listed
 * so this keeps working across webOS versions. */
const CATEGORY = [
  [/^(FunctionCall|EvaluateScript|v8\.run|V8\.Execute|TimerFire|EventDispatch|RunMicrotasks|XHRReadyStateChange)$/, 'JavaScript'],
  [/^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|InvalidateLayout)$/, 'Style recalc'],
  [/^(Layout|LayoutShift|UpdateLayerTree)$/, 'Layout'],
  [/^(Paint|PaintImage|PaintSetup|ScrollLayer|SetLayerTreeId)$/, 'Paint'],
  [/^(CompositeLayers|Compositor|DrawFrame|ActivateLayerTree|BeginFrame|NeedsBeginFrameChanged)$/, 'Composite'],
  [/^(ImageDecodeTask|Decode Image|ImageDecode|DecodeLazyPixelRef|Draw LazyPixelRef)$/, 'Image decode'],
  [/GC|CollectGarbage|BlinkGC/, 'GC'],
  [/^(ResourceSendRequest|ResourceReceiveResponse|ResourceReceivedData|ResourceFinish|ParseHTML)$/, 'Network/parse'],
  [/WebMediaPlayer|Pipeline|MediaSource|VideoRenderer|AudioRenderer|Demuxer/, 'Media pipeline'],
  [/^(ServiceWorker|Worker)/, 'Service worker'],
];
const categorise = (name) => {
  for (const [re, cat] of CATEGORY) if (re.test(name)) return cat;
  return null;
};

/* ---- CONTAINERS ARE NOT CAUSES ---------------------------------------------------------------
 * `RunTask` wraps every top-level task on a thread, so it always "wins" a naive ranking and always
 * says nothing: a 170ms RunTask is the frame, not the reason for it. The same goes for the
 * microtask checkpoint and the message-pump wrappers. They are excluded from the ranking and their
 * CHILDREN are what get reported.
 *
 * The first version of this script ranked them, and the answer to "why is this frame 133ms" came
 * back "RunTask, 171ms" — which is both true and useless, and worse, the 171ms exceeded the frame
 * itself because nested and cross-thread events were being summed as if they were disjoint. */
const CONTAINERS = /^(RunTask|ThreadControllerImpl::RunTask|MessageLoop::RunTask|SequenceManager|ThreadControllerImpl::DoWork|TaskGraphRunner::RunTask)$/;

/* WHICH THREAD DID THE WORK, because the answer changes what to do about it entirely. Main-thread
 * time is the app's fault and the app can fix it. Raster and GPU time is the compositor's, and the
 * lever there is fewer/smaller layers rather than less JavaScript. Summing them together produces
 * totals larger than the frame and a conclusion pointing at neither. */
function threadNames(events) {
  const names = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name) names.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  return names;
}
const threadRole = (name) => {
  if (!name) return 'other';
  if (/CrRendererMain/.test(name)) return 'main';
  if (/^compositor$|crbrowsermain/i.test(name)) return 'compositor';
  if (/compositortileworker|raster|threadpool/i.test(name)) return 'raster';
  if (/gpu|viz/i.test(name)) return 'gpu';
  return 'other';
};

async function main() {
  sweepInspectors();
  try { execSync(`ares-launch --device ${DEVICE} ${APP}`, { stdio: 'ignore' }); } catch { /* already up */ }
  await sleep(2500);
  const cdp = new CDP(await openInspector());
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__GROLOO_PERF__ = true;' });
  if (CSS_ARM) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', function(){
        var s = document.createElement('style'); s.id = '__css_arm';
        s.textContent = ${JSON.stringify(CSS_ARM)};
        document.head.appendChild(s);
      });`,
    });
  }
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000);

  /* Arms are set before the reload so the app reads them at module scope, exactly as tv-measure
   * does — the two scripts must configure the app identically or their results cannot be compared. */
  await cdp.eval(`(function(){
    var K='groloo.settings.v1'; var s={}; try{s=JSON.parse(localStorage.getItem(K)||'{}');}catch(e){}
    s.tvRowTrailers = ${PREVIEWS === 'on' ? 'true' : 'false'};
    localStorage.setItem(K, JSON.stringify(s));
    ${SCROLL ? `localStorage.setItem('groloo.tvscroll', ${JSON.stringify(SCROLL)});` : `localStorage.removeItem('groloo.tvscroll');`}
    ${ROWS_MODE ? `localStorage.setItem('groloo.tvrows', ${JSON.stringify(ROWS_MODE)});` : `localStorage.removeItem('groloo.tvrows');`}
  })()`);
  /* COLD ARTWORK means the image cache must be empty, and only the service worker + HTTP cache hold
   * it. Clearing storage is the honest way to get a cold arm; anything less measures a warm one. */
  if (COLD) {
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    await cdp.eval(`(async function(){ if (window.caches) { var ks = await caches.keys(); await Promise.all(ks.map(function(k){return caches.delete(k);})); } })()`, true);
  }
  await cdp.send('Page.reload');
  await sleep(COLD ? 9000 : 5000);

  const build = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.buildIdentity())'));
  console.log(`\n  BUILD ${build.commit}${build.dirty ? '+dirty' : '  *** CLEAN ***'}  ${build.mode}  ${build.builtAt}`);
  console.log(`        ${build.url}`);
  console.log(`        previews=${build.previews} scroll=${build.scroll} rows=${build.rows}  artwork=${COLD ? 'COLD' : 'warm'}`);
  if (CSS_ARM) console.log(`        css arm: ${CSS_ARM}`);

  // Settle: rows AND decoded images both still, same criterion as tv-measure.
  /* Same two-renders problem as tv-measure's waitSettled: the page comes up on the default row
   * config and drops to the signed-in user's config after the auth round trip. Wait past it. */
  const settleStart = Date.now();
  let lastR = -1, lastD = -1, quiet = 0;
  for (let i = 0; i < 240 && (quiet < 8 || Date.now() - settleStart < 16000); i++) {
    const s = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.sample())'));
    if (s.rows > 0 && s.rows === lastR && s.imagesDecoded === lastD) quiet++;
    else { quiet = 0; lastR = s.rows; lastD = s.imagesDecoded; }
    await sleep(500);
  }
  console.log(`        settled rows=${lastR} decoded=${lastD}`);

  // Seat the remote on a row — pressing arrows at the featured hero measures its autorotate.
  for (let i = 0; i < 6; i++) {
    if (await cdp.eval(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.tv-spot'))`)) break;
    await press(cdp, 'ArrowDown'); await sleep(700);
  }

  /* ---- CLOCK SYNC. One console.timeStamp whose performance.now() we also read; it lands in the
   * trace with a `ts`, which is what pins microseconds-since-boot to milliseconds-since-origin. */
  const events = [];
  cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) events.push(e); });
  const tracingComplete = new Promise((res) => cdp.on('Tracing.tracingComplete', res));
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
      ],
    },
  });
  const syncNow = await cdp.eval('(function(){ var t = performance.now(); console.timeStamp("gsync"); return t; })()');

  await cdp.eval(`window.__gperf.reset(); window.__gperf.tag(${JSON.stringify(LABEL)})`);
  const key = AXIS === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const back = AXIS === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const span = AXIS === 'horizontal' ? 7 : 4;
  let dir = key, since = 0;
  for (let i = 0; i < PRESSES; i++) {
    if (since === span) { dir = dir === key ? back : key; since = 0; }
    await press(cdp, dir); since++;
    await sleep(GAP);
  }
  await sleep(700);

  const block = JSON.parse(await cdp.eval(`JSON.stringify(window.__gperf.summary([${JSON.stringify(LABEL)}])[0])`));
  const raw = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.raw())'));
  await cdp.send('Tracing.end');
  await tracingComplete;

  /* ---- PIN THE CLOCKS TOGETHER ---------------------------------------------------------------- */
  const syncEvt = events.find((e) => (e.name === 'TimeStamp' || e.name === 'ConsoleTime')
    && JSON.stringify(e.args || {}).includes('gsync'));
  if (!syncEvt) {
    console.error('\n  Could not find the gsync marker in the trace — cannot correlate. Aborting.');
    console.error(`  (${events.length} events captured; is blink.user_timing in the category list?)\n`);
    shutdown(); process.exit(3);
  }
  /** trace ts (µs) -> page performance.now() (ms) */
  const toPage = (ts) => (ts - syncEvt.ts) / 1000 + syncNow;

  const tnames = threadNames(events);
  const durational = events
    .filter((e) => (e.ph === 'X' || e.ph === 'B') && typeof e.dur === 'number' && e.dur > 0)
    .map((e) => ({ ...e, role: threadRole(tnames.get(`${e.pid}:${e.tid}`)) }));
  console.log(`\n  trace: ${events.length} events, ${durational.length} with a duration`);
  console.log(`  threads: ${Array.from(new Set(tnames.values())).slice(0, 8).join(', ')}\n`);

  /* ---- THE WORST FRAMES, AND WHAT WAS INSIDE THEM --------------------------------------------- */
  const frames = raw.frames.slice().sort((a, b) => b.dt - a.dt).slice(0, TOPN);
  const findings = [];
  for (const f of frames) {
    const endMs = f.t;                 // rAF timestamp = the frame's END
    const startMs = f.t - f.dt;
    const inside = durational.filter((e) => {
      const s = toPage(e.ts), en = s + e.dur / 1000;
      return en > startMs && s < endMs;
    });
    /* Per-thread-role totals, so "the main thread was busy for 90ms of this 116ms frame" and "the
     * GPU was busy for 94ms" are separate statements rather than one impossible sum. */
    const roleMs = { main: 0, compositor: 0, raster: 0, gpu: 0, other: 0 };
    const byCat = new Map();
    for (const e of inside) {
      const s = Math.max(toPage(e.ts), startMs);
      const en = Math.min(toPage(e.ts) + e.dur / 1000, endMs);
      const overlap = Math.max(0, en - s);
      /* Containers count toward the THREAD total (they really did occupy it) but never toward a
       * category ranking, where they would drown out the thing that actually ran. */
      if (CONTAINERS.test(e.name)) { roleMs[e.role] = (roleMs[e.role] || 0) + overlap; continue; }
      roleMs[e.role] = (roleMs[e.role] || 0) + overlap;
      const cat = categorise(e.name) || `other:${e.name}`;
      const key = `${e.role}/${cat}`;
      const cur = byCat.get(key) || { ms: 0, n: 0, top: '', topMs: 0 };
      cur.ms += overlap; cur.n++;
      /* url:line:col for a FunctionCall, because a minified name alone ("ne", 18ms, 21 calls) is a
       * lead that cannot be followed. With the position, `scripts/tv-whois.mjs` reads the built
       * bundle at that offset and prints the surrounding source. */
      const d = e.args?.data || e.args?.beginData || {};
      const where = d.url ? ` @ ${String(d.url).split('/').pop()}:${d.lineNumber}:${d.columnNumber}` : '';
      const detail = (d.functionName || d.type || '') + where;
      if (overlap > cur.topMs) { cur.topMs = overlap; cur.top = detail ? `${e.name} (${detail})` : e.name; }
      byCat.set(key, cur);
    }
    const ranked = Array.from(byCat.entries()).sort((a, b) => b[1].ms - a[1].ms);
    findings.push({
      frameMs: Number(f.dt.toFixed(1)),
      skipped: Math.max(0, Math.round(f.dt / (1000 / 60)) - 1),
      threadMs: Object.fromEntries(Object.entries(roleMs).map(([k, v]) => [k, Number(v.toFixed(1))])),
      tasks: ranked.slice(0, 5).map(([cat, v]) => ({ cat, ms: Number(v.ms.toFixed(1)), n: v.n, top: v.top })),
    });
  }

  console.log(`  ${LABEL}  —  on-time ${block.onTimePct}%  p95 ${block.p95}  p99 ${block.p99}  worst ${block.worstFrame}ms`);
  console.log(`  within  ${[16.67, 33.33, 50, 67, 100].map((b, i) => `${b}:${block.within[i]}%`).join('  ')}`);
  console.log(`  >67ms ${block.framesOver67}   longest run over 50ms: ${block.maxRunOver50}\n`);
  console.log('  TEN WORST FRAMES AND THE TASKS INSIDE THEM');
  for (const f of findings) {
    const skip = `${f.frameMs}ms (${f.skipped} skipped)`;
    const th = `main ${f.threadMs.main}  gpu ${f.threadMs.gpu}  raster ${f.threadMs.raster}  comp ${f.threadMs.compositor}`;
    console.log(`    ${skip.padEnd(26)}${th}`);
    for (const t of f.tasks) console.log(`        ${String(t.ms).padStart(6)}ms  ${t.cat.padEnd(26)} x${String(t.n).padEnd(4)} ${t.top}`);
  }

  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/trace-${LABEL}-previews-${PREVIEWS}${COLD ? '-cold' : '-warm'}.json`;
  writeFileSync(file, JSON.stringify({ label: LABEL, axis: AXIS, cadence: CADENCE, previews: PREVIEWS, cold: COLD, build, block, findings }, null, 2));
  console.log(`\n  wrote ${file}\n`);
  shutdown();
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
