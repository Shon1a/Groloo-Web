/* Visual regression baseline for the TV hardening work (plan Phase 2).
 *
 * WHY THIS EXISTS, AND WHY IT HAS TO EXIST FIRST. Phase 2 is a deliberate "nothing should
 * look different" pass over 2,551 lines of hand-tuned CSS — 62 linear-gradients, 14
 * radial-gradients, 12 mask-images, a --border set fully transparent so ~45 border rules
 * hold their space without reflowing. It WILL move pixels somewhere. This repo has CI for
 * lint and types and no visual coverage at all, so without a baseline captured BEFORE the
 * refactor there is nothing to compare against afterwards and "it still looks right" is an
 * opinion formed by whoever last looked at it.
 *
 * TWO SIZES, BOTH REQUIRED. 1920x1080 is the TV panel. 1280x720 is the resolution the
 * webOS package is actually built at, and it is not merely the same layout scaled — it
 * crosses breakpoints. A regression that only appears at 720p is exactly the kind that
 * ships, because nobody develops at 720p.
 *
 * DETERMINISM IS THE WHOLE GAME. A screenshot suite that reports false differences gets
 * ignored within a week, and an ignored suite is worse than none. So this script:
 *   - freezes animations and transitions, and disables caret blink
 *   - stubs the catalog API with FIXED fixture data, so a screenshot never depends on what
 *     TMDB happened to be trending that morning — the single largest source of false
 *     positives, and the reason this does not simply drive the live site
 *   - blocks remote images (TMDB posters) and paints deterministic placeholders instead
 *   - waits for fonts to settle before capturing
 *
 * FIXTURES ARE RECORDED, NOT HAND-WRITTEN, and that is a correction rather than a
 * refinement. The first version of this script invented fixture objects that looked
 * plausible. They were deterministic and they were useless: the shapes did not match what
 * the API actually returns, so the home rails and the hero rendered EMPTY and the baseline
 * captured a page with no posters on it. A baseline that does not contain the thing you are
 * about to refactor cannot detect a regression in it, and it fails silently — the run is
 * green either way. So `--record` captures real responses from the live backend once, and
 * every later run replays those exact bytes.
 *
 * Usage:
 *   node scripts/tv-shots.mjs --record       save real API responses to screenshots/fixtures.json
 *   node scripts/tv-shots.mjs --baseline     capture into screenshots/baseline/
 *   node scripts/tv-shots.mjs --check        capture into current/ and diff vs baseline
 *
 * Assumes a dev server on :5173 (npm run dev). --record also needs the API server running.
 * Exit code 1 on any diff above threshold.
 */

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHOTS = join(ROOT, 'screenshots');
const BASE_URL = process.env.SHOT_URL || 'http://localhost:5173';

const mode = process.argv.includes('--baseline') ? 'baseline'
  : process.argv.includes('--check') ? 'check'
  : process.argv.includes('--record') ? 'record' : '';
if (!mode) {
  console.error('Usage: node scripts/tv-shots.mjs --record | --baseline | --check');
  process.exit(1);
}
const FIXTURES = join(SHOTS, 'fixtures.json');

/* A pixel must differ by more than this (0-1, perceptual) to count. 0.1 is pixelmatch's
 * usual starting point and tolerates antialiasing without hiding a real colour shift. */
const THRESHOLD = 0.1;
/* How many differing pixels a screen may have before it is called a regression. Not zero:
 * font rasterisation varies by a few pixels between runs on Windows even with everything
 * else frozen, and a suite that cries wolf is a suite nobody runs. 0.1% of a 1080p frame
 * is ~2000 pixels, which is far below any change a person would notice and far above
 * rasterisation noise. */
const MAX_DIFF_RATIO = 0.001;

const VIEWPORTS = [
  { name: '1080p', width: 1920, height: 1080 },
  { name: '720p', width: 1280, height: 720 },
];

/* The canonical screens. Every one is reachable without an account — signed-in surfaces
 * would need a seeded session and would make the suite depend on server state, which is
 * the opposite of what it is for. The modal states are driven by clicking, not by URL,
 * because a title has no URL yet (that lands in Phase 3). */
const SCREENS = [
  { name: 'home', path: '#/' },
  { name: 'movies', path: '#/movies' },
  { name: 'tv', path: '#/tv' },
  { name: 'anime', path: '#/anime' },
  { name: 'categories', path: '#/categories' },
  { name: 'explore', path: '#/explore' },
  { name: 'addons', path: '#/addons' },
  { name: 'settings', path: '#/settings' },
  { name: 'terms', path: '#/terms' },
  { name: 'legal', path: '#/legal' },
  { name: 'attributions', path: '#/attributions' },
  { name: 'link', path: '#/link' },
  // Overlay states — the ones carrying the heaviest effects (backdrop-filter, blur,
  // layered box-shadow), which is exactly what the effect budget will later strip.
  // waitFor: after the click/open, block until this element is actually on screen rather
  // than guessing with a timeout. Both modals are lazy-loaded (their chunk is fetched on
  // first open), so a fixed wait races the fetch — under Vite's dev server, which serves
  // each sub-module as its own request, that race is lost and the capture lands on the page
  // BEHIND the modal. In production these are single bundled chunks and open instantly;
  // waiting for the element is correct in both worlds.
  { name: 'detail-modal', path: '#/movies', click: '.poster', settle: 1500, waitFor: '.overlay.open' },
  // AuthModal is eager (not lazy), so its own openAuth wait below is enough — no waitFor.
  { name: 'auth-modal', path: '#/', evaluate: 'openAuth' },
];

/* Recorded API responses, keyed by pathname+search. Populated by --record, replayed by
 * --baseline/--check. Held as raw response TEXT so replay is byte-identical and no
 * re-serialisation can quietly reorder a key. */
let fixtures = {};
const fixtureKey = (url) => url.pathname + url.search;

async function setup(page) {
  // Freeze everything that moves. Without this, a rail mid-animation is a different
  // screenshot every run.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;
      animation-duration:0s!important;transition-duration:0s!important;
      caret-color:transparent!important;scroll-behavior:auto!important}
      video{visibility:hidden!important}`,
  }).catch(() => {});
}

async function route(context) {
  /* Trailers are blocked outright. The detail modal autoplays a YouTube embed, and a
   * playing video is the single most nondeterministic thing on the page — every capture
   * lands on a different frame. It also drags in YouTube's analytics beacons, whose URLs
   * contain "/api/" and so were being swallowed by the app-API handler below and reported
   * as missing fixtures. Blocked at the network, not hidden with CSS: an iframe is not a
   * <video> element and no stylesheet in this document can reach inside it. */
  await context.route(/youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com/, (r) => r.abort());

  // The app's OWN API, whichever host it is served from: the dev server proxies /api on
  // localhost, while the production build (vite preview) calls the real backend directly.
  // Match both by host+path so the same suite verifies dev and preview — and still exclude
  // third-party '/api/' URLs (YouTube analytics), which the earlier '**/api/**' swept in.
  const isAppApi = (url) => (url.hostname === 'localhost' || url.hostname.endsWith('.onrender.com')) && url.pathname.startsWith('/api/');
  await context.route((url) => isAppApi(new URL(url)), async (r) => {
    const url = new URL(r.request().url());
    const key = fixtureKey(url);

    if (mode === 'record') {
      // Pass through to the real backend and keep exactly what came back.
      try {
        const res = await r.fetch();
        const body = await res.text();
        if (res.status() === 200) fixtures[key] = body;
        return r.fulfill({ response: res, body });
      } catch { return r.abort(); }
    }

    const hit = fixtures[key];
    if (hit !== undefined) {
      return r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: hit });
    }
    /* An unrecorded call answers empty rather than reaching the network. Letting it through
     * would reintroduce exactly the nondeterminism this exists to remove, and would do it
     * invisibly — the suite would pass locally and drift on the next run. Missing keys are
     * reported below instead, so the answer is to re-record, not to relax this. */
    missing.add(key);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Remote images never load — a TMDB outage or a poster change must not move a pixel.
  // A flat grey PNG keeps the layout identical to a loaded image.
  const px = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');
  await context.route(/image\.tmdb\.org|fixture-|\.(png|jpe?g|webp|avif)$/i, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: px }).catch(() => r.abort()));
}

async function capture(page, screen, vp, dir) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(BASE_URL + '/' + screen.path, { waitUntil: 'domcontentloaded' });
  await setup(page);
  await page.waitForTimeout(screen.settle ?? 900);
  if (screen.evaluate === 'openAuth') {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((b) => /my space/i.test(b.textContent || ''))?.click();
    }).catch(() => {});
    await page.waitForTimeout(600);
  }
  if (screen.click) {
    await page.locator(screen.click).first().click({ timeout: 5000 }).catch(() => {});
  }
  // Block until the opened thing is genuinely visible (covers the lazy-chunk fetch), then a
  // short beat for its entrance transition — which setup() has frozen, so this is slack, not
  // animation time.
  if (screen.waitFor) {
    // 25s, not the usual few: the FIRST open of a lazy modal in a dev session pays Vite's
    // on-demand transform of the whole modal module tree (DetailModal → EpisodeChooser →
    // SourceSelect → addonClient → …), which can take many seconds cold. Production serves
    // one pre-built chunk and this resolves instantly. A silent .catch here would capture
    // the page BEHIND the modal and score it as a regression, so surface a timeout loudly.
    await page.locator(screen.waitFor).first().waitFor({ state: 'visible', timeout: 25000 })
      .catch(() => console.error(`  ! ${screen.name}: waitFor ${screen.waitFor} timed out`));
  }
  await page.waitForTimeout(screen.click || screen.evaluate ? 700 : 200);
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await setup(page);
  await page.waitForTimeout(200);
  const file = join(dir, `${screen.name}-${vp.name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  return file;
}

function diff(aBuf, bBuf) {
  const a = PNG.sync.read(aBuf), b = PNG.sync.read(bBuf);
  if (a.width !== b.width || a.height !== b.height) return { changed: -1, total: 0 };
  const out = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: THRESHOLD });
  return { changed, total: a.width * a.height, png: out };
}

const missing = new Set();
const outDir = join(SHOTS, mode === 'baseline' ? 'baseline' : mode === 'check' ? 'current' : 'record');
await mkdir(outDir, { recursive: true });
if (mode !== 'record') {
  if (!existsSync(FIXTURES)) { console.error('No fixtures. Run --record first (needs the API server up).'); process.exit(1); }
  fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
}

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
await route(context);
const page = await context.newPage();

let captured = 0;
for (const screen of SCREENS) {
  for (const vp of VIEWPORTS) {
    try { await capture(page, screen, vp, outDir); captured++; }
    catch (e) { console.error(`  ! ${screen.name}-${vp.name}: ${e.message}`); }
  }
}
await browser.close();
console.log(`${mode}: captured ${captured}/${SCREENS.length * VIEWPORTS.length} screens → ${outDir}`);

if (mode === 'record') {
  await writeFile(FIXTURES, JSON.stringify(fixtures, null, 1));
  console.log(`Recorded ${Object.keys(fixtures).length} API responses → screenshots/fixtures.json`);
  process.exit(0);
}
if (missing.size) {
  console.log(`\n${missing.size} API call(s) had no fixture and were answered empty — re-record:`);
  for (const k of [...missing].slice(0, 12)) console.log('    ' + k);
}

if (mode === 'baseline') {
  console.log('Baseline saved. Re-run with --check after the CSS changes.');
  process.exit(0);
}

// --check: compare against the baseline
const baseDir = join(SHOTS, 'baseline');
if (!existsSync(baseDir)) { console.error('No baseline. Run --baseline first.'); process.exit(1); }
const diffDir = join(SHOTS, 'diff');
await mkdir(diffDir, { recursive: true });

let failed = 0, clean = 0;
for (const f of await readdir(outDir)) {
  const basePath = join(baseDir, f);
  if (!existsSync(basePath)) { console.log(`  NEW      ${f}`); continue; }
  const r = diff(await readFile(basePath), await readFile(join(outDir, f)));
  if (r.changed === -1) { console.log(`  SIZE     ${f} — dimensions changed`); failed++; continue; }
  const ratio = r.changed / r.total;
  if (ratio > MAX_DIFF_RATIO) {
    await writeFile(join(diffDir, f), PNG.sync.write(r.png));
    console.log(`  CHANGED  ${f} — ${r.changed} px (${(ratio * 100).toFixed(3)}%) → screenshots/diff/${f}`);
    failed++;
  } else { clean++; }
}
console.log(`\n${clean} unchanged, ${failed} changed.`);
process.exit(failed ? 1 : 0);
