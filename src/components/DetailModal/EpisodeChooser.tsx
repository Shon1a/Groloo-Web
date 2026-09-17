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
 *     gesture cannot be handed back once it has been claimed. While it is held the fan is
 *     positioned by a frame loop writing straight to the cards (see the drag effect) — React
 *     renders only when a card enters or leaves the window, and once more on release.
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
/* AND TWO MORE MOUNTED AT EACH END, OUT OF SIGHT. A card used to exist only while it was in the
 * fan, so the one about to enter was created — element, <img>, fetch, decode — on the very
 * frame it became visible, and it came in black and faded up under the finger. Parked cards
 * (`.ep-parked`, visibility:hidden) hold their still ready two cards before it is needed, and
 * a card leaving the fan keeps its picture for two cards more in case the finger comes back.
 * Hidden, they cost no raster; they do cost four more stills per season, which is the price. */
const DECK_PARK = 2;
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
/** Movement before a held mouse is judged vertical or horizontal — the usual slop. */
const SWIPE_SLOP = 8;
/** The same decision for a finger, made sooner, and the reason is a race. Chrome on Android
 *  drops touchmoves inside its own ~8px slop and starts the page SCROLL the moment a touchmove
 *  is dispatched without being cancelled — so a first event that landed at 7px was left
 *  undecided here, went uncancelled, and the browser took the gesture for the page; every
 *  touchmove after that is uncancelable, the deck then claimed the same finger at 8px, and the
 *  two scrolled together. A move Chrome bothers to deliver has already cleared its slop, so a
 *  few pixels is enough to read its direction, and cancelling the FIRST delivered move is the
 *  only way to keep the page still. */
const TOUCH_SLOP = 4;
/* ---- THE GLIDE: what the deck does after the finger leaves ------------------------------
 * A release used to project the finger's speed a fixed 120ms ahead, round that to a whole card
 * and hand the rest to one 340ms ease — so every flick travelled about the same distance and
 * then stopped, and a hard throw and a lazy nudge landed nearly the same place. The next version
 * kept the release velocity and shed it exponentially, the way a thrown thing slows — and that
 * was right about the distance and wrong about the ENDING: the decay ran until it was nearly
 * still, wherever that happened to be, and only then was the remainder to a whole card handed
 * to a fresh 340ms ease. Two motions with a seam between them, and when the decay died at x.4
 * the second one ran BACKWARDS to card x. That reversal is what "the stop is not natural" was.
 *
 * Now the destination is chosen at release and the whole motion is one curve into it. Distance
 * is still velocity x GLIDE_TAU (fast swipe, long run), rounded to a whole card in the flick's
 * own direction; the curve is a cubic ease-out whose initial slope is set equal to the release
 * speed, so the cards leave the finger at the speed the finger was moving and lose it
 * continuously until they are exactly on a card. No seam, no second ease, no reversal — the
 * deck stops the way a scroll view with paging does. */
/** Distance a flick carries, in ms of its release speed: rest = position + speed x TAU. */
const GLIDE_TAU = 320;
/** Below this speed (cards per ms) a release is a lift, not a throw: the deck snaps to the
 *  nearest card on the card transition instead of gliding. */
const GLIDE_MIN_V = 0.0016;
/** The fastest flick the deck will honour — TAU x this is about twelve cards, which is a long
 *  way through a season and still a distance you can aim. */
const GLIDE_MAX_V = 0.038;
/** Bounds on the glide's length. The duration comes from the physics (three times distance over
 *  speed, for a cubic ease-out to leave at the release speed); these only keep a nudge from
 *  being instant and a crawl from outstaying its welcome. */
const GLIDE_MIN_MS = 260;
const GLIDE_MAX_MS = 900;
/** Velocity is measured only over samples inside this window, so a finger that slides, stops,
 *  and then lifts lets go of a stationary deck instead of the speed it arrived at. */
const GLIDE_V_WINDOW = 120;
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

/* ONE MediaQueryList for the module, not one per render. This was `window.matchMedia(...)`
 * evaluated inline in EpisodeChooser's body, and that body runs on every frame of a drag —
 * a style-system call in the hot path to answer a question whose answer almost never changes.
 * Subscribing to it is also the more correct of the two: the deck now notices the setting
 * being changed instead of noticing it at the next render that happens to occur. */
const MOTION_Q = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/* STILLS THE DECK HAS ALREADY SHOWN, by URL. A card that leaves the mounted range and comes back
 * is a new <img>, and without this it came back the way it first arrived: blank, then a 450ms
 * fade — "the pictures go black and load again" on a phone, every time the deck was dragged
 * back a few cards. The browser still has the bytes; what it does not have is our `shown`
 * state, so that is what is kept. Module-level on purpose: it outlives the chooser, so opening
 * the same title twice is also instant. */
const shownStills = new Set<string>();

/* THE STILL IS ASKED FOR AT THE SIZE THE CARD IS DRAWN AT. `STILL_RENDITION` (w500) is what the
 * TV deck fetches, and it was all the web deck fetched too — a 500px picture stretched over a
 * card that is 560 CSS px wide on a desktop at dpr 2 (1120 device px) and 390 at dpr 3 on a
 * phone (1170): every deck still was being upscaled 2.2x and looked it. `srcset` offers w500
 * and w780 and lets the browser pick by its own device-pixel ratio against `sizes`, which is
 * the card's width (the column, capped at CARD_MAX_W); w780 is 50KB against w500's 24KB, and
 * six of them is what a season costs to show sharply. Deliberately no w1280: at 125KB apiece
 * it is 2.5x the bytes for detail a 16:9 still under a scrim does not have. Only a TMDB url
 * has renditions to offer — an add-on's own still passes through `imgW` unchanged, and gets no
 * srcset rather than one that names the same file twice. */
const STILL_SIZES = `min(100vw, ${CARD_MAX_W}px)`;
function stillSources(still: string): { src: string; srcSet?: string } {
  const w500 = imgW(still, STILL_RENDITION), w780 = imgW(still, 'w780');
  return w780 === w500 ? { src: w500 } : { src: w500, srcSet: `${w500} 500w, ${w780} 780w` };
}

interface CardProps {
  ep: Episode;
  /** the card's index in the season — what the drag loop reads back off the DOM (`data-idx`) */
  idx: number;
  /** distance from the focused card; fractional while a finger is dragging */
  offset: number;
  /** mounted for its picture but outside the fan — see `parked` at the render */
  parked: boolean;
  on: boolean;
  lifted: boolean;
  picked: boolean;
  pct: number;
  leftSec: number;
  intro: IntroPhase;
  onPick: () => void;
}

function EpisodeCard({ ep, idx, offset, parked, on, lifted, picked, pct, leftSec, intro, onPick }: CardProps) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const sources = ep.still ? stillSources(ep.still) : null;
  /* The still fades up when it FIRST arrives — see the note on `.ep-art img` in app.css — and
   * only then: a still this deck has shown before is drawn ready (see `shownStills`).
   * `complete` is checked as well as `load` because a cached still can finish before React
   * attaches the handler, and a card whose `load` never fires would sit invisible. */
  const [shown, setShown] = useState(() => !!sources && shownStills.has(sources.src));
  /* Checked once, on mount, rather than from an inline `ref={(el) => ...}`: an inline callback
   * ref has a new identity every render, so React detached and re-attached it — and re-read
   * `complete` — on all six cards on every frame of a drag. A card is keyed by its episode, so
   * mount is exactly when there is a new <img> to ask. */
  const imgRef = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => { if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setShown(true); }, []);
  const onShown = () => { if (sources) shownStills.add(sources.src); setShown(true); };
  /* The deal's stagger, frozen at mount — see TvEpisodeDeck for why it must not follow `offset`. */
  const introStep = useRef(Math.min(Math.abs(Math.round(offset)), INTRO_STEP_CAP));
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  const { transform, opacity, zIndex } = place(offset, lifted);
  const watched = pct >= WATCHED * 100;

  const rising = intro === 'pre';
  /* THE CARD IS OPAQUE AND WEARS ITS DEPTH AS A DIM, NOT AS TRANSPARENCY. `place` still hands
   * back the TV's opacity ramp (.85 per step), but here it drives `.ep-dim` — a black sheet over
   * the card at 1 − that value — and the card itself stays at 1. Translucent cards let the card
   * behind show THROUGH: a tucked card's black scrim laid over the next card's picture, which on
   * a stack of six read as dark bands between every pair the moment the fan stopped moving.
   * Opaque, each visible strip is one picture with one scrim, and the depth reads from size and
   * shade alone. The card's own opacity is kept for the deal, where it rises from nothing. */
  const style: CSSProperties = {
    transform: rising ? `translateY(${INTRO_RISE}) ${transform}` : transform,
    opacity: rising ? 0 : 1,
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
      className={`ep-card${on ? ' on' : ''}${on && lifted ? ' is-lifted' : ''}${picked ? ' picked' : ''}${watched ? ' watched' : ''}${parked ? ' ep-parked' : ''}`}
      style={style}
      data-idx={idx}
      tabIndex={on ? 0 : -1}
      aria-hidden={on ? undefined : true}
      aria-current={picked ? 'true' : undefined}
      aria-label={`E${ep.episode} ${name}`}
      onClick={onPick}
    >
      <span className="ep-art" aria-hidden="true">
        {sources && !broken
          ? (
            /* NOT `loading="lazy"`. The mounted range IS the still budget (see DECK_ABOVE), and
               lazy loading deferred the ones below the fold until the modal was scrolled to
               them — which is exactly when they were wanted, so they arrived black and faded
               in under the viewer's thumb. Mounted means fetch. */
            <img
              className={shown ? 'rdy' : undefined}
              src={sources.src}
              srcSet={sources.srcSet}
              sizes={sources.srcSet ? STILL_SIZES : undefined}
              alt=""
              draggable={false}
              decoding="async"
              ref={imgRef}
              onLoad={onShown}
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
      {/* Last child, so the drag loop can reach it as `lastElementChild` without a query. */}
      <span className="ep-dim" aria-hidden="true" style={{ opacity: 1 - opacity }} />
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
  const liftedRef = useRef(false);
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
  const [reduceMotion, setReduceMotion] = useState(() => !!MOTION_Q?.matches);
  useEffect(() => {
    if (!MOTION_Q?.addEventListener) return;
    const on = () => setReduceMotion(MOTION_Q.matches);
    MOTION_Q.addEventListener('change', on);
    return () => MOTION_Q.removeEventListener('change', on);
  }, []);
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
    type Gesture = { x: number; y: number; mode: 'undecided' | 'deck' | 'page'; stepPx: number; samples: [number, number][];
      /** the fractional offset the deck was already at when this gesture began — non-zero when
       *  a finger lands on a deck that is still gliding, so the grab carries on from where the
       *  cards actually are instead of snapping them to a whole card first */
      base: number };
    let g: Gesture | null = null;
    /** the in-flight glide, if there is one */
    let raf = 0;
    const stopGlide = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    /* ---- THE FRAME IS WRITTEN TO THE DOM, NOT RENDERED THROUGH REACT --------------------------
     * Every touchmove used to `setDrag(frac)`, and every one of those re-rendered the chooser and
     * its six cards — a component function, a `place()` and a reconcile per card, per event, and
     * a phone reports touchmove at up to 120Hz. None of that work produced anything but six new
     * inline styles. So a moving finger now sets those six styles itself, coalesced to one write
     * per animation frame (three touchmoves in a frame are one paint, not three), and React is
     * asked to render only when the WINDOW changes — when the fraction crosses a card boundary
     * and a card has to mount at one end and unmount at the other — and once more on release.
     *
     * The two agree by construction: React's render computes exactly `place(idx - centre)` from
     * the same `drag` it is handed here, so the styles it writes on a window change are the ones
     * the frame loop would have written, and the loop carries on from them. `data-idx` is how the
     * loop knows which card is which without React's help.
     *
     * `.is-dragging` is put on the deck directly as well as through state, and that is not belt
     * and braces: it is what turns the card's transition OFF, and it has to be off before the
     * first direct write lands, or that write is eased over 340ms instead of applied. State
     * arrives a render later; the classList does not. */
    let frameRaf = 0;
    let pending: number | null = null;
    let lastMid = NaN;
    const paint = () => {
      frameRaf = 0;
      if (pending == null) return;
      const centre = activeRef.current + pending;
      el.querySelectorAll<HTMLElement>('.ep-card[data-idx]').forEach((c) => {
        const p = place(Number(c.dataset.idx) - centre, liftedRef.current);
        c.style.transform = p.transform;
        (c.lastElementChild as HTMLElement).style.opacity = String(1 - p.opacity);   // .ep-dim
        c.style.zIndex = String(p.zIndex);
      });
    };
    /** Move the fan to `frac`: the DOM this frame, React only if the window of cards moved. */
    const show = (frac: number) => {
      dragRef.current = frac;
      pending = frac;
      if (!frameRaf) frameRaf = requestAnimationFrame(paint);
      const mid = Math.round(activeRef.current + frac);
      if (mid !== lastMid) { lastMid = mid; el.classList.add('is-dragging'); setDrag(frac); }
    };
    const stopFrames = () => { if (frameRaf) { cancelAnimationFrame(frameRaf); frameRaf = 0; } pending = null; lastMid = NaN; };
    /* Set when a mouse drag actually moved the deck, so the click the browser fires on release
     * does not ALSO pick or re-aim a card. Cleared by the capture-phase listener that eats it. */
    let swallowClick = false;

    const begin = (x: number, y: number): Gesture => {
      stopGlide();                       // a hand on the deck stops it, wherever it had got to
      // one step ahead is STEP_DOWN% of a card; offsetHeight ignores the card's transform
      const card = el.querySelector<HTMLElement>('.ep-card');
      const stepPx = Math.max(48, ((card?.offsetHeight ?? 200) * STEP_DOWN) / 100);
      return { x, y, mode: 'undecided', stepPx, samples: [], base: dragRef.current ?? 0 };
    };
    /** The first few pixels decide whose gesture this is. `mayPage` = a vertical move the deck
     *  cannot answer (sideways, or past its end) is left to the page — true for a finger, whose
     *  swipe would otherwise scroll the modal; a mouse drag has no page meaning, so the deck
     *  keeps it and rubber-bands instead. */
    const decide = (dx: number, dy: number, mayPage: boolean): Gesture['mode'] => {
      const slop = mayPage ? TOUCH_SLOP : SWIPE_SLOP;   // a finger decides sooner — see TOUCH_SLOP
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return 'undecided';
      if (mayPage) {
        if (Math.abs(dx) > Math.abs(dy)) return 'page';
        const ahead = dy < 0;
        const at = activeRef.current + (dragRef.current ?? 0);
        const atEnd = ahead ? at >= lastRef.current : at <= 0;
        if (atEnd) return 'page';
      }
      return 'deck';
    };
    const track = (y: number) => {
      if (!g) return;
      const now = performance.now();
      g.samples.push([now, y]);
      if (g.samples.length > 6) g.samples.shift();
      let frac = g.base - (y - g.y) / g.stepPx;
      const lo = -activeRef.current;
      const hi = lastRef.current - activeRef.current;
      if (frac < lo) frac = lo + (frac - lo) * RUBBER;
      else if (frac > hi) frac = hi + (frac - hi) * RUBBER;
      show(frac);
    };
    /** Land on a whole card. Dropping `drag` hands the last fraction of a card back to
     *  `.ep-card`'s transition, so a glide eases into its place instead of cutting to it.
     *  React takes the frame back here: its render writes the whole-card placements and drops
     *  `.is-dragging`, and the transition carries the cards the rest of the way. */
    const settle = (frac: number) => {
      stopFrames();
      const target = clamp(Math.round(activeRef.current + frac), 0, lastRef.current);
      walked.current = true;
      activeRef.current = target;
      dragRef.current = null;
      setActive(target);
      setDrag(null);
    };
    /** Carry the deck from where it was let go to the whole card the release speed points at,
     *  on one curve that leaves at that speed — see "THE GLIDE" at the top of the file. */
    const glide = (v0: number) => {
      const v = clamp(v0, -GLIDE_MAX_V, GLIDE_MAX_V);
      const from = dragRef.current ?? 0;
      const lo = -activeRef.current;
      const hi = lastRef.current - activeRef.current;
      // Where a free glide would come to rest, then the whole card nearest that — but never one
      // BEHIND the finger: a flick means "on", and rounding back to the card just left is the
      // reversal this curve exists to remove. The ends stop it dead; nothing past them to show.
      let target = Math.round(from + v * GLIDE_TAU);
      if ((target - from) * v < 0) target = v > 0 ? Math.ceil(from) : Math.floor(from);
      target = clamp(target, lo, hi);
      const dist = target - from;
      if (Math.abs(dist) < 1e-4) { settle(from); return; }
      // A cubic ease-out leaves at 3 x dist / D, so D = 3 x dist / v is the length that makes
      // the curve continuous with the finger. Bounded, not exact, at the extremes.
      const D = clamp((3 * Math.abs(dist)) / Math.max(Math.abs(v), 1e-6), GLIDE_MIN_MS, GLIDE_MAX_MS);
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / D);
        if (t >= 1) { raf = 0; settle(target); return; }     // exactly on the card: nothing left to ease
        const e = 1 - (1 - t) ** 3;
        // already inside a frame callback: paint now rather than queueing a second rAF a frame late
        show(from + dist * e);
        if (frameRaf) cancelAnimationFrame(frameRaf);
        paint();
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const finish = () => {
      if (!g) return;
      if (g.mode === 'deck') {
        const frac = dragRef.current ?? 0;
        /* Release speed in cards/ms, from the samples inside the last GLIDE_V_WINDOW only.
         * A finger moving UP walks the deck FORWARD, hence the sign. */
        const now = performance.now();
        const s = g.samples.filter(([t]) => now - t <= GLIDE_V_WINDOW);
        let v = 0;
        if (s.length >= 2) {
          const [t1, y1] = s[0];
          const [t2, y2] = s[s.length - 1];
          if (t2 > t1) v = -((y2 - y1) / (t2 - t1)) / g.stepPx;
        }
        g = null;                        // cleared first: the glide outlives the gesture
        if (Math.abs(v) >= GLIDE_MIN_V && !MOTION_Q?.matches) glide(v);
        else settle(frac);
        return;
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
      stopGlide();
      stopFrames();
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
  liftedRef.current = lifted;    // the frame loop reads it off the ref
  const centre = active + (drag ?? 0);
  const mid = clamp(Math.round(centre), 0, Math.max(0, episodes.length - 1));
  const base = Math.max(0, mid - DECK_ABOVE - DECK_PARK);
  const win = episodes.slice(base, mid + DECK_BELOW + DECK_PARK + 1);
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
        /* KEYBOARD focus only. A tap focuses the card too (it is a button), and lifting on that
           put the deep shadow and the 1.06 scale on the front card after every touch — and then,
           because focus follows the selection while it is in the deck, after every glide as well.
           `:focus-visible` is the browser's own answer to "did a keyboard do this". */
        onFocus={(e) => setFocusIn((e.target as HTMLElement).matches(':focus-visible'))}
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
                idx={idx}
                offset={idx - centre}
                parked={idx < mid - DECK_ABOVE || idx > mid + DECK_BELOW}
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
