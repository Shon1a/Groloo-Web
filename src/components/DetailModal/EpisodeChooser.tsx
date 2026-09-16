import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../../i18n/i18n';
import { imgW } from '../../lib/img';
import { useSeason } from '../../lib/queries';
import { useHistory } from '../../stores/history';
import SeasonSelect from './SeasonSelect';
import {
  STEP_DOWN, STILL_RENDITION, WATCHED, aboveExtent, belowExtent, dur, place, runtimeText, seasonsOf,
} from './deckGeometry';
import type { Episode, MetaDetail } from '../../lib/types';

/* ============================================================================
 * THE WEB EPISODE DECK — the TV's stack of cards, driven by a wheel, a mouse and a finger.
 *
 * WHAT REPLACED WHAT. This was a column of `[still] E3  Title` rows, one per episode, which
 * is the honest shape of a list and the wrong shape for a season: a viewer half way through a
 * show wants ONE episode — the next one — and a list of twenty-four identical rows makes them
 * read to find it, then scroll past the rest to reach the sources. The deck (see the picture in
 * deckGeometry.ts) puts that episode forward at full size, with its still, how much of it is
 * left and a progress bar, tucks the earlier ones into a stack behind it and fans the coming
 * ones out below. Same object as the TV's TvEpisodeDeck, same numbers — deckGeometry is shared —
 * so a title looks the same on the sofa and at the desk.
 *
 * WHAT IS DIFFERENT FROM THE TV IS ONLY THE INPUT, and each input gets the gesture it already
 * knows rather than a control invented for the deck:
 *
 *   · WHEEL / TRACKPAD walks the deck one card per notch, and at either END hands the scroll
 *     back to the page — the nested-scroll chaining every browser does for a list inside a page,
 *     so the deck never becomes a wall the modal cannot be scrolled past. A gesture that reached
 *     the end inside the deck stays in the deck for a moment (its inertia does not leak into a
 *     page jump); the NEXT gesture goes to the page.
 *   · A FINGER drags the fan, and the fan follows it — `place` takes a fractional offset, so
 *     the cards slide continuously under the thumb and snap on release, with a fling carrying
 *     the deck a few cards further. The first few pixels decide whether the swipe is the deck's
 *     or the page's (vertical and the deck can move that way = the deck's; anything else = the
 *     page's), which is the same chaining rule as the wheel, done by hand because a touch
 *     gesture cannot be handed back once it has been claimed.
 *   · A HELD MOUSE drags it the same way: press on any card, pull, release. Same slop, same
 *     snap and fling; the only difference is that a mouse drag has no page meaning, so the deck
 *     never hands it over — it rubber-bands at the ends instead. A drag is not a click: the
 *     click the button fires on release is swallowed when the fan actually moved.
 *   · A CLICK or TAP on a tucked card brings it forward; on the forward card it commits — the
 *     TV's "walk, then OK", because committing scrolls the modal down to the sources and a
 *     single-click-to-commit would yank the page away on every card touched. The forward card
 *     carries no play glyph for it: the lift and the pointer cursor are the affordance, and a
 *     disc over the still was covering the one picture the deck exists to show.
 *   · ARROW KEYS walk it and Enter commits, for anyone tabbing through the modal.
 *
 * ONLY THE FORWARD CARD IS IN THE TAB ORDER. The rest are `tabindex="-1"` and aria-hidden, as
 * on the TV, so the keyboard sees one control that answers Up/Down rather than a pile of
 * overlapping buttons.
 *
 * Styling lives under "THE EPISODE DECK" in src/styles/app.css.
 * ==========================================================================*/

/* Cards rendered behind the focused one, and ahead of it — the render window, and therefore the
 * still budget: a 24-episode season requests six pictures, not twenty-four. The same numbers as
 * the TV so the fan is the same shape; the height they produce (about 2.5 cards) is what the
 * deck reserves in the modal's flow. */
const DECK_ABOVE = 2;
const DECK_BELOW = 3;
const ABOVE_EXTENT = aboveExtent(DECK_ABOVE);
const BELOW_EXTENT = belowExtent(DECK_BELOW);
/* A card is the column's width up to this — the TV's cap, so the forward card is the same size
 * on a 1180px modal as on a 1080p panel. Handed to the CSS in PIXELS, measured (see the
 * ResizeObserver below), because it cannot be a percentage: `--ep-h` is derived from `--ep-w`,
 * and a `100%` inside a custom property resolves against whatever the property it lands in
 * measures — for `height` that is the deck's own height, which is itself computed from `--ep-h`.
 * The cycle resolves to nothing and every card is 0px tall. */
const CARD_MAX_W = 560;

/* ---- WHEEL ------------------------------------------------------------------------------- */
/** Accumulated wheel travel that counts as one step — under a mouse notch (100), so a notch is
 *  exactly one card, and coarse enough that a trackpad does not sprint. */
const WHEEL_STEP = 48;
/** After a step the rest of that notch / burst is ignored, so one notch cannot be two cards. */
const WHEEL_LOCK_MS = 130;
/** Events closer together than this are one gesture. */
const WHEEL_GESTURE_MS = 200;
/** How long after the deck's last step a gesture is still "in the deck" at either end — the
 *  inertia tail that must not leak into the page. Past it, the page gets the wheel. */
const WHEEL_TAIL_MS = 350;

/* ---- TOUCH ------------------------------------------------------------------------------- */
/** Movement before a touch is judged vertical or horizontal — the usual slop. */
const SWIPE_SLOP = 8;
/** How far ahead the release velocity is projected, in ms of travel, and the most cards it may
 *  add. Short: a deck is walked, not thrown. */
const FLING_MS = 120;
const FLING_CAP = 4;
/** Resistance past either end of the season. */
const RUBBER = 0.28;

/* ---- THE DEAL: the deck arrives one card at a time. Same numbers as the TV. ------------- */
type IntroPhase = 'pre' | 'run' | null;
const INTRO_STEP_CAP = 5;
const INTRO_STEP_MS = 55;
/** MUST TRACK `.ep-card`'s transition in app.css — it is that transition doing the movement. */
const CARD_IN_MS = 340;
const INTRO_RISE = '34%';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface CardProps {
  ep: Episode;
  /** distance from the focused card; fractional while a finger is dragging */
  offset: number;
  on: boolean;
  lifted: boolean;
  picked: boolean;
  pct: number;
  leftSec: number;
  intro: IntroPhase;
  onPick: () => void;
}

function EpisodeCard({ ep, offset, on, lifted, picked, pct, leftSec, intro, onPick }: CardProps) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  /* The still fades up when it arrives — see the note on `.ep-art img` in app.css. `complete` is
   * checked as well as `load` because a cached still can finish before React attaches the
   * handler, and a card whose `load` never fires would sit invisible. */
  const [shown, setShown] = useState(false);
  /* The deal's stagger, frozen at mount — see TvEpisodeDeck for why it must not follow `offset`. */
  const introStep = useRef(Math.min(Math.abs(Math.round(offset)), INTRO_STEP_CAP));
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  const { transform, opacity, zIndex } = place(offset, lifted);
  const watched = pct >= WATCHED * 100;

  const rising = intro === 'pre';
  const style: CSSProperties = {
    transform: rising ? `translateY(${INTRO_RISE}) ${transform}` : transform,
    opacity: rising ? 0 : opacity,
    zIndex,
    transitionDelay: intro ? `${introStep.current * INTRO_STEP_MS}ms` : undefined,
  };

  const sub = watched
    ? t('modal.ep_watched')
    : leftSec > 0
      ? t('modal.ep_left', { time: dur(leftSec) })
      : runtimeText(ep.runtime);

  return (
    <button
      type="button"
      className={`ep-card${on ? ' on' : ''}${on && lifted ? ' is-lifted' : ''}${picked ? ' picked' : ''}${watched ? ' watched' : ''}`}
      style={style}
      tabIndex={on ? 0 : -1}
      aria-hidden={on ? undefined : true}
      aria-current={picked ? 'true' : undefined}
      aria-label={`E${ep.episode} ${name}`}
      onClick={onPick}
    >
      <span className="ep-art" aria-hidden="true">
        {ep.still && !broken
          ? (
            <img
              className={shown ? 'rdy' : undefined}
              src={imgW(ep.still, STILL_RENDITION)}
              alt=""
              draggable={false}
              decoding="async"
              loading="lazy"
              ref={(el) => { if (el?.complete && !shown) setShown(true); }}
              onLoad={() => setShown(true)}
              onError={() => setBroken(true)}
            />
          )
          : <span className="ep-nostill" data-n={`E${ep.episode}`} />}
      </span>
      <span className="ep-scrim" aria-hidden="true" />
      {/* The "sources are loaded for this one" mark. Language-free on purpose. */}
      {picked && (
        <span className="ep-picked" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      )}
      <span className="ep-copy">
        <span className="ep-title"><b>{ep.episode}.</b> {name}</span>
        {sub && <span className="ep-sub">{sub}</span>}
      </span>
      {pct > 0 && !watched && (
        <span className="ep-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      )}
    </button>
  );
}

export interface EpisodeChooserProps {
  meta: MetaDetail;
  /** the modal's target id — the prefix of every per-episode progress key */
  titleId: string | number;
  /** the episode the title was opened on (Continue Watching), whose sources are already loading */
  initial?: { season: number; episode: number };
  onEpisode?: (season: number, ep: number) => void;
}

export default function EpisodeChooser({ meta, titleId, initial, onEpisode }: EpisodeChooserProps) {
  const t = useT();
  const progress = useHistory((s) => s.progress);

  const seasons = useMemo(() => seasonsOf(meta), [meta]);
  // the first REAL season, skipping a season-0 "Specials" block
  const firstSeason = useMemo(() => (seasons.find((s) => s.season >= 1) || seasons[0])?.season, [seasons]);
  const [openSeason, setOpenSeason] = useState<number | undefined>(initial?.season ?? firstSeason);
  const season = openSeason ?? firstSeason;

  /* WHERE THE EPISODES COME FROM — TMDB, or the add-on that published the show.
   *
   * `/api/tv/:id/season/:n` is a TMDB read and needs a numeric TMDB id, which a title described
   * by an add-on does not have. `meta.addonEpisodes` is that add-on's own `videos[]`, already
   * flattened and sorted, and it is present ONLY on records that came from `collectAddonMeta` —
   * so the two paths are mutually exclusive by construction and the query is disabled rather
   * than fired-and-ignored on the add-on path. That is also why the guard below is "is there a
   * list at all" rather than "is there an IMDb id": an add-on-described show brings its own
   * episode list AND its own per-episode ids, so it needs neither. */
  const fromAddon = meta.addonEpisodes;
  const { data, isLoading } = useSeason(meta.id, fromAddon ? undefined : season, meta.imdb);
  const episodes: Episode[] = useMemo(() => (fromAddon
    ? fromAddon.filter((e) => e.season === season).map((e) => ({
      episode: e.episode, name: e.name, overview: e.overview, still: e.still, air_date: e.air_date,
    }))
    : data?.episodes ?? []), [data, fromAddon, season]);

  const [picked, setPicked] = useState<{ season: number; ep: number } | null>(
    initial ? { season: initial.season, ep: initial.episode } : null,
  );
  const [active, setActive] = useState(0);
  /** fractional steps the finger has dragged the deck, or null when no finger is on it */
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const deckRef = useRef<HTMLDivElement>(null);
  /* Whether the viewer has moved the selection themselves — once they have, the "up next"
   * aiming below stands down, so a late-arriving history pull cannot yank it back. */
  const walked = useRef(false);
  /* Mirrors for the native wheel/touch listeners, which are bound once and must read the
   * current values without re-binding on every render. */
  const activeRef = useRef(0);
  const lastRef = useRef(-1);
  const dragRef = useRef<number | null>(null);
  activeRef.current = active;
  lastRef.current = episodes.length - 1;

  const go = (next: number) => {
    const n = clamp(next, 0, lastRef.current);
    if (n === activeRef.current) return false;
    walked.current = true;
    activeRef.current = n;
    setActive(n);
    return true;
  };
  const goRef = useRef(go);
  goRef.current = go;

  /* ---- the deal -------------------------------------------------------------------------- */
  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [intro, setIntro] = useState<IntroPhase>(reduceMotion ? null : 'pre');
  useEffect(() => { setIntro(reduceMotion ? null : 'pre'); }, [season, reduceMotion]);
  // Two frames between placing and moving — see TvEpisodeDeck for why one is not enough.
  useEffect(() => {
    if (intro !== 'pre' || !episodes.length) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setIntro('run')); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [intro, episodes.length]);
  useEffect(() => {
    if (intro !== 'run') return;
    const id = window.setTimeout(() => setIntro(null), CARD_IN_MS + INTRO_STEP_MS * INTRO_STEP_CAP + 80);
    return () => window.clearTimeout(id);
  }, [intro]);

  /** pos/dur for one episode, from the same key DetailModal writes progress under. */
  const resumeOf = (ep: number) => {
    const p = progress[`${titleId}:S${season}E${ep}`];
    if (!p || !(p.dur > 0)) return { pct: 0, leftSec: 0, at: 0 };
    return { pct: Math.min(100, (p.pos / p.dur) * 100), leftSec: Math.max(0, p.dur - p.pos), at: p.at || 0 };
  };

  // A new season is a new deck: it may re-aim itself, and nothing has been walked or dragged.
  useEffect(() => { walked.current = false; dragRef.current = null; setDrag(null); }, [season]);

  /* WHERE THE DECK OPENS: on the picked episode if the title was opened on one, otherwise on UP
   * NEXT — the most recently touched episode of this season, or the one after it if that one is
   * finished. A season never started opens on its first. Stops once the viewer has moved. */
  useEffect(() => {
    if (walked.current) return;
    if (!episodes.length) { setActive(0); return; }
    if (picked && picked.season === season) {
      const at = episodes.findIndex((e) => e.episode === picked.ep);
      if (at >= 0) { setActive(at); return; }
    }
    let bestAt = 0;
    let bestIdx = -1;
    episodes.forEach((e, i) => {
      const r = resumeOf(e.episode);
      if (r.at > bestAt) { bestAt = r.at; bestIdx = i; }
    });
    if (bestIdx < 0) { setActive(0); return; }
    const done = resumeOf(episodes[bestIdx].episode).pct >= WATCHED * 100;
    setActive(Math.min(episodes.length - 1, done ? bestIdx + 1 : bestIdx));
    // resumeOf closes over `progress`/`season`, both of which are in the dep list below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, season, progress, picked]);

  /* Keyboard focus follows the selection — but only if it was already in the deck. A wheel or
   * a finger walking the deck must not pull focus away from wherever the viewer left it. */
  useEffect(() => {
    const deck = deckRef.current;
    if (!walked.current || !deck || !deck.contains(document.activeElement)) return;
    deck.querySelector<HTMLElement>('.ep-card.on')?.focus({ preventScroll: true });
  }, [active]);

  // The card's width in px, from the column's — see CARD_MAX_W. Layout-phase so the first paint
  // is already right; a ResizeObserver keeps it right when the modal or the phone turns.
  useLayoutEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const fit = () => el.style.setProperty('--ep-w', `${Math.max(0, Math.min(el.clientWidth, CARD_MAX_W))}px`);
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---- WHEEL: one card per notch, chained to the page at the ends ---------------------- */
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    let acc = 0;
    let lastT = -Infinity;
    let lastStepT = -Infinity;
    let lockUntil = 0;
    const onWheel = (e: WheelEvent) => {
      // lines / pages → pixels, roughly; only the sign and a rough size matter here
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 240 : e.deltaY;
      if (Math.abs(dy) <= Math.abs(e.deltaX)) return;          // a sideways gesture is not ours
      const now = performance.now();
      const ahead = dy > 0;
      const atEnd = ahead ? activeRef.current >= lastRef.current : activeRef.current <= 0;
      if (atEnd) {
        // the tail of the gesture that reached the end stays here; a fresh one goes to the page
        if (now - lastStepT < WHEEL_TAIL_MS) { e.preventDefault(); lastT = now; }
        return;
      }
      e.preventDefault();
      if (now - lastT > WHEEL_GESTURE_MS) acc = 0;
      lastT = now;
      if (now < lockUntil) return;
      acc += dy;
      if (Math.abs(acc) >= WHEEL_STEP) {
        if (goRef.current(activeRef.current + (acc > 0 ? 1 : -1))) lastStepT = now;
        acc = 0;
        lockUntil = now + WHEEL_LOCK_MS;
      }
    };
    // React registers `wheel` passively; preventing the page scroll needs a native listener.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---- DRAG: the fan follows a finger or a held mouse, and snaps on release ------------ */
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    type Gesture = { x: number; y: number; mode: 'undecided' | 'deck' | 'page'; stepPx: number; samples: [number, number][] };
    let g: Gesture | null = null;
    /* Set when a mouse drag actually moved the deck, so the click the browser fires on release
     * does not ALSO pick or re-aim a card. Cleared by the capture-phase listener that eats it. */
    let swallowClick = false;

    const begin = (x: number, y: number): Gesture => {
      // one step ahead is STEP_DOWN% of a card; offsetHeight ignores the card's transform
      const card = el.querySelector<HTMLElement>('.ep-card');
      const stepPx = Math.max(48, ((card?.offsetHeight ?? 200) * STEP_DOWN) / 100);
      return { x, y, mode: 'undecided', stepPx, samples: [] };
    };
    /** The first few pixels decide whose gesture this is. `mayPage` = a vertical move the deck
     *  cannot answer (sideways, or past its end) is left to the page — true for a finger, whose
     *  swipe would otherwise scroll the modal; a mouse drag has no page meaning, so the deck
     *  keeps it and rubber-bands instead. */
    const decide = (dx: number, dy: number, mayPage: boolean): Gesture['mode'] => {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return 'undecided';
      if (mayPage) {
        if (Math.abs(dx) > Math.abs(dy)) return 'page';
        const ahead = dy < 0;
        const atEnd = ahead ? activeRef.current >= lastRef.current : activeRef.current <= 0;
        if (atEnd) return 'page';
      }
      return 'deck';
    };
    const track = (y: number) => {
      if (!g) return;
      const now = performance.now();
      g.samples.push([now, y]);
      if (g.samples.length > 6) g.samples.shift();
      let frac = -(y - g.y) / g.stepPx;
      const lo = -activeRef.current;
      const hi = lastRef.current - activeRef.current;
      if (frac < lo) frac = lo + (frac - lo) * RUBBER;
      else if (frac > hi) frac = hi + (frac - hi) * RUBBER;
      dragRef.current = frac;
      setDrag(frac);
    };
    const finish = () => {
      if (!g) return;
      if (g.mode === 'deck') {
        const frac = dragRef.current ?? 0;
        // release velocity over the last few samples, in px/ms; up is "ahead"
        let fling = 0;
        const s = g.samples;
        if (s.length >= 2) {
          const [t1, y1] = s[0];
          const [t2, y2] = s[s.length - 1];
          const v = t2 > t1 ? (y2 - y1) / (t2 - t1) : 0;
          fling = clamp((-v * FLING_MS) / g.stepPx, -FLING_CAP, FLING_CAP);
        }
        const target = clamp(Math.round(activeRef.current + frac + fling), 0, lastRef.current);
        walked.current = true;
        activeRef.current = target;
        dragRef.current = null;
        setActive(target);
        setDrag(null);
      }
      g = null;
    };

    /* -- touch -- */
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { g = null; return; }
      g = begin(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!g || e.touches.length !== 1) return;
      const t0 = e.touches[0];
      if (g.mode === 'undecided') g.mode = decide(t0.clientX - g.x, t0.clientY - g.y, true);
      if (g.mode !== 'deck') return;
      if (e.cancelable) e.preventDefault();
      track(t0.clientY);
    };
    const onTouchEnd = () => finish();

    /* -- mouse (and pen): hold and drag, exactly as a finger. Pointer events so one pair of
     * handlers covers both; touch is excluded here because the touch listeners above own it,
     * with the page-chaining a pointer listener could not do (a claimed pointer cannot be
     * handed back to the scroller). Once the drag has started the pointer is CAPTURED, so the
     * fan keeps following a mouse that leaves the deck, and the click the button fires on
     * release is swallowed — a drag is not a pick. Capture is taken late, not on press, because
     * capturing redirects the click to the deck and a plain click must still reach its card. */
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      g = begin(e.clientX, e.clientY);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!g || e.pointerType === 'touch') return;
      if (g.mode === 'undecided') {
        g.mode = decide(e.clientX - g.x, e.clientY - g.y, false);
        if (g.mode === 'deck') {
          swallowClick = true;
          try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        }
      }
      if (g.mode !== 'deck') return;
      e.preventDefault();             // no text/image selection while the fan is held
      track(e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!g || e.pointerType === 'touch') return;
      if (g.mode !== 'deck') swallowClick = false;
      finish();
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    // Native and non-passive: React's touch handlers cannot cancel the page's scroll.
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, []);

  if (!seasons.length || (!meta.imdb && !fromAddon)) return null;

  const onKey = (e: ReactKeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = active + 1;
    else if (e.key === 'ArrowUp') next = active - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = episodes.length - 1;
    if (next === null) return;
    e.preventDefault();
    go(next);
  };
  const onPointer = (e: ReactPointerEvent, over: boolean) => { if (e.pointerType === 'mouse') setHover(over); };

  const dragging = drag != null;
  // Held through a drag: the lift is where a grabbed card starts from, not a state it leaves.
  const lifted = hover || focusIn;
  const centre = active + (drag ?? 0);
  const mid = clamp(Math.round(centre), 0, Math.max(0, episodes.length - 1));
  const base = Math.max(0, mid - DECK_ABOVE);
  const win = episodes.slice(base, mid + DECK_BELOW + 1);
  const deckStyle = { '--ep-above': ABOVE_EXTENT, '--ep-below': BELOW_EXTENT } as CSSProperties;

  return (
    <div className="ep-chooser" id="epChooser">
      <div className="m-rail-head ep-head">
        <h4 className="m-rail-label">{t('modal.episodes')}</h4>
        <SeasonSelect seasons={seasons} value={season!} onChange={(s) => { setOpenSeason(s); }} />
        {episodes.length > 0 && (
          <span className="ep-count" aria-live="polite" aria-atomic="true">
            <b>{mid + 1}</b><i>/</i>{episodes.length}
          </span>
        )}
      </div>

      <div
        className={`ep-deck${dragging ? ' is-dragging' : ''}${!isLoading && !episodes.length ? ' is-empty' : ''}`}
        ref={deckRef}
        role="group"
        aria-label={t('modal.episodes')}
        style={deckStyle}
        onKeyDown={onKey}
        onPointerEnter={(e) => onPointer(e, true)}
        onPointerLeave={(e) => onPointer(e, false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocusIn(false); }}
      >
        {isLoading && !fromAddon ? (
          /* the fan's silhouette while the season loads, so the layout does not jump when it lands */
          Array.from({ length: DECK_BELOW + 1 }).map((_, i) => {
            const { transform, opacity, zIndex } = place(i, false);
            return <div className="ep-card ep-skel" key={i} style={{ transform, opacity, zIndex }} aria-hidden="true" />;
          })
        ) : episodes.length ? (
          win.map((e, i) => {
            const idx = base + i;
            const r = resumeOf(e.episode);
            return (
              <EpisodeCard
                key={e.episode}
                ep={e}
                offset={idx - centre}
                on={idx === active}
                lifted={lifted}
                picked={!!picked && picked.season === season && picked.ep === e.episode}
                intro={intro}
                pct={r.pct}
                leftSec={r.leftSec}
                onPick={() => {
                  if (idx !== active) { go(idx); return; }
                  setPicked({ season: season!, ep: e.episode });
                  onEpisode?.(season!, e.episode);
                }}
              />
            );
          })
        ) : (
          <div className="ep-empty">{t('modal.episodes_unavailable')}</div>
        )}
      </div>
    </div>
  );
}
