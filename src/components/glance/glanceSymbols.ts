/* ---- THE GROLOO GLANCE ICONS ----------------------------------------------------------------
 *
 * Small lit objects in the reference's language (Oddfellows' at-a-glance set for Netflix): frosted
 * silver shapes, brand gradient accents (red → pink → violet), soft light from above, and LAYERED
 * TRANSPARENCY — a silver shape in front of a coloured one, the way the double thumbs and the rewind
 * are built. Drawn on a 24-unit grid to read at 18 px from across a room.
 *
 * Every icon carries its own four gradients, and their colours are CSS custom properties
 * (`--gl-b0…` silver, `--gl-a0…` accent, `--gl-d` details — see glance.css). That is what lets one
 * drawing sit on a dark callout, turn dark on a white focused TV button, and flood pink when it is
 * the chosen thumb, without a second set of drawings; and because each icon's gradients are its
 * own, they are referenced from attributes in the same <svg>, never from a stylesheet (an external
 * sheet's `url(#…)` is not a safe bet on a 2022 television's Chromium).
 *
 * Parts that move carry a motion class (`m-pop`, `m-drop`, `m-swing`…, glanceMotion.ts): an icon plays
 * its little entrance when its callout arrives, and replays it whenever its button takes focus. */

import { ensureMotionCss } from './glanceMotion';

export type GlanceIconName =
  | 'calendar' | 'top10' | 'thumbUp' | 'thumbDown' | 'thumbs' | 'megaphone' | 'laurel' | 'clapper'
  | 'starburst' | 'people' | 'popcorn' | 'newTile' | 'sparkle' | 'star' | 'chat' | 'rewind'
  | 'paintbrush' | 'globe' | 'ghost' | 'smile' | 'hearts' | 'notes' | 'shield' | 'planet' | 'wand'
  | 'compass' | 'magnifier' | 'bolt' | 'tear'
  | 'play' | 'add' | 'added' | 'close' | 'flag' | 'link' | 'soundOn' | 'soundOff' | 'credits';

const f = (n: number) => String(Math.round(n * 100) / 100);
const rad = (d: number) => (d * Math.PI) / 180;
/** A star of `n` points, alternating radii R and r, first point at `rot` degrees. */
function star(n: number, cx: number, cy: number, R: number, r: number, rot = -90): string {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = rad(rot + (i * 180) / n);
    const rr = i % 2 ? r : R;
    d += `${i ? 'L' : 'M'}${f(cx + rr * Math.cos(a))} ${f(cy + rr * Math.sin(a))}`;
  }
  return `${d}Z`;
}
/** The four-pointed glint, sides drawn in towards the middle. */
function glint(cx: number, cy: number, R: number, k = 0.13): string {
  const q = R * k;
  return `M${f(cx)} ${f(cy - R)}Q${f(cx + q)} ${f(cy - q)} ${f(cx + R)} ${f(cy)}Q${f(cx + q)} ${f(cy + q)} ${f(cx)} ${f(cy + R)}`
    + `Q${f(cx - q)} ${f(cy + q)} ${f(cx - R)} ${f(cy)}Q${f(cx - q)} ${f(cy - q)} ${f(cx)} ${f(cy - R)}Z`;
}
/* Paints, by placeholder: @A accent (diagonal), @V accent (top to bottom), @B silver, @S sheen. */
const ACC = 'fill="url(@A)"';
const ACV = 'fill="url(@V)"';
const SIL = 'fill="url(@B)"';
const SHEEN = 'fill="url(@S)"';

/* The thumb: a fist, thumb up, its cuff on the left. Every thumb in the set is drawn from it. */
const HAND = 'M7.2 10.6L10.1 4.9C10.6 3.9 11.7 3.4 12.7 3.8C13.7 4.2 14.1 5.2 13.8 6.2L12.9 10H18.4'
  + 'C19.7 10 20.6 10.9 20.6 11.9C20.6 12.7 20.1 13.3 19.5 13.5C20.3 13.8 20.8 14.5 20.7 15.3'
  + 'C20.6 16.1 20.1 16.6 19.4 16.8C20 17.1 20.4 17.8 20.2 18.5C20 19.2 19.5 19.6 18.9 19.7'
  + 'C19.3 20 19.5 20.6 19.2 21.1C19 21.5 18.6 21.6 18.1 21.6H7.2Z';
const thumb = (cuff = ACV) =>
  `<path d="${HAND}" ${SIL}/>`
  + '<rect x="7.2" y="10.3" width="1.7" height="11.3" fill="#000" opacity=".16"/>'
  + `<rect x="2.4" y="10.1" width="5.1" height="11.6" rx="1.3" ${cuff}/>`
  + `<rect x="2.4" y="10.1" width="5.1" height="4.2" rx="1.3" ${SHEEN} opacity=".35"/>`;

const HEART = 'M10.8 21C10.5 21 10.2 20.9 10 20.7C6.4 17.6 2.8 14.5 2.8 10.6C2.8 8 4.8 6 7.3 6C8.7 6 10 6.7 10.8 7.8'
  + 'C11.6 6.7 12.9 6 14.3 6C16.8 6 18.8 8 18.8 10.6C18.8 14.5 15.2 17.6 11.6 20.7C11.4 20.9 11.1 21 10.8 21Z';
const PLUS = 'M10.6 4.2C10.6 3.4 11.2 2.8 12 2.8S13.4 3.4 13.4 4.2V10.6H19.8C20.6 10.6 21.2 11.2 21.2 12S20.6 13.4 19.8 13.4'
  + 'H13.4V19.8C13.4 20.6 12.8 21.2 12 21.2S10.6 20.6 10.6 19.8V13.4H4.2C3.4 13.4 2.8 12.8 2.8 12S3.4 10.6 4.2 10.6H10.6Z';
const CROSS = 'M5.2 7.2C4.6 6.6 4.6 5.8 5.2 5.2S6.6 4.6 7.2 5.2L12 10L16.8 5.2C17.4 4.6 18.2 4.6 18.8 5.2S19.4 6.6 18.8 7.2'
  + 'L14 12L18.8 16.8C19.4 17.4 19.4 18.2 18.8 18.8S17.4 19.4 16.8 18.8L12 14L7.2 18.8C6.6 19.4 5.8 19.4 5.2 18.8'
  + 'S4.6 17.4 5.2 16.8L10 12Z';
const SPEAKER = 'M3.5 9.2H7.2L12.2 5C12.8 4.5 13.6 4.9 13.6 5.7V18.3C13.6 19.1 12.8 19.5 12.2 19L7.2 14.8H3.5'
  + 'C2.9 14.8 2.5 14.4 2.5 13.8V10.2C2.5 9.6 2.9 9.2 3.5 9.2Z';
const GHOST = 'M4.6 19.8V10.6C4.6 6.5 7.6 3.6 11.4 3.6S18.2 6.5 18.2 10.6V19.8C18.2 20.5 17.4 20.8 16.9 20.3L15.5 18.9L13.9 20.5'
  + 'C13.5 20.9 12.9 20.9 12.5 20.5L10.9 18.9L9.3 20.5C8.9 20.9 8.3 20.9 7.9 20.5L6.3 18.9L5.9 19.3C5.4 19.8 4.6 20.5 4.6 19.8Z';
const SHIELD = 'M12 2.6L19.6 5.5C20 5.7 20.3 6.1 20.3 6.5V11.4C20.3 16.4 17 20.3 12.3 22.2C12.1 22.3 11.9 22.3 11.7 22.2'
  + 'C7 20.3 3.7 16.4 3.7 11.4V6.5C3.7 6.1 4 5.7 4.4 5.5Z';
const BOLT = 'M13.6 2.2L4.6 13.4H10.6L9.2 21.8L18.6 9.8H12.4Z';
const DROP = 'M12 2.8C12.4 2.8 12.7 3 12.9 3.3C14.7 5.9 18.5 11.2 18.5 14.6C18.5 18.3 15.6 21.2 12 21.2S5.5 18.3 5.5 14.6'
  + 'C5.5 11.2 9.3 5.9 11.1 3.3C11.3 3 11.6 2.8 12 2.8Z';
const TRI_L = (dx: number) => `M${f(11.6 + dx)} 6.2V17.8C${f(11.6 + dx)} 18.8 ${f(10.7 + dx)} 19.3 ${f(9.9 + dx)} 18.7L${f(3.4 + dx)} 13.2`
  + `C${f(2.7 + dx)} 12.7 ${f(2.7 + dx)} 11.3 ${f(3.4 + dx)} 10.8L${f(9.9 + dx)} 5.3C${f(10.7 + dx)} 4.7 ${f(11.6 + dx)} 5.2 ${f(11.6 + dx)} 6.2Z`;

/* THE LAUREL: pointed leaves set along two arcs, each turned a little outward from its stem, the
 * right branch the mirror of the left; they grow in from the bottom, pair by pair. */
const almond = (L: number, W: number) =>
  `M0 ${f(-L / 2)}C${f(W / 2)} ${f(-L / 4)} ${f(W / 2)} ${f(L / 4)} 0 ${f(L / 2)}C${f(-W / 2)} ${f(L / 4)} ${f(-W / 2)} ${f(-L / 4)} 0 ${f(-L / 2)}Z`;
function laurel(): string {
  let out = '';
  [118, 146, 174, 202, 229].forEach((deg, i) => {
    const t = rad(deg);
    const L = 5.1 - i * 0.3, W = 2.6 - i * 0.1;
    let dx = -Math.sin(t) + 0.55 * Math.cos(t), dy = Math.cos(t) + 0.55 * Math.sin(t);
    const n = Math.hypot(dx, dy); dx /= n; dy /= n;
    const x = 12 + 7.2 * Math.cos(t) + dx * L * 0.4, y = 12.3 + 7.2 * Math.sin(t) + dy * L * 0.4;
    for (const side of [1, -1]) {
      const px = side > 0 ? x : 24 - x, ddx = side > 0 ? dx : -dx;
      const phi = (Math.atan2(ddx, -dy) * 180) / Math.PI;
      out += `<g class="m-grow" style="--d:${f(i * 0.06 + (side > 0 ? 0 : 0.03))}s">`
        + `<path transform="translate(${f(px)} ${f(y)}) rotate(${f(phi)})" d="${almond(L, W)}" ${ACC}/></g>`;
    }
  });
  return out;
}

const ICONS: Record<Exclude<GlanceIconName, 'credits'>, string> = {
  /* A calendar: the brand gradient frame, a white page, a date marked on it, two rings. */
  calendar:
    `<g class="m-pop"><rect x="3" y="4.8" width="18" height="16.2" rx="3.4" ${ACC}/>`
    + `<path d="M3 8.2A3.4 3.4 0 0 1 6.4 4.8H17.6A3.4 3.4 0 0 1 21 8.2V9.6H3Z" ${SHEEN} opacity=".42"/>`
    + '<rect x="5.3" y="9.4" width="13.4" height="9.5" rx="1.7" fill="#fff" opacity=".96"/>'
    + '<circle class="dk m-pop" style="--d:.3s" cx="8.9" cy="13" r="1.4"/></g>'
    + '<rect class="m-drop" style="--d:.12s" x="7" y="2.5" width="2.4" height="4.9" rx="1.2" fill="#fff"/>'
    + '<rect class="m-drop" style="--d:.2s" x="14.6" y="2.5" width="2.4" height="4.9" rx="1.2" fill="#fff"/>',

  /* The chart tile: TOP over a big 10, lettering lit like the tile. */
  top10:
    `<g class="m-flip"><rect x="3" y="3" width="18" height="18" rx="4.2" ${ACC}/>`
    + `<path d="M3 7.2A4.2 4.2 0 0 1 7.2 3H16.8A4.2 4.2 0 0 1 21 7.2V9.4H3Z" ${SHEEN} opacity=".4"/></g>`
    + '<g class="m-rise" style="--d:.14s" fill="#fff">'
    + '<path d="M7.2 5.2H10.2V6.2H9.2V8.6H8.2V6.2H7.2Z"/>'
    + '<path fill-rule="evenodd" d="M12.1 5.1C13.1 5.1 13.7 5.8 13.7 6.85S13.1 8.6 12.1 8.6 10.5 7.9 10.5 6.85 11.1 5.1 12.1 5.1Z'
    + 'M12.1 6C11.7 6 11.5 6.35 11.5 6.85S11.7 7.7 12.1 7.7 12.7 7.35 12.7 6.85 12.5 6 12.1 6Z"/>'
    + '<path fill-rule="evenodd" d="M14.2 5.2H15.8C16.6 5.2 17.1 5.7 17.1 6.35S16.6 7.5 15.8 7.5H15.2V8.6H14.2Z'
    + 'M15.2 6.05V6.65H15.7C15.95 6.65 16.07 6.53 16.07 6.35S15.95 6.05 15.7 6.05Z"/></g>'
    + '<g class="m-rise" style="--d:.22s" fill="#fff">'
    + '<path d="M6.6 10.9L9.4 9.4H10.7V18.8H8.6V11.9L6.6 12.8Z"/>'
    + '<path fill-rule="evenodd" d="M14.6 9.3C16.6 9.3 17.8 11.1 17.8 14.05S16.6 18.9 14.6 18.9 11.4 17 11.4 14.05 12.6 9.3 14.6 9.3Z'
    + 'M14.6 11.2C13.9 11.2 13.5 12.2 13.5 14.05S13.9 17 14.6 17 15.7 15.9 15.7 14.05 15.3 11.2 14.6 11.2Z"/></g>',

  /* The thumbs (the rating tray and "we think you'll like this"). */
  thumbUp: `<g class="m-swing o-bl">${thumb()}</g>`,
  thumbDown: `<g class="m-swing o-tr"><g transform="rotate(180 12 12)">${thumb()}</g></g>`,
  /* Two thumbs: "we think you'll love this", and the tray's "Love this!". */
  thumbs:
    `<g class="m-pop" style="--d:.16s"><g transform="translate(8.6 -1.4) scale(.62)" opacity=".92"><path d="${HAND}" ${SIL}/></g></g>`
    + `<g class="m-swing o-bl"><g transform="translate(-.6 3.4) scale(.82)">${thumb()}</g></g>`,

  /* New season, new episodes: the megaphone. */
  megaphone:
    '<g class="m-shake o-l">'
    + `<rect x="2.3" y="9.4" width="3.4" height="5.2" rx="1.3" ${SIL}/>`
    + `<path d="M5.2 9.8L17.6 5.2C18.9 4.7 20.2 5.7 20.2 7.1V16.9C20.2 18.3 18.9 19.3 17.6 18.8L5.2 14.2Z" ${ACC}/>`
    + `<path d="M5.2 9.8L17.6 5.2C18.9 4.7 20.2 5.7 20.2 7.1V9.2L5.2 11.6Z" ${SHEEN} opacity=".3"/>`
    + '<path d="M7.4 14.9V18.2C7.4 19.2 8 19.8 9 19.8H9.6C10.6 19.8 11.2 19.2 11.2 18.2V16.3" fill="none" stroke="url(@B)" stroke-width="1.8" stroke-linecap="round"/>'
    + '</g>',

  /* Awards and festivals: a laurel, its stems crossed. */
  laurel:
    laurel()
    + '<g class="m-pop" style="--d:.3s">'
    + `<rect x="9.8" y="19.4" width="4.4" height="1.3" rx=".65" transform="rotate(35 12 20)" ${SIL}/>`
    + `<rect x="9.8" y="19.4" width="4.4" height="1.3" rx=".65" transform="rotate(-35 12 20)" ${SIL}/></g>`,

  /* Seasons to binge: the clapperboard, snapping shut. */
  clapper:
    `<g class="m-pop"><rect x="3.2" y="10.4" width="17.6" height="10.2" rx="2.2" ${SIL}/>`
    + '<rect class="dk" x="6" y="15.4" width="7.6" height="1.5" rx=".75" opacity=".7"/></g>'
    + '<g class="m-clap o-bl"><g transform="rotate(-14 3.4 10.2)">'
    + `<rect x="3.2" y="6.8" width="17.6" height="3.4" rx="1.1" ${ACC}/>`
    + '<path d="M7.6 6.8H9.9L8 10.2H5.7ZM12.4 6.8H14.7L12.8 10.2H10.5ZM17.2 6.8H19.5L17.6 10.2H15.3Z" fill="#fff" opacity=".92"/>'
    + '</g></g>',

  /* Trending: a silver burst over a coloured one. */
  starburst:
    `<g class="m-spin2"><path d="${star(8, 12, 12, 10.6, 4.9, -67.5)}" ${ACC} stroke="url(@A)" stroke-width=".8" stroke-linejoin="round"/></g>`
    + `<g class="m-spin"><path d="${star(8, 12, 12, 9.2, 4.3)}" ${SIL} stroke="url(@B)" stroke-width=".7" stroke-linejoin="round"/></g>`,

  /* Family: two people, one in front of the other. */
  people:
    `<g class="m-slide" style="--d:.1s"><circle cx="16.3" cy="8.3" r="3" ${ACC}/>`
    + `<path d="M11.6 19.9C11.6 16.2 13.7 13.8 16.4 13.8S21.2 16.2 21.2 19.9C21.2 20.4 20.8 20.8 20.3 20.8H12.5C12 20.8 11.6 20.4 11.6 19.9Z" ${ACC}/></g>`
    + `<g class="m-pop"><circle cx="9" cy="9" r="3.4" ${SIL}/>`
    + `<path d="M3.2 20.3C3.2 16.1 5.7 13.4 9 13.4S14.8 16.1 14.8 20.3C14.8 20.9 14.4 21.3 13.8 21.3H4.2C3.6 21.3 3.2 20.9 3.2 20.3Z" ${SIL}/></g>`,

  /* A classic: the popcorn bucket, popping. */
  popcorn:
    `<g class="m-rise" style="--d:.2s"><circle cx="7.6" cy="9.4" r="2.4" ${ACC}/></g>`
    + `<g class="m-rise" style="--d:.1s"><circle cx="10.6" cy="7.3" r="2.6" ${ACC}/></g>`
    + `<g class="m-rise" style="--d:.15s"><circle cx="13.8" cy="7.3" r="2.6" ${ACC}/></g>`
    + `<g class="m-rise" style="--d:.25s"><circle cx="16.5" cy="9.4" r="2.4" ${ACC}/></g>`
    + `<g class="m-rise" style="--d:.05s"><circle cx="12.2" cy="9.6" r="2.3" ${ACC}/></g>`
    + `<g class="m-pop"><path d="M4.8 10.6H19.2L17.6 20.7C17.5 21.5 16.8 22 16 22H8C7.2 22 6.5 21.5 6.4 20.7Z" ${SIL}/>`
    + '<path class="dk" d="M8.2 12.4H9.4L9.8 20H8.8ZM11.4 12.4H12.6V20H11.4ZM14.6 12.4H15.8L15.2 20H14.2Z" opacity=".5"/></g>',

  /* New: the stamp. */
  newTile:
    `<g class="m-stamp"><rect x="2.8" y="2.8" width="18.4" height="18.4" rx="4.2" ${ACC}/>`
    + `<path d="M2.8 7A4.2 4.2 0 0 1 7 2.8H17A4.2 4.2 0 0 1 21.2 7V9.4H2.8Z" ${SHEEN} opacity=".4"/>`
    + '<path fill="#fff" d="M5 15.4V8.6H6.3L7.6 12.6V8.6H8.8V15.4H7.6L6.2 11.4V15.4Z'
    + 'M9.7 8.6H12.6V9.8H11.1V11.4H12.4V12.6H11.1V14.2H12.7V15.4H9.7Z'
    + 'M13 8.6H14.3L14.8 12.6L15.5 8.6H16.5L17.2 12.6L17.7 8.6H19L17.9 15.4H16.7L16 11.7L15.3 15.4H14.1Z"/></g>',

  /* A hidden gem: a silver glint, a coloured one beside it. */
  sparkle:
    `<g class="m-spin"><path d="${glint(10.2, 13.4, 8.8)}" ${SIL}/></g>`
    + `<g class="m-pop" style="--d:.24s"><path d="${glint(18.6, 5.6, 3.6)}" ${ACC}/></g>`,

  /* Top rated: a silver star with a coloured heart. */
  star:
    `<g class="m-spin"><path d="${star(5, 12, 12.9, 10.4, 4.6)}" ${SIL} stroke="url(@B)" stroke-width="1.2" stroke-linejoin="round"/>`
    + `<path class="m-pop" style="--d:.18s" d="${star(5, 12, 12.9, 5.4, 2.4)}" ${ACC} stroke="url(@A)" stroke-width=".6" stroke-linejoin="round"/></g>`,

  /* Fan favourite: everyone is talking — two bubbles, three dots. */
  chat:
    `<g class="m-slide" style="--d:.08s"><path d="M8.6 9.2H18.8C20.3 9.2 21.4 10.3 21.4 11.8V16.8C21.4 18.3 20.3 19.4 18.8 19.4H18.2V21.6C18.2 22.1 17.6 22.4 17.2 22L14.4 19.4H8.6C7.1 19.4 6 18.3 6 16.8V11.8C6 10.3 7.1 9.2 8.6 9.2Z" ${ACC}/></g>`
    + `<g class="m-pop"><path d="M5 3.6H15.6C17.1 3.6 18.2 4.7 18.2 6.2V11.6C18.2 13.1 17.1 14.2 15.6 14.2H8.4L5.5 16.8C5.1 17.2 4.5 16.9 4.5 16.4V14.2H5C3.5 14.2 2.4 13.1 2.4 11.6V6.2C2.4 4.7 3.5 3.6 5 3.6Z" ${SIL}/>`
    + '<circle class="dk m-bob" style="--d:.3s" cx="7.1" cy="8.9" r="1.05"/>'
    + '<circle class="dk m-bob" style="--d:.4s" cx="10.3" cy="8.9" r="1.05"/>'
    + '<circle class="dk m-bob" style="--d:.5s" cx="13.5" cy="8.9" r="1.05"/></g>',

  /* Back (to the credits): two arrowheads, the coloured one following. */
  rewind:
    `<g class="m-slidel" style="--d:.1s"><path d="${TRI_L(8.4)}" ${ACC}/></g>`
    + `<g class="m-slidel"><path d="${TRI_L(0)}" ${SIL}/></g>`,

  /* Beautifully animated: the brush. */
  paintbrush:
    '<g class="m-swing o-b">'
    + `<path d="M19.9 2.9C20.5 3.5 20.5 4.4 19.9 5L11.3 13.6L9.2 11.5L17.8 2.9C18.4 2.3 19.3 2.3 19.9 2.9Z" ${SIL}/>`
    + `<path d="M9 11.2L12.6 14.8L11.1 16.3L7.5 12.7Z" ${SIL} opacity=".75"/>`
    + `<path d="M7.3 13.4C8.6 13 10 13.5 10.7 14.6C11.5 15.9 11.2 17.6 10 18.7C8.4 20.2 5.6 20.8 3.4 20.7C4.3 19.9 4.6 18.8 4.6 17.5C4.6 15.6 5.6 13.9 7.3 13.4Z" ${ACC}/>`
    + '</g>',

  /* Eye-opening: the world under a glass. */
  globe:
    `<g class="m-pop"><circle cx="10.6" cy="10.6" r="5.9" ${ACC}/>`
    + '<g class="m-turn"><g fill="none" style="stroke:var(--gl-d)" stroke-width="1" opacity=".7">'
    + '<ellipse cx="10.6" cy="10.6" rx="2.6" ry="5.9"/><path d="M4.7 10.6H16.5M5.5 7.7H15.7M5.5 13.5H15.7"/></g></g>'
    + '<circle cx="10.6" cy="10.6" r="7.3" fill="none" stroke="url(@B)" stroke-width="2.2"/>'
    + '<path d="M16.1 16.1L20.4 20.4" stroke="url(@B)" stroke-width="3.2" stroke-linecap="round"/></g>',

  /* Spine-chilling: a ghost with its shadow. */
  ghost:
    `<g class="m-slide" style="--d:.1s"><g opacity=".9" transform="translate(2.6 1.3)"><path d="${GHOST}" ${ACC}/></g></g>`
    + `<g class="m-float"><path d="${GHOST}" ${SIL}/>`
    + '<ellipse class="dk" cx="9.2" cy="10.6" rx="1.15" ry="1.6"/><ellipse class="dk" cx="13.6" cy="10.6" rx="1.15" ry="1.6"/></g>',

  /* Laugh-out-loud. */
  smile:
    `<g class="m-laugh"><circle cx="12" cy="12" r="9.2" ${SIL}/>`
    + `<path d="M6.9 12.6H17.1C17.1 15.9 14.9 18.2 12 18.2S6.9 15.9 6.9 12.6Z" ${ACC}/>`
    + '<path d="M7.5 9.7C8.4 8.4 10 8.4 10.9 9.7M13.1 9.7C14 8.4 15.6 8.4 16.5 9.7" fill="none" style="stroke:var(--gl-d)" stroke-width="1.6" stroke-linecap="round"/></g>',

  /* Swoon-worthy: a big heart and a small one. */
  hearts:
    `<g class="m-pop" style="--d:.18s"><g transform="translate(13.2 .6) scale(.48)"><path d="${HEART}" ${SIL}/></g></g>`
    + `<g class="m-beat"><path d="${HEART}" ${ACC}/>`
    + '<path d="M5.6 9.6C5.9 8.4 6.9 7.7 8.1 7.8" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".55"/></g>',

  /* Music to your ears. */
  notes:
    `<g class="m-bob" style="--d:.12s"><ellipse cx="16" cy="16.2" rx="2.5" ry="1.9" transform="rotate(-22 16 16.2)" ${ACC}/>`
    + `<rect x="17.5" y="6.6" width="1.6" height="9.6" rx=".8" ${ACC}/></g>`
    + `<g class="m-bob"><ellipse cx="7.6" cy="17.6" rx="3.1" ry="2.4" transform="rotate(-22 7.6 17.6)" ${SIL}/>`
    + `<rect x="9.5" y="4.4" width="1.8" height="13.4" rx=".9" ${SIL}/>`
    + `<path d="M11.2 4.5C13.8 5.1 15.6 6.8 15.6 9.4C14.7 8.1 13.2 7.4 11.2 7.3Z" ${SIL}/></g>`,

  /* An epic saga: the shield. */
  shield:
    `<g class="m-pop"><path d="${SHIELD}" ${SIL}/>`
    + `<path class="m-pop" style="--d:.16s" d="M12 6.3L16.6 8V11.1C16.6 14.1 14.6 16.5 12 17.6C9.4 16.5 7.4 14.1 7.4 11.1V8Z" ${ACC}/></g>`,

  /* Mind-bending: a planet and its ring. */
  planet:
    `<g class="m-pop"><circle cx="12" cy="12" r="6.4" ${ACC}/>`
    + `<path d="M7.6 8.6A6.4 6.4 0 0 1 16.4 8.6" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".4"/></g>`
    + '<g class="m-tilt"><g transform="rotate(-18 12 12)">'
    + `<path fill-rule="evenodd" d="M1.2 12A10.8 3.4 0 1 0 22.8 12A10.8 3.4 0 1 0 1.2 12ZM3.6 12A8.4 2.1 0 1 0 20.4 12A8.4 2.1 0 1 0 3.6 12Z" ${SIL}/>`
    + '</g></g>',

  /* Magical worlds: the wand and its glints. */
  wand:
    '<g class="m-swing o-bl">'
    + '<path d="M3.8 20.2L13 11" stroke="url(@B)" stroke-width="2.5" stroke-linecap="round"/>'
    + `<path d="${star(5, 15.6, 8.4, 5.6, 2.5, -80)}" ${ACC} stroke="url(@A)" stroke-width=".7" stroke-linejoin="round"/></g>`
    + `<path class="m-pop" style="--d:.32s" d="${glint(20.4, 15, 2.1)}" ${SIL}/>`
    + `<path class="m-pop" style="--d:.44s" d="${glint(8.4, 4.4, 1.7)}" ${SIL}/>`,

  /* Adventure: the compass, its needle swinging north. */
  compass:
    '<circle cx="12" cy="12" r="8.7" fill="none" stroke="url(@B)" stroke-width="2.4"/>'
    + '<g class="m-needle"><g transform="rotate(35 12 12)">'
    + `<path d="M12 4.9L14.4 12H9.6Z" ${ACC}/><path d="M12 19.1L9.6 12H14.4Z" ${SIL} opacity=".85"/></g></g>`
    + '<circle class="dk" cx="12" cy="12" r="1.15"/>',

  /* Keeps you guessing: the magnifying glass. */
  magnifier:
    `<g class="m-sweep"><circle cx="10.4" cy="10.4" r="6" ${ACC} opacity=".92"/>`
    + '<circle cx="10.4" cy="10.4" r="7.2" fill="none" stroke="url(@B)" stroke-width="2.3"/>'
    + '<path d="M15.6 15.6L20.3 20.3" stroke="url(@B)" stroke-width="3.2" stroke-linecap="round"/>'
    + '<path d="M7.2 8.8A3.6 3.6 0 0 1 10.2 6.1" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".8"/></g>',

  /* Pulse-pounding: the bolt, with its silver echo. */
  bolt:
    `<g class="m-slide" style="--d:.08s"><g opacity=".9" transform="translate(2.4 1)"><path d="${BOLT}" ${SIL} stroke="url(@B)" stroke-width=".9" stroke-linejoin="round"/></g></g>`
    + `<g class="m-flash"><path d="${BOLT}" ${ACC} stroke="url(@A)" stroke-width=".9" stroke-linejoin="round"/></g>`,

  /* Deeply moving: one tear. */
  tear:
    `<g class="m-dropin"><path d="${DROP}" ${ACC}/>`
    + '<path d="M8.7 14.6C8.7 16.5 10 18 11.7 18.3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></g>',

  /* ---- THE BUTTONS ---- */
  play:
    '<g class="m-nudge">'
    + `<path d="M7.4 4.9V19.1C7.4 20.2 8.6 20.8 9.5 20.2L19.9 13.1C20.7 12.6 20.7 11.4 19.9 10.9L9.5 3.8C8.6 3.2 7.4 3.8 7.4 4.9Z" ${ACC}/>`
    + `<path d="M7.4 4.9V9.6L17 11L9.5 3.8C8.6 3.2 7.4 3.8 7.4 4.9Z" ${SHEEN} opacity=".38"/></g>`,
  add:
    `<g class="m-slide2" style="--d:.06s"><g transform="translate(1.5 1.5)"><path d="${PLUS}" ${ACC} opacity=".95"/></g></g>`
    + `<g class="m-spin"><path d="${PLUS}" ${SIL}/></g>`,
  added:
    '<g class="m-slide2" style="--d:.06s"><path d="M6.4 13.9L10.6 18.1L19.8 8.9" fill="none" stroke="url(@A)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></g>'
    + '<path class="m-draw" d="M4.4 12.1L8.6 16.3L17.8 7.1" fill="none" stroke="url(@B)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>',
  close:
    `<g class="m-slide2" style="--d:.06s"><g transform="translate(1.5 1.5)"><path d="${CROSS}" ${ACC} opacity=".95"/></g></g>`
    + `<g class="m-spin"><path d="${CROSS}" ${SIL}/></g>`,
  flag:
    `<rect x="4.4" y="2.6" width="2.2" height="19" rx="1.1" ${SIL}/>`
    + '<g class="m-wave o-l">'
    + `<path d="M6.6 4.4C8.8 3.2 11.2 3.6 13.2 4.6C15.2 5.6 17.4 5.8 19.6 4.8V13.4C17.4 14.4 15.2 14.2 13.2 13.2C11.2 12.2 8.8 11.8 6.6 13Z" ${ACC}/>`
    + `<path d="M6.6 4.4C8.8 3.2 11.2 3.6 13.2 4.6C15.2 5.6 17.4 5.8 19.6 4.8V7.4C17.4 8.4 15.2 8.2 13.2 7.2C11.2 6.2 8.8 5.8 6.6 7Z" ${SHEEN} opacity=".32"/>`
    + '</g>',
  link:
    '<g class="m-slide" style="--d:.06s"><g transform="rotate(-45 12 12)">'
    + `<path fill-rule="evenodd" d="M12.6 8.6H17.8C19.7 8.6 21.2 10.1 21.2 12S19.7 15.4 17.8 15.4H12.6C10.7 15.4 9.2 13.9 9.2 12S10.7 8.6 12.6 8.6ZM12.6 10.6C11.8 10.6 11.2 11.2 11.2 12S11.8 13.4 12.6 13.4H17.8C18.6 13.4 19.2 12.8 19.2 12S18.6 10.6 17.8 10.6Z" ${ACC}/>`
    + '</g></g>'
    + '<g class="m-slidel"><g transform="rotate(-45 12 12)">'
    + `<path fill-rule="evenodd" d="M6.2 8.6H11.4C13.3 8.6 14.8 10.1 14.8 12S13.3 15.4 11.4 15.4H6.2C4.3 15.4 2.8 13.9 2.8 12S4.3 8.6 6.2 8.6ZM6.2 10.6C5.4 10.6 4.8 11.2 4.8 12S5.4 13.4 6.2 13.4H11.4C12.2 13.4 12.8 12.8 12.8 12S12.2 10.6 11.4 10.6Z" ${SIL}/>`
    + '</g></g>',
  soundOn:
    `<g class="m-pop"><path d="${SPEAKER}" ${SIL}/></g>`
    + '<path class="m-blink" style="--d:.12s" d="M16.4 8.8C17.5 9.9 17.5 14.1 16.4 15.2" fill="none" stroke="url(@V)" stroke-width="2" stroke-linecap="round"/>'
    + '<path class="m-blink" style="--d:.24s" d="M19.1 6.3C21.2 8.6 21.2 15.4 19.1 17.7" fill="none" stroke="url(@V)" stroke-width="2" stroke-linecap="round"/>',
  soundOff:
    `<g class="m-pop"><path d="${SPEAKER}" ${SIL}/></g>`
    + '<g class="m-pop" style="--d:.14s"><path d="M16.3 9.4L21.3 14.6M21.3 9.4L16.3 14.6" fill="none" stroke="url(@A)" stroke-width="2.1" stroke-linecap="round"/></g>',
};

/* Each icon's own four gradients. Colours come from custom properties so a context can recolour
 * the drawing (glance.css: dark bodies on a white focus, a pink hand on the chosen thumb). */
function defs(p: string): string {
  const stops = (a: string, b: string, c: string) =>
    `<stop offset="0" style="stop-color:var(${a})"/><stop offset=".55" style="stop-color:var(${b})"/><stop offset="1" style="stop-color:var(${c})"/>`;
  return '<defs>'
    + `<linearGradient id="${p}A" x1="1" y1="0" x2="0" y2="1">${stops('--gl-a0', '--gl-a1', '--gl-a2')}</linearGradient>`
    + `<linearGradient id="${p}V" x1="0" y1="0" x2="0" y2="1">${stops('--gl-a0', '--gl-a1', '--gl-a2')}</linearGradient>`
    + `<linearGradient id="${p}B" x1="0" y1="0" x2="0" y2="1">${stops('--gl-b0', '--gl-b1', '--gl-b2')}</linearGradient>`
    + `<linearGradient id="${p}S" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + '</defs>';
}

/* A part's delay is written `--d` in the drawings above, the way it reads best there, and handed to the
 * page as `data-d` in centiseconds: the delay is baked into the move's keyframes now (glanceMotion.ts),
 * and a stylesheet can select on an attribute's value but not on a custom property's. */
const DELAY = / style="--d:([\d.]+)s"/g;
const toCs = (s: string) => Math.round(parseFloat(s) * 100);
const DRAWN: Record<string, string> = Object.fromEntries(Object.entries(ICONS)
  .map(([k, v]) => [k, v.replace(DELAY, (_, d: string) => ` data-d="${toCs(d)}"`)]));
/** Every (move, delay) the set uses — each gets keyframes of its own. */
function movesUsed(): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const v of Object.values(DRAWN)) {
    for (const m of v.matchAll(/class="([^"]*)"(?: data-d="(\d+)")?/g)) {
      const move = /\bm-([a-z0-9]+)/.exec(m[1])?.[1];
      if (move) out.push([move, Number(m[2] || 0)]);
    }
  }
  return out;
}

let seq = 0;
/** The inner markup of one icon, with gradient ids of its own. Pass `prefix` for ids that must not
 *  change between renders (React: the same string twice means the SVG is left alone — a new one
 *  means it is rebuilt, which restarts every animation in it). */
export function iconMarkup(name: GlanceIconName, prefix?: string): string {
  ensureMotionCss(movesUsed);
  const key = name === 'credits' ? 'rewind' : name;
  const p = prefix || `gl${(seq++).toString(36)}`;
  return defs(p) + DRAWN[key].replace(/@([ABVS])/g, `#${p}$1`);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The same icon for code that builds DOM by hand (the TV row billboard). */
export function glanceIconNode(name: GlanceIconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `gl-ic gl-ic-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = iconMarkup(name);
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS) as Array<Exclude<GlanceIconName, 'credits'>>;
