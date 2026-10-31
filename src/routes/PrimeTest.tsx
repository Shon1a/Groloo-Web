import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useHome, useMetaOf, useWarmDetail } from '../lib/queries';
import { useT } from '../i18n/i18n';
import { HOME_ROWS } from '../lib/home';
import { imgW } from '../lib/img';
import { barItemHere, setPageEntry } from '../lib/tvBar';
import { registerBackHandler } from '../lib/tvKeys';
import { PAGE_EXIT, registerPageExit, takeArrival } from '../lib/tvPageSlide';
import { quietFor, whenQuiet } from '../lib/tvQuiet';
import { useModal, openItem } from '../stores/modal';
import { usePlayer } from '../stores/player';
import type { MediaItem, MetaDetail } from '../lib/types';
import '../styles/prime.css';

/* PRIME TEST — a TEST PAGE, on the TV bar between Anime and My Space: the Prime Video living-room
 * home as the current app draws it, laid out and moving the way it does on an Android TV emulator
 * (Oct 30: 60fps screen recordings with the keys sent by adb, measured frame by frame — row motion by
 * phase correlation, fades by the brightness of each region per frame, positions off still captures).
 * All numbers are TV pixels at 1920x1080 and milliseconds.
 *
 * THE LAYOUT. No billboard: the page opens on the first row, with the focused title's panel above the
 * rows and its picture top-right. The rows are 384x216 tiles 416 apart, rows 282 apart, and the focused
 * one always sits on the same line under a ring that never moves; rows above it are gone, rows below it
 * at half. The panel is stacked from the bottom: the title's wordmark (its name where it has none), a
 * NEW MOVIE / NEW SERIES pill, the facts line, two lines of synopsis, the included line.
 *   The FEATURED ROW is the exception: its focused title is a 1024x576 card on the focus line, with
 * the wordmark, pill and facts in the card, and the rest are 384x576 posters starting 32 past it. While
 * it holds the remote there is no panel and no picture top-right, and the row above stays, at half.
 *
 * THE MOTION, AS MEASURED
 *   · Up/Down and Left/Right move alike: cubic-bezier(.35, .1, 0, 1) over 380ms (every press fits it to
 *     under 1%). Held, a step every ~210ms, each one re-aiming the move still running.
 *   · A row leaving upward is gone in ~60ms; a row coming into focus, or leaving it downward, changes
 *     between full and half in a sharp ease-out (~270ms, most of it in the first 50).
 *   · The title panel: at the press it fades out where it is (200ms, linear, a frame ahead of the rows);
 *     210ms after the press the new title fades in (200ms, linear), sliding the last 39px (32px
 *     sideways) in from where the rows come from, easing out. So a held key keeps it empty.
 *   · The picture: dims to black 290ms after a move (190ms), and the new one fades in (190ms) once the
 *     remote has rested 440ms and it is decoded, crossing the old one if that is still going.
 *   · The featured card does what the panel does, on the card: out drifting with the rows (190ms,
 *     48px), in at 185ms (200ms), its words sliding 76px and its picture 38px. The posters pass under
 *     it; the one before it shows ~110px left of it, fading into the screen's edge. On a Right press
 *     that one is gone at once and the poster leaving the card is cut in 115ms later, already sliding.
 *   · Into the featured row the panel goes at once and the picture fades out at once (115ms); out of it
 *     the panel comes in 55ms after the press and the picture at 110ms, with no fade. The ring goes at
 *     once both ways and comes back around its new box (150ms, 230ms after).
 *   · Up from the first row, or Back, goes to the bar. Back from further down takes the page back to the
 *     top: the rows go at once, and 130ms later come back a row short and glide into place.
 *   · Switched to along the bar, the page comes as grey shapes, gliding in from the side it is on, and
 *     shows itself all at once when the first screen's pictures are in (THE PAGE BEFORE ITS PICTURES,
 *     below). Switched away, its rows slide off and fade while the panel stays (lib/tvPageSlide.ts).
 *
 * THE REMOTE NEVER MOVES DOM FOCUS HERE. The page root holds focus and owns its arrows (stopped
 * before TvSpatialNav's window listener — no candidate measuring, no rects). A press writes a couple
 * of transforms, classes and text nodes; React does not render, and no picture arrives, while
 * anything moves. */

type PvRow = { key: string; title: string; items: MediaItem[]; feat?: boolean };

/* x is where the focused tile starts. */
const TILE = { w: 384, h: 216, pitch: 416, x: 144 };
/* The featured row's posters (TILE wide) and its card are this tall; prime.css places them. */
const POSTER_H = 576;
const TITLE_H = 45;
/* Between one row's tiles and the next row's title. */
const ROW_GAP = 21;
const FOCUS_BOTTOM = 828;
const ROW_CAP = 20;

/* The rows' one move, on both axes (prime.css has it too, as --move). */
const MOVE_MS = 380;
/* A held key steps this often, whatever the axis. */
const HOLD_MS = 210;
/* The title panel. Out: fades where it is, a frame ahead of the rows (it starts 15ms in). In: from the
   side the rows come from, easing out — a sideways press slides it sideways, Up/Down slides it
   vertically. */
const OUT_MS = 200;
const OUT_LEAD = 15;
const IN_AT = 210;
const IN_MS = 200;
const IN_SLIDE_MS = 200;
const IN_PX_V = 39;
const IN_PX_H = 32;
const IN_EASE = 'cubic-bezier(.11, .14, .26, 1)';
/* Out of the featured row there is no panel to fade first: the new one comes in this soon. */
const IN_AT_FROM_FEAT = 55;
/* The featured card's two faces. The old one fades (190ms, linear) drifting the way the rows go, both
   halves alike (48px over 200ms, linear); the new one's words and picture slide in this far, the
   picture half as far, starting a little sooner than the panel's in (FACE_IN_AT; IN_MS, IN_EASE). */
const FACE_OUT_MS = 190;
const FACE_IN_AT = 185;
const FACE_OUT_PX = 48;
const FACE_OUT_SLIDE_MS = 200;
const FACE_PX_INFO = 76;
const FACE_PX_ART = 38;
/* A Right press on the featured row: the poster left of the card is gone at once, and the one leaving
   the card is cut in this late, already on its way. */
const SLIVER_BACK_AT = 115;
/* Its "gone": below one step of brightness in 255 (sliverBack). */
const SLIVER_GONE = 0.002;
/* A panel this far into its in is still all but invisible (under 10%): a press then simply gives it the
   new title, as before its in. A hold steps right as each in starts, and so never has the two panels
   trade places on every step (measured: a quarter more main-thread frames through a held Down). */
const IN_SEEN_MS = 20;
/* After a tap, the next title is written into the hidden panel this late — past the press's own frame,
   so drawing it never holds up the start of the move. */
const WRITE_AT = 50;
/* The picture top-right: it dims 290ms after a move (190ms, linear) and the next fades in once the
   remote has rested 440ms (190ms, linear), crossing the last if that is still going. */
const ART_OUT_AT = 290;
const ART_OUT_MS = 190;
const ART_IN_MS = 190;
const ART_REST_MS = 440;
/* Into the featured row it goes at once, faster. */
const ART_GONE_MS = 115;
/* Its box (TV px), and how many of its pictures are kept decoded (~3.7MB each): the ones the two boxes
   are about to take, and the last. */
const ART = { w: 1300, h: 731 };
const ART_PICS_KEPT = 3;
/* Out of the featured row the picture is back this soon (~110ms with ART_PRIME_MS), cut in rather than
   faded. */
const ART_REST_FROM_FEAT = 80;
/* A new picture is drawn all but invisible (ART_PRIMED) this long before its fade starts. */
const ART_PRIME_MS = 34;
const ART_PRIMED = 0.01;
/* Into or out of the featured row the ring goes at once, and comes back around its new box. */
const RING_IN_AT = 230;
const RING_IN_MS = 150;
const RING_EASE = 'cubic-bezier(.2, .6, .3, 1)';
/* Back to the top: the rows are gone this long before they glide back in. */
const AWAY_MS = 130;
/* THE PAGE BEFORE ITS PICTURES, as Prime Video's (four switches along its bar, Oct 30, and a still of
   the emulator for the shapes). Switched to, the page is grey shapes — four bars where the panel goes,
   two rows of tiles — cut in 200px to the side it comes from and gliding home a frame later
   (cubic-bezier(0, 0, .2, 1), 233ms). Once the first screen's pictures and wordmarks are all in hand,
   and the shapes have been up SKEL_MIN_MS (the reference's least), they fade (380ms, linear) as the
   page fades in under them (prime.css), the text and the pictures together; the picture top-right
   comes 185ms into that (150ms, linear). However long the pictures take, the page shows SKEL_MAX_MS
   after its rows came, with what it has. x, y, width, height, corner. */
const SKELETON: [number, number, number, number, number][] = [
  [144, 253, 300, 33, 12], [144, 310, 500, 120, 16], [144, 454, 300, 33, 12], [144, 508, 246, 86, 12],
  ...[666, 946].flatMap((y) => [0, 1, 2, 3, 4].map((k): [number, number, number, number, number] => [TILE.x + k * TILE.pitch, y, TILE.w, TILE.h, 12])),
];
const SKEL_SHIFT = 200;
const SKEL_GLIDE_AT = 16;
const SKEL_GLIDE_MS = 233;
const SKEL_GLIDE_EASE = 'cubic-bezier(0, 0, .2, 1)';
const SKEL_MIN_MS = 330;
const SKEL_MAX_MS = 2500;
/* The shapes' fade (prime.css has it too); then they are taken away. */
const SKEL_OUT_MS = 380;
const ART_AT_REVEAL = 185;
const ART_REVEAL_MS = 150;
/* How often the page looks whether its first screen is in. */
const SKEL_POLL_MS = 32;
/* The first screen at the top: a row's first five tiles (the fifth cut by the edge); on the featured
   row, the two posters right of its card. */
const onFirstScreen = (r: PvRow, c: number) => (r.feat ? c >= 1 && c <= 2 : c < 5);
/* Switched away, the picture top-right fades this fast (the rows go as lib/tvPageSlide's PAGE_EXIT). */
const EXIT_ART_MS = 135;
/* Past the move a press starts: React work waits for this, so it never lands mid-move. */
const SETTLE_MS = MOVE_MS + 50;
/* On the featured card the rest's work comes in two parts, the faces one press away first: the rest
   (title screen, panels, pictures top-right) this much later, if the remote is still resting. */
const REST_NEXT_MS = 150;
/* Row pictures are fetched, decoded and put on this many tiles at a time — about a screenful. */
const PICS_AT_ONCE = 5;
/* The width of a tile's picture rendition (w500). */
const PIC_W = 500;
/* The panel's wordmark, for a box 250x75. */
const LOGO_W = 'w300';
/* Wordmarks of the titles one press away, fetched at rest and kept decoded — this many at most. */
const LOGOS_KEPT = 24;
/* The featured card's three faces: the one on screen and, written while the remote rests, the titles one
   press away either side — so a tap only moves and fades what is already drawn. */
const FACES = [0, 1, 2];
/* The card's pictures, decoded and kept for drawing into a face (~3.7MB each): one and two presses
   away, either side, and the one on it — this many at most. */
const FACE_PICS_KEPT = 5;
/* The card's box (TV px, its corner too) and the width of its picture's rendition (w1280). */
const CARD = { w: 1024, h: 576, r: 7 };
const CARD_PIC_W = 1280;
/* Real screen pixels per CSS pixel. Not devicePixelRatio alone: the webOS app's WAM reports 2 while the
   set draws 1080p, which its resolution media query does report (1dppx). */
const SCREEN_PX = window.matchMedia?.('(resolution: 1dppx)').matches ? 1 : window.devicePixelRatio || 1;
/* A remote repeats a held key every ~30-50ms; this long without one means it was let go, for the
   sets that drop a keyup. */
const REPEAT_GONE_MS = 150;

const DIRS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

const tileH = (r: PvRow) => (r.feat ? POSTER_H : TILE.h);
/* A row's tile picture: the backdrop with the title lettered in, as the reference's tiles are; a
   featured row's poster. The picture behind the panel and in the featured card is the textless one. */
const tileSrc = (r: PvRow, m: MediaItem) => imgW(r.feat ? m.poster : m.tileArt ?? m.backdrop, 'w500');
const bgSrc = (m: MediaItem) => imgW(m.bgArt ?? m.backdrop, 'w1280');

const DAY = 864e5;
const within = (date: string | null | undefined, days: number) => {
  const at = date ? Date.parse(date) : NaN;
  return at <= Date.now() && Date.now() - at < days * DAY;
};
/* The reference's pill, on a tile and in the panel. A card knows a new film or a new show; a new season
   or episode only the title's detail knows (glance.ts's spans). */
const badgeOf = (m: MediaItem, d?: MetaDetail) => {
  if (m.type === 'movie') return within(m.released, 45) ? 'New movie' : '';
  if (within(m.released, 60)) return 'New series';
  const last = d?.airing?.last;
  if (last && within(last.seasonStart, 30)) return last.season > 1 ? 'New season' : 'New series';
  return last && within(last.date, 7) ? 'New episode' : '';
};
const runOf = (m: MediaItem, d?: MetaDetail) => (!d ? ''
  : m.type === 'movie' ? d.runtime || ''
    : d.seasons ? `${d.seasons} season${d.seasons > 1 ? 's' : ''}` : '');
/* The age as the reference writes it, an age and a plus. A board that rates by age keeps its number
   ("12", "12A", "16" → 12+, 16+); the US letters take the ages Prime Video gives them (its maturity
   ratings: G, TV-Y, TV-G all ages; TV-Y7, PG, TV-PG 7+; PG-13 13+; TV-14 16+; R, NC-17, TV-MA 18+). */
const US_AGE: Record<string, string> = {
  G: 'ALL', 'TV-G': 'ALL', 'TV-Y': 'ALL', U: 'ALL',
  'TV-Y7': '7+', 'TV-Y7-FV': '7+', PG: '7+', 'TV-PG': '7+',
  'PG-13': '13+', 'TV-14': '16+', R: '18+', 'NC-17': '18+', 'TV-MA': '18+',
};
const ageOf = (d?: MetaDetail) => {
  const c = d?.certification?.trim().toUpperCase();
  if (!c) return '';
  const n = /^\d+/.exec(c)?.[0];
  return n ? (Number(n) ? `${Number(n)}+` : 'ALL') : US_AGE[c] ?? '';
};

/* The facts only the title's detail has: its runtime (or seasons) and age rating. Written with the rest
   when the detail is already here; otherwise when it lands, at rest — at the END of the facts line, so
   they move nothing else, fading in. The featured card has the age alone. */
const writeLate = (el: HTMLElement, m: MediaItem, d: MetaDetail | undefined, late: boolean) => {
  const pairs: [string, string][] = [['.pv-run', runOf(m, d)], ['.pv-age', ageOf(d)]];
  for (const [sel, s] of pairs) {
    const n = el.querySelector<HTMLElement>(sel);
    if (!n || n.textContent === s) continue;
    n.textContent = s;
    n.classList.toggle('is-late', late && !!s);
  }
};

const Check = () => (
  <span className="pv-check">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" /><path d="m7 12.5 3.2 3.2L17 9" /></svg>
    Included with Groloo
  </span>
);

/* A picture's pixels, decoded off the main thread, to be drawn into a canvas once — at the size it is
   drawn, or (`w` left out) its own. The resize is NOT off the main thread: the engine does it as it hands
   the pixels over (measured: 20-60ms of main thread at 4x for a w1280 picture, at rest, where the next
   press lands). A tile's is small enough; a big picture is drawn at its own size and scaled by the GPU. */
const pixels = async (url: string, w?: number, h?: number): Promise<ImageBitmap | null> => {
  const size: ImageBitmapOptions = w && h ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : {};
  try {
    const res = await fetch(url);
    if (res.ok) return await createImageBitmap(await res.blob(), size);
  } catch { /* a host that will not let it be read: through a picture element instead */ }
  return new Promise((done) => {
    const im = new Image();
    im.onload = () => { createImageBitmap(im, size).then(done, () => done(null)); };
    im.onerror = () => done(null);
    im.src = url;
  });
};

/* Pictures decoded for drawing into a canvas, by address, kept a few at a time (the last used last). */
type Pic = { bmp?: ImageBitmap | null; got: Promise<ImageBitmap | null> };
const keepPic = (kept: Map<string, Pic>, url: string, max: number) => {
  let pic = kept.get(url);
  if (pic) kept.delete(url);
  else {
    const fresh: Pic = { got: pixels(url) };
    void fresh.got.then((b) => { fresh.bmp = b; });
    pic = fresh;
  }
  kept.set(url, pic);
  for (const [k, old] of kept) {
    if (kept.size <= max) break;
    kept.delete(k);
    void old.got.then((b) => b?.close());
  }
  return pic;
};

/* A picture drawn to fill a canvas, as object-fit: cover — centred, or kept to the top edge (`top`, as
   object-position: center top) — its corners rounded by `r`. False if there was nothing to draw. The
   canvas is a GPU one, unlike a tile's: a layer of its own whose pixels the GPU keeps while it is
   hidden, so one that comes in is shown, not drawn again (measured: a picture put in a hidden layer at
   rest was still drawn into it at the press that showed it — a hidden layer is not drawn ahead). */
const fillCanvas = (cv: HTMLCanvasElement, bmp: ImageBitmap | null | undefined, w: number, h: number, r = 0, top = false) => {
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  if (!ctx) return false;
  ctx.clearRect(0, 0, w, h);
  if (!bmp?.width) return false;
  const s = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / s;
  const sh = h / s;
  ctx.save();
  if (r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, w, h, r);
    else ctx.rect(0, 0, w, h);
    ctx.clip();
  }
  ctx.drawImage(bmp, (bmp.width - sw) / 2, top ? 0 : (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  ctx.restore();
  return true;
};

/* A wordmark that will not load: the name, as for a title that has none. */
const logoFailed = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = 'none';
  (e.currentTarget.nextElementSibling as HTMLElement).style.display = '';
};

/* A row never re-renders on a press or for its pictures — only when its data changes. A tile is its
 * picture and, on a new title, the pill — laid over it in one grid cell, not positioned, so nothing in
 * the strip is cut out as a layer of its own. The picture's address waits in `data-src`; the page draws
 * it into the tile's canvas once, and only while the remote is still (below). A tile's picture is w500
 * for a tile 384 wide: the edge's w780 WebP cost 4.5x the decoding (837ms against 184ms on a first walk
 * down, measured) for pixels the tile cannot show.
 *   The featured row's posters pass under its card, which stands still on the focus line, on both
 * sides: the titles before it end 32 short of its left edge (the reference shows a sliver of the last
 * one), the titles after it start 32 past its right. That is two copies of the strip, offset by what the
 * card is wider than a poster, moved together — one clipped at the card's left edge, one at its right.
 * The card has no backing of its own: the strips' clips do that — the same to the eye, and nothing
 * black is left to cover the picture top-right when the row is above the focus. The card's three
 * faces (they take turns) are filled in by writeFace, the picture drawn into a canvas, as a tile's is;
 * each half — the picture and the words — is one layer, dimmed through a box of its own, so a dimmed
 * card is never drawn offscreen first. */
const PvRowView = memo(function PvRowView({ row, i, setRowEl }: {
  row: PvRow;
  i: number;
  setRowEl: (i: number, el: HTMLDivElement | null) => void;
}) {
  /* A twin's canvases have no address of their own: the loader draws them from their originals. */
  const strip = (twin = false) => (
    <div className={twin ? 'pv-strip is-twin' : 'pv-strip'}>
      {row.items.map((m) => {
        const tag = badgeOf(m);
        return (
          <div key={m.id} className={row.feat ? 'pv-tile is-poster' : 'pv-tile'}>
            <canvas className="pv-tile-art" data-src={twin ? undefined : tileSrc(row, m)} />
            {tag && <span className="pv-tag">{tag}</span>}
          </div>
        );
      })}
    </div>
  );
  if (!row.feat) {
    return (
      <div className="pv-row" ref={(el) => setRowEl(i, el)}>
        <h2 className="pv-row-title">{row.title}</h2>
        {strip()}
      </div>
    );
  }
  return (
    <div className="pv-row pv-feat" ref={(el) => setRowEl(i, el)}>
      <h2 className="pv-row-title">{row.title}</h2>
      <div className="pv-clip is-left">{strip(true)}</div>
      <div className="pv-clip">{strip()}</div>
      <div className="pv-card">
        {FACES.map((n) => (
          <div key={n} className="pv-dim"><div className="pv-face-art"><canvas className="pv-face-pic" /></div></div>
        ))}
        <div className="pv-card-fade" />
        {FACES.map((n) => (
          <div key={n} className="pv-dim">
            <div className="pv-face-info">
              <img className="pv-logo" alt="" decoding="async" onError={logoFailed} />
              <p className="pv-title" />
              <p className="pv-face-tags">
                <span className="pv-badge" />
                <span className="pv-genre" />
                <span className="pv-age" />
              </p>
              <Check />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default function PrimeTest() {
  const t = useT();
  const { data } = useHome();
  const openModal = useModal((s) => s.open);
  const warm = useWarmDetail();
  const metaOf = useMetaOf();
  const qc = useQueryClient();

  /* The rows are built a frame after the page's first, which is the grey shapes alone (THE PAGE BEFORE
     ITS PICTURES): building twenty rows before it held the switch on black for ~300ms (measured, PC),
     while the shapes glide through the build on the compositor. */
  const [built, setBuilt] = useState(false);
  useEffect(() => {
    let timer = 0;
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => setBuilt(true)); });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, []);

  const rows = useMemo(() => {
    if (!built) return [];
    const list =(cat: string) => (data?.rows?.[cat]?.results ?? []).filter((m) => m.backdrop).slice(0, ROW_CAP);
    const out: PvRow[] = [];
    const push = (key: string, title: string, items: MediaItem[], feat = false) => { if (items.length) out.push({ key, title, items, feat }); };
    push('trending_movie', t('sec.trending_movies'), list('trending_movie'));
    push('featured', t('tv.featured'), list('top_tv').filter((m) => m.poster), true);
    push('top10', 'Top 10', list('trending_tv').slice(0, 10));
    for (const row of HOME_ROWS) {
      if (row.cat === 'trending_movie' || row.cat === 'top_tv' || row.cat === 'trending_tv') continue;
      push(row.cat, t(row.key), list(row.cat));
    }
    return out;
  }, [data?.rows, t, built]);
  /* Where each row starts on the track. */
  const tops = useMemo(() => {
    let y = 0;
    return rows.map((r) => { const top = y; y += TITLE_H + tileH(r) + ROW_GAP; return top; });
  }, [rows]);
  const featAt = useMemo(() => rows.findIndex((r) => r.feat), [rows]);

  const [p] = useState(() => window.innerWidth / 1920);

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const ringRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const rowArtRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const infoRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const setRowEl = useCallback((i: number, el: HTMLDivElement | null) => { rowEls.current[i] = el; }, []);

  const st = useRef({ row: 0, cols: [] as number[] });
  /* What is on screen now, to tell what a press changed. */
  const shown = useRef({ row: -1, col: -1, key: '', item: null as MediaItem | null });
  const timers = useRef({ text: 0, write: 0, rest: 0, artOut: 0, artIn: 0, away: 0, ring: 0, skel: 0 });
  /* Whether the page has shown itself yet (THE PAGE BEFORE ITS PICTURES). */
  const revealed = useRef(false);
  /* Whether the press being applied is a held key's step. */
  const pressHeld = useRef(false);
  /* Where the track stands with row `r` on the focus line. */
  const trackAt = useCallback((r: number) => `translate3d(0, ${Math.round((FOCUS_BOTTOM - (tops[r] + TITLE_H + tileH(rows[r]))) * p)}px, 0)`, [p, rows, tops]);

  /* The next title to write into a hidden panel or card face, and writing it. */
  const pending = useRef<null | (() => void)>(null);
  const fillPending = useCallback(() => {
    const f = pending.current;
    pending.current = null;
    f?.();
  }, []);

  /* ---- THE TITLE PANEL. Text is written straight into its nodes: no render on a press. Two panels
     take turns: while the one on screen fades out, the next title is written into the hidden one, so
     it is drawn before it has to appear. `keys`: the title each holds; `inAt`: when the front one
     comes (or came) in; `hidden`: both are gone (the featured row has the remote). ---- */
  const info = useRef({ front: 0, keys: ['', ''], inAt: 0, hidden: false });
  const writeInfo = useCallback((i: number, m: MediaItem, row: PvRow, col: number) => {
    const el = infoRefs.current[i];
    const key = `${row.key}:${col}`;
    if (!el || info.current.keys[i] === key) return;
    info.current.keys[i] = key;
    const q = (s: string) => el.querySelector<HTMLElement>(s)!;
    const d = metaOf(m);
    const logo = q('.pv-logo') as HTMLImageElement;
    const src = m.titleLogo ? imgW(m.titleLogo, LOGO_W) : '';
    if (!src) logo.removeAttribute('src');
    else if (logo.getAttribute('src') !== src) logo.src = src;
    logo.style.display = src ? '' : 'none';
    q('.pv-title').textContent = m.title ?? '';
    q('.pv-title').style.display = src ? 'none' : '';
    const badge = badgeOf(m, d);
    const callout = row.key === 'top10' ? `#${col + 1} in Top 10` : '';
    q('.pv-badge').textContent = badge;
    q('.pv-badge').style.display = badge ? '' : 'none';
    q('.pv-callout').textContent = callout;
    q('.pv-callout').style.display = callout ? '' : 'none';
    q('.pv-tags').style.display = badge || callout ? '' : 'none';
    q('.pv-genre').textContent = m.genre ?? '';
    q('.pv-year').textContent = m.year ? String(m.year) : '';
    writeLate(el, m, d, false);
    q('.pv-synopsis').textContent = m.overview ?? '';
  }, [metaOf]);

  const fade = (el: HTMLElement | null, to: number, ms: number, delay = 0) => {
    if (!el) return;
    el.style.transition = ms ? `opacity ${ms}ms linear ${delay}ms` : 'none';
    el.style.opacity = String(to);
  };

  /* The key being held, if any (the hold logic below keeps it). */
  const held = useRef({ key: '', lastRepeat: 0, timer: 0 });
  const keyHeld = () => !!held.current.key && performance.now() - held.current.lastRepeat < REPEAT_GONE_MS;

  /* The next title is written WRITE_AT after a tap. `holding`: a hold steps again before the title
     would come in, on either axis, so nothing is written — no text, no wordmark to fetch — until the
     key is let go (onKeyUp), or, on a set that drops the keyup, as the title comes in with no repeat
     saying the key is still down. */
  const writeLater = useCallback((write: () => void, holding: boolean, inAt: number) => {
    const tm = timers.current;
    pending.current = write;
    if (!holding) tm.write = window.setTimeout(fillPending, WRITE_AT);
    else tm.text = window.setTimeout(() => { if (!keyHeld()) fillPending(); }, inAt);
  }, [fillPending]);
  const dropWrites = () => {
    window.clearTimeout(timers.current.text);
    window.clearTimeout(timers.current.write);
    pending.current = null;
  };

  /* `dx, dy`: which way the rows moved (-1 left/up, 1 right/down, per axis). `inAt`: when the new title
     comes in. */
  const infoTo = useCallback((how: 'enter' | 'move', m: MediaItem, row: PvRow, col: number, dx = 0, dy = 0, holding = false, inAt = IN_AT) => {
    const I = info.current;
    const els = infoRefs.current as HTMLDivElement[];
    if (!els[0] || !els[1]) return;
    dropWrites();
    const at = (x: number, y: number) => `translate3d(${x * p}px, ${y * p}px, 0)`;
    const now = performance.now();
    const key = `${row.key}:${col}`;
    let i = I.front;
    if (how === 'enter' || I.hidden) {
      /* Nothing on screen: the panel already holding this title, if either does, comes in. (Out of the
         featured row, both were written at rest with the titles above and below it.) */
      if (I.keys[i] !== key && I.keys[1 - i] === key) i = 1 - i;
    } else if (now >= I.inAt + IN_SEEN_MS) {
      /* The front panel is on screen or coming in: it fades where it is and the other takes over.
         (Before its in, it is still hidden and simply takes the new title instead.) Its slide stays in
         the list, so one still running carries on rather than jumping to its end. */
      const out = els[i];
      out.style.transition = `opacity ${OUT_MS}ms linear ${-OUT_LEAD}ms, transform ${IN_SLIDE_MS}ms ${IN_EASE}`;
      out.style.opacity = '0';
      i = 1 - i;
    }
    const el = els[i];
    I.front = i;
    I.hidden = false;
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.transform = at(-dx * IN_PX_H, -dy * IN_PX_V);
    if (how === 'enter') writeInfo(i, m, row, col);
    /* The starting place is committed first; the in is then set in the same frame as the out, delayed,
       so the gap between them is exact. */
    void getComputedStyle(el).opacity;
    const delay = how === 'enter' ? 0 : inAt;
    el.style.transition = `opacity ${IN_MS}ms linear ${delay}ms, transform ${IN_SLIDE_MS}ms ${IN_EASE} ${delay}ms`;
    el.style.opacity = '1';
    el.style.transform = at(0, 0);
    I.inAt = now + delay;
    if (how === 'move' && I.keys[i] !== key) writeLater(() => writeInfo(i, m, row, col), holding, inAt);
  }, [p, writeInfo, writeLater]);

  /* Into the featured row: the panel is gone at once. */
  const hideInfo = () => {
    dropWrites();
    infoRefs.current.forEach((el) => fade(el, 0, 0));
    info.current.inAt = 0;
    info.current.hidden = true;
  };

  /* ---- THE FEATURED CARD: the focused title of the featured row, in the card on the focus line. Three
     faces take turns: the one on screen, and the titles one press away either side, written into the
     other two while the remote rests — hidden, but drawn, so a tap brings in a face that is already
     there (measured: writing it after the press decoded its picture twice and drew the card again,
     inside the move). Each face is two layers, its picture and its words, moved and faded alike. `outAt`:
     when each last started to go. ---- */
  const face = useRef({ front: 0, keys: ['', '', ''], inAt: 0, outAt: [0, 0, 0] });
  const faceParts = useCallback((i: number) => {
    const card = rowEls.current[featAt];
    const art = card?.querySelectorAll<HTMLElement>('.pv-face-art')[i];
    const words = card?.querySelectorAll<HTMLElement>('.pv-face-info')[i];
    return art && words ? [art, words] as const : null;
  }, [featAt]);

  /* The card's pictures: each fetched and decoded once, off the main thread, then drawn into a face's
     canvas at the card's size (fillCanvas, the GPU scaling it) — never decoded again however often it
     comes back, as a tile's picture is (THE ROWS' PICTURES, below). */
  const cardScale = Math.min(p * SCREEN_PX, CARD_PIC_W / CARD.w);
  const cardPx = useMemo(() => ({ w: Math.round(CARD.w * cardScale), h: Math.round(CARD.h * cardScale) }), [cardScale]);
  const facePics = useRef(new Map<string, Pic>());
  const facePic = useCallback((url: string) => keepPic(facePics.current, url, FACE_PICS_KEPT), []);
  const drawPic = useCallback((cv: HTMLCanvasElement, bmp: ImageBitmap | null | undefined) =>
    fillCanvas(cv, bmp, cardPx.w, cardPx.h, CARD.r * cardScale), [cardPx, cardScale]);

  const writeFace = useCallback((i: number, m: MediaItem, row: PvRow, col: number) => {
    const parts = faceParts(i);
    const key = `${row.key}:${col}`;
    if (!parts || face.current.keys[i] === key) return;
    face.current.keys[i] = key;
    const [art, words] = parts;
    const q = (s: string) => words.querySelector<HTMLElement>(s)!;
    const d = metaOf(m);
    const logo = q('.pv-logo') as HTMLImageElement;
    const src = m.titleLogo ? imgW(m.titleLogo, LOGO_W) : '';
    if (!src) logo.removeAttribute('src');
    else if (logo.getAttribute('src') !== src) logo.src = src;
    logo.style.display = src ? '' : 'none';
    q('.pv-title').textContent = m.title ?? '';
    q('.pv-title').style.display = src ? 'none' : '';
    const badge = badgeOf(m, d);
    q('.pv-badge').textContent = badge;
    q('.pv-badge').style.display = badge ? '' : 'none';
    q('.pv-genre').textContent = m.genre ?? '';
    writeLate(words, m, d, false);
    /* The picture is drawn at once if its pixels are here; otherwise once they are, and one that comes
       after the face has, fades in. */
    const cv = art.querySelector('canvas')!;
    const url = bgSrc(m);
    const pic = facePic(url);
    cv.classList.remove('is-late');
    cv.dataset.want = url;
    if (pic.bmp !== undefined) { drawPic(cv, pic.bmp); cv.dataset.on = url; return; }
    drawPic(cv, null);
    delete cv.dataset.on;
    void pic.got.then((bmp) => {
      if (cv.dataset.want !== url) return;
      drawPic(cv, bmp);
      cv.dataset.on = url;
      const F = face.current;
      if (F.front === i && performance.now() > F.inAt) cv.classList.add('is-late');
    });
  }, [metaOf, faceParts, facePic, drawPic]);

  const faceTo = useCallback((how: 'enter' | 'move', m: MediaItem, row: PvRow, col: number, dx = 0, holding = false) => {
    const F = face.current;
    if (!FACES.every((n) => faceParts(n))) return;
    dropWrites();
    const at = (x: number) => `translate3d(${x * p}px, 0, 0)`;
    const now = performance.now();
    const key = `${row.key}:${col}`;
    let i = F.front;
    /* The faces not on screen; one that has gone, holding this title (written at rest), is ready. */
    const others = FACES.filter((n) => n !== i);
    const gone = (n: number) => now >= F.outAt[n] + FACE_OUT_MS;
    const ready = others.find((n) => F.keys[n] === key && gone(n));
    if (how === 'enter') {
      if (ready !== undefined) i = ready;
    } else if (now >= F.inAt + IN_SEEN_MS) {
      for (const el of faceParts(i)!) {
        el.style.transition = `opacity ${FACE_OUT_MS}ms linear, transform ${FACE_OUT_SLIDE_MS}ms linear`;
        el.style.opacity = '0';
        el.style.transform = at(dx * FACE_OUT_PX);
      }
      F.outAt[i] = now;
      i = ready ?? others.find(gone) ?? others[0];
    } else if (ready !== undefined) {
      /* The front face has not come in yet — all but invisible — and a face that has the title takes over. */
      for (const el of faceParts(i)!) { el.style.transition = 'none'; el.style.opacity = '0'; }
      i = ready;
    }
    F.front = i;
    const [art, words] = faceParts(i)!;
    for (const [el, px] of [[art, FACE_PX_ART], [words, FACE_PX_INFO]] as const) {
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = at(-dx * px);
    }
    if (how === 'enter') writeFace(i, m, row, col);
    void getComputedStyle(words).opacity;
    const delay = how === 'enter' ? 0 : FACE_IN_AT;
    for (const el of [art, words]) {
      el.style.transition = `opacity ${IN_MS}ms linear ${delay}ms, transform ${IN_SLIDE_MS}ms ${IN_EASE} ${delay}ms`;
      el.style.opacity = '1';
      el.style.transform = at(0);
    }
    F.inAt = now + delay;
    if (how === 'move' && F.keys[i] !== key) writeLater(() => writeFace(i, m, row, col), holding, FACE_IN_AT);
  }, [p, faceParts, writeFace, writeLater]);

  /* The runtime and age rating of the title on screen, when its detail lands after it was written. */
  useEffect(() => qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || e.query.queryKey[0] !== 'meta') return;
    const { item, key, row } = shown.current;
    if (!item) return;
    const onCard = row === featAt;
    const A = onCard ? face.current : info.current;
    const el = onCard ? faceParts(A.front)?.[1] : infoRefs.current[A.front];
    if (!el || A.keys[A.front] !== key) return;
    const d = metaOf(item);
    if (d) writeLate(el, item, d, true);
  }), [qc, metaOf, featAt, faceParts]);

  /* Wordmarks for the titles one press away, fetched and decoded at rest. */
  const logosKept = useRef(new Map<string, HTMLImageElement>());
  const keep = (kept: Map<string, HTMLImageElement>, url: string, max: number) => {
    if (kept.has(url)) return;
    const im = new Image();
    im.src = url;
    im.decode().catch(() => { /* the panel copes */ });
    kept.set(url, im);
    if (kept.size > max) kept.delete(kept.keys().next().value!);
  };

  /* ---- THE BACKGROUND PICTURE: the focused title's, in the box top-right. Two boxes take turns.
     `outAt`: how soon the one on screen starts to go, `outMs` its fade; `rest`: how long the remote must
     be still before the next comes in; `inMs`: its fade, `inBy` the earliest that may start (a
     performance.now() time). The next may come in while the last is still going — the two cross.
     `goneAt`: when each box's last fade out ends. Each box is a GPU canvas (fillCanvas), its picture
     decoded once off the main thread and drawn in; the fade over them is one layer for
     both (prime.css), drawn once. ---- */
  const art = useRef({ shown: '', layer: 1, visible: false, token: 0, lastChange: 0, goneAt: [0, 0] });
  const artPx = useMemo(() => ({ w: Math.round(ART.w * p * SCREEN_PX), h: Math.round(ART.h * p * SCREEN_PX) }), [p]);
  const artPics = useRef(new Map<string, Pic>());
  const artPic = useCallback((url: string) => keepPic(artPics.current, url, ART_PICS_KEPT), []);
  const artTo = useCallback((want: string, { outAt = ART_OUT_AT, outMs = ART_OUT_MS, rest = ART_REST_MS, inMs = ART_IN_MS, inBy = 0 } = {}) => {
    const a = art.current;
    const tm = timers.current;
    a.token += 1;
    a.lastChange = performance.now();
    window.clearTimeout(tm.artIn);
    if (a.visible && a.shown === want) {
      if (tm.artOut) { window.clearTimeout(tm.artOut); tm.artOut = 0; fade(rowArtRefs.current[a.layer], 1, 0); }
      return;
    }
    if (a.visible && !tm.artOut) {
      /* The fade is set now, delayed, so it starts on time whatever the main thread is doing; the timer
         only marks it gone. */
      fade(rowArtRefs.current[a.layer], 0, outMs, outAt);
      a.goneAt[a.layer] = a.lastChange + outAt + outMs;
      const out = () => { tm.artOut = 0; a.visible = false; };
      if (outAt) tm.artOut = window.setTimeout(out, outAt);
      else out();
    }
    if (!want) return;
    const token = a.token;
    const tryIn = () => {
      if (token !== a.token) return;
      const now = performance.now();
      const ready = a.visible || tm.artOut ? Infinity : a.lastChange + rest;
      if (now < ready) { tm.artIn = window.setTimeout(tryIn, ready === Infinity ? 50 : ready - now); return; }
      const cvs = rowArtRefs.current.map((b) => b?.querySelector('canvas'));
      /* A box that has gone and already holds it (out of the featured row, drawn at rest: holdArt) shows
         it as it is. */
      const held = [0, 1].find((n) => now >= a.goneAt[n] && cvs[n]?.dataset.on === want);
      const next = held ?? 1 - a.layer;
      const box = rowArtRefs.current[next];
      const cv = cvs[next];
      if (!box || !cv) return;
      /* Drawn all but invisible for two frames before the fade starts: a picture's first frame on screen
         can take a few (its upload), and the fade would start that far along. The wait is the fade's
         delay — on the compositor, no frames of the main thread's. A cut is a 1ms fade. */
      const show = () => {
        fade(box, ART_PRIMED, 0);
        void getComputedStyle(box).opacity;
        fade(box, 1, Math.max(inMs, 1), Math.max(inBy - performance.now(), ART_PRIME_MS));
        a.shown = want; a.layer = next; a.visible = true;
      };
      if (held !== undefined) { show(); return; }
      /* Otherwise decoded (once, off the main thread) and drawn into the box first. */
      const pic = artPic(want);
      cv.dataset.want = want;
      delete cv.dataset.on;
      const put = (bmp: ImageBitmap | null | undefined) => {
        fillCanvas(cv, bmp, artPx.w, artPx.h, 0, true);
        cv.dataset.on = want;
        show();
      };
      if (pic.bmp !== undefined) put(pic.bmp);
      else void pic.got.then((bmp) => { if (token === a.token) put(bmp); });
    };
    tryIn();
  }, [artPic, artPx]);
  /* On the featured row the picture top-right is gone, and the boxes take, hidden, the pictures that come
     back out of it, up and down: whichever it is is then cut in drawn already, with nothing decoded or
     drawn inside the move (measured: decoded twice, ~10ms each on the PC at 4x, and drawn, as the rows
     moved). */
  const holdArt = useCallback((urls: string[]) => {
    const a = art.current;
    const now = performance.now();
    if (a.visible || timers.current.artOut) return;
    const cvs = rowArtRefs.current.map((b) => b?.querySelector('canvas'));
    const free = [0, 1].filter((n) => now >= a.goneAt[n] && !urls.includes(cvs[n]?.dataset.want ?? ''));
    for (const url of urls) {
      if (cvs.some((cv) => cv?.dataset.want === url)) continue;
      const n = free.shift();
      const cv = n === undefined ? null : cvs[n];
      if (!cv) continue;
      cv.dataset.want = url;
      delete cv.dataset.on;
      void artPic(url).got.then((bmp) => {
        if (cv.dataset.want !== url) return;
        fillCanvas(cv, bmp, artPx.w, artPx.h, 0, true);
        cv.dataset.on = url;
      });
    }
  }, [artPic, artPx]);

  /* "Gone" is all but nothing, not nothing: a layer at 0 is not drawn, and its drawing is thrown away —
     the left strip was drawn again, twice, on every Right press (measured). */
  const sliverBack = (el: HTMLElement | null | undefined) => {
    if (!el) return;
    el.style.transition = 'none';
    el.style.opacity = String(SLIVER_GONE);
    void getComputedStyle(el).opacity;
    /* 1ms, not 0s: a zero-length transition runs on the main thread, a frame of its every 16ms. */
    el.style.transition = `opacity 1ms linear ${SLIVER_BACK_AT}ms`;
    el.style.opacity = '';
  };

  /* ---- THE RING: the tile's or the featured card's — two, each drawn once, the other hidden (one box
     resized drew itself again on the press into or out of the card). ---- */
  const ringBig = useRef<boolean | null>(null);
  const ringTo = (big: boolean) => {
    const [off, on] = big ? ringRefs.current : [...ringRefs.current].reverse();
    if (!on || !off || ringBig.current === big) return;
    const first = ringBig.current === null;
    ringBig.current = big;
    off.classList.add('is-off');
    on.classList.remove('is-off');
    if (first) return;
    off.style.transition = 'none';
    on.style.transition = 'none';
    on.style.opacity = '0';
    void getComputedStyle(on).opacity;
    on.style.transition = `opacity ${RING_IN_MS}ms ${RING_EASE} ${RING_IN_AT}ms`;
    on.style.opacity = '';
    window.clearTimeout(timers.current.ring);
    timers.current.ring = window.setTimeout(() => { on.style.transition = ''; off.style.transition = ''; }, RING_IN_AT + RING_IN_MS);
  };

  /* ONE PRESS = THIS. Works out what changed and writes only that. */
  const apply = useCallback(() => {
    const s = st.current;
    const was = shown.current;
    const root = rootRef.current;
    const track = trackRef.current;
    if (!root || !track || !rows.length) return;
    window.clearTimeout(timers.current.away);
    root.classList.remove('is-away');
    const row = rows[s.row];
    const col = s.cols[s.row] ?? 0;
    const item = row.items[col];
    const feat = s.row === featAt;
    const wasFeat = was.row === featAt;

    document.body.classList.toggle('pv-deep', s.row > 0);
    track.style.transform = trackAt(s.row);
    rowEls.current.forEach((el, i) => {
      if (!el) return;
      /* Over the featured card there is no panel: the row above it stays, at half. */
      const above = feat && i === s.row - 1;
      el.classList.toggle('is-gone', i < s.row && !above);
      el.classList.toggle('is-dim', i > s.row || above);
    });
    rowEls.current[s.row]?.querySelectorAll<HTMLElement>('.pv-strip').forEach((strip) => {
      strip.style.transform = `translate3d(${-Math.round(col * TILE.pitch * p)}px, 0, 0)`;
    });
    ringTo(feat);

    if (s.row !== was.row || col !== was.col) {
      /* The rows move against the press: Right slides them left, Down slides them up. */
      const dy = s.row > was.row ? -1 : 1;
      const dx = col > was.col ? -1 : 1;
      if (was.row < 0) {
        if (featAt >= 0) faceTo('enter', rows[featAt].items[s.cols[featAt] ?? 0], rows[featAt], s.cols[featAt] ?? 0);
        if (!feat) {
          infoTo('enter', item, row, col, 0, -1);
          /* Before the page shows itself, its picture waits to come with it (reveal). */
          if (revealed.current) artTo(bgSrc(item));
        }
      } else if (feat && s.row === was.row) {
        faceTo('move', item, row, col, dx, pressHeld.current);
        if (dx < 0) sliverBack(rowEls.current[s.row]?.querySelector<HTMLElement>('.pv-clip.is-left'));
      } else if (feat) { hideInfo(); artTo('', { outAt: 0, outMs: ART_GONE_MS }); }
      else {
        /* Out of the featured row on a tap, the panel and picture come at once; a hold carries on as
           any hold does, so nothing comes, or is decoded, between its steps. */
        const fromFeat = wasFeat && !pressHeld.current;
        if (s.row !== was.row) infoTo('move', item, row, col, 0, dy, pressHeld.current, fromFeat ? IN_AT_FROM_FEAT : IN_AT);
        else infoTo('move', item, row, col, dx, 0, pressHeld.current);
        artTo(bgSrc(item), fromFeat ? { rest: ART_REST_FROM_FEAT, inMs: 0 } : undefined);
      }
    }
    shown.current = { row: s.row, col, key: `${row.key}:${col}`, item };

    /* Once everything has stopped moving, the title the remote rests on gets its title screen ready
       (detail, backdrop, wordmark) — so OK opens it at once, on the picture already here — and the
       wordmarks one press away are fetched, so the next panel comes in with its own. On the featured
       card the faces one press away come first, on their own (the likeliest next press's). */
    const rest = () => {
      warm(item, undefined, () => shown.current.item === item);
      const near: [number, number][] = [[s.row, col + 1], [s.row, col - 1], [s.row + 1, s.cols[s.row + 1] ?? 0], [s.row - 1, s.cols[s.row - 1] ?? 0]];
      for (const [r, c] of near) {
        const m = rows[r]?.items[c];
        if (m?.titleLogo) keep(logosKept.current, imgW(m.titleLogo, LOGO_W), LOGOS_KEPT);
      }
      /* On the featured row both panels are hidden: each takes a title one press away, above and below —
         and the boxes top-right their pictures. */
      if (feat) {
        const out: string[] = [];
        for (const [r, n] of [[s.row - 1, 0], [s.row + 1, 1]]) {
          const R = rows[r];
          if (!R) continue;
          writeInfo(n, R.items[s.cols[r] ?? 0], R, s.cols[r] ?? 0);
          out.push(bgSrc(R.items[s.cols[r] ?? 0]));
        }
        holdArt(out);
      }
    };
    window.clearTimeout(timers.current.rest);
    timers.current.rest = window.setTimeout(() => {
      if (!feat) { rest(); return; }
      /* The two faces not on screen take the titles either side, unless they hold them already; the
         pictures two presses away are decoded too, so a quick second tap draws its face from them. */
      const F = face.current;
      const spare = FACES.filter((n) => n !== F.front);
      const near = [col + 1, col - 1].filter((c) => row.items[c]);
      const keyAt = (c: number) => `${row.key}:${c}`;
      for (const c of near) {
        if (spare.some((n) => F.keys[n] === keyAt(c))) continue;
        const n = spare.find((j) => !near.some((c2) => F.keys[j] === keyAt(c2)));
        if (n !== undefined) writeFace(n, row.items[c], row, c);
      }
      for (const c of [col + 2, col - 2]) if (row.items[c]) facePic(bgSrc(row.items[c]));
      timers.current.rest = window.setTimeout(rest, REST_NEXT_MS);
    }, SETTLE_MS);
  }, [rows, featAt, p, trackAt, infoTo, writeInfo, faceTo, writeFace, facePic, artTo, holdArt, warm]);

  useLayoutEffect(() => { apply(); }, [apply]);
  useEffect(() => {
    document.body.classList.add('pv-page');
    const tm = timers.current;
    return () => {
      document.body.classList.remove('pv-page', 'pv-deep');
      Object.values(tm).forEach((id) => window.clearTimeout(id));
    };
  }, []);

  /* ---- THE ROWS' PICTURES ARRIVE ONLY WHILE THE REMOTE IS STILL ----
     A picture arriving costs its strip a paint, a decode and a raster. They used to be put on whole
     rows at once the moment the remote rested, so a run to the bottom set off two hundred of them, and
     they landed in the run back up (measured: ~210 decodes, ~730ms of decoding and a 44ms main-thread
     task inside that move; now none, and 3ms). Nothing is fetched or put on a tile while anything
     moves. Once the remote has been still SETTLE_MS they come nearest first — what is on screen at the
     focus, then the rows below and above, then further along — a few at a time, each tile taking its
     picture only once it is decoded, checking in between that the remote is still still. A press stops
     it where it is and the next rest picks it up; a run past rows that have no pictures yet shows their
     empty tiles, as the reference does.
     DECODED ONCE, AND KEPT. An <img> leaves its decoded pixels to the browser, which keeps them in a
     cache with a budget: on a TV-sized one (PC at --force-gpu-mem-discardable-limit-mb=16) the second
     walk down decoded 42 of the first walk's 78 pictures again. A tile holds its own pixels instead: the
     picture is decoded off the main thread at the tile's size (createImageBitmap) and drawn into its
     canvas once — after that the browser only ever copies it to the screen, never decodes it again
     (the user's call, Oct 29: once a picture is here it costs nothing). The canvas is CPU-backed
     (`willReadFrequently`), so it is painted into its strip's layer as the picture was, not made a GPU
     layer of its own. That holds ~330KB per tile at 1080p (~880KB per poster, twice over for the
     featured row's two strips), ~140MB for the page while it is open. */
  useEffect(() => {
    if (!rows.length) return;
    let dead = false;
    let running = false;
    let cancel = () => {};
    /* Decoded, but a press came before it could be drawn: drawn at the next rest. */
    const ready = new Map<HTMLCanvasElement, { url: string; bmp: ImageBitmap | null }>();
    const still = () => !dead && quietFor() >= SETTLE_MS;
    /* The featured row's left strip shows the same posters: each is copied from its original as that
       one is drawn, never fetched or decoded again. */
    const twins = new Map<HTMLCanvasElement, HTMLCanvasElement>();
    rowEls.current.forEach((el) => {
      const copies = el?.querySelectorAll<HTMLCanvasElement>('.pv-strip.is-twin .pv-tile-art');
      el?.querySelectorAll<HTMLCanvasElement>('.pv-strip:not(.is-twin) .pv-tile-art').forEach((cv, c) => {
        if (copies?.[c]) twins.set(cv, copies[c]);
      });
    });
    const draw =(cv: HTMLCanvasElement) => {
      const got = ready.get(cv);
      ready.delete(cv);
      if (!got || got.url !== cv.dataset.src) { got?.bmp?.close(); return; }
      cv.dataset.on = got.url;
      if (!got.bmp) return;
      cv.width = got.bmp.width;
      cv.height = got.bmp.height;
      cv.getContext('2d', { willReadFrequently: true })?.drawImage(got.bmp, 0, 0);
      got.bmp.close();
      const twin = twins.get(cv);
      if (twin) {
        twin.width = cv.width;
        twin.height = cv.height;
        twin.getContext('2d', { willReadFrequently: true })?.drawImage(cv, 0, 0);
      }
    };
    /* The tiles still without their picture, in groups of PICS_AT_ONCE, nearest first: a group is
       `d` rows from the focus (below before above) and `k` screenfuls along its row from where that
       row's focus is. Each comes with the size its canvas is drawn at: the tile in real screen pixels,
       never more than the w500 picture has. */
    const scale = Math.min(p * SCREEN_PX, PIC_W / TILE.w);
    const w = Math.round(TILE.w * scale);
    const plan = () => {
      const s = st.current;
      const groups: { at: number; d: number; k: number; tiles: { cv: HTMLCanvasElement; w: number; h: number }[] }[] = [];
      rows.forEach((row, r) => {
        const tiles = rowEls.current[r]?.querySelectorAll<HTMLCanvasElement>('.pv-strip:not(.is-twin) .pv-tile-art');
        if (!tiles) return;
        const h = Math.round(tileH(row) * scale);
        const col = s.cols[r] ?? 0;
        const d = r >= s.row ? r - s.row : s.row - r + 0.5;
        const byK = new Map<number, { cv: HTMLCanvasElement; w: number; h: number }[]>();
        tiles.forEach((cv, c) => {
          if (!cv.dataset.src || cv.dataset.on === cv.dataset.src) return;
          const off = c < col ? col - c : Math.max(0, c - col - (PICS_AT_ONCE - 1));
          const k = Math.ceil(off / PICS_AT_ONCE);
          byK.set(k, [...(byK.get(k) ?? []), { cv, w, h }]);
        });
        byK.forEach((tl, k) => groups.push({ at: d + k, d, k, tiles: tl }));
      });
      /* At the same distance, what is on screen first: the row below's tiles before the focused row's
         next screenful — the first screen is whole a group sooner (the page shows itself with it). */
      return groups.sort((a, b) => a.at - b.at || a.k - b.k || a.d - b.d).map((gr) => gr.tiles);
    };
    const pump = async () => {
      if (running) return;
      running = true;
      for (const tiles of plan()) {
        await Promise.all(tiles.filter((tl) => !ready.has(tl.cv)).map(async ({ cv, w: tw, h: th }) => {
          const url = cv.dataset.src!;
          const bmp = await pixels(url, tw, th);
          if (dead) bmp?.close(); else ready.set(cv, { url, bmp });
        }));
        if (!still()) break;
        tiles.forEach((tl) => draw(tl.cv));
      }
      running = false;
      if (!dead && plan().length) arm();
    };
    const arm = () => { cancel(); cancel = whenQuiet(() => { void pump(); }, SETTLE_MS, true); };
    arm();
    return () => {
      dead = true;
      cancel();
      ready.forEach((got) => got.bmp?.close());
    };
  }, [rows, p]);

  /* ---- THE PAGE BEFORE ITS PICTURES (SKELETON above) ----
     The page is there from its first frame but hidden (prime.css `.pv-show`, kept rastered) under its
     grey shapes, the remote still in the bar. It shows itself — `is-shown` on the root: the shapes fade,
     the page fades in — once its first screen is whole: the first screen's tiles drawn (the loader puts
     them on as ever, a group at a time), the front panel's wordmark, the featured card's picture and
     wordmark when that row is on screen, the picture top-right decoded (it then comes a little after
     the rest, as the reference's does). At once if the remote comes down into the page first. */
  const skelRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const reveal = useCallback(() => {
    const root = rootRef.current;
    if (revealed.current || !root) return;
    revealed.current = true;
    root.classList.add('is-shown');
    const s = st.current;
    const row = rows[s.row];
    const item = row?.items[s.cols[s.row] ?? 0];
    if (item && !row.feat) artTo(bgSrc(item), { rest: 0, inMs: ART_REVEAL_MS, inBy: performance.now() + ART_AT_REVEAL });
    timers.current.skel = window.setTimeout(() => { if (skelRef.current) skelRef.current.style.display = 'none'; }, SKEL_OUT_MS);
  }, [rows, artTo]);

  /* Switched to along the bar, the shapes glide in from the side the page comes from. */
  useLayoutEffect(() => {
    openedAt.current = performance.now();
    const dir = takeArrival('/prime');
    const glide = skelRef.current?.firstElementChild;
    if (!dir || !glide) return;
    glide.animate([{ transform: `translate3d(${dir * SKEL_SHIFT * p}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: SKEL_GLIDE_MS, delay: SKEL_GLIDE_AT, easing: SKEL_GLIDE_EASE, fill: 'backwards' });
  }, [p]);

  useEffect(() => {
    if (!rows.length || revealed.current) return;
    let timer = 0;
    const from = performance.now();
    const s = st.current;
    const row = rows[s.row];
    let picIn = !!row.feat;
    if (!row.feat) void artPic(bgSrc(row.items[s.cols[s.row] ?? 0])).got.then(() => { picIn = true; });
    const whole = () => {
      const drawn = [0, 1].every((r) => {
        const R = rows[r];
        const cvs = R && rowEls.current[r]?.querySelectorAll<HTMLCanvasElement>('.pv-strip:not(.is-twin) .pv-tile-art');
        return !cvs || [...cvs].every((cv, c) => !onFirstScreen(R, c) || cv.dataset.on === cv.dataset.src);
      });
      const F = featAt >= 0 && featAt <= 1 ? faceParts(face.current.front) : null;
      const card = F?.[0].querySelector('canvas');
      const imgs = [infoRefs.current[info.current.front]?.querySelector('img'), F?.[1].querySelector('img')];
      return drawn && picIn && (!card?.dataset.want || card.dataset.on === card.dataset.want)
        && imgs.every((im) => !im || !im.getAttribute('src') || im.complete);
    };
    const check = () => {
      const now = performance.now();
      const early = openedAt.current + SKEL_MIN_MS - now;
      if (now - from >= SKEL_MAX_MS || (early <= 0 && whole())) { reveal(); return; }
      timer = window.setTimeout(check, Math.max(SKEL_POLL_MS, early));
    };
    check();
    return () => window.clearTimeout(timer);
  }, [rows, featAt, faceParts, reveal, artPic]);

  /* Switched away along the bar: the rows (the shapes, if the page has not shown itself yet) slide off
     the way the pages go and fade, the picture fades faster, the panel stays — and the page is cut
     PAGE_EXIT.cutMs in (lib/tvPageSlide.ts). Each from where it is now. */
  useEffect(() => {
    registerPageExit((dir) => {
      const own = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '1px 0px');
      const going = revealed.current ? trackRef.current : skelRef.current?.firstElementChild;
      going?.animate([own ? { translate: `${-dir * PAGE_EXIT.px * p}px 0px`, opacity: 0 } : { opacity: 0 }],
        { duration: PAGE_EXIT.ms, easing: PAGE_EXIT.ease, fill: 'forwards' });
      rowArtRefs.current.forEach((el) => el?.animate([{ opacity: 0 }], { duration: EXIT_ART_MS, easing: 'linear', fill: 'forwards' }));
      return PAGE_EXIT.cutMs;
    });
    return () => registerPageExit(null);
  }, [p]);

  /* Down from the bar lands on the page root, which holds focus for the whole page. */
  useEffect(() => setPageEntry(() => rootRef.current), []);

  /* Back goes to the bar — from further down, by way of the top (above) — not while a title or the
   * player is open over the page, whose own Back comes first. */
  useEffect(() => registerBackHandler(() => {
    if (useModal.getState().target || usePlayer.getState().source) return false;
    const root = rootRef.current;
    const track = trackRef.current;
    if (!root || !track || document.activeElement !== root) return false;
    const s = st.current;
    if (s.row > 0) {
      root.classList.add('is-away');
      track.style.transition = 'none';
      track.style.transform = trackAt(1);
      void track.offsetHeight;
      track.style.transition = '';
      s.row = 0;
      window.clearTimeout(timers.current.away);
      timers.current.away = window.setTimeout(apply, AWAY_MS);
    }
    /* The bar comes back with the remote in it — after the layout forced above, so it takes the quick
       fade the bar has while it holds the remote, not the late one of a move up. */
    barItemHere()?.focus({ preventScroll: true });
    document.body.classList.remove('pv-deep');
    return true;
  }, 100), [apply, trackAt]);

  /* ---- ONE STEP OF THE REMOTE ---- */
  const lastStep = useRef(0);
  const step = (dir: 'up' | 'down' | 'left' | 'right', held = false) => {
    const s = st.current;
    const col = s.cols[s.row] ?? 0;
    if (dir === 'up') {
      /* Up off the first row goes to the bar — on a tap; a held Up stops there. */
      if (s.row === 0) { if (!held) barItemHere()?.focus({ preventScroll: true }); return; }
      s.row -= 1;
    } else if (dir === 'down') {
      if (s.row < rows.length - 1) s.row += 1; else return;
    } else if (dir === 'left') {
      if (col === 0) return;
      s.cols[s.row] = col - 1;
    } else if (col < rows[s.row].items.length - 1) s.cols[s.row] = col + 1;
    else return;
    lastStep.current = performance.now();
    pressHeld.current = held;
    apply();
  };

  /* A TAP STEPS AT ONCE; A HOLD STEPS EVERY HOLD_MS. A tap during a move retargets it, and so does each
   * step of a hold, as the reference does: a held key does not step on every repeat, but every ~210ms,
   * each step re-aiming the 380ms move still running — so a held press is one quickening glide. */
  const chain = () => {
    const h = held.current;
    h.timer = 0;
    if (!h.key || performance.now() - h.lastRepeat > REPEAT_GONE_MS) return;
    step(DIRS[h.key], true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const s = st.current;
    const dir = DIRS[e.key];
    if (!dir && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!rows.length) return;
    if (e.key === 'Enter') {
      openModal(openItem(rows[s.row].items[s.cols[s.row] ?? 0]));
      return;
    }
    const h = held.current;
    const now = performance.now();
    if (!e.repeat && h.key !== e.key) {
      window.clearTimeout(h.timer);
      h.timer = 0;
      h.key = e.key;
      h.lastRepeat = now;
      step(dir);
      return;
    }
    h.key = e.key;
    h.lastRepeat = now;
    const left = HOLD_MS - (now - lastStep.current);
    if (left <= 0) step(dir, true);
    else if (!h.timer) h.timer = window.setTimeout(chain, left);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const h = held.current;
    if (e.key !== h.key) return;
    h.key = '';
    window.clearTimeout(h.timer);
    h.timer = 0;
    fillPending();
  };

  return (
    <div
      ref={rootRef}
      className="pv"
      tabIndex={-1}
      style={{ ['--p' as string]: `${p}px` }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={() => { reveal(); apply(); }}
    >
      <div className="pv-show">
        {/* THE BACKGROUND: two boxes top-right that the focused title's picture alternates between. */}
        {[0, 1].map((i) => (
          <div key={i} className="pv-row-art" ref={(el) => { rowArtRefs.current[i] = el; }}>
            <canvas />
          </div>
        ))}
        <div className="pv-art-fade" />

        {/* THE FOCUSED TITLE'S PANEL, twice (they take turns) — bottom-anchored, filled in by writeInfo. */}
        {[0, 1].map((n) => (
          <div key={n} className="pv-info" ref={(el) => { infoRefs.current[n] = el; }}>
            <img className="pv-logo" alt="" decoding="async" onError={logoFailed} />
            <p className="pv-title" />
            <p className="pv-tags"><span className="pv-badge" /><span className="pv-callout" /></p>
            <p className="pv-meta">
              <span className="pv-genre" />
              <span className="pv-year" />
              <span className="pv-run" />
              <span className="pv-age" />
            </p>
            <p className="pv-synopsis" />
            <Check />
          </div>
        ))}

        <div className="pv-track" ref={trackRef}>
          {rows.map((r, i) => <PvRowView key={r.key} row={r} i={i} setRowEl={setRowEl} />)}
        </div>

        {/* The focus ring stands still: the focused tile, or the featured card, is always pinned under it. */}
        <div className="pv-ring" ref={(el) => { ringRefs.current[0] = el; }} />
        <div className="pv-ring is-big is-off" ref={(el) => { ringRefs.current[1] = el; }} />
      </div>

      {/* THE PAGE BEFORE ITS PICTURES: grey shapes over it until it shows itself. */}
      <div className="pv-skel" ref={skelRef} aria-hidden="true">
        <div className="pv-skel-glide">
          {SKELETON.map(([x, y, w, h, r], i) => (
            <div
              key={i}
              className="pv-sk"
              style={{ left: `calc(${x} * var(--p))`, top: `calc(${y} * var(--p))`, width: `calc(${w} * var(--p))`, height: `calc(${h} * var(--p))`, borderRadius: `calc(${r} * var(--p))` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
