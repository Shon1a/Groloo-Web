import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { imgW } from '../../lib/img';
import { useSeason } from '../../lib/queries';
import { useHistory } from '../../stores/history';
import TvChipMenu from './TvChipMenu';
import type { Episode, MetaDetail, SeasonInfo } from '../../lib/types';

/* ============================================================================
 * THE EPISODE DECK — the season as a stack of cards, not a list of lines.
 *
 * WHAT REPLACED WHAT. This panel used to be `E3 · The Janitor's Boy` rows in a scrolling box,
 * and the reasoning for that (written at the head of TvDetail) was sound as far as it went: a
 * season is up to two dozen stills, and a still carries no information the name doesn't.
 *
 * It carries something else, though, which a name cannot: WHERE YOU ARE. A viewer opening a
 * series they are half way through wants one episode — the next one — and a list of twenty
 * identical rows makes them read to find it. The deck puts that episode in the middle of the
 * screen at full size, with its picture, how much of it is left and a progress bar, and tucks
 * the rest away behind it. Nothing is hunted for; the answer is already on screen.
 *
 *     ┌──────────────┐        · the cards BEHIND collapse into a tight stack, dim and
 *     │ ┌──────────┐ │          receded to the right — enough to say "there are earlier
 *     │ │┌────────┐│ │          episodes", not enough to read
 *     │ ││        ││ │        · the FOCUSED card is forward, full size, opaque
 *     │┌┴┴────────┴┴┐│        · the cards AHEAD fan down at a readable pitch and fade out
 *     ││ 11. Episode││
 *     ││ 27m left   ││        Only `transform` and `opacity` differ between the states, which
 *     │└────────────┘│        is the one thing a TV GPU composites for free — see the effect
 *     │ ┌──────────┐ │        budget at the top of tv.css. Nothing here reflows.
 *     │ │12. …     │ │
 *
 * WHAT THIS COSTS, HONESTLY. Stills come back. The number is bounded by the render window
 * below — eight cards on screen at once regardless of season length — so a 24-episode season
 * requests 8 pictures rather than 24, and walking the deck pulls them in one at a time. That is
 * the trade this makes deliberately, and it is the first thing to reconsider if a set stutters.
 *
 * ONLY THE FOCUSED CARD IS A D-PAD STOP. The rest are `tabindex="-1"`, exactly as the spotlight
 * strip's thumbnails are, so TvSpatialNav's `candidates()` filters them out and cannot try to
 * score its way through a pile of overlapping rectangles. Up/Down are handled HERE and consumed
 * (again, the spotlight's Left/Right idiom) — except at the two ends, where they are allowed to
 * bubble so the remote can leave the deck. Left/Right are never touched, so Left always walks
 * back out to WATCH.
 * ==========================================================================*/

/* Cards rendered behind the focused one, and ahead of it. The whole cost control — and the
 * numbers are what FITS, measured, not guessed: past three ahead the next card's top edge is
 * already below the bottom of the screen, so a fourth would be a still requested for a picture
 * nobody can see.
 *
 * TWO BEHIND, NOT THREE, AND THAT IS WHAT BUYS THE SEASON MENU ITS ROOM. The back stack is where
 * the deck's height is cheapest to give up: the third card behind contributes 46px of rise at
 * 1080p and is nearly all covered by the two in front of it, so dropping it costs almost nothing
 * to look at and hands the space straight to the top of the column, where the chip's menu opens.
 * The fan was measured filling the column to within 9px before this — there was no slack to move
 * anything into, so something had to get shorter. */
const DECK_ABOVE = 2;
const DECK_BELOW = 3;

/* GEOMETRY, IN PERCENTAGES OF THE CARD'S OWN BOX. A `translate()` percentage resolves against
 * the element being moved, so the deck's proportions survive the `clamp()` that sizes a card off
 * the viewport — one set of numbers for a 720p webOS package and a 1080p set alike. */
const STEP_DOWN = 56;     // % of card height to the next card ahead
const STEP_UP = 22;       // …and to the one behind, which is why the back stack reads as a stack
const STEP_DECAY = 0.82;  // each further card sits closer to its neighbour: the ends bunch
const STEP_X = 5;         // % of card width each card recedes to the right
const STEP_X_DECAY = 0.8;
/* SIZE IS WHAT RANKS THE CARDS, not opacity. Each step away from the selection is drawn this
 * much smaller: 1 · 0.90 · 0.80 · 0.70.
 *
 * It was 0.05 a step, and that is the mistake that made two rounds of brightening feel like they
 * were not working. At 5% a card one place away is 95% the size of the focused one — a
 * difference nobody sees from a sofa — so the ONLY thing separating the selection from its
 * neighbours was how dim they were, and the deck could either be legible or be ranked, not both.
 * Dimming is a poor tool for it anyway: it destroys the picture, which is the whole reason the
 * cards carry stills.
 *
 * At 10% the hierarchy is obvious at a glance and it costs nothing — a bigger card is not a
 * fainter one, so every episode in the deck stays readable while the focused one is plainly the
 * focused one. That is what lets the opacity ratio sit as high as it now does. */
const STEP_SCALE = 0.1;
const MIN_SCALE = 0.65;
/* THE SELECTED CARD LIFTS WHEN THE REMOTE IS ACTUALLY IN THE DECK, and sits flat when it is not.
 * That distinction is the whole reason this is a separate number rather than just a bigger card:
 * a deck still has a selected episode while focus is off on WATCH, and the lift is what says
 * "the remote is HERE", which is exactly what a card cannot say once its ring is taken away.
 *
 * It has to be applied in JS rather than by a `:focus-visible` rule, because `transform` is one
 * property: the cards carry an inline transform that also positions them, and a stylesheet rule
 * setting `transform: scale(...)` would replace the translate along with it — and lose to the
 * inline style anyway. */
const FOCUS_SCALE = 1.06;
/* OPACITY FALLS GEOMETRICALLY, AND THE SAME WAY IN BOTH DIRECTIONS: each card keeps this
 * fraction of the one nearer the selection. 1 · 0.85 · 0.72 · 0.61.
 *
 * THE RATIO IS DELIBERATELY SHALLOW, and it took two goes to get there — 0.6 first, then 0.78,
 * both of which looked reasonable as a ladder of numbers and too faint on an actual panel. The
 * mistake behind both was treating opacity as the thing that marks the selection. It is not, and
 * it does not have to be: the focused card is the biggest, the only fully opaque one, the only
 * one with a hairline, and the only one carrying the focus ring. Four signals, none of them
 * opacity. That leaves opacity free to do the one job it is actually good at here — depth — and
 * depth reads at 0.85 per step as well as it does at 0.6, while a season still looks like it
 * continues past the edges of the screen instead of dissolving two cards out.
 *
 * There is a real ceiling above this, though it is not close: as the ratio approaches 1 the
 * cards stop separating from one another and the fan flattens into overlapping rectangles.
 *
 * It used to be a subtraction, and a different one per side (0.78 falling by 0.26 ahead, 0.58
 * by 0.20 behind), on the argument that the next episode is the one you would press and should
 * look available. Two problems with that. A subtraction is not a fade — the same 0.26 is a third
 * of the way down at the top of the run and most of what is left at the bottom, so the steps
 * read as uneven — and the asymmetry meant a card one place BEHIND the selection and one place
 * AHEAD of it, equally far away and equally not-selected, were drawn differently for no reason
 * the viewer could see. A ratio gives every step the same visual weight, which is what "further
 * away" should look like. */
const OPACITY_STEP = 0.85;

/** Same threshold history.ts uses to stop offering a resume — past this, it's watched. */
const WATCHED = 0.94;

/* The ids focus can be sitting on without anyone having chosen it — see the seeding note below.
 * `mWatch` is kept for the case where a WATCH button exists; the TV title screen no longer
 * renders one, so in this build the ✕ is the only park that actually occurs. */
const AUTO_PARKED = new Set(['mWatch', 'closeModal']);

/** Cumulative offset `d` cards out, each step shorter than the last. */
function stack(step: number, d: number, decay: number) {
  let total = 0;
  let s = step;
  for (let k = 0; k < d; k++) { total += s; s *= decay; }
  return total;
}

/* HOW FAR THE FAN REACHES BELOW THE FOCUSED CARD'S CENTRE, in card-heights — the cumulative
 * run of steps, plus half of the last card (which is scaled, so it is half of a smaller box).
 *
 * The CSS needs this to park the fan against the bottom of the column, and it must not be a
 * second copy of the number: it falls out of STEP_DOWN, STEP_DECAY, DECK_BELOW and STEP_SCALE,
 * so change any of those and the anchor follows on its own. Handed over as a custom property on
 * the deck. */
const BELOW_EXTENT =
  (stack(STEP_DOWN, DECK_BELOW, STEP_DECAY) + 50 * Math.max(MIN_SCALE, 1 - DECK_BELOW * STEP_SCALE)) / 100;

interface Placement { transform: string; opacity: number; zIndex: number }

/** Where a card sits, given how far it is from the one in focus. `lifted` = the remote is in the
 *  deck, so the selected card takes its focus zoom. */
function place(offset: number, lifted: boolean): Placement {
  const d = Math.abs(offset);
  const y = (offset < 0 ? -1 : 1) * stack(offset < 0 ? STEP_UP : STEP_DOWN, d, STEP_DECAY);
  const x = stack(STEP_X, d, STEP_X_DECAY);
  const scale = d === 0
    ? (lifted ? FOCUS_SCALE : 1)
    : Math.max(MIN_SCALE, 1 - d * STEP_SCALE);
  const opacity = OPACITY_STEP ** d;
  return {
    transform: `translate(${x}%, ${y}%) scale(${scale})`,
    opacity,
    zIndex: 100 - d,
  };
}

/* THE STILL IS RE-REQUESTED AT w500. The API hands them out at w300 — right for the web
 * chooser's 150px card and half the resolution this one needs, since a deck card is up to 560px
 * wide. `imgW` only rewrites TMDB URLs, so an add-on's own still passes through untouched. */
const STILL_RENDITION = 'w500';

/** `1h 22m` / `27m`, from seconds. */
function dur(sec: number) {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/* `Episode.runtime` is typed `number` and the live API sends `"60m"` — a pre-formatted string.
 * Both spellings are in the wild (add-on catalogues supply minutes), so take either rather than
 * printing `NaNm` on whichever one this build did not expect. */
function runtimeText(runtime: unknown): string {
  if (typeof runtime === 'number' && runtime > 0) return dur(runtime * 60);
  if (typeof runtime === 'string' && runtime.trim()) {
    const mins = Number(runtime);
    return Number.isFinite(mins) && mins > 0 ? dur(mins * 60) : runtime.trim();
  }
  return '';
}

export function seasonsOf(meta: MetaDetail): SeasonInfo[] {
  if (meta.seasonList?.length) return meta.seasonList;
  if (meta.seasons) return Array.from({ length: Number(meta.seasons) }, (_, i) => ({ season: i + 1, episodes: 0 }));
  return [];
}

/** Whether TvDetail should give the panel over to the deck (and drop its own chrome for it).
 *
 *  `imdb` OR `addonEpisodes`: the IMDb id is what makes the TMDB season fetch addressable,
 *  and an add-on-described show brings its own episode list instead — see the note in
 *  EpisodeChooser. Requiring the id alone is what kept the deck off every series that came
 *  from a community catalog with its own ids. */
export function hasEpisodeDeck(meta?: MetaDetail): boolean {
  return !!meta && (!!meta.imdb || !!meta.addonEpisodes) && seasonsOf(meta).length > 0;
}

interface CardProps {
  ep: Episode;
  offset: number;
  on: boolean;
  /** the remote is inside the deck — only then does the selected card lift */
  lifted: boolean;
  pct: number;
  leftSec: number;
  onPick: () => void;
  /** which phase of the deal the deck is in; null once it is over (and for every card that mounts
   *  afterwards, which is every card the remote walks onto) */
  intro: IntroPhase;
}

/* ---- THE DEAL'S NUMBERS. The mechanism is documented on `intro` in the deck below. ------------ */
type IntroPhase = 'pre' | 'run' | null;
/** Cards past this share the last step. Beyond it the delay outruns the movement and the tail of
 *  the deck arrives on its own, after everything else has settled — a queue, not a deal. */
const INTRO_STEP_CAP = 5;
/** Gap between one card starting and the next. Short enough to read as one gesture. */
const INTRO_STEP_MS = 55;
/** MUST TRACK `.tv-ep-card`'s transition in tv.css — it is that transition doing the movement. */
const CARD_IN_MS = 340;
/** How far below its place a card starts, as a share of its own height. A percentage rather than
 *  pixels so it holds on a 720p package and on a 4K panel, where the cards are different sizes and
 *  the same 80px would read as a lurch on one and a twitch on the other. */
const INTRO_RISE = '34%';

function EpisodeCard({ ep, offset, on, lifted, pct, leftSec, onPick, intro }: CardProps) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  /* THE STILL FADES IN WHEN IT ARRIVES, and this is most of what "the deck appears heavily" was.
   * Eight <img> elements decode at eight different moments and each one used to SNAP from the
   * placeholder to a full-brightness photograph — so a deck that is otherwise gliding into place
   * finishes as a burst of hard pops, in no particular order, over the second after it lands.
   *
   * `complete` is checked as well as `load`, and it is not belt-and-braces: a still already in the
   * cache can finish decoding before React has attached the handler, in which case `load` never
   * fires for it and the card would sit at opacity 0 permanently — an invisible episode. Walking
   * back to a card you have already seen is exactly that case. */
  const [shown, setShown] = useState(false);
  /* LATCHED AT MOUNT AND NEVER RECOMPUTED. It is the stagger's step, and it has to be frozen:
   * `offset` changes on every press, and a CSS `animation-delay` that GROWS after its animation
   * has finished can drop the element back inside the delay window — where `backwards` fill would
   * snap it to opacity 0. Cards would blink as the remote walked past them. Frozen, each element
   * keeps the step it entered on for as long as it exists. */
  const introStep = useRef(Math.min(Math.abs(offset), INTRO_STEP_CAP));
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  const { transform, opacity, zIndex } = place(offset, lifted);

  /* The offset is PREPENDED to the placement rather than replacing it, so a card rises into the
   * exact spot `place` computed for it — including its scale and its share of the fan — instead of
   * flying to a position this code would have to duplicate. Percentages in a transform resolve
   * against the element's own box, and the outer translate is applied in the parent's space, so
   * the rise is a clean 34% of card height whatever scale the card is wearing.
   *
   * The delay is carried through 'run' as well as 'pre': it has to be on the element in the commit
   * that CHANGES the values, or the transition it is meant to stagger starts immediately. */
  const rising = intro === 'pre';
  const style: CSSProperties = {
    transform: rising ? `translateY(${INTRO_RISE}) ${transform}` : transform,
    opacity: rising ? 0 : opacity,
    zIndex,
    transitionDelay: intro ? `${introStep.current * INTRO_STEP_MS}ms` : undefined,
  };

  /* One line under the title, and it answers the only question the card is asked: how much of
   * this is left? Failing that, how long is it? A card with neither says nothing extra rather
   * than padding itself with an air date nobody reads from a sofa. */
  const sub = pct >= WATCHED * 100
    ? t('modal.ep_watched')
    : leftSec > 0
      ? t('modal.ep_left', { time: dur(leftSec) })
      : runtimeText(ep.runtime);

  return (
    <button
      type="button"
      className={`tv-ep-card${on ? ' on' : ''}${on && lifted ? ' is-lifted' : ''}`}
      style={style}
      tabIndex={on ? 0 : -1}
      aria-hidden={on ? undefined : true}
      aria-label={`E${ep.episode} ${name}`}
      onClick={onPick}
    >
      <span className="tv-ep-art" aria-hidden="true">
        {ep.still && !broken
          ? (
            <img
              className={shown ? 'rdy' : undefined}
              src={imgW(ep.still, STILL_RENDITION)}
              alt=""
              decoding="async"
              loading="lazy"
              ref={(el) => { if (el?.complete && !shown) setShown(true); }}
              onLoad={() => setShown(true)}
              onError={() => setBroken(true)}
            />
          )
          : <span className="tv-ep-nostill" data-n={`E${ep.episode}`} />}
      </span>
      <span className="tv-ep-scrim" aria-hidden="true" />
      <span className="tv-ep-copy">
        <span className="tv-ep-title"><b>{ep.episode}.</b> {name}</span>
        {sub && <span className="tv-ep-sub">{sub}</span>}
      </span>
      {pct > 0 && pct < WATCHED * 100 && (
        <span className="tv-ep-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      )}
    </button>
  );
}

export interface TvEpisodeDeckProps {
  meta: MetaDetail;
  /** the modal's target id — the prefix of every per-episode progress key */
  titleId: string | number;
  picked: { season: number; ep: number } | null;
  onPick: (season: number, ep: number) => void;
  /** Add / Report, rendered beside the season chip. Owned by TvDetail so the sources head can
   *  show the same two buttons — see the note there. */
  actions?: ReactNode;
}

export default function TvEpisodeDeck({ meta, titleId, picked, onPick, actions }: TvEpisodeDeckProps) {
  const t = useT();
  const progress = useHistory((s) => s.progress);

  const seasons = useMemo(() => seasonsOf(meta), [meta]);
  const firstSeason = useMemo(() => (seasons.find((s) => s.season >= 1) || seasons[0])?.season, [seasons]);
  const [openSeason, setOpenSeason] = useState<number | undefined>(picked?.season ?? firstSeason);
  const season = openSeason ?? firstSeason;
  // TMDB, or the add-on's own `videos[]` when this title is one TMDB cannot name. Mutually
  // exclusive by construction — `addonEpisodes` is set only on a record `collectAddonMeta`
  // built — so the season query is disabled rather than fired and discarded.
  const fromAddon = meta.addonEpisodes;
  const { data, isLoading } = useSeason(meta.id, fromAddon ? undefined : season, meta.imdb);
  const episodes: Episode[] = useMemo(() => (fromAddon
    ? fromAddon.filter((e) => e.season === season).map((e) => ({
      episode: e.episode, name: e.name, overview: e.overview, still: e.still, air_date: e.air_date,
    }))
    : data?.episodes ?? []), [data, fromAddon, season]);

  const [active, setActive] = useState(0);
  /* Whether the remote is IN the deck. With the focus ring gone, the selected card's lift is the
   * only thing left saying so — and it must be able to say "no", because the deck keeps a
   * selection while focus is away on WATCH or up in the season chip. Same onFocus/onBlur pair
   * TvSpotlight uses to open a row, including the relatedTarget check that distinguishes "focus
   * moved to a sibling card" (still ours) from "focus left entirely". */
  const [lifted, setLifted] = useState(false);
  const deckRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);   // the row the season chip sits in — Up's destination

  /* ---- THE DEAL: the deck arrives one card at a time -----------------------------------------
   *
   * Three phases, like every staged animation in this build: 'pre' is the offset committed and
   * not yet moving, 'run' is the movement, null is the deck at rest with nothing left on it.
   *
   * DRIVEN FROM HERE RATHER THAN FROM A KEYFRAME, AND THAT IS FORCED. Every card's position is an
   * inline `transform` written by `place` on each render. A keyframe that also animated transform
   * would own the property for its whole duration and then hand it back — a jump on the last frame
   * of every entrance, on eight cards. So the deal uses the card's OWN transition, the .34s
   * transform/opacity it already carries for walking the deck: render every card pushed down and
   * transparent, then one frame later render it where it belongs, and the transition it already
   * had does the movement. Nothing new animates; the existing animation is simply given a
   * different starting point.
   *
   * THE STAGGER IS A PER-CARD `transition-delay` THAT EXISTS ONLY WHILE `intro` DOES. That is the
   * whole reason for the third phase: left in place, the same delay would sit on every subsequent
   * press, so walking the deck would answer the remote up to 200ms late. It is removed on a commit
   * that changes nothing else, so removing it starts no transition of its own.
   *
   * STARTED WHEN THE CARDS ARRIVE, NOT WHEN THE DECK MOUNTS. The deck renders before its episodes
   * do (a season is a fetch), so a phase clock hung off mount would have run itself out against an
   * empty container and the cards would have appeared, fully placed, into a finished animation.
   * Re-armed per season for the same reason: a new season is a new set of cards and should be
   * dealt like one. */
  // Read the same way TvHero and TvSpotlight read it — once, plainly, no listener: an OS setting
  // changed mid-session is not worth one, and the value is only consulted when a deck is dealt.
  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [intro, setIntro] = useState<IntroPhase>(reduceMotion ? null : 'pre');
  useEffect(() => { setIntro(reduceMotion ? null : 'pre'); }, [season, reduceMotion]);

  /* Two frames between placing and moving. The first is the frame the offset state is painted in;
   * flipping inside it can be coalesced into one style recalculation, which produces no transition
   * at all — the cards just appear where they belong. The second guarantees the browser has seen
   * the two states separately. (Same two-frame rule as the trailer's flight in TvDetail.) */
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
  /* Focus is only ever MOVED by this component when this component moved the selection. Without
   * the flag the effect below would also fire when the deck first renders — snatching the remote
   * away from whatever TvSpatialNav had just seeded (WATCH) the moment a season loaded. */
  const walked = useRef(false);

  /** pos/dur for one episode, from the same key DetailModal writes progress under. */
  const resumeOf = (ep: number) => {
    const p = progress[`${titleId}:S${season}E${ep}`];
    if (!p || !(p.dur > 0)) return { pct: 0, leftSec: 0, at: 0 };
    return { pct: Math.min(100, (p.pos / p.dur) * 100), leftSec: Math.max(0, p.dur - p.pos), at: p.at || 0 };
  };

  // A new season is a new deck: it may re-aim itself, and the remote has not walked it yet.
  useEffect(() => { walked.current = false; }, [season]);

  /* WHERE THE DECK OPENS: on UP NEXT, not on episode 1.
   * The most recently touched episode of this season wins — and if it is finished, the one after
   * it, which is the episode the viewer actually came back for. A season never started opens on
   * its first.
   *
   * ONCE THE VIEWER HAS MOVED, THIS STOPS. `progress` is in the dependency list because the deck
   * has to re-aim when a season's history arrives late (the store pulls from /api/library-state
   * on focus, and finishes after the episode list does) — but the same dependency would other-
   * wise yank a walked selection back to "up next" the next time that pull landed. */
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

  // Carry the remote with the selection — see `walked` above for why this is gated.
  useEffect(() => {
    if (!walked.current) return;
    deckRef.current?.querySelector<HTMLElement>('.tv-ep-card.on')?.focus({ preventScroll: true });
  }, [active]);

  /* OPENING A SERIES PUTS THE REMOTE ON THE EPISODE, not on WATCH.
   *
   * TvSpatialNav seeds every overlay with `#mWatch`, which is right for a film — there is one
   * thing to do and that is it. A series is the other case: WATCH cannot play anything until an
   * episode is chosen, so landing there means the first press is always "go find the episode".
   *
   * THE DECK HAS TO CLAIM FOCUS ITSELF RATHER THAN TvSpatialNav PREFERRING IT, because of when
   * each exists. WATCH appears the moment /api/meta lands; the cards appear later still, after
   * /api/tv/:id/season. A seeder that looked for a card at seed time would find none and settle
   * on WATCH for every series. Only the deck knows when its episodes have arrived.
   *
   * IT ONLY TAKES FOCUS FROM AN AUTOMATIC PARK. If the viewer has moved somewhere deliberately
   * in the moment before the season loaded, focus is theirs and this stands down permanently.
   * There are exactly three places focus can be without anyone having chosen it: `body` (nothing
   * focused yet), `#closeModal` (DetailModal focuses its ✕ 40ms after opening) and `#mWatch`
   * (TvSpatialNav's seed, once /api/meta lands). WHICH of the three depends on how fast the
   * season request came back relative to the metadata one — a race this has no business caring
   * about, and it lost it while the ✕ was missing from the list: a Continue Watching open, whose
   * season is usually cached and therefore early, stood down every time.
   *
   * The rAF is what makes it land on the RIGHT card. This runs on the same commit that discovers
   * the episodes, when `active` is still 0; the effect above then re-aims it at "up next", which
   * is a second render. Deferring a frame — and cancelling on cleanup when `active` does change —
   * means the focus call happens after the deck has settled rather than on the card it opened on
   * and immediately abandoned. */
  const autoSeeded = useRef(false);
  useEffect(() => {
    if (autoSeeded.current || !episodes.length) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && !AUTO_PARKED.has(ae.id)) { autoSeeded.current = true; return; }
    const id = requestAnimationFrame(() => {
      const card = deckRef.current?.querySelector<HTMLElement>('.tv-ep-card.on');
      if (card) { card.focus({ preventScroll: true }); autoSeeded.current = true; }
    });
    return () => cancelAnimationFrame(id);
  }, [episodes, active]);

  if (!seasons.length || !meta.imdb) return null;

  const step = (delta: number) => {
    const next = active + delta;
    if (next < 0 || next >= episodes.length) return false;
    walked.current = true;
    setActive(next);
    return true;
  };

  /* Up/Down walk the deck and are consumed so the global D-pad handler does not ALSO try to move
   * focus through a stack of overlapping cards. At the BOTTOM the key is left alone, which is how
   * the remote gets down to whatever is below.
   *
   * AT THE TOP IT IS AIMED AT THE SEASON CHIP RATHER THAN RELEASED. Letting it go handed the press
   * to TvSpatialNav, which scores the head row by geometry and answers with the ✕ in the far
   * corner — it is genuinely the nearest candidate above a full-width card, and it closes the
   * title the viewer was picking an episode from. The chip is what Up MEANS here: it is the head
   * of this panel, it names what the deck is showing, and every other control in the head row is
   * one press sideways from it. The source list makes the same correction for the same reason —
   * see `leaveList` in TvDetail. */
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (step(e.key === 'ArrowDown' ? 1 : -1)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowUp') return;                 // the bottom of the deck stays a way out
    const chip = headRef.current?.querySelector<HTMLElement>('.tv-chipmenu-btn');
    if (!chip) return;                               // no head to go back to; leave the key alone
    e.preventDefault();
    e.stopPropagation();
    chip.focus({ preventScroll: true });
  };

  const win = episodes.slice(Math.max(0, active - DECK_ABOVE), active + DECK_BELOW + 1);
  const base = Math.max(0, active - DECK_ABOVE);

  return (
    <>
      <div className="tv-det-panel-head tv-ep-head" ref={headRef}>
        {/* THE "EPISODES" HEADING IS STILL HERE, JUST NOT DRAWN. On screen it was a label on a
            column of episode cards — it named what was already obvious, in the corner where the
            season chip does real work. Deleting the element outright is the tempting version and
            the wrong one: it is the only thing that names this region, so a screen reader would
            be left with an unlabelled stack of buttons. `.sr-only` keeps the name and takes back
            the pixels. */}
        <h3 className="tv-det-panel-title sr-only">{t('modal.episodes')}</h3>
        <TvChipMenu
          ariaLabel={t('modal.episodes')}
          value={String(season)}
          onSelect={(k) => setOpenSeason(Number(k))}
          options={seasons.map((s) => ({
            key: String(s.season),
            label: s.name || t('modal.season', { n: s.season }),
          }))}
        />
        {actions}
      </div>

      <div
        className="tv-ep-deck"
        ref={deckRef}
        onKeyDown={onKey}
        onFocus={() => setLifted(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setLifted(false); }}
        style={{ '--ep-below': BELOW_EXTENT } as CSSProperties}
      >
        {isLoading ? (
          <div className="tv-det-note tv-ep-note">{t('modal.loading_synopsis')}</div>
        ) : episodes.length ? (
          win.map((e, i) => {
            const idx = base + i;
            const r = resumeOf(e.episode);
            return (
              <EpisodeCard
                key={e.episode}
                ep={e}
                offset={idx - active}
                on={idx === active}
                lifted={lifted}
                intro={intro}
                pct={r.pct}
                leftSec={r.leftSec}
                /* A card that is not the selection becomes it; the selection itself commits.
                 * On a remote only the second half can ever happen — the first is for the mouse
                 * in `npm run dev:tv`, where clicking a tucked card should reach it, not skip it. */
                onPick={() => {
                  if (idx !== active) { walked.current = true; setActive(idx); return; }
                  onPick(season!, e.episode);
                }}
              />
            );
          })
        ) : (
          <div className="tv-det-note tv-ep-note">{t('modal.episodes_unavailable')}</div>
        )}
      </div>
    </>
  );
}
