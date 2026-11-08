import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQueryClient, useQueries } from '@tanstack/react-query';
import { useHome, useMetaOf, useWarmDetail, useImdbTrailer } from '../lib/queries';
import { useVideoTrailer } from '../components/DetailModal/useVideoTrailer';
import { useSettings } from '../stores/settings';
import { useT, useLang, useGenre } from '../i18n/i18n';
import { HOME_ROWS, PROVIDER_CATS } from '../lib/home';
import { api } from '../lib/api';
import { gridUrl } from '../lib/grid';
import { imgW } from '../lib/img';
import { barItemHere, openRail, setPageEntry, setPageToBar } from '../lib/tvBar';
import { bootRowsStaged } from '../lib/bootGate';
import { registerBackHandler } from '../lib/tvKeys';
import { PAGE_EXIT, registerPageExit, takeArrival } from '../lib/tvPageSlide';
import { quietFor, whenQuiet } from '../lib/tvQuiet';
import { useModal, openItem, type PvHead } from '../stores/modal';
import { useContinueItems, useMyListItems, entryTarget } from '../lib/continueItems';
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

/* `resume`: Continue Watching's watched fraction per item (0-1), drawn as a bar on the tile. */
type PvRow = { key: string; title: string; items: MediaItem[]; feat?: boolean; resume?: number[] };

/* x is where the focused tile starts. */
const TILE = { w: 384, h: 216, pitch: 416, x: 144 };
/* The featured row's posters (TILE wide) and its card are this tall; prime.css places them. */
const POSTER_H = 576;
const TITLE_H = 45;
/* Between one row's tiles and the next row's title. */
const ROW_GAP = 21;
const FOCUS_BOTTOM = 828;
/* Items kept per row. 14 (was 20): each row's `.pv-strip` is a promoted compositor layer as wide as its
   tiles, and on a weak TV GPU the full set of full-width strips exceeds GPU memory and gets evicted then
   re-uploaded mid-move — dropped frames a desktop can't reproduce. 14 tiles ~= 5936px strips (~30% less
   backing per row) and still well above MIN_ROW (8). Raise toward 20 if a stronger set wants deeper rows. */
const ROW_CAP = 14;
/* THE PAGE IS MOUNTED A FEW ROWS AT A TIME, not all in one commit (see the build effect below). The full
   row list is known at once; only how many rows are in the DOM grows. BUILD_FIRST is the first screen's
   rows, mounted together so the reveal never shows the page a row short (it checks rows 0 and 1); then
   BUILD_STEP more each frame to the end. Kept small so no single commit holds the main thread past a
   frame too long — building all ~270 tiles at once was one long task (~300ms on a PC, far more on a TV):
   a freeze at the instant the tab opens, with the remote dead through it. Spread this way it is a handful
   of short commits instead (measured ~90ms worst against ~480ms), the remote answers between them, and
   the grey shapes glide over all of it on the compositor — so the entrance stays smooth. */
const BUILD_FIRST = 2;
const BUILD_STEP = 2;

/* A row has to carry at least this many titles to earn a place on a single-kind tab. The provider
   rows (Netflix, Disney+ …) are mixed movie+series feeds; once a Movies/Series tab keeps only its
   own kind, some shrink to two or three tiles, which reads as broken — those are dropped. */
const MIN_ROW = 8;
/* GENRE ROWS — what gives the single-kind tabs their body past the handful of home feeds. One
   /api/catalog request per name (OR'd on the server for the mixed kinds). The names are TMDB's
   MOVIE genre labels on purpose: the server maps each onto the right TV bucket for type=tv
   (Action → Action & Adventure, Science Fiction → Sci-Fi & Fantasy — see TV_GENRE_ALIASES), so the
   same list drives both tabs. The Movies tab leans on these hardest — its provider rows almost all
   fall below MIN_ROW once trimmed to films, so the genre rows ARE its body; the Series tab keeps
   full provider rows, so it takes a shorter list (and one that avoids the pairs that would collide
   onto one TV bucket — no Action+Adventure, no Science Fiction+Fantasy together). */
const GENRE_ROWS: Record<'movie' | 'series', string[]> = {
  movie: ['Action', 'Comedy', 'Drama', 'Science Fiction', 'Horror', 'Animation', 'Thriller'],
  series: ['Drama', 'Comedy', 'Crime', 'Mystery'],
};
/* The anime tab cannot use /api/catalog genre rows — that endpoint has no origin-country filter, so
   a "genre=Action" row would be every action series, not anime. Instead its two feeds are pulled a
   few pages deep and the pooled titles are re-cut client-side (so every row stays Japanese
   animation). Primary genre barely splits them — ~90% read "Animation" — so the body comes from
   ERAS, which do split cleanly (measured: 2020s/2010s/2000s/pre-2000 all clear MIN_ROW), plus
   whatever non-Animation genre bucket is large enough to stand on its own. */
/* A row's genre (TMDB's movie label) against a title's main genre as the server names it: the server
   shortens Science Fiction to Sci-Fi, and a series' TV genre folds onto the movie label it maps to. */
const GENRE_SAME: Record<string, string[]> = {
  'Science Fiction': ['Sci-Fi', 'Sci-Fi & Fantasy'],
  Action: ['Action & Adventure'],
};
const sameGenre = (row: string, main?: string) => !!main && (main === row || !!GENRE_SAME[row]?.includes(main));
const ANIME_POOLS = ['trending_anime', 'top_anime'];
const ANIME_ERAS: { key: string; title: string; lo: number; hi: number }[] = [
  { key: 'era_2020', title: 'New Releases', lo: 2020, hi: 9999 },
  { key: 'era_2010', title: '2010s Anime', lo: 2010, hi: 2019 },
  { key: 'era_2000', title: '2000s Anime', lo: 2000, hi: 2009 },
  { key: 'era_classic', title: 'Classic Anime', lo: 0, hi: 1999 },
];
const ANIME_BUCKET_MAX = 6;   // cap the extra rows a sparse tab gains

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
/* OK: THE TITLE SCREEN COMES OUT OF THE PANEL (the user's recordings, Oct 31: Prime Video's rows and
   rise, read frame by frame and eased to fit; then the user's own call — the panel stays, only the
   buttons come from below). At the press the rows sink 87px (233ms, easing in), faded by 170ms, and
   the panel rises whole to where the title screen's column starts (HEAD_Y, 233ms), on its own left
   edge. Its synopsis then opens to the whole one (EXPAND_MS), and the title screen takes over the same
   block, adding the cast under it and its buttons from below (prime.css). Back runs the way in backwards:
   the panel comes down from the column, the rows and ring rise back up, the opened synopsis folds away
   (CLOSE_EASE). */
const OPEN_MS = 233;
const OPEN_FADE_MS = 170;
const OPEN_ROWS_PX = 87;
const OPEN_EASE = 'cubic-bezier(.25, 0, .55, .25)';
const OPEN_RISE_EASE = 'cubic-bezier(.15, 0, .65, .85)';
const HEAD_Y = 84;
const EXPAND_MS = 200;
/* Back plays openTitle in reverse: the panel comes down, the rows rise — decelerating into place. */
const CLOSE_EASE = 'cubic-bezier(.2, .6, .3, 1)';
/* THE PAGE BEFORE ITS PICTURES, as Prime Video's (four switches along its bar, Oct 30, and a still of
   the emulator for the shapes). Switched to, the page is grey shapes — four bars where the panel goes,
   two rows of tiles — cut in 200px to the side it comes from and gliding home a frame later
   (cubic-bezier(0, 0, .2, 1), 233ms). Once the first screen's pictures and wordmarks are all in hand,
   and the shapes have been up SKEL_MIN_MS (the reference's least), they fade (380ms, linear) as the
   page fades in under them (prime.css), the text and the pictures together; the picture top-right
   comes 185ms into that (150ms, linear). However long the pictures take, the page shows SKEL_MAX_MS
   after its rows came, with what it has. x, y, width, height, corner. */
const SKELETON: [number, number, number, number, number][] = [
  /* The panel's four forms sit on the real panel (.pv-info, measured at 1920): the big one over the
     wordmark (~190-301), the third on the facts line (317), the last on the synopsis (369-441). Was
     137px lower (253/310/454/508), running into the first row's title. */
  [147, 116, 300, 33, 12], [147, 173, 500, 120, 16], [147, 317, 300, 33, 12], [147, 371, 246, 86, 12],
  /* Row 0's tiles sit at y 612. The row below is always the featured row (y 894): its card (prime.css
     .pv-card, 1024x576) and then its posters (576 tall, the strip's first in view at x 1200). */
  ...[0, 1, 2, 3, 4].map((k): [number, number, number, number, number] => [TILE.x + k * TILE.pitch, 612, TILE.w, TILE.h, 12]),
  [144, 894, 1024, 576, 12], [1200, 894, TILE.w, 576, 12], [1200 + TILE.pitch, 894, TILE.w, 576, 12],
];
/* My Space (kind 'myspace') is one featured row, My List, on the focus line from the start: its card and
   the two posters right of it. */
const SKELETON_MYSPACE: [number, number, number, number, number][] = [
  [144, 252, 1024, 576, 12], [1200, 252, TILE.w, 576, 12], [1200 + TILE.pitch, 252, TILE.w, 576, 12],
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
/* WARM-UP: on webOS the first move of each layer pays a one-time cost — the GPU rasterises and uploads
   that layer's texture only when it first actually moves, which is the cold stutter felt on the first
   press in each direction (it is gone once every layer has been composited once — the user's own finding,
   Nov 2). So, hidden behind the skeleton, each layer navigation will move (the row track, every strip,
   the rings, the faces, the panel) is nudged 1px and back on the compositor (`composite: 'add'`, so the
   real resting transform is untouched and nothing jumps): the GPU does its one-time work before the
   remote ever comes down. Off with localStorage['groloo.primewarm']='0' (to A/B it on the set). */
const WARM_MS = 160;

/* HOLD-OK TRAILERS. A deliberate hold of OK on a rested title plays its trailer (IMDb MP4, the same
   pipeline the home hero uses — useImdbTrailer + useVideoTrailer) on that title's big-picture surface:
   the top-right backdrop for a standard row, the featured card for the featured row. NOT autoplay —
   the user's call, so a trailer never starts itself and never costs a frame unasked. A tap still opens
   the title; a hold past TRAILER_HOLD_MS starts the trailer instead. */
const TRAILER_HOLD_MS = 450;
/* The sound rises from silence over this long when the picture is revealed (useVideoTrailer fadeSoundMs). */
const TRAILER_FADE_MS = 1000;
/* The widest frame a trailer's box fills to, pushing IMDb's baked-in scope bands out (coverOf, mirrors
   SpotlightStage): 2.39 for a scope film, its own aspect for a mild-wide one, none for 16:9. */
const COVER_MAX = 2.39;
const coverOf = (aspect?: number | null) => (!aspect || aspect >= 2.3 ? COVER_MAX : aspect > 1.9 ? aspect : undefined);
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
/* From the title's detail, or before it lands, from the card (the home feed carries them). */
const runOf = (m: MediaItem, d?: MetaDetail) => {
  const s = d ?? m;
  return m.type === 'movie' ? s.runtime || ''
    : s.seasons ? `${s.seasons} season${s.seasons > 1 ? 's' : ''}` : '';
};
/* The age as the reference writes it, an age and a plus. A board that rates by age keeps its number
   ("12", "12A", "16" → 12+, 16+); the US letters take the ages Prime Video gives them (its maturity
   ratings: G, TV-Y, TV-G all ages; TV-Y7, PG, TV-PG 7+; PG-13 13+; TV-14 16+; R, NC-17, TV-MA 18+). */
const US_AGE: Record<string, string> = {
  G: 'ALL', 'TV-G': 'ALL', 'TV-Y': 'ALL', U: 'ALL',
  'TV-Y7': '7+', 'TV-Y7-FV': '7+', PG: '7+', 'TV-PG': '7+',
  'PG-13': '13+', 'TV-14': '16+', R: '18+', 'NC-17': '18+', 'TV-MA': '18+',
};
const ageOf = (m: MediaItem, d?: MetaDetail) => {
  const c = (d ? d.certification : m.certification)?.trim().toUpperCase();
  if (!c) return '';
  const n = /^\d+/.exec(c)?.[0];
  return n ? (Number(n) ? `${Number(n)}+` : 'ALL') : US_AGE[c] ?? '';
};

/* The facts only the title's detail has: its runtime (or seasons) and age rating. Written with the rest
   when the detail or the card has them (the home feed carries them once the server has learned them);
   otherwise when the detail lands, at rest — at the END of the facts line, so
   they move nothing else, fading in. The featured card has the age alone. */
const writeLate = (el: HTMLElement, m: MediaItem, d: MetaDetail | undefined, late: boolean) => {
  const pairs: [string, string][] = [['.pv-run', runOf(m, d)], ['.pv-age', ageOf(m, d)]];
  for (const [sel, s] of pairs) {
    const n = el.querySelector<HTMLElement>(sel);
    if (!n || n.textContent === s) continue;
    n.textContent = s;
    n.classList.toggle('is-late', late && !!s);
  }
};

/* A panel's facts, as written (writeInfo, writeLate). */
const factsOf = (el: HTMLElement): PvHead['facts'] =>
  (['genre', 'year', 'run', 'age'] as const).map((key) => ({ key, text: el.querySelector(`.pv-${key}`)?.textContent ?? '' }));

/* What OK set going here (PrimeTest's openTitle), for Back to put back: the title open, what moves, what
   faded, the panel that rose, its synopsis as it was before it opened, and over the featured card the
   title that panel held. */
const notLeaving = () => ({
  id: '' as string | number, anims: [] as Animation[], faded: [] as Element[], panel: null as HTMLElement | null, syn: '', held: '', dy: 0,
  /* The opened title's picture top-right ('' from the featured card, where none shows). */
  art: '',
});

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
      {row.items.map((m, k) => {
        const tag = badgeOf(m);
        const pct = row.resume?.[k];
        return (
          <div key={m.id} className={row.feat ? 'pv-tile is-poster' : 'pv-tile'}>
            <canvas className="pv-tile-art" data-src={twin ? undefined : tileSrc(row, m)} />
            {tag && <span className="pv-tag">{tag}</span>}
            {pct != null && <span className="pv-resume"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%` }} /></span>}
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
        {/* A held trailer mounts here — OVER the card's pictures but UNDER its fade and wordmark, so the
            card's dark gradient and the title's logo stay drawn over the moving trailer, as over the still. */}
        <div className="pv-trailer-slot is-feat" aria-hidden="true" />
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

/* The same Prime-Video layout serves four pages — the Prime test page and the Series / Movies / Anime
   tabs — differing only in which rows they build. `kind` picks that: 'prime' keeps the mixed home feed;
   the others keep ONE kind of content (a Movies tab shows only movies, etc.). */
/* Where Up off the first row (and Back) lands in the bar: its current item, or — on a page the bar has no
 * item for (My Space) — its first. */
const barTarget = () => barItemHere() || document.querySelector<HTMLElement>('.tv-topnav button.tv-nav-item');

export type PvKind = 'prime' | 'movie' | 'series' | 'anime' | 'myspace';

/* Each kind's path on the top bar — the key the page-slide stores its arrival direction under, so the
   arriving tab reads back the side it came from (takeArrival). Must match the routes in App.tsx and the
   PRIME_LIKE set in tvPageSlide.ts. */
const ROUTE_OF: Record<PvKind, string> = { prime: '/', movie: '/movies', series: '/tv', anime: '/anime', myspace: '/library' };

export default function PrimeTest({ kind = 'prime' }: { kind?: PvKind } = {}) {
  const t = useT();
  const { data } = useHome();
  /* CONTINUE WATCHING leads the home page (kind 'prime'). Its titles are taken ONCE, when the history's
     art has answered, and kept: a row coming or going after the build would move every row under it
     (the imperative draw keys on a row's index). Only the bars follow the progress. */
  const cw = useContinueItems();
  const [cwItems, setCwItems] = useState<MediaItem[] | null>(kind === 'prime' ? null : []);
  useEffect(() => {
    if (cwItems === null && cw.ready) setCwItems(cw.tvItems.slice(0, ROW_CAP));
  }, [cwItems, cw.ready, cw.tvItems]);
  /* MY SPACE's one row, My List, in the featured row's form (the user's call, Nov 9). Taken once its art has
     answered and frozen like Continue Watching's: the imperative draw keys on a title's place in the row,
     so a title saved or removed meanwhile shows on the next visit. */
  const ml = useMyListItems();
  const [mlItems, setMlItems] = useState<MediaItem[] | null>(kind === 'myspace' ? null : []);
  useEffect(() => {
    if (mlItems === null && ml.ready) setMlItems(ml.items);
  }, [mlItems, ml.ready, ml.items]);
  const openModal = useModal((s) => s.open);
  const warm = useWarmDetail();
  const metaOf = useMetaOf();
  const qc = useQueryClient();
  const { lang } = useLang();
  const genreT = useGenre();

  /* EXTRA ROWS beyond the home feed, so a single-kind tab is not three thin rows (the home feed only
     carries one trending + one top + the mixed provider rows for each kind). Movies / Series pull a
     catalogue row per genre; Anime pools its two feeds a few pages deep (the catalogue has no
     origin filter, so it is bucketed client-side to stay anime). `prime` adds nothing — it keeps the
     full mixed home feed it always had. Every request is keyed by its URL, so react-query dedupes and
     caches them, and they fold in as they land (the build effect appends, never restarts — below). */
  const fetchSpecs = useMemo<{ key: string; title: string; url: string }[]>(() => {
    if (kind === 'movie' || kind === 'series') {
      const type = kind === 'movie' ? 'movie' : 'tv';
      return GENRE_ROWS[kind].map((g) => ({
        key: `genre_${g}`,
        title: genreT(g),
        url: gridUrl({ kind: 'filter', filters: { genre: g, type }, title: g }, 1, lang),
      }));
    }
    if (kind === 'anime') {
      return ANIME_POOLS.flatMap((cat) => [1, 2, 3].map((page) => ({
        key: `pool_${cat}_${page}`,
        title: '',
        url: gridUrl({ kind: 'category', cat, title: '' }, page, lang),
      })));
    }
    return [];
  }, [kind, lang, genreT]);

  const fetched = useQueries({
    queries: fetchSpecs.map((s) => ({
      queryKey: ['pv-row', s.url],
      staleTime: 10 * 60 * 1000,
      queryFn: () => api<{ results?: MediaItem[] }>(s.url),
    })),
  });
  /* useQueries hands back a fresh array every render; a ref lets the memo below read the latest data
     without listing `fetched` as a dependency (which would rebuild the rows — and restart the whole
     page build — on every render). `sig` moves only when a query actually resolves, so the rows
     recompute exactly when new data arrives and no more often. */
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const sig = fetched.map((q) => q.dataUpdatedAt).join('|');
  const extraRows = useMemo<PvRow[]>(() => {
    void sig;   // recompute marker: `sig` moves exactly when a query's data lands (read below via ref)
    const f = fetchedRef.current;
    if (kind === 'movie' || kind === 'series') {
      /* ONE ROW PER TITLE: a title is in several genres, so the catalogue answers put it in several
         rows (The Mentalist under Crime AND Mystery). Each title goes to the row of its main genre
         when the page has one, otherwise to the first row whose answer held it; each row keeps its
         answer's order. No anime (the Anime tab's). */
      const answers = fetchSpecs.map((_, i) => (f[i]?.data?.results ?? []).filter((m) => m.backdrop && !m.anime));
      const rowOf = new Map<string, number>();
      answers.forEach((arr) => arr.forEach((m) => {
        const id = String(m.id);
        if (rowOf.has(id)) return;
        const main = GENRE_ROWS[kind].findIndex((g) => sameGenre(g, m.genre));
        rowOf.set(id, main >= 0 && answers[main].some((x) => String(x.id) === id) ? main : -1);
      }));
      answers.forEach((arr, i) => arr.forEach((m) => { const id = String(m.id); if (rowOf.get(id) === -1) rowOf.set(id, i); }));
      const out: PvRow[] = [];
      fetchSpecs.forEach((s, i) => {
        const items = answers[i].filter((m) => rowOf.get(String(m.id)) === i).slice(0, ROW_CAP);
        if (items.length >= MIN_ROW) out.push({ key: s.key, title: s.title, items, feat: false });
      });
      return out;
    }
    if (kind === 'anime') {
      // Pool every page of both anime feeds and dedupe by id — one list of Japanese animation to cut.
      const seen = new Set<string | number>();
      const pool: MediaItem[] = [];
      for (const q of f) for (const m of (q?.data?.results ?? [])) {
        if (m.id == null || seen.has(m.id) || !m.backdrop) continue;
        seen.add(m.id);
        pool.push(m);
      }
      const byPop = (a: MediaItem, b: MediaItem) => (b.pop ?? 0) - (a.pop ?? 0);
      const out: PvRow[] = [];
      // Any non-Animation primary genre big enough to be a row of its own (usually "Action &
      // Adventure"); Animation itself is every title's genre, so it is skipped.
      const buckets = new Map<string, MediaItem[]>();
      for (const m of pool) {
        const g = m.genre;
        if (!g || g === '—' || g === 'Animation') continue;
        (buckets.get(g) ?? (buckets.set(g, []), buckets.get(g)!)).push(m);
      }
      for (const [g, arr] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
        if (arr.length >= MIN_ROW) out.push({ key: `anime_${g}`, title: genreT(g), items: arr.sort(byPop).slice(0, ROW_CAP), feat: false });
      }
      // Era rows — the axis that actually splits anime — newest first, each popularity-sorted.
      for (const e of ANIME_ERAS) {
        const arr = pool.filter((m) => { const y = parseInt(String(m.year), 10); return y >= e.lo && y <= e.hi; });
        if (arr.length >= MIN_ROW) out.push({ key: e.key, title: e.title, items: arr.sort(byPop).slice(0, ROW_CAP), feat: false });
      }
      return out.slice(0, ANIME_BUCKET_MAX);
    }
    return [];
    // `fetched` is intentionally NOT a dependency — it is a new array each render and is read through
    // `fetchedRef`; `sig` moves exactly when a query's data changes, which is the only time to recompute.
  }, [kind, fetchSpecs, genreT, sig]);

  /* THE PAGE BEFORE ITS PICTURES is the grey shapes alone; the rows mount under them. The whole list is
     computed here at once (cheap — it is plain data), but only `builtCount` of its rows are rendered, and
     that count grows a row per frame (the build effect below), so the main thread is never held for one
     long task. The shapes glide over it on the compositor the whole time. */
  const allRows = useMemo(() => {
    /* TV Shows and Movies leave Japanese animation to the Anime tab. */
    const list =(cat: string) => (data?.rows?.[cat]?.results ?? []).filter((m) => m.backdrop && !(m.anime && (kind === 'movie' || kind === 'series'))).slice(0, ROW_CAP);
    const out: PvRow[] = [];
    const push = (key: string, title: string, items: MediaItem[], feat = false) => { if (items.length) out.push({ key, title, items, feat }); };

    /* A single-kind tab (Series / Movies / Anime): the Prime layout, kept to one kind of content.
       One trending feed leads, THEN the featured card (row 2, as on the Prime page), THEN the
       top-rated feed and the streaming-service rows kept to that kind (anime has none but
       Crunchyroll), and finally the genre rows (`extraRows`) that give the page its body. The genre
       rows land a moment after the home feed, so they are appended at the END: the rows already on
       screen keep their index, and the imperative draw never has a built row shift under it.
       Featured MUST stay within the first BUILD_FIRST rows (it is row 2, index 1): its card art is
       written once, on the first apply() while the opening rows mount, so a featured row that is not
       yet built at that moment would never get its first picture and would open black. */
    if (kind === 'myspace') {
      if (mlItems) push('mylist', t('myspace.my_list'), mlItems, true);
      return out;
    }
    if (kind !== 'prime') {
      const meta = {
        movie: { T: 'movie', tr: 'sec.trending_movies', tp: 'sec.top_movies' },
        series: { T: 'tv', tr: 'sec.trending_shows', tp: 'sec.top_shows' },
        anime: { T: 'anime', tr: 'sec.trending_anime', tp: 'sec.top_anime' },
      }[kind as 'movie' | 'series' | 'anime'];
      const T = meta.T;
      push(`trending_${T}`, t(meta.tr), list(`trending_${T}`));
      const feat = list(`top_${T}`).filter((m) => m.poster);
      push('featured', t('tv.featured'), feat.length ? feat : list(`trending_${T}`).filter((m) => m.poster), true);
      push(`top_${T}`, t(meta.tp), list(`top_${T}`));
      if (kind === 'anime') {
        push('prov_crunchyroll', t('sec.crunchyroll'), list('prov_crunchyroll'));
      } else {
        const isKind = kind === 'movie'
          ? (m: MediaItem) => (m.type ?? 'movie') === 'movie'
          : (m: MediaItem) => m.type === 'tv' || m.type === 'series';
        for (const cat of PROVIDER_CATS) {
          if (cat === 'prov_crunchyroll') continue;   // an anime house — not this tab's kind
          const row = HOME_ROWS.find((r) => r.cat === cat);
          // Drop a provider row that keeps too few of its own kind to look like a row (MIN_ROW).
          if (row) { const items = list(cat).filter(isKind); if (items.length >= MIN_ROW) push(cat, t(row.key), items); }
        }
      }
      out.push(...extraRows);
      return out;
    }

    /* Held till Continue Watching is settled, so the first build already has it. With it, it is row 0
       and the featured card stays row 1 (the skeleton's shapes and the first build expect a tile row
       then the card); Trending Movies comes after the card instead. */
    if (!cwItems) return out;
    if (cwItems.length) {
      out.push({ key: 'continue', title: t('sec.continue'), items: cwItems, resume: cwItems.map((m) => cw.resumeOf(m)?.pct ?? 0) });
      push('featured', t('tv.featured'), list('top_tv').filter((m) => m.poster), true);
      push('trending_movie', t('sec.trending_movies'), list('trending_movie'));
    } else {
      push('trending_movie', t('sec.trending_movies'), list('trending_movie'));
      push('featured', t('tv.featured'), list('top_tv').filter((m) => m.poster), true);
    }
    push('top10', 'Top 10', list('trending_tv').slice(0, 10));
    for (const row of HOME_ROWS) {
      if (row.cat === 'trending_movie' || row.cat === 'top_tv' || row.cat === 'trending_tv') continue;
      push(row.cat, t(row.key), list(row.cat));
    }
    return out;
  }, [data?.rows, t, kind, extraRows, cwItems, cw.resumeOf, mlItems]);
  /* 0 until a frame after the first paint (the shapes are on screen first, as the whole build used to
     wait); then the first screen's rows together, then one more each frame. A press does not race this:
     the remote is in the bar until the page shows itself, which waits for the first screen's pictures —
     long after every row is mounted. */
  const [builtCount, setBuiltCount] = useState(0);
  const rows = useMemo(() => allRows.slice(0, builtCount), [allRows, builtCount]);
  /* `allRows` grows after first paint — the genre rows (`extraRows`) fold in as they fetch. The build
     must CONTINUE from where it is, never restart: a restart would drop `builtCount` back to
     BUILD_FIRST, unmounting rows already on screen and re-running their imperative draw. A ref holds
     the live count so a re-run resumes from it (clamped to at least the first screen), and only the
     newly-appended rows are built. */
  const builtRef = useRef(0);
  builtRef.current = builtCount;
  /* THE REVEAL HOLDS DEFERRABLE MAIN-THREAD WORK FOR THE LENGTH OF THE FADE (fadeHoldRef, set in
     `reveal`): the off-screen rows past the first screen (the build, below) and the off-screen tiles'
     canvas draws (the picture pump, below) both wait out the ~380ms skeleton→page fade and land AFTER
     it, so the fade keeps the compositor to itself and never has a build commit or a drawImage in the
     middle of it. The first screen is never held — it must be whole for the reveal to fire at all.
     Before this, the reveal instead waited for the WHOLE build so the fade ran clean; but a single-kind
     tab's genre rows arrive over the network, so that wait routinely hit SKEL_MAX_MS (measured: Series
     ~3.3s, Movies ~2.8s on the shapes) and then revealed mid-build anyway. Revealing at the first screen
     and holding the off-screen work gives both: the page shows as soon as it is drawn, and the fade is
     still alone. */
  const fadeHoldRef = useRef(false);
  /* AND THE SAME HOLD FOR THE ARRIVAL GLIDE (glideHoldRef, set in the glide layout effect below): when the
     page is switched to along the bar its skeleton glides in (~250ms) while the remount's build train
     (grow, 2 rows/frame) is still running — a build commit is a main-thread task, so the off-screen rows
     mounting under the glide dropped its frames (the worst block, the tab-switch). The FIRST screen (rows
     0 and 1, which the reveal waits on) still builds at once — only the rows past it are held, so the
     reveal is not delayed — and they land in the dead air after the glide, before the reveal fade. */
  const glideHoldRef = useRef(false);
  useEffect(() => {
    if (!allRows.length) { setBuiltCount(0); return; }
    if (builtRef.current >= allRows.length) { setBuiltCount(allRows.length); return; }
    let raf = 0;
    let timer = 0;
    const grow = (n: number) => {
      setBuiltCount(n);
      if (n >= allRows.length) return;
      // Past the first screen, don't mount more rows while the reveal fade OR the arrival glide is running.
      if (n >= BUILD_FIRST && (fadeHoldRef.current || glideHoldRef.current)) { timer = window.setTimeout(() => grow(n), 48); return; }
      raf = requestAnimationFrame(() => grow(Math.min(n + BUILD_STEP, allRows.length)));
    };
    const start = Math.max(builtRef.current, BUILD_FIRST);
    raf = requestAnimationFrame(() => { timer = window.setTimeout(() => grow(Math.min(start, allRows.length))); });
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [allRows]);
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
  const timers = useRef({ text: 0, write: 0, rest: 0, artOut: 0, artIn: 0, away: 0, ring: 0, skel: 0, land: 0, hand: 0, build: 0 });
  /* Whether the page has shown itself yet (THE PAGE BEFORE ITS PICTURES). */
  const revealed = useRef(false);
  /* Whether the press being applied is a held key's step. */
  const pressHeld = useRef(false);

  /* ---- HOLD-OK TRAILERS ---------------------------------------------------------------------------
     A trailer plays only on a deliberate hold of OK — never autoplay. `dwelt` is the title the remote
     is resting on; its IMDb trailer is resolved while it rests (useImdbTrailer), so a hold starts at
     once. `playing` mounts ONE shared <video> (useVideoTrailer) in `slotRef`, positioned over the
     active surface — the featured card, or the top-right backdrop — and torn down the moment anything
     moves. `playingRef` mirrors `playing` for the imperative handlers (step/back/exit). */
  const trailersOn = useSettings((s) => s.settings.tvRowTrailers);
  const [dwelt, setDwelt] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState(true);
  const playingRef = useRef(false);
  /* The trailer mounts INSIDE whichever surface it plays on — the featured card, or the standard-row
     backdrop — so that surface's own gradient and wordmark paint over it, exactly as over the still.
     Each slot sits in its surface's DOM, between the picture and the fade; `slotRef` points at the
     active one, chosen at play time (the hook mounts its <video> there). */
  const slotRef = useRef<HTMLDivElement | null>(null);
  const artSlotRef = useRef<HTMLDivElement | null>(null);
  const trailer = useImdbTrailer(trailersOn ? dwelt?.imdb : undefined);
  const trailerUrl = trailer.data?.url || undefined;
  const stopTrailer = useCallback(() => {
    if (!playingRef.current) return;
    playingRef.current = false;
    slotRef.current?.classList.remove('is-live');
    /* If a trailer was carrying the title screen's backdrop, let that screen show its own picture again. */
    document.body.classList.remove('pv-trailer-bg');
    setPlaying(false);
  }, []);
  const playTrailer = () => {
    if (!trailersOn || !trailerUrl || playingRef.current) return;
    const s = st.current;
    const it = rows[s.row]?.items[s.cols[s.row] ?? 0];
    /* Only the rested title, whose trailer the hold holds — matched by IMDb id, not object identity
       (a background refetch rebuilds the item objects while the id stays). */
    if (!it || !it.imdb || it.imdb !== dwelt?.imdb) return;
    const feat = s.row === featAt;
    const node = feat
      ? rootRef.current?.querySelector<HTMLDivElement>('.pv-card .pv-trailer-slot') ?? null
      : artSlotRef.current;
    if (!node) return;
    slotRef.current = node;
    node.classList.add('is-live');            // reveal the active slot before the hook measures it
    playingRef.current = true;
    setSound(true);
    setPlaying(true);
  };
  useVideoTrailer(
    slotRef,
    rootRef as RefObject<HTMLElement | null>,
    playing ? trailerUrl : undefined,
    dwelt?.title ?? '',
    {
      renditions: trailer.data?.urls,
      cropScale: 1,                            // TV: the crop is laid out, never transformed
      coverAspect: coverOf(trailer.data?.aspect),
      maxRenditionPx: 1280,
      sound,
      fadeSoundMs: TRAILER_FADE_MS,
      restartKey: dwelt?.id != null ? String(dwelt.id) : undefined,
      onFail: stopTrailer,
    },
  );
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
  /* OK's tap-vs-hold: `timer` fires at TRAILER_HOLD_MS and plays the trailer; `held` then suppresses
     the tap-open on key-up. A quick release (before the timer) is a tap and opens the title. */
  /* `down`: this page saw the OK go down. A keyup without it is a press that began elsewhere — OK on the side
   * rail's My Space, whose page mounts under the still-held key — and opens nothing. */
  const enter = useRef({ timer: 0, held: false, down: false });
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

  /* The runtime and age rating of the title on screen, when its detail lands after it was written — and
     in the title screen opened from it, which draws its panel (openTitle). */
  useEffect(() => qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || e.query.queryKey[0] !== 'meta') return;
    const { item, key, row } = shown.current;
    if (!item) return;
    const L = leaving.current;
    const late = L.panel && L.id === item.id ? metaOf(item) : undefined;
    if (L.panel && late) {
      writeLate(L.panel, item, late, true);
      const facts = factsOf(L.panel);
      useModal.setState((m) => (m.target?.pv && m.target.id === L.id ? { target: { ...m.target, pv: { ...m.target.pv, facts } } } : m));
    }
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
  /* OK: the opened title's picture NOW. After a quick move the one on screen was still the last title's,
     waiting out the move's rest — it stayed up under the opening title, faded to black, and only then
     did the right one come (the user's recording, Nov 8). So the one on screen crosses straight to it:
     a pending, delayed fade-out starts now, and the new one comes in with no rest, faded a little
     quicker than the old goes so the cross never dips to black. */
  const artNow = useCallback((want: string) => {
    const a = art.current;
    const tm = timers.current;
    if (tm.artOut && a.shown !== want) {
      window.clearTimeout(tm.artOut);
      tm.artOut = 0;
      const el = rowArtRefs.current[a.layer];
      if (el) {
        const now = getComputedStyle(el).opacity;   // read BEFORE the transition goes, or it reads its end
        el.style.transition = 'none';
        el.style.opacity = now;
        void getComputedStyle(el).opacity;   // the delayed fade cancelled here, so the next one starts now
      }
    }
    artTo(want, { outAt: 0, outMs: ART_OUT_MS + ART_PRIME_MS + 60, rest: 0 });
  }, [artTo]);
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

  /* WARM THE FEATURED CARD as navigation reaches it. Its poster strips, card, the three faces and the
     big ring each pay a one-time GPU upload the first time they draw or move — and the entrance warm
     (warmLayers) could not reach them: at reveal they are opacity-0, where a nudge is free and uploads
     nothing, yet it still spends the `warm` mark. So this uses a mark of its own (`warmfeat`) and fires
     while the card is actually on screen (focused, or one row away and dimmed-visible), a beat before
     the first left/right carries the posters under the card — which is where the ~400ms cold stall was.
     Off with the same localStorage['groloo.primewarm']='0'. */
  const warmFeatured = useCallback(() => {
    try { if (localStorage.getItem('groloo.primewarm') === '0') return; } catch { /* storage blocked: warm */ }
    if (typeof Element === 'undefined' || !Element.prototype.animate || featAt < 0) return;
    const card = rowEls.current[featAt];
    if (!card) return;
    const nudge = (el?: Element | null) => {
      const h = el as HTMLElement | null;
      if (!h || h.dataset.warmfeat === '1') return;
      h.dataset.warmfeat = '1';
      h.animate(
        [{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(1px,0,0)' }, { transform: 'translate3d(0,0,0)' }],
        { duration: WARM_MS, easing: 'linear', composite: 'add' },
      );
    };
    nudge(ringRefs.current[1]);
    card.querySelectorAll('.pv-strip, .pv-face-art, .pv-face-info, .pv-card, .pv-card-fade').forEach(nudge);
  }, [featAt]);

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

    /* Only the ROW-dependent writes need redoing when the row changes; a horizontal (same-row) press
       leaves pv-deep, the track's vertical transform and every row's dim/gone state identical, so skip
       them (classList.toggle is a no-op when unchanged, but this also saves the track write and the loop). */
    if (s.row !== was.row) {
      document.body.classList.toggle('pv-deep', s.row > 0);
      track.style.transform = trackAt(s.row);
      rowEls.current.forEach((el, i) => {
        if (!el) return;
        /* Over the featured card there is no panel: the row above it stays, at half. */
        const above = feat && i === s.row - 1;
        el.classList.toggle('is-gone', i < s.row && !above);
        el.classList.toggle('is-dim', i > s.row || above);
        /* The featured row, when >1 away (invisible, is-gone), drops its two full-width poster strips from
           the compositor (prime.css `.pv-feat.is-cold`) to free a weak TV GPU's memory. Clearing warmfeat
           lets the abs<=1 warmFeatured below re-upload the re-promoted strips one row before focus returns. */
        const cold = i === featAt && Math.abs(i - s.row) > 1;
        el.classList.toggle('is-cold', cold);
        if (cold) el.querySelectorAll<HTMLElement>('.pv-strip').forEach((n) => { delete n.dataset.warmfeat; });
      });
    }
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
    /* Reached the featured row (or the row beside it) by an actual move — warm its layers now, before
       the first poster slide. Gated on a real row change and on being revealed, so it never fires at
       the opening rest and never adds its uploads to the entrance fade. */
    if (revealed.current && featAt >= 0 && s.row !== was.row && Math.abs(s.row - featAt) <= 1) warmFeatured();
    shown.current = { row: s.row, col, key: `${row.key}:${col}`, item };

    /* Once everything has stopped moving, the title the remote rests on gets its title screen ready
       (detail, backdrop, wordmark) — so OK opens it at once, on the picture already here — and the
       wordmarks one press away are fetched, so the next panel comes in with its own. On the featured
       card the faces one press away come first, on their own (the likeliest next press's). */
    const rest = () => {
      /* Rested on this title: let the trailer resolve for it and show the "Hold select for trailer"
         hint (CSS reveals it under `.pv.is-still`). `dwelt` is read ONLY by the trailer path (useImdbTrailer,
         canTrail), so skip the whole re-render when trailers are off; when on, defer it as a transition so a
         press that lands while this rest's render is in flight preempts it instead of colliding with the move
         (the far-from-press frames a held/quick-second press showed were this render landing mid-glide). */
      if (trailersOn) startTransition(() => setDwelt(item));
      rootRef.current?.classList.add('is-still');
      warm(item, undefined, () => shown.current.item === item, item.bgArt);
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
  }, [rows, featAt, p, trackAt, infoTo, writeInfo, faceTo, writeFace, facePic, artTo, holdArt, warm, warmFeatured]);

  useLayoutEffect(() => { apply(); }, [apply]);
  useEffect(() => {
    document.body.classList.add('pv-page');
    const tm = timers.current;
    return () => {
      document.body.classList.remove('pv-page', 'pv-deep', 'pv-titled', 'pv-landed', 'pv-art-same');
      ['--p', '--pv-head-x', '--pv-head-y'].forEach((v) => document.body.style.removeProperty(v));
      Object.values(tm).forEach((id) => window.clearTimeout(id));
    };
  }, []);
  /* The title screen opened from here draws the panel at this page's scale (prime.css). */
  useEffect(() => { document.body.style.setProperty('--p', `${p}px`); }, [p]);

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
        /* The off-screen tiles' draws (drawImage, main thread) wait out the reveal fade, which only
           ever shows the first screen — its tiles are already on by the time the page shows itself.
           Decoding above stays off-thread throughout; this holds only the paint, so the fade is alone.
           `running` stays true, so the pump is paused here rather than re-armed (which would spin). */
        while (fadeHoldRef.current && !dead) await new Promise((r) => setTimeout(r, 48));
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

  /* Pay the first-move GPU cost up front (WARM_MS above). Each layer is nudged once — a dataset mark
     keeps it to once — by a tiny compositor-only animation that adds 1px and takes it back, over the
     layer's own resting transform (`composite: 'add'`), so `apply`'s inline transform is never touched
     and there is nothing to see. Opacity-0 layers (rings, faces before the featured row) cost nothing
     to nudge and warm when they first draw instead; the ones that matter — the track and the strips —
     are opaque and on screen, so this is where their texture goes to the GPU. */
  const warmLayers = useCallback(() => {
    try { if (localStorage.getItem('groloo.primewarm') === '0') return; } catch { /* storage blocked: warm */ }
    if (typeof Element === 'undefined' || !Element.prototype.animate) return;
    const nudge = (el?: Element | null) => {
      const h = el as HTMLElement | null;
      if (!h || h.dataset.warm === '1') return;
      h.dataset.warm = '1';
      h.animate(
        [{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(1px,0,0)' }, { transform: 'translate3d(0,0,0)' }],
        { duration: WARM_MS, easing: 'linear', composite: 'add' },
      );
    };
    const root = rootRef.current;
    if (!root) return;
    nudge(trackRef.current);
    ringRefs.current.forEach(nudge);
    root.querySelectorAll('.pv-strip, .pv-face-art, .pv-face-info, .pv-info').forEach(nudge);
  }, []);
  /* Rows build a few at a time (BUILD_STEP), so some strips mount after the reveal warmed what was there.
     Once the build is whole, warm again — the dataset mark skips all the already-warm ones, so only the
     late strips pay, and every row is hot before the remote reaches it. */
  useEffect(() => {
    if (allRows.length && builtCount >= allRows.length) warmLayers();
  }, [builtCount, allRows.length, warmLayers]);

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
    /* As the TV home page, its first screen being whole is what the boot splash waits on (lib/bootGate). */
    bootRowsStaged();
    /* Hold the deferrable work (off-screen rows' build, off-screen tiles' canvas draws) off the thread
       until the fade is done — see the build effect and the picture pump. Released a beat past the
       skeleton's fade so nothing lands through it. */
    fadeHoldRef.current = true;
    timers.current.build = window.setTimeout(() => { fadeHoldRef.current = false; }, SKEL_OUT_MS + 80);
    /* Show the page's picture and arm the skeleton's fade — the visible reveal. */
    const showPage = () => {
      root.classList.add('is-shown');
      const s = st.current;
      const row = rows[s.row];
      const item = row?.items[s.cols[s.row] ?? 0];
      if (item && !row.feat) artTo(bgSrc(item), { rest: 0, inMs: ART_REVEAL_MS, inBy: performance.now() + ART_AT_REVEAL });
      timers.current.skel = window.setTimeout(() => { if (skelRef.current) skelRef.current.style.display = 'none'; }, SKEL_OUT_MS);
    };
    let decouple = true;
    try { decouple = localStorage.getItem('groloo.primedecouple') !== '0'; } catch { /* storage blocked: on */ }
    if (decouple) {
      /* PRE-LIGHT: the page is drawn at 1% over the still skeleton (is-lit). Every layer takes its
         one-time upload now — nothing is animating, 1% is invisible — so when the page fades in two
         frames later it is already whole and the fade carries no upload work. */
      root.classList.add('is-lit');
      warmLayers();
      requestAnimationFrame(() => requestAnimationFrame(showPage));
    } else {
      showPage();
      warmLayers();
    }
  }, [rows, artTo, warmLayers]);

  /* Switched to along the bar, the shapes glide in from the side the page comes from. */
  useLayoutEffect(() => {
    openedAt.current = performance.now();
    const dir = takeArrival(ROUTE_OF[kind]);
    const glide = skelRef.current?.firstElementChild;
    if (!dir || !glide) return;
    /* Hold the off-screen build train off the thread while this glide runs (glideHoldRef, read by the build
       effect above), so a build commit never lands under the arrival animation. Released on a real timer,
       not the animation's finish, so a backgrounded tab whose animation never fires still builds. Only when
       dir is set — a deep link or a Down into the page (dir 0) has no glide and builds at once. */
    glideHoldRef.current = true;
    glide.animate([{ transform: `translate3d(${dir * SKEL_SHIFT * p}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: SKEL_GLIDE_MS, delay: SKEL_GLIDE_AT, easing: SKEL_GLIDE_EASE, fill: 'backwards' });
    const release = window.setTimeout(() => { glideHoldRef.current = false; }, SKEL_GLIDE_AT + SKEL_GLIDE_MS);
    return () => { window.clearTimeout(release); glideHoldRef.current = false; };
  }, [p, kind]);

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
      /* Reveal once the FIRST SCREEN is drawn (whole() checks rows 0 and 1 and the featured card — the
         only rows on screen behind the shapes), not the whole build. The rows build a couple per frame
         and a build commit is a main-thread task, so revealing with the rest of the build still running
         let a long frame land in the glide and the fade. The build is paused for the length of the fade
         instead (holdBuildRef, set in `reveal`), so the off-screen rows mount after it — the animation
         keeps the thread to itself without the page waiting on rows nobody can see yet. That wait used
         to reach the whole build, which on a single-kind tab meant waiting on genre rows coming over the
         network: it routinely hit SKEL_MAX_MS (~3.3s Series, ~2.8s Movies) and revealed mid-build anyway.
         SKEL_MAX_MS stays the hard cap, so a stalled first screen can never strand the page on the shapes. */
      if (now - from >= SKEL_MAX_MS || (early <= 0 && whole())) { reveal(); return; }
      timer = window.setTimeout(check, Math.max(SKEL_POLL_MS, early));
    };
    check();
    return () => window.clearTimeout(timer);
  }, [rows, featAt, faceParts, reveal, artPic]);

  /* Switched away along the bar: the rows (the shapes, if the page has not shown itself yet) AND the
     title panel slide off the way the pages go and fade, together; the picture top-right fades faster
     where it is — and the page is cut PAGE_EXIT.cutMs in (lib/tvPageSlide.ts). Each from where it is
     now. (The panel used to stay put, mirroring the reference, but the user wants it to leave with the
     rest.) */
  useEffect(() => {
    registerPageExit((dir) => {
      stopTrailer();
      const own = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '1px 0px');
      const slideOut = [own ? { translate: `${-dir * PAGE_EXIT.px * p}px 0px`, opacity: 0 } : { opacity: 0 }];
      const opts = { duration: PAGE_EXIT.ms, easing: PAGE_EXIT.ease, fill: 'forwards' as const };
      if (revealed.current) {
        /* The rows SLIDE on the track (translate, compositor-cheap) but FADE on their leaf layers via
           `is-exiting` (prime.css) — never the track as a group. A group opacity over the ~15-25 promoted
           strip layers forces them all into one offscreen surface every frame, the exact flatten this page
           avoids for dim/gone. Each strip/title/dim is its own layer, so fading them apart needs no flatten. */
        rootRef.current?.classList.add('is-exiting');
        trackRef.current?.animate(
          own ? [{ translate: '0px 0px' }, { translate: `${-dir * PAGE_EXIT.px * p}px 0px` }] : [{ opacity: 1 }, { opacity: 0 }],
          opts,
        );
      } else {
        skelRef.current?.firstElementChild?.animate(slideOut, opts);
      }
      // The title panel is a sibling of the rows, not inside the track, so it needs its own matching
      // slide-and-fade to leave with them instead of hanging on the empty page.
      infoRefs.current.forEach((el) => el?.animate(slideOut, opts));
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
    /* OK pressed, its title screen not mounted yet (openPv): the press is spent on nothing. */
    if (leaving.current.id !== '') return true;
    /* A playing trailer takes Back first: it stops and the page stays where it is. */
    if (playingRef.current) { stopTrailer(); return true; }
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
    barTarget()?.focus({ preventScroll: true });
    document.body.classList.remove('pv-deep');
    return true;
  }, 100), [apply, trackAt]);

  /* The rail's Main menu (lib/tvBar.ts pageToBar): the bar shows with the remote in it, the rows stay
     where they are. */
  useEffect(() => setPageToBar(() => {
    const el = barTarget();
    if (!el) return false;
    el.focus({ preventScroll: true });
    document.body.classList.remove('pv-deep');
    return true;
  }), []);

  /* ---- OK: THE TITLE SCREEN (TvDetail, over this page) comes out of the panel (OPEN_MS). What is on
     screen goes at the press, whether or not the title screen is ready — no spinner however long it
     takes (the user's call, Oct 29) — and the page takes no keys till it is closed. The rows and the
     ring sink and fade. The panel holding the title — written at the press if that came before it, and
     over the featured card, where none shows, given it then — rises whole to where the title screen's
     column starts (from the card it fades in there instead), and its synopsis opens to the whole one.
     The title screen draws the same block in the same place (TvDetail's `pv` head) and takes over
     from it in one frame: body.pv-landed, which brings in its cast and its buttons (prime.css).
     .pv-titled while a title is open. ---- */
  const leaving = useRef(notLeaving());
  /* The panel's synopsis, two lines, opened to the whole (six at most, prime.css): split where its
     third line starts, the two lines kept as they stand and the rest under them — fading in, or not,
     where the panel is not on screen yet. */
  const openSynopsis = (panel: HTMLElement, fadeIn: boolean) => {
    const L = leaving.current;
    const syn = panel.querySelector<HTMLElement>('.pv-synopsis');
    const node = syn?.firstChild;
    if (!syn || !node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    L.syn = text;
    syn.classList.add('is-open');
    const third = syn.getBoundingClientRect().top + 1.5 * parseFloat(getComputedStyle(syn).lineHeight);
    const r = document.createRange();
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      r.setStart(node, mid);
      r.setEnd(node, mid + 1);
      if (r.getBoundingClientRect().top >= third) hi = mid;
      else lo = mid + 1;
    }
    if (lo >= text.length) return;
    const first = document.createElement('span');
    first.textContent = text.slice(0, lo);
    const more = document.createElement('span');
    more.className = 'pv-more';
    more.textContent = text.slice(lo);
    syn.replaceChildren(first, more);
    if (fadeIn) L.anims.push(more.animate([{ opacity: 0 }, { opacity: 1 }], { duration: EXPAND_MS, easing: 'linear' }));
  };
  /* Once the title screen's block is there, its wordmark decoded, it takes over in one frame. */
  const handOver = () => {
    const L = leaving.current;
    if (useModal.getState().target?.id !== L.id) return;
    const head = document.querySelector<HTMLElement>('.tv-dm.is-pv .pv-head');
    if (!head) {
      timers.current.hand = window.setTimeout(handOver, 50);
      return;
    }
    const take = () => {
      if (leaving.current !== L) return;
      /* The page's own picture top-right IS the title screen's (same art, same w1280): when it is up,
         the screen draws none of its own — no second decode, no second 1300x731 layer faded in over
         the first on the set's GPU (prime.css). */
      const a = art.current;
      const cv = rowArtRefs.current[a.layer]?.querySelector('canvas');
      if (L.art && a.visible && a.shown === L.art && cv?.dataset.on === L.art) document.body.classList.add('pv-art-same');
      document.body.classList.add('pv-landed');
      if (L.panel) L.panel.style.visibility = 'hidden';
      /* A standard-row trailer is NOT stopped here: it plays on as the title screen's backdrop (the
         screen's own picture is held back by `pv-trailer-bg`), so there is no cut between the two pages.
         It ends on Back or when the clip finishes (stopTrailer). The featured row stopped it at the press. */
    };
    const img = head.querySelector('img');
    if (img) img.decode().then(take, take);
    else take();
  };
  /* The panel as text, for the title screen to draw the same (TvDetail's `pv` head). */
  const headOf = (el: HTMLElement): PvHead => {
    const q = (sel: string) => el.querySelector<HTMLElement>(sel);
    const logo = q('.pv-logo');
    return {
      logo: logo && logo.style.display !== 'none' ? logo.getAttribute('src') ?? '' : '',
      name: q('.pv-title')?.textContent ?? '',
      badge: q('.pv-badge')?.textContent ?? '',
      callout: q('.pv-callout')?.textContent ?? '',
      facts: factsOf(el),
      synopsis: q('.pv-synopsis')?.textContent ?? '',
    };
  };
  /* What OK opens: a Continue Watching title resumes where it was left (its episode, its add-on). */
  const targetOf = (row: PvRow, it: MediaItem) => {
    const e = row.key === 'continue' ? cw.byId.get(String(it.id)) : undefined;
    return e ? entryTarget(e) : openItem(it);
  };
  /* OK opens the title: the page clears itself away at once (openTitle), and the title screen mounts a
     frame later, once those animations are on the compositor — React building it in the press's own
     task held up the first frames of the rise (traced at 6x: 7 dropped frames in its first 100ms). */
  const openPv = (row: PvRow, it: MediaItem) => {
    const target = { ...targetOf(row, it), backdrop: it.bgArt, pv: openTitle(it) };
    const L = leaving.current;
    requestAnimationFrame(() => window.setTimeout(() => { if (leaving.current === L) openModal(target); }, 0));
  };
  const openTitle = (it: MediaItem): PvHead => {
    const L = leaving.current;
    const I = info.current;
    const tm = timers.current;
    const s = shown.current;
    const feat = I.hidden;
    const own = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '1px 0px');
    L.id = it.id;
    /* Each from where it is, written out: an animation that takes its start from what lies under it
       cannot leave the main thread while an old one lies there finished, till that is collected. (A ring
       at 0 is held there: it may be on its way in.) */
    const sink = (el: Element | null | undefined, px: number) => {
      if (!el) return;
      const from = +getComputedStyle(el).opacity;
      if (own) L.anims.push(el.animate([{ translate: '0px 0px' }, { translate: `0px ${px * p}px` }], { duration: OPEN_MS, easing: OPEN_EASE, fill: 'forwards' }));
      L.anims.push(el.animate([{ opacity: from }, { opacity: 0 }], { duration: OPEN_FADE_MS, easing: 'linear', fill: 'forwards' }));
      L.faded.push(el);
    };
    sink(trackRef.current, OPEN_ROWS_PX);
    ringRefs.current.forEach((ring) => sink(ring, OPEN_ROWS_PX));
    /* Nothing more is written meanwhile: at rest over the featured card that would be both panels. */
    dropWrites();
    window.clearTimeout(tm.rest);
    const els = infoRefs.current as HTMLDivElement[];
    const panel = els[I.front];
    if (feat) L.held = I.keys[I.front];
    writeInfo(I.front, it, rows[s.row], s.col);
    L.panel = panel;
    L.art = feat || !it.bgArt ? '' : bgSrc(it);
    if (!feat) artNow(bgSrc(it));
    /* The panel from where it is (it may still be on its way in), held by its top from here, so that
       what opens in it opens downward; the title screen's block where it will rise to, a whole number
       of pixels above, so the two are drawn alike. The other panel, if it is still going out, is left to
       its own fade (over 185ms after its press, about with the rows'): another fade on top of a running
       one would be ticked on the main thread. */
    const cs = getComputedStyle(panel);
    const fromO = +cs.opacity;
    const fromT = cs.transform;
    panel.style.transition = 'none';
    panel.style.opacity = feat ? '0' : '1';
    panel.style.transform = 'translate3d(0px, 0px, 0px)';
    panel.style.top = getComputedStyle(panel).top;
    panel.style.bottom = 'auto';
    const box = panel.getBoundingClientRect();
    const dy = Math.round(HEAD_Y * p - box.top);
    L.dy = dy;                                 // how far it rose — Back brings it back down from here
    document.body.style.setProperty('--pv-head-x', `${box.left}px`);
    document.body.style.setProperty('--pv-head-y', `${box.top + dy}px`);
    const to = `translate3d(0px, ${dy}px, 0px)`;
    const start = feat ? to : fromT === 'none' ? 'translate3d(0px, 0px, 0px)' : fromT;
    L.anims.push(panel.animate([{ transform: start }, { transform: to }], { duration: OPEN_MS, easing: OPEN_RISE_EASE, fill: 'forwards' }));
    if (!feat && fromO < 1) L.anims.push(panel.animate([{ opacity: fromO }, { opacity: 1 }], { duration: OPEN_FADE_MS, easing: 'linear' }));
    const head = headOf(panel);
    document.body.classList.add('pv-titled');
    tm.land = window.setTimeout(() => {
      if (feat) {
        openSynopsis(panel, false);
        L.anims.push(panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_FADE_MS, easing: 'linear', fill: 'forwards' }));
      } else openSynopsis(panel, true);
      tm.hand = window.setTimeout(handOver, feat ? OPEN_FADE_MS : EXPAND_MS);
    }, OPEN_MS);
    return head;
  };
  /* Closed: openTitle in reverse. The title screen unmounts at the press (target → null), and the panel,
     drawn the same as its head, takes the head's place at HEAD_Y in that frame and carries the way-in
     backwards — down to its home while the rows and ring rise from where they sank and the opened synopsis
     folds away. Each piece is pinned at its open end-state first, so cancelling the open's animations under
     them snaps nothing, and each clears itself to rest on arrival so no finished animation is left on the
     compositor. The ring keeps its own opacity (it waits for the remote); it only rides the rise so it
     stays on its tile. A title opened from the title screen (More Like This) leaves no panel here. */
  useEffect(() => useModal.subscribe((m) => {
    const L = leaving.current;
    const P = L.panel;
    if (L.id === '') return;
    if (m.target) {
      if (m.target.id !== L.id && P) P.style.visibility = 'hidden';
      return;
    }
    const tm = timers.current;
    [tm.land, tm.hand].forEach((id) => window.clearTimeout(id));
    document.body.classList.remove('pv-titled', 'pv-landed', 'pv-art-same');
    stopTrailer();                             // safety: never leave a bridge trailer running behind Back
    const feat = info.current.hidden;
    const sank = L.faded as HTMLElement[];
    const track = trackRef.current;
    const down = `0px ${OPEN_ROWS_PX * p}px`;
    /* Pin each piece at the open's end-state, so cancelling the open animations under them snaps nothing. */
    for (const el of sank) el.style.translate = down;
    if (track) track.style.opacity = '0';
    if (P) P.style.transform = `translate3d(0px, ${L.dy}px, 0px)`;
    L.anims.forEach((a) => a.cancel());
    /* Rise: the rows and ring come back up together, the track fading in with them. */
    for (const el of sank) {
      const a = el.animate([{ translate: down }, { translate: '0px 0px' }], { duration: OPEN_MS, easing: CLOSE_EASE, fill: 'both' });
      a.onfinish = () => { el.style.translate = ''; a.cancel(); };
    }
    if (track) {
      const a = track.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_FADE_MS, easing: 'linear', fill: 'both' });
      a.onfinish = () => { track.style.opacity = ''; a.cancel(); };
    }
    /* Down: the panel comes home from HEAD_Y, its opened synopsis folding back to two lines. */
    if (P) {
      P.style.visibility = '';
      const a = P.animate([{ transform: `translate3d(0px, ${L.dy}px, 0px)` }, { transform: 'translate3d(0px, 0px, 0px)' }], { duration: OPEN_MS, easing: CLOSE_EASE, fill: 'both' });
      a.onfinish = () => { P.style.transform = ''; P.style.top = ''; P.style.bottom = ''; a.cancel(); };
      const syn = P.querySelector<HTMLElement>('.pv-synopsis');
      const more = syn?.querySelector<HTMLElement>('.pv-more');
      const fold = () => { if (syn && L.syn) { syn.textContent = L.syn; syn.classList.remove('is-open'); } };
      if (more) more.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OPEN_FADE_MS, easing: 'linear', fill: 'forwards' }).onfinish = fold;
      else fold();
      if (feat) {
        /* Over the featured card the panel is hidden at rest: it fades out as it comes down and goes back
           to the title it held. */
        P.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OPEN_FADE_MS, easing: 'linear' });
        const c = L.held.lastIndexOf(':');
        const R = rows.find((r) => r.key === L.held.slice(0, c));
        const col = Number(L.held.slice(c + 1));
        if (R?.items[col]) writeInfo(info.current.front, R.items[col], R, col);
      }
    }
    leaving.current = notLeaving();
  }), [rows, writeInfo]);

  /* ---- ONE STEP OF THE REMOTE ---- */
  const lastStep = useRef(0);
  const step = (dir: 'up' | 'down' | 'left' | 'right', held = false) => {
    /* A directional press stops a playing trailer. (The hint is hidden only on a real move — below,
       next to apply() — so a blocked press, e.g. Left at column 0, does not make it vanish.) */
    stopTrailer();
    const s = st.current;
    const col = s.cols[s.row] ?? 0;
    if (dir === 'up') {
      /* Up off the first row goes to the bar — on a tap; a held Up stops there. */
      if (s.row === 0) { if (!held) barTarget()?.focus({ preventScroll: true }); return; }
      s.row -= 1;
    } else if (dir === 'down') {
      if (s.row < rows.length - 1) s.row += 1; else return;
    } else if (dir === 'left') {
      /* Left off the first card opens the side rail — on a tap; a held Left stops there. */
      if (col === 0) { if (!held) openRail(); return; }
      s.cols[s.row] = col - 1;
    } else if (col < rows[s.row].items.length - 1) s.cols[s.row] = col + 1;
    else return;
    /* A real move: hide the hint until the next rest re-adds `is-still` (no React render — the hint
       element stays mounted, CSS just fades it under the class). */
    rootRef.current?.classList.remove('is-still');
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
    /* A title open over the page, or on its way: the page takes no keys till it is closed. */
    if (!rows.length || leaving.current.id !== '') return;
    if (e.key === 'Enter') {
      if (e.repeat) return;                    // the OS repeats a held OK; the hold timer is enough
      enter.current.down = true;
      /* OK while a trailer plays opens the title — never a sound toggle. On the featured row the card
         rises into the title head, so its trailer is stopped first and the title opens with no trailer.
         On a standard row the trailer plays on in the top-right backdrop and is handed to the title's
         own picture once it lands (handOver → stopTrailer), so there is no cut. */
      if (playingRef.current) {
        const it = rows[s.row].items[s.cols[s.row] ?? 0];
        enter.current.held = true;             // this press is spent; the keyup must not also tap-open
        if (s.row === featAt) stopTrailer();    // featured: the card rises into the head; no carry-over
        else document.body.classList.add('pv-trailer-bg'); // standard: the trailer plays on as the backdrop
        openPv(rows[s.row], it);
        return;
      }
      const it = rows[s.row].items[s.cols[s.row] ?? 0];
      const canTrail = trailersOn && !!trailerUrl && !!it.imdb && it.imdb === dwelt?.imdb;
      if (!canTrail) {
        /* No trailer to offer — open at once, as OK always did. */
        openPv(rows[s.row], it);
        return;
      }
      /* A trailer is ready: wait to tell a tap (opens the title) from a hold (plays the trailer). */
      const en = enter.current;
      en.held = false;
      window.clearTimeout(en.timer);
      en.timer = window.setTimeout(() => { en.timer = 0; en.held = true; playTrailer(); }, TRAILER_HOLD_MS);
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
    if (e.key === 'Enter') {
      const en = enter.current;
      window.clearTimeout(en.timer);
      en.timer = 0;
      /* Released before the hold fired, and nothing is playing: it was a tap — open the title. (Not if
         the press itself opened it: its title screen mounts a frame later, so this keyup still lands here.) */
      if (en.down && !en.held && !playingRef.current && leaving.current.id === '') {
        const s = st.current;
        const it = rows[s.row]?.items[s.cols[s.row] ?? 0];
        if (it) openPv(rows[s.row], it);
      }
      en.held = false;
      en.down = false;
      return;
    }
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
      className={kind === 'myspace' ? 'pv is-myspace' : 'pv'}
      tabIndex={-1}
      data-tv-noscroll=""
      style={{ ['--p' as string]: `${p}px` }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={() => { document.body.classList.toggle('pv-deep', st.current.row > 0); reveal(); apply(); }}
      /* The key that took the remote out (Left into the rail, Up into the bar) is let go out there: its
         keyup never comes here, so it is let go here, or the next press of it reads as a hold. */
      onBlur={() => {
        const h = held.current;
        if (!h.key) return;
        h.key = '';
        window.clearTimeout(h.timer);
        h.timer = 0;
        fillPending();
      }}
    >
      {/* THE PAGE BEFORE ITS PICTURES: grey shapes UNDER it (first in paint order); the page fades in over them. */}
      <div className="pv-skel" ref={skelRef} aria-hidden="true">
        <div className="pv-skel-glide">
          {(kind === 'myspace' ? SKELETON_MYSPACE : SKELETON).map(([x, y, w, h, r], i) => (
            <div
              key={i}
              className="pv-sk"
              style={{ left: `calc(${x} * var(--p))`, top: `calc(${y} * var(--p))`, width: `calc(${w} * var(--p))`, height: `calc(${h} * var(--p))`, borderRadius: `calc(${r} * var(--p))` }}
            />
          ))}
        </div>
      </div>
      <div className="pv-show">
        {/* THE BACKGROUND: two boxes top-right that the focused title's picture alternates between. */}
        {[0, 1].map((i) => (
          <div key={i} className="pv-row-art" ref={(el) => { rowArtRefs.current[i] = el; }}>
            <canvas />
          </div>
        ))}
        {/* A held trailer mounts here — OVER the backdrop still but UNDER its fade and the title panel,
            so the standard row's gradient and wordmark stay drawn over the moving trailer. */}
        <div ref={artSlotRef} className="pv-trailer-slot" aria-hidden="true" />
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
          </div>
        ))}

        <div className="pv-track" ref={trackRef}>
          {rows.map((r, i) => <PvRowView key={r.key} row={r} i={i} setRowEl={setRowEl} />)}
        </div>

        {/* The focus ring stands still: the focused tile, or the featured card, is always pinned under it. */}
        <div className="pv-ring" ref={(el) => { ringRefs.current[0] = el; }} />
        <div className="pv-ring is-big is-off" ref={(el) => { ringRefs.current[1] = el; }} />
      </div>

      {/* "Hold select for trailer" hint — hidden for now (the user's call). To bring it back, restore the
          `.pv-hint` block below (Prime-Video style, bottom-right of the hero; CSS + i18n are still in
          place) and re-add the `dweltFeat` state (set in rest()) that its `.is-feat` modifier needs:
          {trailersOn && !!trailerUrl && !playing && (
            <div className={`pv-hint${dweltFeat ? ' is-feat' : ''}`} aria-hidden="true">
              <svg className="pv-hint-ic" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="3.4" fill="currentColor" />
              </svg>
              <span>{t('pv.holdForTrailer')}</span>
            </div>
          )} */}

    </div>
  );
}
