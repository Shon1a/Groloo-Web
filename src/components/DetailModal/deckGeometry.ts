import type { MetaDetail, SeasonInfo } from '../../lib/types';

/* ============================================================================
 * THE EPISODE DECK'S GEOMETRY — shared by the TV deck (TvEpisodeDeck) and the web one
 * (EpisodeChooser), so the two are the SAME object at different sizes rather than two things
 * that happened to be tuned alike once. Every number below was measured on a panel; the
 * reasoning is kept with the number it justifies. Change one here and both decks follow.
 *
 *     ┌──────────────┐        · the cards BEHIND collapse into a tight stack, dim and
 *     │ ┌──────────┐ │          receded to the right — enough to say "there are earlier
 *     │ │┌────────┐│ │          episodes", not enough to read
 *     │ ││        ││ │        · the FOCUSED card is forward, full size, opaque
 *     │┌┴┴────────┴┴┐│        · the cards AHEAD fan down at a readable pitch and fade out
 *     ││ 11. Episode││
 *     ││ 27m left   ││        Only `transform` and `opacity` differ between the states, which
 *     │└────────────┘│        is the one thing a GPU composites for free. Nothing reflows.
 *     │ ┌──────────┐ │
 *     │ │12. …     │ │
 * ==========================================================================*/

/* GEOMETRY, IN PERCENTAGES OF THE CARD'S OWN BOX. A `translate()` percentage resolves against
 * the element being moved, so the deck's proportions survive whatever `clamp()` sizes a card off
 * the viewport — one set of numbers for a 720p webOS package, a 1080p set, a desktop modal and
 * a phone alike. */
export const STEP_DOWN = 56;     // % of card height to the next card ahead
export const STEP_UP = 22;       // …and to the one behind, which is why the back stack reads as a stack
export const STEP_DECAY = 0.82;  // each further card sits closer to its neighbour: the ends bunch
export const STEP_X = 5;         // % of card width each card recedes to the right
export const STEP_X_DECAY = 0.8;
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
export const STEP_SCALE = 0.1;
export const MIN_SCALE = 0.65;
/* THE SELECTED CARD LIFTS WHEN THE INPUT IS ACTUALLY IN THE DECK (the remote on TV; a pointer or
 * keyboard focus on the web), and sits flat when it is not. That distinction is the whole reason
 * this is a separate number rather than just a bigger card: a deck still has a selected episode
 * while focus is elsewhere, and the lift is what says "the input is HERE", which is exactly what
 * a card cannot say once its ring is taken away.
 *
 * It has to be applied in JS rather than by a `:focus-visible`/`:hover` rule, because `transform`
 * is one property: the cards carry an inline transform that also positions them, and a
 * stylesheet rule setting `transform: scale(...)` would replace the translate along with it — and
 * lose to the inline style anyway. */
export const FOCUS_SCALE = 1.06;
/* OPACITY FALLS GEOMETRICALLY, AND THE SAME WAY IN BOTH DIRECTIONS: each card keeps this
 * fraction of the one nearer the selection. 1 · 0.85 · 0.72 · 0.61.
 *
 * THE RATIO IS DELIBERATELY SHALLOW, and it took two goes to get there — 0.6 first, then 0.78,
 * both of which looked reasonable as a ladder of numbers and too faint on an actual panel. The
 * mistake behind both was treating opacity as the thing that marks the selection. It is not, and
 * it does not have to be: the focused card is the biggest, the only fully opaque one, the only
 * one with a shadow. That leaves opacity free to do the one job it is actually good at here —
 * depth — and depth reads at 0.85 per step as well as it does at 0.6, while a season still looks
 * like it continues past the edges of the screen instead of dissolving two cards out.
 *
 * There is a real ceiling above this, though it is not close: as the ratio approaches 1 the
 * cards stop separating from one another and the fan flattens into overlapping rectangles. */
export const OPACITY_STEP = 0.85;

/** Same threshold history.ts uses to stop offering a resume — past this, it's watched. */
export const WATCHED = 0.94;

/* THE STILL IS RE-REQUESTED AT w500. The API hands them out at w300 — right for a 150px list
 * thumbnail and half the resolution a deck card needs, since one is up to 560px wide. `imgW`
 * only rewrites TMDB URLs, so an add-on's own still passes through untouched. */
export const STILL_RENDITION = 'w500';

/** Cumulative offset `d` cards out, each step shorter than the last. */
export function stack(step: number, d: number, decay: number) {
  let total = 0;
  let s = step;
  for (let k = 0; k < d; k++) { total += s; s *= decay; }
  return total;
}

/* HOW FAR THE FAN REACHES BELOW THE FOCUSED CARD'S CENTRE, in card-heights — the cumulative run
 * of steps, plus half of the last card (which is scaled, so it is half of a smaller box). And the
 * same above it, where the steps are the short STEP_UP ones.
 *
 * The CSS needs these to size and anchor the deck, and they must not be second copies of the
 * numbers: they fall out of the step, the decay, the window and the scale, so change any of
 * those and the anchors follow on their own. Handed over as custom properties on the deck. */
export function belowExtent(cardsBelow: number) {
  return (stack(STEP_DOWN, cardsBelow, STEP_DECAY) + 50 * Math.max(MIN_SCALE, 1 - cardsBelow * STEP_SCALE)) / 100;
}
export function aboveExtent(cardsAbove: number) {
  const back = (stack(STEP_UP, cardsAbove, STEP_DECAY) + 50 * Math.max(MIN_SCALE, 1 - cardsAbove * STEP_SCALE)) / 100;
  // the focused card lifted is the other candidate for the top edge
  return Math.max(back, FOCUS_SCALE / 2);
}

export interface Placement { transform: string; opacity: number; zIndex: number }

interface Parts { x: number; y: number; scale: number; opacity: number }

/** The four numbers behind a card `d` WHOLE steps from the selection (signed: behind < 0). */
function partsAt(offset: number, lifted: boolean): Parts {
  const d = Math.abs(offset);
  return {
    x: stack(STEP_X, d, STEP_X_DECAY),
    y: (offset < 0 ? -1 : 1) * stack(offset < 0 ? STEP_UP : STEP_DOWN, d, STEP_DECAY),
    scale: d === 0 ? (lifted ? FOCUS_SCALE : 1) : Math.max(MIN_SCALE, 1 - d * STEP_SCALE),
    opacity: OPACITY_STEP ** d,
  };
}

/** Where a card sits, given how far it is from the one in focus. `lifted` = the input is in the
 *  deck, so the selected card takes its focus zoom.
 *
 *  A FRACTIONAL OFFSET IS ALLOWED, and is what a finger dragging the web deck produces: the card
 *  is drawn part-way between the two whole-step placements either side of it, so the fan follows
 *  the drag continuously instead of snapping a step at a time. Whole numbers cost nothing extra —
 *  the interpolation collapses to one placement. */
export function place(offset: number, lifted: boolean): Placement {
  const lo = Math.floor(offset);
  const t = offset - lo;
  let p: Parts;
  if (t === 0) {
    p = partsAt(lo, lifted);
  } else {
    /* The lift is interpolated out of, not dropped. A card grabbed while it is lifted must
     * stay the size it was grabbed at and shrink as it recedes; dropping the lift on the
     * first pixel of a drag — with transitions off — was a visible snap from 1.06 to 1 the
     * moment the pointer moved. Only the whole-step end that IS offset 0 carries the lift. */
    const a = partsAt(lo, lifted);
    const b = partsAt(lo + 1, lifted);
    p = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      scale: a.scale + (b.scale - a.scale) * t,
      opacity: a.opacity + (b.opacity - a.opacity) * t,
    };
  }
  return {
    transform: `translate(${p.x}%, ${p.y}%) scale(${p.scale})`,
    opacity: p.opacity,
    zIndex: 100 - Math.round(Math.abs(offset)),
  };
}

/** `1h 22m` / `27m`, from seconds. */
export function dur(sec: number) {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/* `Episode.runtime` is typed `number` and the live API sends `"60m"` — a pre-formatted string.
 * Both spellings are in the wild (add-on catalogues supply minutes), so take either rather than
 * printing `NaNm` on whichever one this build did not expect. */
export function runtimeText(runtime: unknown): string {
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
