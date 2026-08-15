import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const base = process.env.ROW_URL || 'http://localhost:5174';
const fixtures = JSON.parse(await readFile(new URL('../screenshots/fixtures.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
  const url = new URL(route.request().url());
  const key = url.pathname + url.search;
  const body = fixtures[key] ?? (url.pathname === '/api/home' ? fixtures['/api/home?lang=en&logos=1'] : '{}');
  await route.fulfill({ status: 200, contentType: 'application/json', body });
});
const page = await context.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tv-spot-hero');
await page.locator('.tv-spot-hero').first().focus();
await page.waitForTimeout(700);

await page.evaluate(() => {
  const row = document.activeElement.closest('.tv-spot');
  const strip = row.querySelector('.tv-spot-strip');
  const read = () => ({
    t: performance.now(),
    strip: getComputedStyle(strip).transform,
    active: strip.style.getPropertyValue('--active'),
    rowClass: row.className,
    layers: [...row.querySelectorAll('.tv-spot-layer')].map((el) => ({
      on: el.classList.contains('on'),
      opacity: Number(getComputedStyle(el).opacity),
      transform: getComputedStyle(el).transform,
    })),
    copy: [...row.querySelectorAll('.tv-spot-infoblk')].map((el) => ({
      on: el.classList.contains('on'),
      opacity: Number(getComputedStyle(el).opacity),
      transform: getComputedStyle(el).transform,
    })),
  });
  window.__rowFrames = [];
  const start = performance.now();
  const frame = () => {
    window.__rowFrames.push(read());
    if (performance.now() - start < 650) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(750);
const frames = await page.evaluate(() => window.__rowFrames);
const previousRect = await page.locator('.tv-spot-prev').first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hero = el.parentElement.querySelector('.tv-spot-hero').getBoundingClientRect();
  return { left: r.left, right: r.right, heroLeft: hero.left, visibleWidth: Math.max(0, r.right) };
});
await browser.close();

const moving = new Set(frames.map((f) => f.strip)).size;
const mixed = frames.filter((f) => f.layers.filter((x) => x.opacity > 0.03).length > 1).length;
const layerMotion = new Set(frames.flatMap((f) => f.layers.map((x) => x.transform))).size;
const copyMotion = new Set(frames.flatMap((f) => f.copy.map((x) => x.transform))).size;
console.log(JSON.stringify({ frames: frames.length, stripPositions: moving, mixedArtworkFrames: mixed, layerTransforms: layerMotion, copyTransforms: copyMotion, previousRect }, null, 2));
console.log(JSON.stringify([frames[0], frames[Math.floor(frames.length / 3)], frames.at(-1)], null, 2));
if (moving < 3 || mixed < 2 || layerMotion < 3 || copyMotion < 3 || previousRect.left >= 0 || previousRect.right <= 0 || previousRect.right >= previousRect.heroLeft) process.exitCode = 1;
