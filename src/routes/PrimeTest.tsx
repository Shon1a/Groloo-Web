import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useHome, useWarmDetail } from '../lib/queries';
import { useT } from '../i18n/i18n';
import { HOME_ROWS } from '../lib/home';
import { imgW } from '../lib/img';
import { barItemHere, setPageEntry } from '../lib/tvBar';
import { registerBackHandler } from '../lib/tvKeys';
import { quietFor, whenQuiet } from '../lib/tvQuiet';
import { useModal, openItem } from '../stores/modal';
import { usePlayer } from '../stores/player';
import type { MediaItem } from '../lib/types';
import '../styles/prime.css';

/* PRIME TEST — a TEST PAGE, on the TV bar between Anime and My Space: the Prime Video living-room
 * home, laid out and moving the way the real app does in a 1080p60 capture of it (YouTube
 * WbGGXCXVaoM from 4:02, measured frame by frame — tile positions by template matching, row motion
 * by phase correlation, fades by the brightness of each region per frame). All numbers are TV pixels
 * at 1920x1080 and milliseconds.
 *
 * THE MOTION, AS MEASURED
 *   · Up/Down: LINEAR, 200ms per move whatever the distance (283px row to row, 306px out of the
 *     billboard, 640px into the poster carousel). Held, the moves chain end to end — one continuous
 *     glide at a row per 200ms.
 *   · Left/Right: CSS `ease`, 400ms (fits the capture to under 1%). The focused tile stays in the
 *     first slot under a ring that never moves; the row slides under it. Held, it is NOT a stream:
 *     whole 400ms steps, each starting as the last one ends.
 *   · The title panel (fades measured linearly, median of ten presses): on any move it fades out over
 *     200ms, sliding 32.5px WITH the rows and easing in; 205ms after the press the new title fades in
 *     over 210ms, sliding 30px in from where the rows come from and easing out hard — so a held key
 *     keeps it empty (vertical) or blinking per step (horizontal), as the reference does. Arriving from
 *     the billboard or a poster carousel, it comes in the same way at once. The title arrives with the
 *     rest (one late title in the capture was its picture decoding).
 *   · The background picture: dims to black 330ms after a move (150ms), and the new one fades in
 *     (200ms) only once the remote has rested 400ms.
 *   · Out of the billboard: the bar is gone in one frame, the billboard copy fades in 100ms while it
 *     scrolls up with the rows; back up, both fade in over the 200ms move.
 *   · Rows below the focused one sit at half; rows above it are gone, except the row above a poster
 *     carousel, which stays. Those changes take 100ms. The title panel is not shown on a carousel.
 *
 * THE REMOTE NEVER MOVES DOM FOCUS HERE. The page root holds focus and owns its arrows (stopped
 * before TvSpatialNav's window listener — no candidate measuring, no rects). A press writes a couple
 * of transforms, classes and text nodes; React does not render, and no picture arrives, while
 * anything moves. */

type Kind = 'tile' | 'poster' | 'top10';
type PvRow = { key: string; title: string; kind: Kind; items: MediaItem[] };
type Mode = 'hero' | 'rows';

/* x is where the focused tile's picture starts (a Top 10 tile sits right of its numeral). */
const GEO: Record<Kind, { w: number; h: number; pitch: number; x: number }> = {
  tile: { w: 384, h: 216, pitch: 416, x: 140 },
  poster: { w: 384, h: 575, pitch: 421, x: 140 },
  top10: { w: 337, h: 189, pitch: 476, x: 279 },
};
const TITLE_H = 45;
const ROW_GAP = 22;
const FOCUS_BOTTOM = 827;
const HERO_ROW_TOP = 919;
const ROW_CAP = 20;

const V_MS = 200;
const H_MS = 400;
/* The title panel. Out: fades linearly and slides away WITH the rows, easing in. In: from the side the
   rows come from, easing out — a sideways press slides it sideways, Up/Down slides it vertically. */
const OUT_MS = 200;
const OUT_PX = 32.5;
const OUT_EASE = 'cubic-bezier(.2, 0, .5, 0)';
const IN_AT = 207;
const IN_MS = 210;
const IN_SLIDE_MS = 200;
const IN_PX = 30;
const IN_EASE = 'cubic-bezier(.3, 1, .4, 1)';
/* After a tap, the next title is written into the hidden panel this late — past the press's own frame,
   so drawing it never holds up the start of the move. */
const WRITE_AT = 50;
const ART_OUT_AT = 330;
const ART_OUT_MS = 150;
const ART_IN_MS = 200;
const ART_REST_MS = 400;
const HERO_ART_AT = 370;
/* Past the longest move a press starts: React work waits for this, so it never lands mid-move. */
const SETTLE_MS = H_MS + 50;
/* Row pictures are decoded this many at a time — about a screenful — and put on each tile the moment
   its own is ready. */
const PICS_AT_ONCE = 5;
/* Meanwhile the next this many are downloading: bytes only, so a decode never waits on the network. */
const FETCH_AHEAD = 10;
/* The first of those downloads start once a vertical move is over, before the rest the decodes wait
   for (SETTLE_MS): bytes arriving draw nothing. */
const BYTES_AT = V_MS + 50;
/* The width of a tile's picture rendition (w500). */
const PIC_W = 500;
/* Real screen pixels per CSS pixel. Not devicePixelRatio alone: the webOS app's WAM reports 2 while the
   set draws 1080p, which its resolution media query does report (1dppx). */
const SCREEN_PX = window.matchMedia?.('(resolution: 1dppx)').matches ? 1 : window.devicePixelRatio || 1;
/* A remote repeats a held key every ~30-50ms; this long without one means it was let go, for the
   sets that drop a keyup. */
const REPEAT_GONE_MS = 150;

const DIRS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

const rowHeight = (r: PvRow) => TITLE_H + GEO[r.kind].h + ROW_GAP;
const isNew = (m: MediaItem) => !!m.released && Date.now() - Date.parse(m.released) < 45 * 864e5;
const votes = (n?: number) => (!n ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const statusOf = (m: MediaItem, row: PvRow, col: number) => (row.kind === 'top10' ? `#${col + 1} in Top 10`
  : isNew(m) ? (m.type === 'movie' ? 'New movie' : 'New episodes') : '');

const Check = () => (
  <span className="pv-check">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" /><path d="m7 12.5 3.2 3.2L17 9" /></svg>
    Included with Groloo
  </span>
);

/* A row never re-renders on a press or for its pictures — only when its data changes. A tile is its
 * picture alone: no wordmark over it. The picture's address waits in `data-src`; the page draws it into
 * the tile's canvas once, and only while the remote is still (below). A tile's picture is w500 for a
 * tile 384 wide: the edge's w780 WebP cost 4.5x the decoding (837ms against 184ms on a first walk
 * down, measured) for pixels the tile cannot show. */
const PvRowView = memo(function PvRowView({ row, i, setRowEl }: {
  row: PvRow;
  i: number;
  setRowEl: (i: number, el: HTMLDivElement | null) => void;
}) {
  return (
    <div className={`pv-row is-${row.kind}`} ref={(el) => setRowEl(i, el)}>
      <h2 className="pv-row-title">{row.title}</h2>
      <div className="pv-strip">
        {row.items.map((m, c) => (
          <div key={m.id} className="pv-item">
            {row.kind === 'top10' && <span className="pv-num"><span>{c + 1}</span></span>}
            <div className="pv-tile">
              <canvas className="pv-tile-art" data-src={row.kind === 'poster' ? imgW(m.poster, 'w500') : imgW(m.backdrop, 'w500')} />
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

  const hero = useMemo(() => (data?.hero?.results ?? []).find((m) => m.backdrop), [data?.hero?.results]);
  const rows = useMemo(() => {
    const list = (cat: string, need: 'backdrop' | 'poster' = 'backdrop') =>
      (data?.rows?.[cat]?.results ?? []).filter((m) => m[need]).slice(0, ROW_CAP);
    const out: PvRow[] = [];
    const push = (key: string, title: string, kind: Kind, items: MediaItem[]) => { if (items.length) out.push({ key, title, kind, items }); };
    /* The reference's order: a row of tiles under the billboard, then the poster carousel. */
    push('trending_movie', t('sec.trending_movies'), 'tile', list('trending_movie'));
    push('featured', t('tv.featured'), 'poster', list('top_tv', 'poster'));
    push('top10', 'Top 10', 'top10', list('trending_tv').slice(0, 10));
    for (const row of HOME_ROWS) {
      if (row.cat === 'trending_movie' || row.cat === 'top_tv' || row.cat === 'trending_tv') continue;
      push(row.cat, t(row.key), 'tile', list(row.cat));
    }
    return out;
  }, [data?.rows, t]);
  /* Where each row starts in the track — from the constants, never measured. */
  const rowTops = useMemo(() => {
    let y = 0;
    return rows.map((r) => { const top = y; y += rowHeight(r); return top; });
  }, [rows]);

  const [p] = useState(() => window.innerWidth / 1920);

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const heroCopyRef = useRef<HTMLDivElement>(null);
  const heroArtRef = useRef<HTMLDivElement>(null);
  const rowArtRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const infoRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const setRowEl = useCallback((i: number, el: HTMLDivElement | null) => { rowEls.current[i] = el; }, []);
  const focusEl = useRef<Element | null>(null);

  const st = useRef({ mode: 'hero' as Mode, btn: 1, row: 0, cols: [] as number[] });
  /* What is on screen now, to tell what a press changed. */
  const shown = useRef({ inRows: false, row: -1, col: -1, kind: '' as Kind | '', item: null as MediaItem | null });
  const timers = useRef({ text: 0, write: 0, ring: 0, rest: 0, artOut: 0, artIn: 0 });
  /* Whether the press being applied is a held key's step. */
  const pressHeld = useRef(false);

  /* ---- THE TITLE PANEL. Text is written straight into its nodes: no render on a press. Two panels
     take turns: while the one on screen fades out, the next title is written into the hidden one, so
     it is drawn before it has to appear. `keys`: the title each holds; `inAt`: when the front one
     comes (or came) in; `pending`: what the next in shows. ---- */
  const info = useRef({ front: 0, keys: ['', ''], inAt: 0, pending: null as null | { i: number; m: MediaItem; row: PvRow; col: number } });
  const writeInfo = useCallback((i: number, m: MediaItem, row: PvRow, col: number) => {
    const el = infoRefs.current[i];
    const key = `${row.key}:${col}`;
    if (!el || info.current.keys[i] === key) return;
    info.current.keys[i] = key;
    const q = (s: string) => el.querySelector<HTMLElement>(s)!;
    const status = statusOf(m, row, col);
    q('.pv-status').textContent = status;
    q('.pv-status').style.display = status ? '' : 'none';
    q('.pv-title').textContent = m.title ?? '';
    const stars = Math.round((m.rating ?? 0)) / 2;
    q('.pv-stars').querySelectorAll('i').forEach((s, i) => { s.className = i + 1 <= stars ? 'on' : i + 0.5 === stars ? 'half' : ''; });
    q('.pv-votes').textContent = votes(m.votes);
    q('.pv-year').textContent = m.year ? String(m.year) : '';
    q('.pv-genre').textContent = m.genre ?? '';
    q('.pv-synopsis').textContent = m.overview ?? '';
  }, []);

  const fade = (el: HTMLElement | null, to: number, ms: number, delay = 0) => {
    if (!el) return;
    el.style.transition = ms ? `opacity ${ms}ms linear ${delay}ms` : 'none';
    el.style.opacity = String(to);
  };

  const fillInfo = useCallback(() => {
    const pd = info.current.pending;
    if (pd) writeInfo(pd.i, pd.m, pd.row, pd.col);
  }, [writeInfo]);

  /* `dx, dy`: which way the rows moved (-1 left/up, 1 right/down, per axis). `held`: a held Down/Up
     steps again before the title would come in, so its text is only written once the key is let go. */
  const infoTo = useCallback((how: 'enter' | 'move' | 'hide', m?: MediaItem, row?: PvRow, col = 0, dx = 0, dy = 0, held = false) => {
    const I = info.current;
    const els = infoRefs.current as HTMLDivElement[];
    const tm = timers.current;
    if (!els[0] || !els[1]) return;
    window.clearTimeout(tm.text);
    window.clearTimeout(tm.write);
    I.pending = null;
    if (how === 'hide' || !m || !row) {
      els.forEach((el) => { el.style.transition = 'none'; el.style.opacity = '0'; });
      return;
    }
    const at = (x: number, y: number) => `translate3d(${x * p}px, ${y * p}px, 0)`;
    const now = performance.now();
    let i = I.front;
    if (how === 'enter') {
      if (I.keys[1 - i] === `${row.key}:${col}`) i = 1 - i;
    } else if (now >= I.inAt) {
      /* The front panel is on screen or coming in: it leaves with the rows and the other takes over.
         (Before its in, it is still hidden and simply takes the new title instead.) */
      const out = els[i];
      out.style.transition = `opacity ${OUT_MS}ms linear, transform ${OUT_MS}ms ${OUT_EASE}`;
      out.style.opacity = '0';
      out.style.transform = at(dx * OUT_PX, dy * OUT_PX);
      i = 1 - i;
    }
    const el = els[i];
    I.front = i;
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.transform = at(-dx * IN_PX, -dy * IN_PX);
    if (how === 'enter') writeInfo(i, m, row, col);
    /* The starting place is committed first; the in is then set in the same frame as the out, delayed,
       so the gap between them is exact. */
    void getComputedStyle(el).opacity;
    const delay = how === 'enter' ? 0 : IN_AT;
    el.style.transition = `opacity ${IN_MS}ms linear ${delay}ms, transform ${IN_SLIDE_MS}ms ${IN_EASE} ${delay}ms`;
    el.style.opacity = '1';
    el.style.transform = at(0, 0);
    I.inAt = now + delay;
    if (how === 'enter') return;
    I.pending = { i, m, row, col };
    if (!(held && dy)) tm.write = window.setTimeout(fillInfo, WRITE_AT);
    /* A set that drops the keyup after a hold: the text, at the latest as it shows. */
    tm.text = window.setTimeout(fillInfo, IN_AT);
  }, [p, writeInfo, fillInfo]);

  /* ---- THE BACKGROUND PICTURE: the billboard's, or the focused title's in the box top-right. ---- */
  const art = useRef({ want: '' as string, shown: 'hero' as string, layer: -1, visible: true, outEnd: 0, token: 0, lastChange: 0 });
  const artLayer = (layer: number) => (layer < 0 ? heroArtRef.current : rowArtRefs.current[layer]);
  const artTo = useCallback((want: string) => {
    const a = art.current;
    const tm = timers.current;
    a.want = want;
    a.token += 1;
    a.lastChange = performance.now();
    window.clearTimeout(tm.artIn);
    if (a.visible && a.shown === want) { window.clearTimeout(tm.artOut); tm.artOut = 0; return; }
    if (a.visible && !tm.artOut) {
      tm.artOut = window.setTimeout(() => {
        tm.artOut = 0;
        fade(artLayer(a.layer), 0, ART_OUT_MS);
        a.visible = false;
        a.outEnd = performance.now() + ART_OUT_MS;
      }, ART_OUT_AT);
    }
    if (!want) return;
    const token = a.token;
    const tryIn = () => {
      if (token !== a.token) return;
      const now = performance.now();
      const ready = Math.max(a.lastChange + (want === 'hero' ? HERO_ART_AT : ART_REST_MS), a.visible || tm.artOut ? Infinity : a.outEnd);
      if (now < ready) { tm.artIn = window.setTimeout(tryIn, ready === Infinity ? 50 : ready - now); return; }
      if (want === 'hero') {
        fade(heroArtRef.current, 1, ART_IN_MS);
        a.shown = 'hero'; a.layer = -1; a.visible = true;
        return;
      }
      const next = a.layer === 0 ? 1 : 0;
      const box = rowArtRefs.current[next];
      const img = box?.querySelector('img');
      if (!box || !img) return;
      const pic = new Image();
      pic.src = want;
      pic.decode().catch(() => { /* show it anyway */ }).then(() => {
        if (token !== a.token) return;
        img.src = want;
        fade(box, 1, ART_IN_MS);
        a.shown = want; a.layer = next; a.visible = true;
      });
    };
    tryIn();
  }, []);

  /* ONE PRESS = THIS. Works out what changed and writes only that. */
  const apply = useCallback(() => {
    const s = st.current;
    const was = shown.current;
    const root = rootRef.current;
    const track = trackRef.current;
    if (!root || !track || !rows.length) return;
    const px = (n: number) => Math.round(n * p);
    const inRows = s.mode === 'rows';
    const row = rows[s.row];
    const g = GEO[row.kind];
    const col = s.cols[s.row] ?? 0;
    const item = row.items[col];

    root.classList.toggle('is-rows', inRows);
    document.body.classList.toggle('pv-rows', inRows);
    const btn = s.mode === 'hero' ? String(s.btn) : '';
    if (root.dataset.btn !== btn) root.dataset.btn = btn;

    /* The page scrolls as one: the rows, and the billboard copy riding on them. */
    const heroY = HERO_ROW_TOP - (rowTops[0] + TITLE_H);
    const y = inRows ? FOCUS_BOTTOM - (rowTops[s.row] + TITLE_H + g.h) : heroY;
    track.style.transform = `translate3d(0, ${px(y)}px, 0)`;
    if (heroCopyRef.current) heroCopyRef.current.style.transform = `translate3d(0, ${px(y - heroY)}px, 0)`;

    /* Rows below the billboard are already dim while they are off screen, so a press only ever
       re-fades the two or three rows that can be seen. */
    rowEls.current.forEach((el, i) => {
      if (!el) return;
      const above = inRows && (i < s.row - 1 || (i === s.row - 1 && row.kind !== 'poster'));
      el.classList.toggle('is-gone', above);
      el.classList.toggle('is-dim', i !== (inRows ? s.row : 0) && !above);
    });
    const strip = rowEls.current[s.row]?.lastElementChild as HTMLElement | null;
    if (strip) strip.style.transform = `translate3d(${-px(col * g.pitch)}px, 0, 0)`;
    const next = inRows ? strip?.children[col] ?? null : null;
    if (focusEl.current !== next) {
      focusEl.current?.classList.remove('is-focus');
      next?.classList.add('is-focus');
      focusEl.current = next;
    }

    /* The ring stands still. It only moves — hidden, and shown again when the rows land — when the
       focused row is of another kind, or the remote has just come down out of the billboard. */
    const ring = ringRef.current;
    if (ring) {
      const ringOn = inRows;
      const sameKind = was.inRows && was.kind === row.kind;
      window.clearTimeout(timers.current.ring);
      if (!ringOn) ring.classList.remove('on');
      else if (sameKind) ring.classList.add('on');
      else {
        ring.classList.remove('on');
        ring.style.left = `${px(g.x - 7)}px`;
        ring.style.top = `${px(FOCUS_BOTTOM - g.h - 7)}px`;
        ring.style.width = `${px(g.w + 14)}px`;
        ring.style.height = `${px(g.h + 14)}px`;
        timers.current.ring = window.setTimeout(() => ring.classList.add('on'), V_MS);
      }
    }

    const moved = inRows !== was.inRows || s.row !== was.row || col !== was.col;
    if (moved) {
      if (!inRows) infoTo('hide');
      else if (row.kind === 'poster') infoTo('hide');
      /* The rows move against the press: Right slides them left, Down slides them up. */
      else if (!was.inRows || was.kind === 'poster') infoTo('enter', item, row, col, 0, !was.inRows || s.row > was.row ? -1 : 1);
      else if (s.row !== was.row) infoTo('move', item, row, col, 0, s.row > was.row ? -1 : 1, pressHeld.current);
      else infoTo('move', item, row, col, col > was.col ? -1 : 1, 0, pressHeld.current);
      artTo(!inRows ? 'hero' : row.kind === 'poster' ? '' : imgW(item.backdrop, 'w1280'));
    }
    shown.current = { inRows, row: s.row, col, kind: inRows ? row.kind : '', item: inRows ? item : null };

    /* Once everything has stopped moving, the title the remote rests on gets its title screen ready
       (detail, backdrop, wordmark) — so OK opens it at once, on the picture already here. */
    const rested = inRows ? item : hero;
    /* Where the panel is hidden — the billboard, a poster carousel — the titles a press could bring in
       are written ahead into the two panels, so that press only has to show one. */
    const ahead = !inRows ? [0] : row.kind === 'poster' ? [s.row - 1, s.row + 1] : [];
    window.clearTimeout(timers.current.rest);
    timers.current.rest = window.setTimeout(() => {
      warm(rested, undefined, () => (shown.current.inRows ? shown.current.item : hero) === rested);
      ahead.forEach((r, i) => {
        const c = s.cols[r] ?? 0;
        if (rows[r] && rows[r].kind !== 'poster' && !info.current.keys.includes(`${rows[r].key}:${c}`)) writeInfo(i, rows[r].items[c], rows[r], c);
      });
    }, SETTLE_MS);
  }, [rows, rowTops, p, infoTo, writeInfo, artTo, hero, warm]);

  useLayoutEffect(() => { apply(); }, [apply]);
  useEffect(() => {
    document.body.classList.add('pv-page');
    const tm = timers.current;
    return () => {
      document.body.classList.remove('pv-page', 'pv-rows');
      Object.values(tm).forEach((id) => window.clearTimeout(id));
    };
  }, []);

  /* ---- THE ROWS' PICTURES ARRIVE ONLY WHILE THE REMOTE IS STILL ----
     A picture arriving costs its strip a paint, a decode and a raster. They used to be put on whole
     rows at once the moment the remote rested, so a run to the bottom set off two hundred of them, and
     they landed in the run back up (measured: ~210 decodes, ~730ms of decoding and a 44ms main-thread
     task inside that move; now none, and 3ms). Nothing is put on a tile while anything moves, and
     nothing is downloaded while the rows do: the bytes for what is on screen start as a vertical move
     ends (BYTES_AT). Once the remote has been still SETTLE_MS the pictures come nearest first — what
     is on screen, then the rows below and above, then further along — a few decoding at a time with
     the next ones' bytes already downloading, each tile taking its picture the moment its own is
     decoded, and only while the remote is still still. (They used to come five at a time, each five
     waiting for the five before, so the row below waited on the network behind tiles off screen —
     measured with every picture 150ms away: the screen after a press down was whole at ~1.0s, now
     ~0.49s; after a run down ~1.0-1.3s, now ~0.5-0.6s; dropped frames while tapping unchanged.) A press
     stops it where it is and the next rest picks it up; a run past rows that have no pictures yet
     shows their empty tiles, as the reference does.
     DECODED ONCE, AND KEPT. An <img> leaves its decoded pixels to the browser, which keeps them in a
     cache with a budget: on a TV-sized one (PC at --force-gpu-mem-discardable-limit-mb=16) the second
     walk down decoded 42 of the first walk's 78 pictures again. A tile holds its own pixels instead: the
     picture is decoded off the main thread at the tile's size (createImageBitmap) and drawn into its
     canvas once — after that the browser only ever copies it to the screen, never decodes it again
     (the user's call, Oct 29: once a picture is here it costs nothing). The canvas is CPU-backed
     (`willReadFrequently`), so it is painted into its strip's layer as the picture was, not made a GPU
     layer of its own. That holds ~330KB per tile at 1080p, ~100MB for the page while it is open. */
  useEffect(() => {
    if (!rows.length) return;
    let dead = false;
    let running = false;
    let cancel = () => {};
    /* Decoded, but a press came before it could be drawn: drawn at the next rest. */
    const ready = new Map<HTMLCanvasElement, { url: string; bmp: ImageBitmap | null }>();
    const still = () => !dead && quietFor() >= SETTLE_MS;
    /* A picture's bytes, downloaded once; kept until it is decoded. */
    const blobs = new Map<string, Promise<Blob | null>>();
    const bytes = (url: string) => {
      let b = blobs.get(url);
      if (!b) {
        b = fetch(url).then((res) => (res.ok ? res.blob() : null), () => null);
        blobs.set(url, b);
      }
      return b;
    };
    const pixels = async (url: string, w: number, h: number): Promise<ImageBitmap | null> => {
      const size: ImageBitmapOptions = { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' };
      const blob = await bytes(url);
      blobs.delete(url);
      try {
        if (blob) return await createImageBitmap(blob, size);
      } catch { /* not one this browser decodes from bytes */ }
      /* A host that will not let it be read: through a picture element instead. */
      return new Promise((done) => {
        const im = new Image();
        im.onload = () => { createImageBitmap(im, size).then(done, () => done(null)); };
        im.onerror = () => done(null);
        im.src = url;
      });
    };
    const draw = (cv: HTMLCanvasElement) => {
      const got = ready.get(cv);
      ready.delete(cv);
      if (!got || got.url !== cv.dataset.src) { got?.bmp?.close(); return; }
      cv.dataset.on = got.url;
      if (!got.bmp) return;
      cv.width = got.bmp.width;
      cv.height = got.bmp.height;
      cv.getContext('2d', { willReadFrequently: true })?.drawImage(got.bmp, 0, 0);
      got.bmp.close();
    };
    /* The tiles still without their picture, nearest first: `d` rows from the focus (below before
       above) and `k` screenfuls along its row from where that row's focus is — at the same distance,
       what is on screen first. Each comes with the size its canvas is drawn at: the tile in real
       screen pixels, never more than the w500 picture has. */
    const plan = () => {
      const s = st.current;
      const f = s.mode === 'rows' ? s.row : 0;
      const todo: { cv: HTMLCanvasElement; w: number; h: number; d: number; k: number }[] = [];
      rows.forEach((row, r) => {
        const tiles = rowEls.current[r]?.querySelectorAll<HTMLCanvasElement>('.pv-tile-art');
        if (!tiles) return;
        const g = GEO[row.kind];
        const scale = Math.min(p * SCREEN_PX, PIC_W / g.w);
        const w = Math.round(g.w * scale);
        const h = Math.round(g.h * scale);
        const col = s.cols[r] ?? 0;
        const d = r >= f ? r - f : f - r + 0.5;
        tiles.forEach((cv, c) => {
          if (!cv.dataset.src || cv.dataset.on === cv.dataset.src) return;
          const off = c < col ? col - c : Math.max(0, c - col - (PICS_AT_ONCE - 1));
          todo.push({ cv, w, h, d, k: Math.ceil(off / PICS_AT_ONCE) });
        });
      });
      return todo.sort((a, b) => a.d + a.k - (b.d + b.k) || a.k - b.k || a.d - b.d);
    };
    const fetchFrom = (todo: ReturnType<typeof plan>, at: number, n: number) =>
      todo.slice(at, at + n).forEach((t) => { if (!ready.has(t.cv)) void bytes(t.cv.dataset.src!); });
    const pump = async () => {
      if (running) return;
      running = true;
      const todo = plan();
      let next = 0;
      const lane = async () => {
        while (next < todo.length && still()) {
          const { cv, w, h } = todo[next++];
          fetchFrom(todo, next, FETCH_AHEAD);
          if (!ready.has(cv)) {
            const url = cv.dataset.src!;
            const bmp = await pixels(url, w, h);
            if (dead) { bmp?.close(); return; }
            ready.set(cv, { url, bmp });
          }
          if (still()) draw(cv);
        }
      };
      await Promise.all(Array.from({ length: PICS_AT_ONCE }, lane));
      running = false;
      if (!dead && plan().length) arm();
    };
    const arm = () => {
      cancel();
      const early = whenQuiet(() => fetchFrom(plan(), 0, PICS_AT_ONCE + FETCH_AHEAD), BYTES_AT, true);
      const rest = whenQuiet(() => { void pump(); }, SETTLE_MS, true);
      cancel = () => { early(); rest(); };
    };
    arm();
    return () => {
      dead = true;
      cancel();
      ready.forEach((got) => got.bmp?.close());
    };
  }, [rows, p]);

  /* Down from the bar lands on the page root, which holds focus for the whole page. */
  useEffect(() => setPageEntry(() => rootRef.current), []);

  /* Back from the rows goes back up to the billboard — not while a title or the player is open over
   * the page, whose own Back comes first. */
  useEffect(() => registerBackHandler(() => {
    if (useModal.getState().target || usePlayer.getState().source) return false;
    const s = st.current;
    if (s.mode === 'hero') return false;
    s.mode = 'hero';
    s.btn = 1;
    apply();
    return true;
  }, 100), [apply]);

  /* ---- ONE STEP OF THE REMOTE ---- */
  const lastStep = useRef(0);
  const step = (dir: 'up' | 'down' | 'left' | 'right', held = false) => {
    const s = st.current;
    if (s.mode === 'hero') {
      if (dir === 'up') {
        if (s.btn === 1) s.btn = 0;
        else { barItemHere()?.focus({ preventScroll: true }); return; }
      } else if (dir === 'down') {
        if (s.btn === 0) s.btn = 1; else s.mode = 'rows';
      } else return;
    } else if (s.mode === 'rows') {
      const col = s.cols[s.row] ?? 0;
      if (dir === 'up') {
        if (s.row === 0) { s.mode = 'hero'; s.btn = 1; } else s.row -= 1;
      } else if (dir === 'down') {
        if (s.row < rows.length - 1) s.row += 1; else return;
      } else if (dir === 'left') {
        if (col === 0) return;
        s.cols[s.row] = col - 1;
      } else if (col < rows[s.row].items.length - 1) s.cols[s.row] = col + 1;
      else return;
    }
    lastStep.current = performance.now();
    pressHeld.current = held;
    apply();
  };

  /* A TAP STEPS AT ONCE; A HOLD STEPS WHEN THE LAST MOVE ENDS. A tap during a move retargets it, as
   * the reference does. A held key does not step on every repeat: the next move starts the moment the
   * running one ends (200ms vertically, 400ms along a row), which is what makes a held Down one
   * continuous glide and a held Right a run of whole steps. */
  const held = useRef({ key: '', lastRepeat: 0, timer: 0 });
  const stepMs = (dir: string) => (st.current.mode !== 'rows' ? V_MS : dir === 'up' || dir === 'down' ? V_MS : H_MS);
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
      if (s.mode === 'hero') { if (hero) openModal(openItem(hero)); }
      else openModal(openItem(rows[s.row].items[s.cols[s.row] ?? 0]));
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
    const left = stepMs(dir) - (now - lastStep.current);
    if (left <= 0) step(dir, true);
    else if (!h.timer) h.timer = window.setTimeout(chain, left);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const h = held.current;
    if (e.key !== h.key) return;
    h.key = '';
    window.clearTimeout(h.timer);
    h.timer = 0;
    fillInfo();
  };

  return (
    <div
      ref={rootRef}
      className="pv"
      tabIndex={-1}
      style={{ ['--p' as string]: `${p}px` }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={(e) => {
        /* Down out of the bar lands on the billboard's first button, as on the reference. */
        if (st.current.mode === 'hero' && (e.relatedTarget as Element | null)?.closest?.('.tv-topnav')) st.current.btn = 0;
        apply();
      }}
    >
      {/* THE BACKGROUND: the billboard's picture full screen, and two boxes top-right that the
          focused title's picture alternates between. */}
      <div className="pv-hero-art" ref={heroArtRef}>
        {hero && <img src={imgW(hero.backdrop, 'w1280')} alt="" decoding="async" />}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="pv-row-art" ref={(el) => { rowArtRefs.current[i] = el; }}>
          <img alt="" decoding="async" />
        </div>
      ))}

      {/* THE BILLBOARD COPY — rides up with the rows. */}
      <div className="pv-hero-copy" ref={heroCopyRef}>
        {hero && (
          <>
            <div className="pv-logo-box">
              {hero.titleLogo
                ? <img className="pv-logo" src={imgW(hero.titleLogo, 'w500')} alt={hero.title} />
                : <span className="pv-logo-text">{hero.title}</span>}
            </div>
            <p className="pv-status">{isNew(hero) ? (hero.type === 'movie' ? 'New movie' : 'New season') : hero.genre}</p>
            <p className="pv-hero-synopsis">{hero.overview}</p>
            <span className="pv-btn pv-btn-more">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6M12 7.5v.5" /></svg>
              More details
            </span>
            <span className={`pv-btn pv-btn-play${hero.type === 'movie' ? '' : ' is-two'}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>
              <span>{hero.type === 'movie' ? 'Watch now' : <>Episode 1<br />Watch now</>}</span>
            </span>
            <Check />
            {hero.rating ? <span className="pv-badge">★ {hero.rating.toFixed(1)}</span> : null}
          </>
        )}
      </div>

      {/* THE FOCUSED TITLE'S PANEL, twice (they take turns) — bottom-anchored, filled in by writeInfo. */}
      {[0, 1].map((n) => (
        <div key={n} className="pv-info" ref={(el) => { infoRefs.current[n] = el; }}>
          <p className="pv-title" />
          <p className="pv-status" />
          <p className="pv-meta">
            <span className="pv-stars">{[0, 1, 2, 3, 4].map((i) => <i key={i}>★</i>)}</span>
            <span className="pv-votes" />
            <span className="pv-year" />
            <span className="pv-genre" />
          </p>
          <p className="pv-synopsis" />
          <Check />
        </div>
      ))}

      <div className="pv-track" ref={trackRef}>
        {rows.map((r, i) => <PvRowView key={r.key} row={r} i={i} setRowEl={setRowEl} />)}
      </div>

      {/* The focus ring stands still: the focused tile is always pinned under it. */}
      <div className="pv-ring" ref={ringRef} />
    </div>
  );
}
