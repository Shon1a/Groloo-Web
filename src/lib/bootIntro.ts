import { INTRO } from './bootIntroMarkup';

/* ---- THE START-UP INTRO, PLAYED ------------------------------------------------------------------
 *
 * index.html opens on the intro's first act, the stack landing, its depth popping out and the first
 * glug, and all of that is CSS (lib/bootIntroMarkup.ts). What comes next depends on the app, so it is
 * played from here:
 *
 *   pour    the next glug is earned by the progress lib/bootGate.ts reports, and comes no closer to
 *           the last than a glug can be seen as one
 *   finish  once the app is ready: the last glug tops the O's up, they hop, and the last O floods the
 *           screen; under the flood the black and the logo go out, and the flood clears off the app
 *
 * EVERYTHING HERE MOVES A TRANSFORM OR AN OPACITY on a box of its own, and is handed its delay as it
 * starts (WAAPI `delay`). So the whole finale is scheduled on the compositor's clock the moment it is
 * started, and keeps its timing even if the main thread is still busy when a part of it is due; only
 * `covered` and the clean-up wait on the main thread.
 *
 * With reduced motion the glugs land where they go without moving, and the finale is a plain fade. */

/** Each glug leaves the tall O's this full. The first is the CSS's… */
const LEVELS = [INTRO.firstLevel, 0.7, 1];
/** …the second waits for this much of the loading, and the last one for the app. */
const SECOND_AT = 0.5;
const GLUG_MS = 440;
/** At least this long from one glug to the next, so that each one reads as a glug. */
const STEP_MS = 600;
/** The second O pours this long after the first, and catches up a little for the last glug. A glug
 *  must be over before the next one in the same O starts (each one starts from where the last ended):
 *  STEP_MS + LAST_LAG_MS >= LAG_MS + GLUG_MS. */
const LAG_MS = 450;
const LAST_LAG_MS = 300;
/** The finale, counted from the last glug: the hop (the second O a beat behind), the flood, the clearing. */
const HOP_AT_MS = 780;
const HOP_GAP_MS = 80;
const HOP_MS = 500;
const FLOOD_AT_MS = 1420;
const FLOOD_MS = 800;
const CLEAR_MS = 530;
/** `#boot-splash.out`'s fade, for reduced motion. */
const FADE_MS = 520;

/** A tall O's hop: it crouches, jumps, lands squashed and straightens up. */
const HOP: Keyframe[] = [
  { transform: 'translateY(0) scale(1,1)', easing: 'ease-out' },
  { transform: 'translateY(0) scale(1.06,.92)', offset: 0.16, easing: 'cubic-bezier(.2,.7,.4,1)' },
  { transform: 'translateY(-1.8em) scale(.97,1.05)', offset: 0.48, easing: 'cubic-bezier(.6,0,.8,.4)' },
  { transform: 'translateY(0) scale(1.07,.9)', offset: 0.76, easing: 'cubic-bezier(.2,.7,.4,1)' },
  { transform: 'translateY(0) scale(1,1)' },
];

let root: HTMLElement | null = null;
let liquids: HTMLElement[] = [];
let poured = 1;
let earned = 1;
let nextAt = 0;
let timer = 0;
let state: 'pouring' | 'finale' | 'covered' = 'pouring';
let onCovered: (() => void) | null = null;

const smooth = () => typeof Element.prototype.animate === 'function'
  && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const level = (l: number) => `translateY(${(INTRO.dropEm * (1 - l)).toFixed(3)}em)`;

/** Takes over the intro index.html is showing (`#boot-splash`). */
export function introStart(el: HTMLElement): void {
  root = el;
  liquids = Array.from(el.querySelectorAll<HTMLElement>('.bs-liq'));
  /* The pouring keeps time with the CSS, whose clock starts when the landing is first on screen: so it
   * counts from that animation's own start, not from whenever the bundle got round to running. Before
   * the first frame that start is not known yet, and it is waited for. */
  const landing = el.querySelector('.bs-c')?.getAnimations?.()[0];
  const from = (t: number) => { nextAt = t + INTRO.firstAtMs + STEP_MS; };
  from(performance.now());
  if (landing && typeof landing.startTime === 'number') from(landing.startTime);
  else landing?.ready.then((a) => { if (typeof a.startTime === 'number') from(a.startTime); }, () => {});
}

/** How far the app has got, 0 to 1. It earns the second glug; the last one is `introFinish`'s. */
export function introProgress(p: number): void {
  if (p >= SECOND_AT) earned = Math.max(earned, 2);
  pour();
}

/** The app is ready: top up, hop and flood. `covered` runs once the flood covers the screen, when the
 *  app is about to be seen; at once if there is no intro on screen (or it has already gone). */
export function introFinish(covered: () => void): void {
  if (!root?.isConnected || state === 'covered') { covered(); return; }
  const before = onCovered;
  onCovered = () => { before?.(); covered(); };
  if (state === 'finale') return;
  earned = LEVELS.length;
  pour();
}

/** Straight to the flood: the website lets a click or a key skip the intro. */
export function introSkip(): void {
  if (!root?.isConnected || state !== 'pouring') return;
  window.clearTimeout(timer);
  timer = 0;
  for (const el of liquids) {
    el.getAnimations().forEach((a) => a.cancel());
    el.style.transform = level(1);
  }
  poured = earned = LEVELS.length;
  finale(true);
}

function pour(): void {
  if (!root?.isConnected || state !== 'pouring' || timer || poured >= earned) return;
  // Without motion there is no glug to be seen, so nothing to space out.
  const wait = smooth() ? nextAt - performance.now() : 0;
  if (wait > 0) {
    timer = window.setTimeout(() => { timer = 0; pour(); }, wait);
    return;
  }
  const last = poured === LEVELS.length - 1;
  const from = poured ? LEVELS[poured - 1] : 0;
  liquids.forEach((el, k) => glug(el, from, LEVELS[poured], k ? (last ? LAST_LAG_MS : LAG_MS) : 0));
  poured++;
  nextAt = performance.now() + STEP_MS;
  if (last) finale(false);
  else pour();
}

/** One glug: up past the new level by five units, then settling onto it. Each glug holds its level
 *  by filling forwards (the browser drops the one before it once it is over), and nothing touches the
 *  inline style meanwhile: while the second O's glug waits out its lag, that O shows the last one. */
function glug(el: HTMLElement, from: number, to: number, delay: number): void {
  if (!smooth()) { el.style.transform = level(to); return; }
  const over = `translateY(${Math.max(INTRO.dropEm * (1 - to) - 0.5, -0.2).toFixed(3)}em)`;
  el.animate([
    { transform: level(from), easing: 'cubic-bezier(.3,.6,.4,1)' },
    { transform: over, offset: 0.68, easing: 'ease-in-out' },
    { transform: level(to) },
  ], { duration: GLUG_MS, delay, fill: 'forwards' });
}

function cover(): void {
  if (state === 'covered') return;
  state = 'covered';
  if (root) root.style.pointerEvents = 'none';
  const fn = onCovered;
  onCovered = null;
  fn?.();
}

/** The hop and the flood, all scheduled now. A skip has no hop, and floods at once. */
function finale(quick: boolean): void {
  const el = root!;
  state = 'finale';
  if (!smooth()) {
    cover();
    el.classList.add('out');
    window.setTimeout(() => el.remove(), FADE_MS + 80);
    return;
  }
  const floodAt = quick ? 0 : FLOOD_AT_MS;
  if (!quick) {
    // Each tall O's letters and its depth (`h0`, `h1`), started together so they keep together.
    el.querySelectorAll<HTMLElement>('.bs-hop').forEach((hop) => {
      hop.animate(HOP, { duration: HOP_MS, delay: HOP_AT_MS + (hop.classList.contains('h1') ? HOP_GAP_MS : 0) });
    });
  }
  /* The flood: a disc as wide as the last O's slot, in the round of its top, growing until it covers the
   * screen's farthest corner. Measured now, before the hop moves the O. */
  const slot = el.querySelectorAll<HTMLElement>('.bs-slot')[1]?.getBoundingClientRect();
  const flood = el.querySelector<HTMLElement>('.bs-flood');
  if (!slot || !flood) { cover(); el.remove(); return; }
  const cx = slot.left + slot.width / 2;
  const cy = slot.top + slot.width / 2;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const r = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) + 2;
  const from = `scale(${(slot.width / 2 / r).toFixed(5)})`;
  flood.style.cssText = `left:${cx - r}px;top:${cy - r}px;width:${2 * r}px;height:${2 * r}px;transform:${from}`;
  flood.animate([{ transform: from, opacity: 1 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: FLOOD_MS, delay: floodAt, easing: 'cubic-bezier(.7,0,.3,1)', fill: 'forwards' }).onfinish = cover;
  // Under the flood the black and the logo go out; then the flood clears off the app.
  const under = floodAt + FLOOD_MS;
  for (const part of el.querySelectorAll<HTMLElement>('.bs-bg, .bs-logo')) {
    part.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, delay: under, fill: 'forwards' });
  }
  flood.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLEAR_MS, delay: under, easing: 'ease', fill: 'forwards' })
    .onfinish = () => el.remove();
  // Should a finish event never come (a page hidden mid-flood), the app is still handed over.
  window.setTimeout(cover, under + 1000);
  window.setTimeout(() => el.remove(), under + CLEAR_MS + 1000);
}
