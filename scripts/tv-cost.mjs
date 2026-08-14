/* WHAT ONE PRESS COSTS THE MAIN THREAD, in the engine's own counters.
 *
 *   node scripts/tv-cost.mjs --url=http://192.168.0.7:4173/ --axis=vertical --presses=20
 *   node scripts/tv-cost.mjs --url=... --axis=horizontal --css='...'
 *
 * WHY THIS EXISTS ALONGSIDE tv-trace.mjs. A trace says what was inside the ten WORST frames, which
 * is the right question for a stutter and the wrong one for "is this class of work worth attacking
 * at all". `Performance.getMetrics` gives cumulative counters — layout count, style recalc count and
 * the seconds spent in each — so taking them before and after a known number of presses gives a
 * per-press cost for every category, including the frames that were fine.
 *
 * IT IS THE CHEAP WAY TO KILL AN EXPENSIVE IDEA. Rewriting focus to `aria-activedescendant` is a
 * large, risky change justified by the belief that moving DOM focus costs style recalculation. That
 * belief is worth about ninety seconds of measurement first: if style recalc is a millisecond a
 * press, no amount of re-architecting focus can pay for itself, and the honest thing is to say so
 * rather than build it and discover the same number afterwards.
 */
import { spawn, execSync } from 'node:child_process';
import WebSocket from 'ws';

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const URL_ = arg('url', 'http://192.168.0.7:4173/');
const AXIS = arg('axis', 'vertical');
const PRESSES = Number(arg('presses', '20'));
const GAP = Number(arg('gap', '900'));
const PREVIEWS = arg('previews', 'on');
const CSS_ARM = arg('css', '');
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

const KEY = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40 };
async function press(cdp, key) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: KEY[key], nativeVirtualKeyCode: KEY[key] });
  }
}
const metricsOf = (list) => Object.fromEntries(list.map((m) => [m.name, m.value]));

sweep();
try { execSync('ares-launch --device tv com.groloo.web', { stdio: 'ignore' }); } catch { /* running */ }
await sleep(2500);
const cdp = new CDP(await openInspector());
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__GROLOO_PERF__ = true;' });
if (CSS_ARM) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('DOMContentLoaded', function(){
      var s = document.createElement('style'); s.id='__css_arm'; s.textContent = ${JSON.stringify(CSS_ARM)};
      document.head.appendChild(s);
    });`,
  });
}
await cdp.send('Page.navigate', { url: URL_ });
await sleep(4000);
await cdp.eval(`(function(){
  var K='groloo.settings.v1'; var s={}; try{s=JSON.parse(localStorage.getItem(K)||'{}');}catch(e){}
  s.tvRowTrailers = ${PREVIEWS === 'on' ? 'true' : 'false'};
  localStorage.setItem(K, JSON.stringify(s));
})()`);
await cdp.send('Page.reload');
/* Past the auth round trip — the page renders once on the default row config and again on the
 * signed-in user's, and the two are different screens. */
await sleep(19000);

const build = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.buildIdentity())'));
const sample = JSON.parse(await cdp.eval('JSON.stringify(window.__gperf.sample())'));
console.log(`\n  BUILD ${build.commit}${build.dirty ? '+dirty' : ' CLEAN'}  previews=${build.previews}  rows=${sample.rows}`);
if (CSS_ARM) console.log(`  css arm: ${CSS_ARM}`);

for (let i = 0; i < 6; i++) {
  if (await cdp.eval(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.tv-spot'))`)) break;
  await press(cdp, 'ArrowDown'); await sleep(700);
}
await sleep(1200);

await cdp.send('Performance.enable');
const before = metricsOf((await cdp.send('Performance.getMetrics')).metrics);

const key = AXIS === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
const back = AXIS === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
const span = AXIS === 'horizontal' ? 7 : 4;
let dir = key, since = 0;
for (let i = 0; i < PRESSES; i++) {
  if (since === span) { dir = dir === key ? back : key; since = 0; }
  await press(cdp, dir); since++;
  await sleep(GAP);
}
await sleep(600);
const after = metricsOf((await cdp.send('Performance.getMetrics')).metrics);

const d = (k) => (after[k] || 0) - (before[k] || 0);
const perPress = (k, scale = 1) => (d(k) * scale) / PRESSES;
console.log(`\n  ${AXIS} x${PRESSES} presses @ ${GAP}ms — PER PRESS`);
console.log(`    style recalcs      ${perPress('RecalcStyleCount').toFixed(1)}      ${(perPress('RecalcStyleDuration', 1000)).toFixed(2)}ms`);
console.log(`    layouts            ${perPress('LayoutCount').toFixed(1)}      ${(perPress('LayoutDuration', 1000)).toFixed(2)}ms`);
console.log(`    script                        ${(perPress('ScriptDuration', 1000)).toFixed(2)}ms`);
console.log(`    task (all main)               ${(perPress('TaskDuration', 1000)).toFixed(2)}ms`);
console.log(`    devtools overhead             ${(perPress('DevToolsCommandDuration', 1000)).toFixed(2)}ms`);
console.log(`\n  heap ${(after.JSHeapUsedSize / 1048576).toFixed(1)}MB used / ${(after.JSHeapTotalSize / 1048576).toFixed(1)}MB total`);
console.log(`  nodes ${after.Nodes}  listeners ${after.JSEventListeners}  documents ${after.Documents}\n`);
down();
process.exit(0);
