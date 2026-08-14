/* SAMPLE where the strip and the billboard artwork actually ARE, frame by frame.
 *
 * WHY NOT A SCREENCAST. Page.startScreencast delivers ~17fps with out-of-order timestamps on this
 * set, and the first frame after a press lands at ~126ms — by which time a 230ms glide is 97%
 * done. So the camera can only ever photograph the settled state. This reads the transforms
 * instead, on the page's own rAF, which is exact and can compare two elements to each other.
 *
 * WHAT IT FOUND, and the reason it is kept: tv.css had moved `.tv-spot-strip` to
 * cubic-bezier(.22,1,.36,1) while TvSpotlight's PARALLAX_EASE was still the fitted
 * cubic-bezier(.25,.46,.45,.94), so the artwork drifted on a different shape from the card
 * carrying it. Both files say they are one movement. Fixed, and re-confirmed with this.
 *
 *   node scripts/tv-motion.mjs --url=http://192.168.0.7:4173/ --out=motion
 *
 * READ THE CENSUS, NOT ONLY THE SAMPLES. `--anims` output lists every running animation on the
 * first frame the strip actually moves, with its duration, easing and current time. That is what
 * settles "are these two one movement" — it is direct, where inferring start and end times from
 * sampled transforms is not, and a wrong inference from exactly that cost a build and a TV slot:
 * the leaving artwork layer animates none -> away, so its transform matches its resting value
 * until the animation is under way, and "when did it last change" then lands on the post-animation
 * snap rather than on the movement.
 *
 * NOT A PERFORMANCE MEASUREMENT: getComputedStyle every frame forces a style recalc, so the frame
 * CADENCE here is perturbed. The POSITIONS are exact, and position is the whole question.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DEVICE = arg('device', 'tv'), APP = arg('app', 'com.groloo.web');
const URL_ = arg('url', 'http://192.168.0.7:4173/'), OUT = arg('out', 'motion');

let inspector = null;
const shutdown = () => { try { inspector?.kill(); } catch { /* gone */ } };
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, shutdown);

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else (this.listeners.get(m.method) || []).forEach(fn => fn(m.params));
    });
    this.ws.on('close', () => this.failAll('socket closed by the television'));
    this.ws.on('error', e => this.failAll('socket error: ' + e.message));
  }
  failAll(msg) { for (const [, p] of this.pending) p.reject(new Error(msg)); this.pending.clear(); }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' — ' + expression.slice(0, 90));
    return r.result.value;
  }
}

function openInspector() {
  return new Promise((resolve, reject) => {
    const p = spawn('ares-inspect', ['--device', DEVICE, '--app', APP], { shell: true });
    inspector = p; let buf = '', settled = false;
    const tryResolve = async () => {
      if (settled) return;
      const direct = buf.match(/ws=([^\s]+)/);
      if (direct) { settled = true; return resolve(`ws://${direct[1]}`); }
      const base = buf.match(/http:\/\/(localhost:\d+)/); if (!base) return;
      try {
        const list = await (await fetch(`http://${base[1]}/json/list`)).json();
        const page = list.find(t => t.webSocketDebuggerUrl);
        if (page) { settled = true; resolve(page.webSocketDebuggerUrl); }
      } catch { /* tunnel not up yet */ }
    };
    p.stdout.on('data', d => { buf += d; tryResolve(); });
    p.stderr.on('data', d => { buf += d; tryResolve(); });
    p.on('exit', c => { if (!settled) reject(new Error(`ares-inspect exited (${c})\n${buf}`)); });
    const poll = setInterval(tryResolve, 1000);
    setTimeout(() => { clearInterval(poll); if (!settled) reject(new Error('no inspector URL after 45s\n' + buf)); }, 45000);
  });
}

const KEYCODE = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40 };
async function press(cdp, key) {
  const code = KEYCODE[key];
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitSettled(cdp, quietFor = 5) {
  let last = -1, quiet = 0;
  for (let i = 0; i < 120; i++) {
    const n = await cdp.eval(`document.querySelectorAll('.tv-spot').length * 1000 +
      [...document.images].filter(i => i.complete && i.naturalWidth).length`);
    quiet = n === last ? quiet + 1 : 0; last = n;
    if (quiet >= quietFor) return n;
    await sleep(500);
  }
  return last;
}

/* Samples the FOCUSED row: the strip's translateX and every .tv-spot-art's translateX, per rAF.
 * Also records the WAAPI animations the row is running, which is how the parallax is driven. */
const START_SAMPLER = `(() => {
  const row = document.activeElement && document.activeElement.closest('.tv-spot');
  if (!row) return 'no focused row';
  const strip = row.querySelector('.tv-spot-strip');
  const arts  = [...row.querySelectorAll('.tv-spot-art')];
  const hero  = row.querySelector('.tv-spot-hero');
  if (!strip) return 'no strip in focused row';
  const tx = (el) => {
    const m = getComputedStyle(el).transform;
    if (!m || m === 'none') return 0;
    const p = m.match(/matrix(3d)?\\(([^)]+)\\)/);
    if (!p) return 0;
    const n = p[2].split(',').map(Number);
    return p[1] ? n[12] : n[4];
  };
  const sx = (el) => {
    const m = getComputedStyle(el).transform;
    if (!m || m === 'none') return 1;
    const p = m.match(/matrix(3d)?\\(([^)]+)\\)/);
    if (!p) return 1;
    const n = p[2].split(',').map(Number);
    return p[1] ? n[0] : n[0];
  };
  window.__samp = [];
  window.__anims = null;
  const x0 = tx(strip);
  const t0 = performance.now();
  const tick = () => {
    const t = performance.now() - t0;
    /* One-time census of everything animating, taken as soon as anything has started, so the
       parallax seek can be checked against the strip's transition instead of assumed. */
    if (!window.__anims && Math.abs(tx(strip) - x0) > 0.5) {
      window.__anims = { at: Math.round(t), list: document.getAnimations().map((a) => {
        const tg = a.effect && a.effect.target;
        let tm = {}; try { tm = a.effect.getTiming(); } catch (e) { tm = {}; }
        return {
          kind: a.constructor && a.constructor.name,
          prop: a.transitionProperty || a.animationName || null,
          cls: tg && tg.className ? String(tg.className).slice(0, 40) : null,
          dur: tm.duration, ease: tm.easing,
          cur: typeof a.currentTime === 'number' ? Math.round(a.currentTime) : null,
        };
      }) };
    }
    window.__samp.push({ t: Math.round(t * 10) / 10, strip: tx(strip), art: arts.map(tx), hero: hero ? sx(hero) : null });
    if (t < 900) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'sampling ' + arts.length + ' art layers';
})()`;

const main = async () => {
  console.log('opening inspector…');
  const cdp = new CDP(await openInspector()); await cdp.open();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  console.log('navigating to', URL_);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(3000);
  const settled = await waitSettled(cdp);
  console.log(`settled: ${Math.floor(settled / 1000)} rows, ${settled % 1000} decoded images`);

  /* Walk down until focus is actually inside a row. One press was enough on a warm app and not on
   * a fresh navigate — where focus starts on the nav and the first Down lands on the billboard. */
  let inRow = false;
  for (let i = 0; i < 5 && !inRow; i++) {
    await press(cdp, 'ArrowDown');
    await sleep(1200);
    inRow = await cdp.eval(`!!(document.activeElement && document.activeElement.closest('.tv-spot'))`);
  }
  if (!inRow) throw new Error('could not get focus into a row after 5 presses');

  const runs = {};
  for (const label of ['right-1', 'right-2', 'right-3']) {
    await sleep(1400);
    const status = await cdp.eval(START_SAMPLER);
    if (typeof status === 'string' && status.startsWith('no')) throw new Error(status);
    await press(cdp, 'ArrowRight');
    await sleep(1100);
    runs[label] = await cdp.eval('window.__samp');
    const census = await cdp.eval('window.__anims');
    runs[label + '-anims'] = census;
    console.log(`  ${label}: ${runs[label].length} frames  (${status})`);
    if (census) {
      console.log(`     census at +${census.at}ms — ${census.list.length} animations`);
      for (const a of census.list) {
        console.log(`       ${String(a.kind).padEnd(14)} ${String(a.prop).padEnd(12)} dur=${String(a.dur).padEnd(6)} cur=${String(a.cur).padEnd(5)} ease=${String(a.ease).slice(0, 28).padEnd(28)} ${a.cls}`);
      }
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/motion.json`, JSON.stringify({ url: URL_, runs }, null, 1));
  console.log(`\nwrote ${OUT}/motion.json`);
  shutdown(); process.exit(0);
};

main().catch(e => { console.error('FAILED:', e.message); shutdown(); process.exit(1); });
