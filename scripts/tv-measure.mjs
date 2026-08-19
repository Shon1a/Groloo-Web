/* MEASURE THE SHIPPING TV APP ON THE REAL TELEVISION.
 *
 *   node scripts/tv-measure.mjs verify
 *   node scripts/tv-measure.mjs measure --url=http://192.168.0.7:4173/ --label=before
 *   node scripts/tv-measure.mjs measure --url=http://192.168.0.7:4173/ --label=after --previews=off
 *
 * Playwright cannot attach to a webOS app, so this speaks CDP over the tunnel `ares-inspect` opens.
 * It is the sibling of blits-bench/tools/drive.mjs and borrows that file's hard-won parts verbatim —
 * the tunnel sweep, the key-dispatch form, and above all the statistics, which live in the app now
 * (src/lib/tvPerf.ts) so both arms of any comparison are scored by identical code.
 *
 * WHAT MAKES A RUN VALID, and each of these has invalidated one before:
 *   · PRESSES MUST LAND. A block whose key handler quietly did nothing scores beautifully. The
 *     driver reads the focused element's position before and after and refuses a block that did
 *     not move.
 *   · THE PICTURES MUST BE DECODED FIRST. Scoring while artwork is still arriving measures the
 *     network. `waitSettled` waits for the decoded-image count to stop climbing, not for `load`.
 *   · THERE MUST BE AN IDLE CONTROL. A per-press cost is a block total divided by the press count,
 *     which charges the keypress for everything the app does anyway — a trailer decoding, the
 *     probe's own loop, simply being on screen. Without the control the busier arm loses for the
 *     wrong reason.
 *   · AN UNSPECIFIED ARM CLEARS ITS KEY. localStorage outlives reloads and rebuilds, so an arm
 *     left set by an earlier run silently overrides the default the report claims to be testing.
 *   · ORDER IS REVERSED BETWEEN ROUNDS, so anything that drifts over a session (the set warming up,
 *     a background service waking) lands on both arms equally instead of on whichever went second.
 *
 * NEVER JUDGE PERFORMANCE FROM THE DEV SERVER. React's development build is roughly 5x off on this
 * device. `--url` should point at a real production build: either https://tv.groloo.com/ or this
 * PC's LAN address serving `npx vite preview --mode tv --host`.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const CMD = process.argv[2] || 'verify';
const DEVICE = arg('device', 'tv');
const APP = arg('app', 'com.groloo.web');
const URL_ = arg('url', 'https://tv.groloo.com/');
const LABEL = arg('label', 'run');
const PREVIEWS = arg('previews', 'on');
const SCROLL = arg('scroll', '');   // '' clears the key so the app default applies; 'window' | 'transform'
const ROWS_MODE = arg('rows', ''); // '' clears the key; 'virtual' enables the row-window experiment
const CARDS = arg('cards', '');    // '' clears the key; a number sets how many titles a row carries
const ROUNDS = Number(arg('rounds', '2'));
const OUT = arg('out', 'perf-results');
const SURFACES = arg('surfaces', 'home,series,movies,anime,library').split(',');
/* Which cadences to run. The scroll A/B only needs the two MOVEMENT cadences: 'settled' is dominated
 * by the preview mounting, which is identical in both arms, so including it spends 40s a block to
 * measure something the comparison is not asking about. */
const ONLY_CADENCES = arg('cadences', '').split(',').filter(Boolean);
/* A request that has not answered in this long means the socket is gone. See CDP.send. */
const REQUEST_TIMEOUT_MS = Number(arg('cdpTimeout', '30000'));
/* Refuse to score a home screen that came up short — see the guard after waitSettled. */
const MIN_ROWS = Number(arg('minRows', '0'));
/* ---- A CSS ARM, INJECTED RATHER THAN BUILT -----------------------------------------------------
 * `--css='<rules>'` installs a stylesheet into every document the page loads, so a one-rule
 * hypothesis can be run as a full five-round arm in ten minutes instead of a rebuild, reinstall and
 * re-settle cycle. It is recorded in the results file, because an arm whose configuration is not
 * written down is not a result. */
const CSS_ARM = arg('css', '');
/* `--ls='k=v,k2=v2'` — set arbitrary experiment keys for this run. Anything NOT listed is left as
 * it was, so use the dedicated flags (--previews/--scroll/--rows) for the arms that must be cleared
 * when unspecified; this is for one-off switches like groloo.tvparallax that have their own default
 * in the app and no "clear me" semantics to get wrong. */
const LS_ARM = arg('ls', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- LEAVE NO TUNNEL BEHIND -----------------------------------------------------------------
 * Each ares-inspect holds an SSH session on the set, whose sshd is OpenSSH 6.1 with the default
 * session cap. Leak six and the television stops completing handshakes altogether — which looks
 * exactly like it having dropped out of developer mode. On Windows `spawn(..., {shell:true})` puts
 * a cmd.exe in between, so killing the child kills only the shell: the whole tree has to go. */
const sweepInspectors = () => {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
      'Where-Object { $_.CommandLine -match \'ares-inspect\' } | ' +
      'ForEach-Object { taskkill /PID $_.ProcessId /T /F }"',
      { stdio: 'ignore' },
    );
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
  process.on(sig, (err) => {
    shutdown();
    if (err instanceof Error) { console.error(err); process.exit(1); }
  });
}

/* ---- CDP ------------------------------------------------------------------------------------ */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
    /* The set closes this socket by itself sometimes, mid-run and without warning. Both handlers
     * exist so that shows up as a thrown error on the next call instead of as silence. */
    this.ws.on('close', (code) => this.failAll(`CDP socket closed by the television (code ${code})`));
    this.ws.on('error', (e) => this.failAll(`CDP socket error: ${e.message}`));
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  /* ---- EVERY REQUEST HAS A DEADLINE, AND THAT IS NOT DEFENSIVE PROGRAMMING ---------------------
   *
   * A run died on exactly this. The television dropped the debugger socket part way through round
   * two — the app was fine, the tunnel was fine, `/json/list` still listed the page — but `ws` had
   * emitted 'close' with nobody listening, so every pending promise simply never settled. The
   * driver sat at 0.1 seconds of CPU, holding a tunnel, looking for all the world like a slow
   * block, and the run had to be killed by hand after burning fifteen minutes of television time.
   *
   * A measurement harness that can hang indefinitely is worse than one that fails: a failure is
   * visible in a minute, a hang costs the whole session. So the socket closing rejects everything
   * outstanding, and every request carries its own deadline besides. */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Fail every outstanding request. Called when the socket goes away for any reason. */
  failAll(why) {
    const dead = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of dead) p.reject(new Error(why));
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
    }
    return r.result.value;
  }
}

/* ares-inspect prints either the full devtools URL with `?ws=host:port/...` or just the tunnel's
 * base address. Both are handled; resolving through /json/list is the more reliable of the two
 * because it survives the app navigating. */
function openInspector() {
  return new Promise((resolve, reject) => {
    const p = spawn('ares-inspect', ['--device', DEVICE, '--app', APP], { shell: true });
    inspector = p;
    let buf = '';
    let settled = false;
    const tryResolve = async () => {
      if (settled) return;
      const direct = buf.match(/ws=([^\s]+)/);
      if (direct) { settled = true; return resolve(`ws://${direct[1]}`); }
      const base = buf.match(/http:\/\/(localhost:\d+)/);
      if (!base) return;
      try {
        const list = await (await fetch(`http://${base[1]}/json/list`)).json();
        const page = list.find((t) => t.webSocketDebuggerUrl);
        if (page) { settled = true; resolve(page.webSocketDebuggerUrl); }
      } catch { /* tunnel not up yet — the poll retries */ }
    };
    const onData = (d) => { buf += d.toString(); tryResolve(); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => { if (!settled) reject(new Error(`ares-inspect exited (${code})\n${buf}`)); });
    const poll = setInterval(tryResolve, 1000);
    setTimeout(() => { clearInterval(poll); if (!settled) reject(new Error(`no inspector URL after 45s\n${buf}`)); }, 45000);
  });
}

/* ---- PRESSING A KEY ON A TELEVISION ----------------------------------------------------------
 * rawKeyDown + keyUp, with no `text` and no char event. Not incidental: sending a key as
 * keyDown-with-text on this set delivers TWO activations for one press, which silently corrupted
 * two earlier rounds of measurement before anyone noticed. Arrows and Enter are all dispatched
 * correctly without text, so the safe form is also the correct one. */
const KEYCODE = {
  ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40,
  Enter: 13, Escape: 27,
  /* webOS delivers Back as 461 on a normal keydown. lib/tvKeys.ts answers it. */
  Back: 461,
};
/* ENTER IS THE EXCEPTION, AND IT IS THE EXCEPTION IN BOTH DIRECTIONS.
 *
 * Arrows must be sent as `rawKeyDown` — a `keyDown` carrying text delivers TWO activations for one
 * press on this set, which silently corrupted two earlier rounds of measurement.
 *
 * Enter is the opposite problem and cost a functional run to find. `rawKeyDown` means "no text",
 * and a button's default activation is driven by the text-bearing key event — so an Enter sent the
 * arrows' way moves nothing, activates nothing, and reports as "OK does not open the title" when the
 * app is behaving perfectly. One `keyDown` WITH text and no separate `char` event is the form that
 * activates exactly once. */
async function press(cdp, key) {
  const code = KEYCODE[key];
  const k = key === 'Back' ? 'GoBack' : key;
  const down = key === 'Enter'
    ? { type: 'keyDown', text: '\r', unmodifiedText: '\r' }
    : { type: 'rawKeyDown' };
  await cdp.send('Input.dispatchKeyEvent', {
    ...down, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
  });
}

/* ---- READINESS IS A DECODE GUARANTEE, NOT A LOAD EVENT ---------------------------------------
 * Waits for the decoded-image count to stop climbing. Scoring before that measures the network and
 * the decoder, which is a different question from the one this file asks. */
/* `quietFor` IS 8 (four seconds), RAISED FROM 3, AND THE REASON IS A COMPARABILITY BUG.
 * Two runs of the same page settled at 30 and at 19 decoded images — the count plateaus while a
 * request is in flight, and 1.5s of quiet was short enough to mistake that pause for the end. A run
 * that starts with a third of the artwork missing is measuring a different page from the one it is
 * being compared against, and the difference lands in the numbers as if it were the change. */
/* `minMs` IS NOT PADDING — IT WAITS FOR A SECOND, LATER TRUTH.
 *
 * The home screen renders TWICE with different content. It comes up on the DEFAULT row config (15
 * rows), and then the signed-in user's own config arrives from the server and applies — this account
 * has `catalog: false`, so the page drops to 9 rows. Both states are stable for seconds, so row-count
 * stability alone accepts whichever one the run happens to land in.
 *
 * That is not a theoretical risk: a five-run A/B of the row-window experiment measured the native arm
 * at 15 rows and the virtual arm at 9, and the "improvement" was a page with six fewer rows in it.
 * Waiting past the auth round trip makes every run measure the same screen. */
async function waitSettled(cdp, { timeoutMs = 120000, quietFor = 8, minMs = 16000 } = {}) {
  const t0 = Date.now();
  let lastDecoded = -1, lastRows = -1, quiet = 0;
  for (;;) {
    const s = await cdp.eval('window.__gperf ? JSON.stringify(window.__gperf.sample()) : "null"');
    const sample = s === 'null' ? null : JSON.parse(s);
    if (sample && sample.rows > 0) {
      /* ---- THE ROW COUNT HAS TO BE STILL TOO, NOT JUST THE IMAGE COUNT ------------------------
       * Watching decoded images alone declared a home screen settled at NINE rows when the feed
       * carries thirteen: rows mount in bursts, images decode in bursts, and the lull between two
       * bursts looks exactly like the end of loading. The run then scored a smaller, cheaper page
       * than the one it was being compared against — which flatters every number in the table for a
       * reason that has nothing to do with the build. Both counts must hold still. */
      if (sample.imagesDecoded === lastDecoded && sample.rows === lastRows) quiet++;
      else { quiet = 0; lastDecoded = sample.imagesDecoded; lastRows = sample.rows; }
      if (quiet >= quietFor && Date.now() - t0 >= minMs) return sample;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`never settled (rows=${sample?.rows} decoded=${sample?.imagesDecoded})`);
    }
    await sleep(500);
  }
}

/* ---- WHERE THE REMOTE IS, AND WHY IT IS NOT `document.activeElement` -------------------------
 * The obvious probe — the focused element's class and position — reports NOTHING MOVED for a
 * perfectly healthy horizontal walk, and it cost a run to find out. Focus stays on the row while
 * the STRIP translates inside it, so the focused element's own rectangle is identical before and
 * after nine real moves. Any liveness guard built on it certifies a dead key handler.
 *
 * So the fingerprint is everything that actually changes when the app responds: the focused
 * element, the page offset, and every strip transform on the screen. */
/* THE PAGE TRANSFORM IS IN HERE, AND LEAVING IT OUT COST A WHOLE RUN.
 *
 * The first version read `window.scrollY`. Under the transform scroller that is ALWAYS ZERO — the
 * document does not scroll, `main` translates. And a vertical move parks the destination row at the
 * same place the last one sat, so the focused element has the same class AND the same viewport
 * rectangle before and after. Every field agreed, the fingerprint was identical, and a perfectly
 * healthy walk down the home screen was recorded as `live: false` and thrown away by the report —
 * on the very change the run existed to evaluate. The numbers were there all along (55.7%, 60.8%,
 * 66.7%); the guard simply could not see the movement it was guarding.
 *
 * So the track's own transform is part of the identity now. It is the thing that actually moves. */
const FINGERPRINT = `(function(){
  var a = document.activeElement;
  var r = a ? a.getBoundingClientRect() : { left: 0, top: 0 };
  var t = [];
  var strips = document.querySelectorAll('.tv-spot-strip');
  for (var i = 0; i < strips.length; i++) t.push(getComputedStyle(strips[i]).transform);
  var m = document.querySelector('main');
  var page = m ? getComputedStyle(m).transform : 'none';
  return (a ? (a.className || a.tagName) : 'none') + '@' + Math.round(r.left) + ',' + Math.round(r.top)
    + '|y' + Math.round(window.scrollY) + '|page' + page + '|' + t.join(',');
})()`;

/* ---- SIT THE REMOTE ON A ROW BEFORE MEASURING A ROW -----------------------------------------
 * A cold home screen puts focus on `.tv-hero-scrim`, the featured billboard above the rows. Left and
 * Right do nothing there — it is one picture, not a strip — so a horizontal block started from a
 * fresh load presses 23 times into a surface that cannot answer, and scores the hero's own 4-second
 * autorotate as if it were keypress response. That produced a plausible-looking 233ms worst frame
 * for a block in which no key did anything, which is precisely the failure the liveness guard
 * exists to catch. Walk down until the remote is actually inside a row. */
async function seatOnRow(cdp, maxSteps = 6) {
  for (let i = 0; i < maxSteps; i++) {
    const on = await cdp.eval(`(function(){
      var a = document.activeElement;
      return !!(a && a.closest && a.closest('.tv-spot'));
    })()`);
    if (on) return true;
    await press(cdp, 'ArrowDown');
    await sleep(700);
  }
  return await cdp.eval(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.tv-spot'))`);
}

/* A PRE-FLIGHT, NOT AN AFTER-THE-FACT CHECK. Reading the fingerprint between two scored presses
 * would put a CDP round trip inside the very window those frames are attributed to. This presses
 * once before scoring starts, confirms the app answered, and steps back. */
async function assertLive(cdp, key, backKey) {
  const a = await cdp.eval(FINGERPRINT);
  await press(cdp, key);
  await sleep(700);
  const b = await cdp.eval(FINGERPRINT);
  await press(cdp, backKey);
  await sleep(700);
  return a !== b;
}

/* ---- THE WALK BOUNCES, AND THAT IS THE DIFFERENCE BETWEEN A MEASUREMENT AND A FICTION.
 *
 * A home row holds SPOT_MAX = 10 titles and does not wrap. Walking 23 presses in one direction is
 * therefore 9 moves and 14 presses into a wall — and a press that cannot move paints nothing, scores
 * a clean 16.7ms frame, and drags the block's on-time percentage UP. The first validation run read
 * 58% on-time on a block that was two-thirds no-ops; the real figure is worse.
 *
 * Reversing at `span` keeps every press doing work. `span` is set below the stop count on each axis
 * so the walk never reaches the end at all. */
async function runBlock(cdp, label, { key, backKey, gap, presses, span }) {
  await cdp.eval(`window.__gperf.reset(); window.__gperf.tag(${JSON.stringify(label)})`);
  const before = await cdp.eval(FINGERPRINT);
  let dir = key, sinceTurn = 0;
  for (let i = 0; i < presses; i++) {
    if (sinceTurn === span) { dir = dir === key ? backKey : key; sinceTurn = 0; }
    await press(cdp, dir);
    sinceTurn++;
    await sleep(gap);
  }
  /* Let the last press's animation finish inside its own attribution window before scoring. */
  await sleep(600);
  const after = await cdp.eval(FINGERPRINT);
  const [block] = JSON.parse(await cdp.eval(`JSON.stringify(window.__gperf.summary([${JSON.stringify(label)}]))`));
  await cdp.eval('window.__gperf.tag("")');
  return { ...block, endedWhereItStarted: before === after };
}

async function idleBlock(cdp, ms) {
  await cdp.eval('window.__gperf.reset(); window.__gperf.tag("")');
  await sleep(ms);
  return JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.idleStats())'));
}

/* ---- THE CADENCES ---------------------------------------------------------------------------
 * A deliberate press and a held key take different paths through the row — different duration,
 * different easing, and a whole class of decoration suppressed on the held path. Measuring one
 * would answer half the question. 900ms is what a considered press measures at; 240ms is the rate
 * the row actually walks at when a key is held (the set repeats at ~120ms, but HELD_STEP_MIN_MS
 * paces it to 220). 5000ms is how a television is really used: read the synopsis, then press. */
const CADENCES = [
  { label: 'deliberate', gap: 900 },
  { label: 'held', gap: 240 },
  { label: 'settled', gap: 5000 },
  /* ---- THE PACE ARMS -------------------------------------------------------------------------
   * A remote repeats about every 120ms and the row refuses to walk faster than HELD_STEP_MIN_MS
   * (220ms), dropping anything sooner. So the LIMITER IS ONLY EVER A FLOOR: drive presses slower
   * than it and every one is accepted, and the row's pace is whatever the driver's gap is. That
   * makes `held300` an exact emulation of raising HELD_STEP_MIN_MS to 300 — no rebuild, no
   * reinstall, and both arms run against the identical binary, which is the only way the
   * comparison is worth anything.
   *
   * 300 rather than 400 on purpose: SLIDE_CHAIN_WINDOW is 320ms, so past that a press stops
   * counting as chained and takes the deliberate curve, the un-suppressed decoration and the
   * slower slide — a different code path, not a slower version of this one.
   *
   * `held160` is the other side: faster than the floor, so the limiter starts DROPPING presses.
   * It says whether the dropping itself costs anything.
   *
   * Press counts are matched to `held` so the three arms differ in pace and nothing else. */
  { label: 'held160', gap: 160, presses: { horizontal: 34, vertical: 20 } },
  { label: 'held300', gap: 300, presses: { horizontal: 34, vertical: 20 } },
];

const HASH = { home: '#/', series: '#/tv', movies: '#/movies', anime: '#/anime', library: '#/library' };

async function gotoSurface(cdp, surface) {
  await cdp.eval(`location.hash = ${JSON.stringify(HASH[surface])}`);
  await sleep(1200);
}

/* Write the settings store and the scroll-arm switch directly, then reload — the same keys the app
 * reads at module scope.
 *
 * THE SCROLL ARM IS WHY THIS IS WORTH DOING FROM THE DRIVER RATHER THAN BY BUILDING TWICE. Two
 * builds compared across two sessions is not a comparison: the set warms up, a background service
 * wakes, and the drift lands on whichever went second. One build carrying both code paths, switched
 * by a localStorage key and run interleaved with the order reversed, is the same discipline every
 * other result in this project was settled with. See lib/tvPageScroll.ts. */
async function setArms(cdp, previewsOn, scroll, rowsMode, cards) {
  await cdp.eval(`(function(){
    var K = 'groloo.settings.v1';
    var s = {}; try { s = JSON.parse(localStorage.getItem(K) || '{}'); } catch (e) {}
    s.tvRowTrailers = ${previewsOn ? 'true' : 'false'};
    localStorage.setItem(K, JSON.stringify(s));
    ${scroll ? `localStorage.setItem('groloo.tvscroll', ${JSON.stringify(scroll)});` : `localStorage.removeItem('groloo.tvscroll');`}
    ${rowsMode ? `localStorage.setItem('groloo.tvrows', ${JSON.stringify(rowsMode)});` : `localStorage.removeItem('groloo.tvrows');`}
    ${cards ? `localStorage.setItem('groloo.tvcards', ${JSON.stringify(cards)});` : `localStorage.removeItem('groloo.tvcards');`}
    ${LS_ARM.split(',').filter(Boolean).map((pair) => {
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      return `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`;
    }).join(' ')}
  })()`);
}

async function connect() {
  console.log(`  opening inspector on ${APP} @ ${DEVICE} …`);
  sweepInspectors();
  try { execSync(`ares-launch --device ${DEVICE} ${APP}`, { stdio: 'ignore' }); } catch { /* already up */ }
  await sleep(2500);
  const wsUrl = await openInspector();
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

/** Arm the probe for the NEXT document, then navigate. */
async function armAndGo(cdp, url) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__GROLOO_PERF__ = true;' });
  if (CSS_ARM) {
    /* On EVERY new document, not once: the driver reloads after writing the arms, and a style
     * injected only into the first document would be gone for the run that is actually scored. */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', function(){
        var s = document.createElement('style'); s.id = '__css_arm';
        s.textContent = ${JSON.stringify(CSS_ARM)};
        document.head.appendChild(s);
      });`,
    });
  }
  await cdp.send('Page.navigate', { url });
  await sleep(4000);
}

async function main() {
  const cdp = await connect();

  if (CMD === 'verify') {
    const href = await cdp.eval('location.href');
    const ua = await cdp.eval('navigator.userAgent');
    const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1] || '?';
    console.log(`\n  location.href  ${href}`);
    console.log(`  Chromium       ${chrome}`);
    console.log(`  webOS UA       ${ua}`);
    const isTv = /tv\.groloo\.com/.test(href);
    console.log(`\n  ${isTv ? 'OK  — the package launched the TV build.' : 'WRONG TARGET — expected tv.groloo.com'}`);
    /* Prove the TV build is what is actually RENDERING, not merely the URL that serves it. Polled
     * rather than read once: a cold launch on this set is several seconds of network before the
     * first row exists, and reading immediately after navigation reports zero for a healthy app. */
    for (let i = 0; i < 20; i++) {
      const d = JSON.parse(await cdp.eval(`JSON.stringify({
        ready: document.readyState,
        rows: document.querySelectorAll('.tv-spot').length,
        strips: document.querySelectorAll('.strip-row').length,
        imgs: document.images.length,
        err: (document.body && document.body.innerText || '').slice(0, 120)
      })`));
      if (d.rows > 0 || i === 19) {
        console.log(`  readyState     ${d.ready}`);
        console.log(`  .tv-spot rows  ${d.rows}   (TV build)`);
        console.log(`  .strip-row     ${d.strips}   (desktop build — should be 0 here)`);
        console.log(`  images         ${d.imgs}`);
        if (!d.rows && !d.strips) console.log(`  body text      ${JSON.stringify(d.err)}`);
        break;
      }
      await sleep(1000);
    }
    shutdown();
    return;
  }

  /* DOES THE CARD-COUNT ARM ACTUALLY BITE? A row loads with about twenty titles and SPOT_MAX is a
   * CAP, not a count — it only changes anything once the row has fetched more, which it does on
   * first focus. Measuring at rest therefore compares two identical rows and reports no difference,
   * which is exactly what the first A/B did. This seats on a row, walks it far enough to trigger
   * the fetch, waits, and then reports what the strip is actually made of. */
  if (CMD === 'cards') {
    await setArms(cdp, PREVIEWS === 'on', SCROLL, ROWS_MODE, CARDS);
    await gotoSurface(cdp, 'home');
    await waitSettled(cdp);
    await seatOnRow(cdp);
    for (let i = 0; i < 10; i++) { await press(cdp, 'ArrowRight'); await sleep(260); }
    await sleep(6000);   // let the row's own fetch land and commit
    const d = JSON.parse(await cdp.eval(`(() => {
      const open = document.querySelector('.tv-spot.is-settled') || document.querySelector('.tv-spot.is-open') || document.querySelector('.tv-spot');
      const strip = open && open.querySelector('.tv-spot-strip');
      const tiles = strip ? strip.querySelectorAll('.tv-spot-thumb').length : 0;
      return JSON.stringify({
        arm: localStorage.getItem('groloo.tvcards'),
        rows: document.querySelectorAll('.tv-spot').length,
        cardsTotal: document.querySelectorAll('.tv-spot-thumb').length,
        tilesInOpenRow: tiles,
        stripWidthPx: strip ? Math.round(strip.scrollWidth) : 0,
        imgs: document.images.length,
      });
    })()`));
    console.log(`
  arm groloo.tvcards = ${d.arm === null ? '(cleared — app default)' : d.arm}`);
    console.log(`  rows on screen        ${d.rows}`);
    console.log(`  tiles in focused row  ${d.tilesInOpenRow}`);
    console.log(`  strip width           ${d.stripWidthPx}px`);
    console.log(`  cards on the page     ${d.cardsTotal}`);
    console.log(`  images                ${d.imgs}`);
    await cdp.close?.();
    return;
  }

  /* ARE WE SENDING MORE PIXELS THAN THE PANEL SHOWS? Decode cost scales with pixel COUNT, not with
   * file size, so an image sent at twice its displayed width costs four times the decode. This
   * reports, per kind, the box the set lays out and the picture it was handed. */
  /* ARE WE SENDING MORE PIXELS THAN THE PANEL SHOWS? Decode cost scales with pixel COUNT, not file
   * size, so a picture handed over at twice its displayed width costs four times the decode. This
   * reports, per kind, the box the set lays out against the picture it was given.
   *
   * Written as ONE expression with no function bodies: Runtime.evaluate takes an expression, and a
   * `return` inside an injected wrapper is what the first two attempts died on. */
  if (CMD === 'img') {
    await gotoSurface(cdp, 'home');
    /* A plain wait rather than waitSettled: that reads the app's own perf probe, which only the
     * measure path arms — without it every poll reads undefined and the wait times out. */
    await sleep(12000);
    await seatOnRow(cdp);
    await sleep(4000);
    const one = (sel) => `[...document.querySelectorAll('${sel}')].filter(e=>e.naturalWidth>0).slice(0,1).map(e=>[Math.round(e.getBoundingClientRect().width),Math.round(e.getBoundingClientRect().height),e.naturalWidth,e.naturalHeight,e.currentSrc])`;
    const SNAP = 'JSON.stringify([devicePixelRatio,innerWidth,innerHeight,'
      + one('.tv-spot-thumbimg') + ',' + one('.tv-spot-thumbmark') + ',' + one('.tv-spot-art')
      + ',document.images.length])';
    const d = JSON.parse(await cdp.eval(SNAP));
    const [dpr, vw, vh, poster, mark, art, imgs] = d;
    console.log('');
    console.log('  screen viewport ' + vw + 'x' + vh + '   devicePixelRatio ' + dpr);
    console.log('  a box W css px wide needs W x dpr real pixels; anything beyond that is decode thrown away');
    console.log('');
    for (const [label, hit] of [['poster tile', poster[0]], ['wordmark', mark[0]], ['billboard', art[0]]]) {
      if (!hit) { console.log('  ' + label.padEnd(12) + ' none loaded'); continue; }
      const [bw, bh, nw, nh, src] = hit;
      const need = Math.round(bw * dpr);
      const asked = (/\/(w\d+|original)\//.exec(src) || [])[1] || '(n/a)';
      console.log('  ' + label.padEnd(12) + ' box ' + (bw + 'x' + bh).padEnd(11)
        + ' given ' + (nw + 'x' + nh).padEnd(11) + ' asked ' + String(asked).padEnd(9)
        + ' needs ' + String(need).padEnd(5) + ' -> ' + Math.round((nw / Math.max(1, need)) * 100) + '% of need');
    }
    console.log('');
    console.log('  images on the page  ' + imgs);
    return;
  }

  if (CMD === 'functional') {
    /* ---- DOES IT STILL WORK, not how fast --------------------------------------------------
     * The performance blocks only ever press arrows on a page of rows. That exercises none of the
     * things the transform scroller and the focus fast path could plausibly break: an overlay that
     * is `position: fixed` outside the moving surface, Back walking the layer stack, and focus
     * surviving a modal opening WHILE the page is mid-animation. Each check prints its own verdict
     * so a failure names itself instead of showing up later as a number nobody trusts. */
    await armAndGo(cdp, URL_);
    await waitSettled(cdp);
    const checks = [];
    const check = (name, ok, detail = '') => {
      checks.push({ name, ok });
      console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
    };

    await seatOnRow(cdp);
    check('remote seats on a row', await cdp.eval(`!!(document.activeElement && document.activeElement.closest('.tv-spot'))`));

    /* The page must actually have moved by the mechanism we think is moving it. */
    const mode = await cdp.eval(`document.documentElement.classList.contains('tv-xform-scroll') ? 'transform' : 'window'`);
    await press(cdp, 'ArrowDown'); await sleep(900);
    const moved = await cdp.eval(`(function(){
      var m = document.querySelector('main');
      var t = m ? getComputedStyle(m).transform : 'none';
      return JSON.stringify({ transform: t, scrollY: Math.round(window.scrollY) });
    })()`);
    const mv = JSON.parse(moved);
    check(`page moves by ${mode}`, mode === 'transform' ? mv.transform !== 'none' && mv.transform !== 'matrix(1, 0, 0, 1, 0, 0)' : mv.scrollY > 0, moved);

    // OPEN A TITLE
    await press(cdp, 'Enter'); await sleep(2500);
    const modalOpen = await cdp.eval(`!!document.querySelector('.overlay.open')`);
    check('OK opens the detail sheet', modalOpen);
    check('focus moves into the sheet', await cdp.eval(`!!(document.activeElement && document.activeElement.closest('.overlay.open'))`));

    /* MOVE INSIDE IT — the geometric navigator still owns this surface, and that is the point of
     * the check: the row fast path must NOT have taken over a screen it cannot describe.
     *
     * Down OR Right counts. The sheet's initial focus is the play button on a row of actions, and
     * whether Down reaches anything depends on what that particular title has below it — a film with
     * no episode deck has a different layout from a series. Requiring one specific direction tests
     * the fixture, not the navigation. */
    const who = () => cdp.eval(`(function(){var a=document.activeElement;return a?(a.className||a.tagName):'none';})()`);
    const beforeFp = await cdp.eval(FINGERPRINT);
    const beforeWho = await who();
    await press(cdp, 'ArrowDown'); await sleep(800);
    let movedInSheet = (await cdp.eval(FINGERPRINT)) !== beforeFp;
    if (!movedInSheet) { await press(cdp, 'ArrowRight'); await sleep(800); movedInSheet = (await cdp.eval(FINGERPRINT)) !== beforeFp; }
    check('D-pad moves inside the sheet', movedInSheet, `${beforeWho} -> ${await who()}`);

    // SOURCE SELECTION — the streams list is the row below the action buttons.
    const srcs = await cdp.eval(`document.querySelectorAll('.tv-src, .m-src-opt, .tv-stream, [class*="src"]').length`);
    check('source list is present', srcs > 0, `${srcs} elements`);

    // BACK CLOSES IT, and focus comes home to the page rather than nowhere.
    await press(cdp, 'Back'); await sleep(1600);
    check('Back closes the sheet', !(await cdp.eval(`!!document.querySelector('.overlay.open')`)));
    check('focus returns to the page', await cdp.eval(`!!(document.activeElement && document.activeElement !== document.body)`));

    /* THE ONE THAT ACTUALLY WORRIED ME: a modal opening while the page is still gliding. The
     * scroller is mid-animation, `will-change` is on, and the overlay mounts on top of a moving
     * surface — if focus or the layer scoping got confused this is where it would show. */
    await seatOnRow(cdp);
    await press(cdp, 'ArrowDown');
    await sleep(90);                       // deliberately INSIDE the glide
    await press(cdp, 'Enter'); await sleep(2600);
    check('OK mid-glide still opens the sheet', await cdp.eval(`!!document.querySelector('.overlay.open')`));
    await press(cdp, 'Back'); await sleep(1600);
    check('Back after mid-glide open closes it', !(await cdp.eval(`!!document.querySelector('.overlay.open')`)));
    const settledAfter = await cdp.eval(`(function(){
      var m = document.querySelector('main');
      return (m ? getComputedStyle(m).willChange : '') || 'auto';
    })()`);
    check('promotion is dropped when movement ends', settledAfter === 'auto' || settledAfter === '', `will-change: ${settledAfter}`);

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} passed${failed.length ? `  —  FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
    shutdown();
    process.exit(failed.length ? 1 : 0);
  }

  mkdirSync(OUT, { recursive: true });
  await armAndGo(cdp, URL_);

  const href = await cdp.eval('location.href');
  const hasProbe = await cdp.eval('!!window.__gperf');
  console.log(`\n  url     ${href}`);
  console.log(`  probe   ${hasProbe ? 'armed' : 'MISSING — is this a build with lib/tvPerf.ts in it?'}`);
  if (!hasProbe) { shutdown(); process.exit(1); }

  /* ---- WHICH BUILD IS ACTUALLY UNDER TEST -----------------------------------------------------
   * Printed before anything is scored, and stored in the results file, because the packaged app
   * loads the DEPLOYED site by default and a local build is served from the LAN — the two are
   * indistinguishable on screen. A session spent measuring the deployed bundle looks exactly like a
   * change that did nothing. `dirty` is the load-bearing field here: during this work the tree is
   * expected to be dirty, so a CLEAN stamp means the wrong bytes are on the panel. */
  /* Read here only to fail FAST on the wrong bundle. The authoritative stamp — the one recorded in
   * the results — is re-read after the arms are written and the page reloaded, because the runtime
   * half of the identity (previews, scroll, rows) is whatever localStorage said at module scope, and
   * at this point in the run that is still the PREVIOUS configuration. Reading it once here and
   * trusting it printed `rows=native` across an entire five-run virtual arm. */
  const preBuild = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.buildIdentity())'));
  if (!preBuild.isTvBuild) {
    console.error('\n  REFUSING TO SCORE: this is not a --mode tv build.\n');
    shutdown(); process.exit(2);
  }
  if (!preBuild.dirty) {
    console.log('\n  WARNING: the build stamp says the tree was CLEAN when this bundle was built.');
    console.log('  If you meant to measure uncommitted work, this is the wrong bundle — rebuild.\n');
  }

  await setArms(cdp, PREVIEWS === 'on', SCROLL, ROWS_MODE, CARDS);
  await cdp.send('Page.reload');
  await sleep(4000);

  /* THE AUTHORITATIVE STAMP, read after the arms are written and the page reloaded — so
   * previews/scroll/rows describe the configuration actually under test rather than the one left
   * over from the previous run. */
  const build = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.buildIdentity())'));
  console.log(`\n  BUILD   ${build.commit}${build.dirty ? '+dirty' : '  *** CLEAN ***'}   mode=${build.mode}   built ${build.builtAt}`);
  console.log(`          previews=${build.previews}  scroll=${build.scroll}  rows=${build.rows}`);

  const first = await waitSettled(cdp);
  console.log(`  settled rows=${first.rows} cards=${first.cards} img=${first.imagesDecoded}/${first.images} bitmap~${first.bitmapMb}MB heap=${first.heapUsedMb}MB\n`);
  /* ---- TWO RUNS OF DIFFERENT PAGES ARE NOT A COMPARISON ----------------------------------------
   * A home screen that came up with 9 rows was compared against one that came up with 14, and the
   * smaller page did less work for reasons that had nothing to do with the change being measured.
   * The row count varies with what /api/home returns — a cold backend, an add-on catalogue that did
   * not answer — so it is a property of the session, not of the build, and it has to be asserted
   * rather than hoped for. `--minRows=13` refuses to score a page that is not the page. */
  if (MIN_ROWS && first.rows < MIN_ROWS) {
    console.error(`\n  REFUSING TO SCORE: ${first.rows} rows, expected at least ${MIN_ROWS}.`);
    console.error('  The home feed came up short — usually a cold backend or an add-on row that did');
    console.error('  not answer. Re-run; a smaller page would flatter every number in the table.\n');
    shutdown();
    process.exit(2);
  }

  const results = {
    label: LABEL, url: href, previews: PREVIEWS, scroll: SCROLL || 'default', rows: ROWS_MODE || 'default', cssArm: CSS_ARM || null, lsArm: LS_ARM || null, when: new Date().toISOString(),
    /* The whole point of recording the sample beside the frame statistics: a run that got faster by
       rendering less has to be visible as such, not just as a better number. */
    settled: first,
    build,
    ua: await cdp.eval('navigator.userAgent'),
    rounds: [],
  };

  for (let round = 1; round <= ROUNDS; round++) {
    /* Reversed on odd rounds so session drift lands on both directions equally. */
    const order = round % 2 ? ['horizontal', 'vertical'] : ['vertical', 'horizontal'];
    const surfaces = round % 2 ? SURFACES : SURFACES.slice().reverse();
    const blocks = [];
    console.log(`  --- round ${round} ---`);

    blocks.push({ surface: 'home', axis: 'idle', ...(await (async () => {
      await gotoSurface(cdp, 'home');
      await waitSettled(cdp);
      return idleBlock(cdp, 20000);
    })()) });
    console.log(`    idle                           on-time ${blocks[0].onTimePct}%  p95 ${blocks[0].p95}  p99 ${blocks[0].p99}  worst ${blocks[0].worstFrame}  >67 ${blocks[0].framesOver67}`);

    for (const surface of surfaces) {
      await gotoSurface(cdp, surface);
      await waitSettled(cdp);
      for (const axis of order) {
        /* Re-seated per axis, not once per surface: a vertical block bounces five rows at a time
           and can walk back up off the top of the list into the hero, which would leave the
           horizontal block that follows pressing at a billboard again. */
        const seated = await seatOnRow(cdp);
        if (!seated) console.log(`    !! ${surface}/${axis}: could not seat the remote on a row`);
        const horizontal = axis === 'horizontal';
        const key = horizontal ? 'ArrowRight' : 'ArrowDown';
        const backKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
        /* Below the stop count on each axis so the bounce never reaches an end: a home row holds
           SPOT_MAX = 10 titles, and the page is 13-15 rows. */
        const span = horizontal ? 7 : 5;
        const live = await assertLive(cdp, key, backKey);
        if (!live) console.log(`    !! ${surface}/${axis}: a press changed nothing — blocks below are not a measurement`);
        for (const cad of (ONLY_CADENCES.length ? CADENCES.filter((c) => ONLY_CADENCES.includes(c.label)) : CADENCES)) {
          const presses = cad.presses
            ? (horizontal ? cad.presses.horizontal : cad.presses.vertical)
            : horizontal
              ? (cad.label === 'held' ? 34 : cad.label === 'settled' ? 8 : 23)
              : (cad.label === 'held' ? 20 : cad.label === 'settled' ? 6 : 12);
          const label = `${surface}-${axis}-${cad.label}`;
          const b = await runBlock(cdp, label, { key, backKey, gap: cad.gap, presses, span });
          blocks.push({ surface, axis, cadence: cad.label, live, ...b });
          console.log(`    ${label.padEnd(30)} on-time ${String(b.onTimePct).padStart(5)}%  p95 ${String(b.p95).padStart(5)}  p99 ${String(b.p99).padStart(5)}  worst ${String(b.worstFrame).padStart(6)}  >67 ${String(b.framesOver67).padStart(3)}  run50 ${String(b.maxRunOver50).padStart(2)}  lat ${String(b.latencyMedian).padStart(5)}${live ? '' : '   !! DEAD'}`);
          await sleep(800);
        }
      }
    }
    results.rounds.push({ round, blocks });
  }

  if (CSS_ARM) console.log(`  css arm: ${CSS_ARM}`);
  if (LS_ARM) console.log(`  ls arm: ${LS_ARM}`);
  const file = `${OUT}/${LABEL}-previews-${PREVIEWS}${SCROLL ? '-scroll-' + SCROLL : ''}${ROWS_MODE ? '-rows-' + ROWS_MODE : ''}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n  wrote ${file}`);
  shutdown();
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
