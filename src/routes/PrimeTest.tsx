import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../lib/queries';
import { useT } from '../i18n/i18n';
import { HOME_ROWS } from '../lib/home';
import { imgW } from '../lib/img';
import { barItemHere, setPageEntry } from '../lib/tvBar';
import { registerBackHandler } from '../lib/tvKeys';
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
 *   · The title panel: out over 200ms on any move, the new title in over 180ms from 240ms — so a held
 *     key keeps it empty (vertical) or blinking per step (horizontal), as the reference does.
 *   · The background picture: dims to black 330ms after a move (150ms), and the new one fades in
 *     (200ms) only once the remote has rested 400ms.
 *   · Out of the billboard: the bar is gone in one frame, the billboard copy fades in 100ms while it
 *     scrolls up with the rows; back up, both fade in over the 200ms move.
 *   · Rows below the focused one sit at half; rows above it are gone, except the row above a poster
 *     carousel, which stays. Those changes take 100ms. The title panel is not shown on a carousel.
 *
 * THE REMOTE NEVER MOVES DOM FOCUS HERE. The page root holds focus and owns its arrows (stopped
 * before TvSpatialNav's window listener — no candidate measuring, no rects). A press writes a couple
 * of transforms, classes and text nodes; React renders only when the remote has rested and a row
 * needs more pictures. */

type Kind = 'tile' | 'poster' | 'top10';
type PvRow = { key: string; title: string; kind: Kind; items: MediaItem[] };
type Mode = 'hero' | 'rows' | 'side';

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
const TEXT_OUT_MS = 200;
const TEXT_SWAP_MS = 240;
const TEXT_IN_MS = 180;
const ENTER_DELAY_MS = 100;
const ENTER_MS = 130;
const ART_OUT_AT = 330;
const ART_OUT_MS = 150;
const ART_IN_MS = 200;
const ART_REST_MS = 400;
const HERO_ART_AT = 370;
/* Past the longest move a press starts: React work waits for this, so it never lands mid-move. */
const SETTLE_MS = H_MS + 50;
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

/* A row never re-renders on a press — only when its data changes, or the remote first comes near it and it
 * gets its pictures (the whole row at once, so a walk along it never renders). A tile is its picture
 * alone: no wordmark over it. */
const PvRowView = memo(function PvRowView({ row, i, drawn, setRowEl }: {
  row: PvRow;
  i: number;
  drawn: boolean;
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
              {drawn && <img className="pv-tile-art" src={row.kind === 'poster' ? imgW(m.poster, 'w500') : imgW(m.backdrop, 'w780')} alt="" decoding="async" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default function PrimeTest() {
  const t = useT();
  const nav = useNavigate();
  const { data } = useHome();
  const openModal = useModal((s) => s.open);

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
  const [reach, setReach] = useState(1);

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const heroCopyRef = useRef<HTMLDivElement>(null);
  const heroArtRef = useRef<HTMLDivElement>(null);
  const rowArtRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const infoRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const setRowEl = useCallback((i: number, el: HTMLDivElement | null) => { rowEls.current[i] = el; }, []);
  const focusEl = useRef<Element | null>(null);

  const st = useRef({ mode: 'hero' as Mode, back: 'hero' as Mode, btn: 1, side: 0, row: 0, cols: [] as number[] });
  /* What is on screen now, to tell what a press changed. */
  const shown = useRef({ inRows: false, row: -1, col: -1, kind: '' as Kind | '', item: null as MediaItem | null });
  const timers = useRef({ text: 0, ring: 0, rest: 0, artOut: 0, artIn: 0 });

  /* ---- THE TITLE PANEL. Text is written straight into its nodes: no render on a press. ---- */
  const writeInfo = useCallback((m: MediaItem, row: PvRow, col: number) => {
    const el = infoRef.current;
    if (!el) return;
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

  const infoTo = useCallback((how: 'enter' | 'move' | 'hide', m?: MediaItem, row?: PvRow, col = 0) => {
    const el = infoRef.current;
    if (!el) return;
    window.clearTimeout(timers.current.text);
    if (how === 'hide' || !m || !row) { el.style.transform = ''; fade(el, 0, 0); return; }
    if (how === 'enter') {
      writeInfo(m, row, col);
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translate3d(0, 20px, 0)';
      requestAnimationFrame(() => {
        el.style.transition = `opacity ${ENTER_MS}ms linear ${ENTER_DELAY_MS - 16}ms, transform ${ENTER_MS}ms linear ${ENTER_DELAY_MS - 16}ms`;
        el.style.opacity = '1';
        el.style.transform = 'translate3d(0, 0, 0)';
      });
      return;
    }
    el.style.transform = '';
    fade(el, 0, TEXT_OUT_MS);
    timers.current.text = window.setTimeout(() => {
      writeInfo(m, row, col);
      fade(el, 1, TEXT_IN_MS);
    }, TEXT_SWAP_MS);
  }, [writeInfo]);

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
    const inRows = s.mode === 'rows' || (s.mode === 'side' && s.back === 'rows');
    const row = rows[s.row];
    const g = GEO[row.kind];
    const col = s.cols[s.row] ?? 0;
    const item = row.items[col];

    root.classList.toggle('is-rows', inRows);
    document.body.classList.toggle('pv-rows', inRows);
    const btn = s.mode === 'hero' ? String(s.btn) : '';
    const side = s.mode === 'side' ? String(s.side) : '';
    if (root.dataset.btn !== btn) root.dataset.btn = btn;
    if (root.dataset.side !== side) root.dataset.side = side;

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
      const ringOn = s.mode === 'rows';
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
      else if (!was.inRows) infoTo('enter', item, row, col);
      else infoTo('move', item, row, col);
      artTo(!inRows ? 'hero' : row.kind === 'poster' ? '' : imgW(item.backdrop, 'w1280'));
    }
    shown.current = { inRows, row: s.row, col, kind: inRows ? row.kind : '', item: inRows ? item : null };

    /* The rows below get their pictures once everything has stopped moving. */
    window.clearTimeout(timers.current.rest);
    timers.current.rest = window.setTimeout(() => setReach((n) => Math.max(n, s.row + 2)), SETTLE_MS);
  }, [rows, rowTops, p, infoTo, artTo]);

  useLayoutEffect(() => { apply(); }, [apply]);
  useEffect(() => {
    document.body.classList.add('pv-page');
    const tm = timers.current;
    return () => {
      document.body.classList.remove('pv-page', 'pv-rows');
      Object.values(tm).forEach((id) => window.clearTimeout(id));
    };
  }, []);

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
  const step = (dir: 'up' | 'down' | 'left' | 'right') => {
    const s = st.current;
    if (s.mode === 'hero') {
      if (dir === 'up') {
        if (s.btn === 1) s.btn = 0;
        else { barItemHere()?.focus({ preventScroll: true }); return; }
      } else if (dir === 'down') {
        if (s.btn === 0) s.btn = 1; else s.mode = 'rows';
      } else if (dir === 'left') { s.back = 'hero'; s.mode = 'side'; } else return;
    } else if (s.mode === 'rows') {
      const col = s.cols[s.row] ?? 0;
      if (dir === 'up') {
        if (s.row === 0) { s.mode = 'hero'; s.btn = 1; } else s.row -= 1;
      } else if (dir === 'down') {
        if (s.row < rows.length - 1) s.row += 1; else return;
      } else if (dir === 'left') {
        if (col === 0) { s.back = 'rows'; s.mode = 'side'; } else s.cols[s.row] = col - 1;
      } else if (col < rows[s.row].items.length - 1) s.cols[s.row] = col + 1;
      else return;
    } else {
      if (dir === 'up') s.side = Math.max(0, s.side - 1);
      else if (dir === 'down') s.side = Math.min(2, s.side + 1);
      else if (dir === 'right') s.mode = s.back;
      else return;
    }
    lastStep.current = performance.now();
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
    step(DIRS[h.key]);
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
      else if (s.mode === 'rows') openModal(openItem(rows[s.row].items[s.cols[s.row] ?? 0]));
      else nav(['/explore', '/movies', '/library'][s.side]);
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
    if (left <= 0) step(dir);
    else if (!h.timer) h.timer = window.setTimeout(chain, left);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const h = held.current;
    if (e.key !== h.key) return;
    h.key = '';
    window.clearTimeout(h.timer);
    h.timer = 0;
  };

  const sideIcons = [
    <svg key="s" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>,
    <svg key="g" viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.2" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" /></svg>,
    <svg key="b" viewBox="0 0 24 24"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" /></svg>,
  ];

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

      {/* THE FOCUSED TITLE'S PANEL — bottom-anchored, filled in by writeInfo. */}
      <div className="pv-info" ref={infoRef}>
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

      <div className="pv-track" ref={trackRef}>
        {rows.map((r, i) => <PvRowView key={r.key} row={r} i={i} drawn={i <= reach} setRowEl={setRowEl} />)}
      </div>

      {/* The focus ring stands still: the focused tile is always pinned under it. */}
      <div className="pv-ring" ref={ringRef} />

      <div className="pv-side">
        {sideIcons.map((ic, i) => <span key={i} className="pv-side-btn">{ic}</span>)}
      </div>
    </div>
  );
}
