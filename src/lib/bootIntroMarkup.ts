/* ---- THE START-UP INTRO: ITS MARKUP, BUILT INTO index.html ---------------------------------------
 *
 * The stacked GROLOO: G over R | a tall O | L over O | a tall O, with its pink-violet depth. The columns
 * drop and rise into place, squash as they land and bounce twice; the depth pops out from behind the
 * letters; the tall O's fill like a loading bar while the app loads; and once it is ready they hop and
 * the last one floods the screen into the app.
 *
 * WHO PLAYS WHAT. vite.config.ts `bootSplash` writes `introMarkup()` into index.html, so the landing and
 * the pop are CSS and on screen from the first frame, before a single script has run. The pouring, the
 * hop and the flood answer to the app's loading, so lib/bootIntro.ts plays them once the bundle runs.
 * Nothing in this file runs in the browser: lib/bootIntro.ts imports INTRO and nothing else.
 *
 * EVERY MOVING PART IS AN HTML BOX moved by transform or opacity, and the SVGs are only the still
 * pictures inside them. A box's transform runs on the compositor and keeps its pace however busy the
 * main thread is, and the main thread is never busier than while it builds the app this covers.
 * Anything animated INSIDE an SVG goes back to that main thread to be repainted, every frame.
 *
 * UNITS are the logo's own (cap height 100, y down, columns 81 wide) and 1em is ten of them, so every
 * length below is a length of the logo and the whole intro scales with the font-size of `.bs-logo`. */

/** Logo units to the em. */
const U = 10;
const COL = 81;
/** Each column's left edge. */
const X = [0, 97, 192, 287];
const W = 368;
/** The lower row's baseline. */
const H = 216.5;
/** The tall O's run from 1.8 above the cap height to 1.8 below the lower baseline. */
const TOP = -1.8;
const BOT = H + 1.8;
const RING = 28;
/** The depth sits this far right and down, behind the letters. */
const DEPTH = [11, 7.5];
/** Room around each column's picture for its antialiased edge. */
const PAD = 2;
/** The logo's box: the letters, their depth and a little margin. */
const BOX = { x: -4, y: TOP - 4, w: W + DEPTH[0] + 8, h: BOT - TOP + DEPTH[1] + 8 };
const COL_H = BOT - TOP + 2 * PAD;

/* The letters are Barlow Black (SIL Open Font License) fitted to the columns, the L's foot reaching the
 * column's edge; the tall O's are capsule rings. */
const SHAPES: Record<string, string> = {
  G: 'M0 63.43L0 36.43Q0 25.29 5.07 16.79Q10.14 8.29 19.33 3.57Q28.52 -1.14 40.57 -1.14Q52.33 -1.14 61.59 3.36Q70.85 7.86 75.93 15.57Q81 23.29 81 32.43L81 32.57Q81 33.57 80.41 34.14Q79.83 34.71 78.8 34.71L55.72 34.71Q53.51 34.71 53.51 33.43Q53.51 28.71 50.06 25.29Q46.6 21.86 40.57 21.86Q34.69 21.86 31.16 25.64Q27.63 29.43 27.63 35.71L27.63 64.29Q27.63 70.43 31.68 74.29Q35.72 78.14 41.75 78.14Q47.19 78.14 50.64 75.21Q54.1 72.29 54.1 67.14L54.1 65.29Q54.1 64.57 53.36 64.57L40.43 64.57Q39.4 64.57 38.81 64Q38.22 63.43 38.22 62.43L38.22 45.29Q38.22 44.29 38.81 43.71Q39.4 43.14 40.43 43.14L78.8 43.14Q79.83 43.14 80.41 43.71Q81 44.29 81 45.29L81 64.86Q81 75.43 75.93 83.71Q70.85 92 61.66 96.57Q52.49 101.14 40.57 101.14Q28.52 101.14 19.33 96.43Q10.14 91.71 5.07 83.14Q0 74.57 0 63.43Z',
  R: 'M51.69 214.93L35.49 178.64Q35.19 178.07 34.61 178.07L28.42 178.07Q27.69 178.07 27.69 178.79L27.69 214.36Q27.69 215.36 27.1 215.93Q26.51 216.5 25.48 216.5L2.2 216.5Q1.17 216.5 0.59 215.93Q0 215.36 0 214.36L0 118.64Q0 117.64 0.59 117.07Q1.17 116.5 2.2 116.5L46.83 116.5Q56.84 116.5 64.43 120.5Q72.02 124.5 76.21 131.71Q80.41 138.93 80.41 148.36Q80.41 157.79 75.63 164.86Q70.84 171.93 62.44 175.21Q61.71 175.5 62 176.21L80.71 213.93Q81 214.79 81 214.93Q81 215.64 80.41 216.07Q79.82 216.5 78.94 216.5L54.19 216.5Q52.29 216.5 51.69 214.93ZM27.69 140.21L27.69 156.93Q27.69 157.64 28.42 157.64L42.27 157.64Q46.98 157.64 49.93 155.14Q52.87 152.64 52.87 148.64Q52.87 144.5 49.93 142Q46.98 139.5 42.27 139.5L28.42 139.5Q27.69 139.5 27.69 140.21Z',
  O1: 'M97 38.7A40.5 40.5 0 0 1 178 38.7V177.8A40.5 40.5 0 0 1 97 177.8ZM125 38.7V177.8A12.5 12.5 0 0 0 150 177.8V38.7A12.5 12.5 0 0 0 125 38.7Z',
  L: 'M192 97.86L192 2.14Q192 1.14 192.57 0.57Q193.14 0 194.14 0L216.72 0Q217.72 0 218.29 0.57Q218.86 1.14 218.86 2.14L218.86 76.29Q218.86 77 219.57 77L270.86 77Q271.86 77 272.43 77.57Q273 78.14 273 79.14L273 97.86Q273 98.86 272.43 99.43Q271.86 100 270.86 100L194.14 100Q193.14 100 192.57 99.43Q192 98.86 192 97.86Z',
  o: 'M192 179.93L192 153.07Q192 141.93 197.06 133.36Q202.11 124.79 211.28 120.07Q220.45 115.36 232.43 115.36Q244.56 115.36 253.73 120.07Q262.89 124.79 267.95 133.36Q273 141.93 273 153.07L273 179.93Q273 191.36 267.95 200Q262.89 208.64 253.73 213.43Q244.56 218.21 232.43 218.21Q220.45 218.21 211.28 213.43Q202.11 208.64 197.06 200Q192 191.36 192 179.93ZM245.85 180.79L245.85 152.79Q245.85 146.21 242.18 142.29Q238.5 138.36 232.43 138.36Q226.51 138.36 222.83 142.29Q219.14 146.21 219.14 152.79L219.14 180.79Q219.14 187.36 222.83 191.29Q226.51 195.21 232.43 195.21Q238.5 195.21 242.18 191.29Q245.85 187.36 245.85 180.79Z',
  O2: 'M287 38.7A40.5 40.5 0 0 1 368 38.7V177.8A40.5 40.5 0 0 1 287 177.8ZM315 38.7V177.8A12.5 12.5 0 0 0 340 177.8V38.7A12.5 12.5 0 0 0 315 38.7Z',
};
const COLUMNS = [['G', 'R'], ['O1'], ['L', 'o'], ['O2']];
/** Each column's [second it starts to fall, from above (-1) or below (1)]. It lands on the side it
 *  falls towards, so that is where it squashes from: its foot from above, its head from below. */
const ARRIVE: Array<[number, number]> = [[0.3, -1], [0.42, 1], [0.54, -1], [0.66, 1]];
/** The second the depth pops out, once the last column has settled. */
const POP = 1.44;

const FACE: Array<[number, string]> = [[0, '#fde8e8'], [0.5, '#e4d9d9'], [1, '#d2cdcd']];
const PINK: Array<[number, string]> = [[0, '#ff4752'], [0.55, '#ec1a74'], [1, '#8f24d6']];
/** Where PINK runs left to right, in the letters' space: the depth and the liquid share it. */
const PINK_X = [DEPTH[0], W + DEPTH[0]];

/* A tall O's slot, in its column's box. Half a unit larger all round than the hole in the ring, and
 * the ring is drawn over it, so the liquid's edge is tucked under the ring: two antialiased edges on
 * the same line let a hairline of whatever is behind them show through. */
const GROW = 0.5;
const SLOT = { x: PAD + RING - GROW, y: PAD + RING - GROW, w: COL - 2 * RING + 2 * GROW, h: BOT - TOP - 2 * RING + 2 * GROW };
/** The liquid's surface: one wave, this long and this high. */
const WL = 16;
const WA = 1.4;
/** The liquid's box starts this far above the slot's top, with the surface this far into it. */
const LIQ_TOP = -6;
const SURFACE = 4.5;
const LIQ_H = SLOT.h - LIQ_TOP + 8;
/** From empty (the surface out of sight below the slot) to full (just over its top). */
const DROP = SLOT.h + 11;
/** Three bubbles in each O: across the slot, radius, seconds to rise, head start. */
const BUBBLES: Array<[number, number, number, number]> = [[0.3, 1.6, 1.3, 0], [0.55, 2.3, 1.7, -0.6], [0.78, 1.3, 1.1, -0.3]];
/* THE FIRST GLUG IS CSS TOO: the depth has popped and settled, and the loading has plainly begun.
 * Left to a script timer it would be due exactly while the bundle is being evaluated and the app's
 * first render is laid out, the longest tasks of the whole start-up: on a slow set it came most of a
 * second late, and the logo stood still waiting for it. The glugs after it mark real progress, so
 * lib/bootIntro.ts pours them. */
const GLUG = 0.44;
const FIRST = { at: [1.85, 2.3], level: 0.36 };

/** What lib/bootIntro.ts needs to know to play the rest. */
export const INTRO = {
  /** The liquid's travel from empty to full, in em. */
  dropEm: DROP / U,
  /** How full the first glug leaves the tall O's… */
  firstLevel: FIRST.level,
  /** …and when it starts in the first O, on the intro's clock (ms). */
  firstAtMs: FIRST.at[0] * 1000,
};

const f = (n: number) => String(Math.round(n * 1000) / 1000);
const em = (units: number) => `${f(units / U)}em`;
const grad = (id: string, stops: Array<[number, string]>, x1: number, x2: number) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="0" x2="${f(x2)}" y2="0">`
  + stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') + '</linearGradient>';
const paths = (keys: string[], fill: string) => keys.map((k) => `<path d="${SHAPES[k]}" fill="${fill}"/>`).join('');
const svg = (vb: number[], body: string, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} viewBox="${vb.map(f).join(' ')}">${body}</svg>`;

/** A tall O's liquid: a strip of waves, wider than the slot by the stretch it slides through. Its
 *  colour is the depth's, measured from the slot's left edge `x0` in the letters' space. */
function liquid(k: number, x0: number): string {
  let d = `M${-WL} ${SURFACE}q${WL / 4} ${-2 * WA} ${WL / 2} 0`;
  for (let x = -WL / 2; x < SLOT.w + 2 * WL; x += WL / 2) d += `t${WL / 2} 0`;
  d += `V${f(LIQ_H)}H${-WL}Z`;
  const wave = svg([-WL, 0, SLOT.w + 3 * WL, LIQ_H], `<defs>${grad(`bsl${k}`, PINK, PINK_X[0] - x0, PINK_X[1] - x0)}</defs><path d="${d}" fill="url(#bsl${k})"/>`, 'bs-wave');
  return `<div class="bs-slot"><div class="bs-liq">${wave}<i></i><i></i><i></i></div></div>`;
}

/** A tall O's hop wrapper: `h0` for the first, `h1` for the second. */
const hop = (i: number, inner: string) => (i === 1 || i === 3 ? `<div class="bs-hop h${i === 1 ? 0 : 1}">${inner}</div>` : inner);

function column(i: number): string {
  const face = svg([X[i] - PAD, TOP - PAD, COL + 2 * PAD, COL_H], `<defs>${grad(`bsf${i}`, FACE, 0, W)}</defs>${paths(COLUMNS[i], `url(#bsf${i})`)}`);
  // The ring goes over its liquid (see SLOT); the two hop together.
  const inner = i === 1 || i === 3 ? liquid(i === 1 ? 0 : 1, X[i] - PAD + SLOT.x) + face : face;
  return `<div class="bs-c bs-c${i}">${hop(i, inner)}</div>`;
}

/* The depth, a column at a time behind its letters, so that a tall O's depth hops with it. No column's
 * depth reaches the next column's letters, so all of it can stay in one layer under all of them. */
function depthColumn(i: number): string {
  const pic = svg([X[i] - PAD, TOP - PAD, COL + 2 * PAD, COL_H], `<defs>${grad(`bsd${i}`, PINK, PINK_X[0], PINK_X[1])}</defs>${paths(COLUMNS[i], `url(#bsd${i})`)}`);
  return `<div class="bs-dc" style="left:${em(X[i] - PAD - BOX.x)}">${hop(i, pic)}</div>`;
}

/** Keyframes for column `i`, one set per column with its start inside them, never an animation-delay:
 *  every column then starts and ends on a single boundary, and each boundary costs a main-thread frame. */
function arrive(i: number): string {
  const [t0, dir] = ARRIVE[i];
  const dur = t0 + 0.7;
  const pc = (s: number) => `${f((s / dur) * 100)}%`;
  const flight = `translateY(${em(dir * 300)}) scale(.94,1.12)`;
  const at = (s: number, tf: string, ease: string) => `${pc(t0 + s)}{transform:${tf};animation-timing-function:${ease}}`;
  const origin = `${em(COL / 2 + PAD)} ${em(dir < 0 ? BOT - TOP + PAD : PAD)}`;
  return `.bs-c${i}{left:${em(X[i] - PAD - BOX.x)};transform-origin:${origin};animation:bs-c${i} ${f(dur)}s linear both}`
    + `@keyframes bs-c${i}{0%,${pc(t0)}{opacity:0;transform:${flight};animation-timing-function:cubic-bezier(.55,0,1,.45)}`
    + `${pc(t0 + 0.01)}{opacity:1;transform:${flight};animation-timing-function:cubic-bezier(.55,0,1,.45)}`
    // Stretched in flight, squashed flat on landing, then two bounces, each smaller.
    + at(0.3, 'translateY(0) scale(1.1,.86)', 'cubic-bezier(.2,.7,.4,1)')
    + at(0.43, `translateY(${em(-dir * 16)}) scale(.96,1.05)`, 'cubic-bezier(.6,0,.8,.4)')
    + at(0.55, 'translateY(0) scale(1.04,.95)', 'cubic-bezier(.2,.7,.4,1)')
    + at(0.63, `translateY(${em(-dir * 4)}) scale(1,1)`, 'ease-in')
    + '100%{opacity:1;transform:none}}';
}

export function introMarkup(): { html: string; css: string } {
  const html = '<div class="bs-bg"></div><div class="bs-logo">'
    + `<div class="bs-depth">${[0, 1, 2, 3].map(depthColumn).join('')}</div>`
    + `<div class="bs-face">${[0, 1, 2, 3].map(column).join('')}</div>`
    + '</div><div class="bs-flood"></div>';

  const level = (l: number) => `translateY(${em(DROP * (1 - l))})`;
  // The first glug, one keyframe set per O with its start inside: up past the level, settling onto it.
  const firstGlug = FIRST.at.map((s, k) => {
    const pc = (t: number) => `${f((t / (s + GLUG)) * 100)}%`;
    const over = `translateY(${em(Math.max(DROP * (1 - FIRST.level) - 5, -2))})`;
    return `.bs-c${k ? 3 : 1} .bs-liq{animation:bs-fill${k} ${f(s + GLUG)}s linear both}`
      + `@keyframes bs-fill${k}{0%,${pc(s)}{transform:${level(0)};animation-timing-function:cubic-bezier(.3,.6,.4,1)}`
      + `${pc(s + 0.68 * GLUG)}{transform:${over};animation-timing-function:ease-in-out}100%{transform:${level(FIRST.level)}}}`;
  }).join('');
  const popAt = (s: number) => `${f(((POP + s) / (POP + 0.43)) * 100)}%`;
  const recoilAt = (s: number) => `${f(((POP + s) / (POP + 0.3)) * 100)}%`;
  // From the foot of the slot, in the liquid's box (they rise with it as it fills).
  const bubbles = BUBBLES.map(([fx, r, s, lead], n) => `.bs-liq i:nth-of-type(${n + 1}){left:${em(SLOT.w * fx - r)};top:${em(SLOT.h - 4 - LIQ_TOP - r)};`
    + `width:${em(2 * r)};height:${em(2 * r)};animation-duration:${s}s;animation-delay:${lead}s}`).join('');
  const css = [
    '#boot-splash{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '#boot-splash.out{opacity:0;pointer-events:none;transition:opacity .52s cubic-bezier(.4,0,.2,1)}',
    '.bs-bg{position:absolute;inset:0;background:#000}',
    // 70% of the width on a phone, 40% of the height anywhere wider.
    `.bs-logo{position:relative;flex:none;font-size:min(1.9vw,1.82vh);width:${em(BOX.w)};height:${em(BOX.h)}}`,
    '.bs-logo svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block;overflow:visible}',
    '.bs-depth,.bs-face{position:absolute;left:0;top:0;width:100%;height:100%}',
    // The depth waits hidden right behind the letters, then kicks out past its place and springs back.
    `.bs-depth{left:${em(DEPTH[0])};top:${em(DEPTH[1])};animation:bs-pop ${f(POP + 0.43)}s linear both}`,
    `@keyframes bs-pop{0%,${popAt(0)}{opacity:0;transform:translate(${em(-DEPTH[0])},${em(-DEPTH[1])})}`
    + `${popAt(0.02)}{opacity:1;transform:translate(${em(-DEPTH[0])},${em(-DEPTH[1])});animation-timing-function:cubic-bezier(.2,.8,.3,1)}`
    + `${popAt(0.2)}{transform:translate(.4em,.28em);animation-timing-function:ease-in-out}`
    + `${popAt(0.33)}{transform:translate(-.12em,-.08em);animation-timing-function:ease-in-out}100%{opacity:1;transform:none}}`,
    // …and the letters flinch as it goes.
    `.bs-face{transform-origin:${em(W / 2 - BOX.x)} ${em(H / 2 - BOX.y)};animation:bs-recoil ${f(POP + 0.3)}s linear both}`,
    `@keyframes bs-recoil{0%,${recoilAt(-0.08)}{transform:none;animation-timing-function:ease-out}`
    + `${recoilAt(0)}{transform:scale(.965);animation-timing-function:cubic-bezier(.2,.8,.3,1)}`
    + `${recoilAt(0.16)}{transform:scale(1.025);animation-timing-function:ease-in-out}100%{transform:none}}`,
    `.bs-c,.bs-dc{position:absolute;top:${em(TOP - PAD - BOX.y)};width:${em(COL + 2 * PAD)};height:${em(COL_H)}}`,
    ...[0, 1, 2, 3].map(arrive),
    // Already on their own layers when lib/bootIntro.ts starts moving them, so a start costs no raster.
    `.bs-hop{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:${em(COL / 2 + PAD)} ${em(BOT - TOP + PAD)};will-change:transform}`,
    `.bs-slot{position:absolute;left:${em(SLOT.x)};top:${em(SLOT.y)};width:${em(SLOT.w)};height:${em(SLOT.h)};border-radius:${em(SLOT.w / 2)};overflow:hidden}`,
    // Empty, until the first glug below; lib/bootIntro.ts pours the rest.
    `.bs-liq{position:absolute;left:0;top:${em(LIQ_TOP)};width:100%;height:${em(LIQ_H)};transform:${level(0)};will-change:transform}`,
    firstGlug,
    `.bs-logo .bs-wave{left:${em(-WL)};width:${em(SLOT.w + 3 * WL)};animation:bs-wave .95s linear infinite}`,
    '.bs-c3 .bs-wave{animation-duration:1.1s}',
    `@keyframes bs-wave{to{transform:translateX(${em(-WL)})}}`,
    '.bs-liq i{position:absolute;border-radius:50%;background:#fff;opacity:0;animation:bs-bub 1.3s ease-in infinite}',
    bubbles,
    `@keyframes bs-bub{from{transform:none;opacity:0}15%{opacity:.6}to{transform:translateY(${em(-(SLOT.h - 11))});opacity:0}}`,
    // Sized, placed and played by lib/bootIntro.ts.
    '.bs-flood{position:absolute;left:0;top:0;width:2px;height:2px;border-radius:50%;opacity:0;will-change:transform,opacity;background:linear-gradient(135deg,#ff4752,#ec1a74 55%,#8f24d6)}',
    `@media (prefers-reduced-motion:reduce){#boot-splash *{animation:none!important}.bs-liq{transform:${level(FIRST.level)}}}`,
  ].join('');
  return { html, css };
}
