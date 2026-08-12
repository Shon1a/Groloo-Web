/* WATCH THE TV BUILD RUN AT ROUGHLY TV SPEED, on this PC, in a window you can drive.
 *
 *   npm run tv:perf                    the dev server, 6x slower, 1280x720
 *   npm run tv:perf -- --rate=10       a slower set
 *   npm run tv:perf -- --rate=1        the same window with no throttling, for comparison
 *   npm run tv:perf -- --url=https://tv.groloo.com/
 *
 * WHY THIS EXISTS. Neither thing we can run locally shows TV performance. The webOS Simulator
 * is a Chromium window on Windows using this machine's CPU and GPU, so it always feels fast.
 * A browser tab is the same. The one number that IS honest to imitate is processor speed: a
 * 2019-2020 LG set runs a low-clocked quad A53, and against a desktop core that lands somewhere
 * around 6-10x slower on the single-threaded work a React app actually does. Chromium can be
 * told to run that slowly, so this launches the app that way and lets you look at it.
 *
 * THROTTLING IS SET BEFORE THE FIRST NAVIGATION, on purpose. Startup is the part a viewer
 * judges — the wait between pressing the app icon and seeing a row of artwork — and it is the
 * part that a mid-session throttle would skip entirely.
 *
 * WHAT IT CANNOT TELL YOU, and these are the three that decide whether a TV app is actually
 * shippable, so do not read a good result here as a pass:
 *   - GPU. A TV's fill rate is a fraction of a desktop's. Blurs, shadows and large composited
 *     layers are cheap here and expensive there; this will under-report all of it.
 *   - VIDEO. Playback on webOS goes through a hardware plane this has no equivalent of.
 *   - MEMORY. webOS kills background apps below ~250 MB free (see tv-plan/03-performance.md).
 *     Nothing here is under memory pressure, so nothing here will ever be killed.
 * It is a sluggishness preview, not a verdict. The verdict needs a television.
 */

import { chromium } from 'playwright-core';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const RATE = Number(arg('rate', '6'));
const URL = arg('url', 'http://localhost:5173/');
const WIDTH = Number(arg('width', '1280'));
const HEIGHT = Number(arg('height', '720'));

console.log(`\n  GROLOO TV performance preview`);
/* ASCII, not box-drawing: the default Windows console codepage renders those as mojibake. */
console.log(`  -----------------------------`);
console.log(`  url        ${URL}`);
console.log(`  viewport   ${WIDTH}x${HEIGHT}   (what appinfo.json asks webOS for)`);
console.log(`  cpu        ${RATE}x slower than this machine${RATE === 1 ? '  (throttling OFF)' : ''}`);
console.log(`\n  Drive it with the arrow keys and Enter, the way a remote would.`);
console.log(`  Close the window to stop.\n`);

/* `channel: 'chrome'` uses the Chrome already installed, the same choice scripts/tv-shots.mjs
   makes — playwright-core ships no browser of its own, so without this there is nothing to
   launch. deviceScaleFactor 1 keeps CSS pixels and screen pixels the same, so what is on
   screen is the size the TV would actually lay out. */
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

/* Long tasks are the ones a viewer feels: while the main thread is busy for 50ms+ the remote
   does nothing, and on a TV that reads as a dead button rather than as a slow app. Registered
   as an init script so it is watching before any of the app's own code runs. */
await page.addInitScript(() => {
  window.__tvLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__tvLongTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask support — the summary just stays empty */ }
});

const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch((e) => {
  console.error(`  ! could not open ${URL}\n    ${e.message}`);
  console.error(`    Is the dev server up?  npm run dev:tv\n`);
});

/* First paint of real content, measured the way a viewer would: the moment artwork exists.
   `networkidle` would keep waiting for the catalog's images and report a number nobody waits
   for in practice. */
page.waitForSelector('.tv-spot, .tv-shell', { timeout: 60_000 })
  .then(() => console.log(`  first screen rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
  .catch(() => console.log(`  first screen did not render within 60s`));

const summarise = async () => {
  try {
    const tasks = await page.evaluate(() => window.__tvLongTasks || []);
    if (!tasks.length) return;
    const total = tasks.reduce((a, b) => a + b, 0);
    const worst = Math.max(...tasks);
    console.log(`\n  main thread blocked ${tasks.length} times, ${total}ms total, worst ${worst}ms`);
    console.log(`  (each one is a moment the remote would not respond)\n`);
  } catch { /* page already gone */ }
};

await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
await summarise();
await browser.close().catch(() => {});
