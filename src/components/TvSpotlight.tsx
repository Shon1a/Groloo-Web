import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { useVideoTrailer, INTRO_SKIP } from './DetailModal/useVideoTrailer';
import { useMeta, usePrefetchMeta, useImdbTrailer, usePrefetchImdbTrailer } from '../lib/queries';
import { useSettings } from '../stores/settings';
import { usePreviewSound } from '../stores/previewSound';
import { isPreviewSoundKey } from '../lib/tvKeys';
import { FadeBg, FadeImg } from './FadeArt';

/* A TV HOME ROW — every row below the featured billboard is one of these (Row renders it
 * whenever MODE === 'tv', so home rows, Upcoming and add-on catalogues all get it).
 *
 * THE LEADING CARD IS ALWAYS THE BILLBOARD. Every row rests as a 16:9 billboard — backdrop,
 * tag and title plate — followed by its strip of portrait posters. It does not grow out of a
 * poster when the row is reached; a row that has not been reached looks exactly like the one
 * that has, minus two things:
 *
 *   RESTING — heading dimmed, no info panel.
 *   FOCUSED (the row the remote is on) — heading brightens, and the genre · year · ★rating line
 *   plus the synopsis fade in beneath. Left/Right then walk the row, cross-dissolving the
 *   billboard between titles and sliding the strip one card at a time.
 *
 * THE TV BUDGET IS PAID BY VISIBILITY, NOT BY FOCUS. A dozen 16:9 backdrops decoded at once is
 * the largest passive memory load on this screen, so a row's backdrop is not requested until the
 * row comes NEAR the viewport (`visible`, an IntersectionObserver with a screenful of margin).
 * A cold home screen loads the two or three rows you can actually see; the rest cost nothing
 * until you scroll toward them, and once loaded they stay. Gating on focus instead was tried and
 * is wrong — it left rows sitting in plain sight with no artwork.
 *
 * Nothing here reflows: the info panel's height is RESERVED in both states (see tv.css), so a
 * row gaining focus never moves the rows below it — on a page this long that would be a
 * whole-document layout pass on every keypress. Only opacity and transform animate.
 *
 * NOTHING RESPONDS TO HOVER, deliberately. Both the row's focus state and the billboard's
 * position in the strip used to follow the mouse, which on a TV build is at best untested and in
 * a browser is actively wrong: scrolling drags the cursor across tiles it never meant to touch,
 * so the artwork walked to the next poster on its own while the page moved. The remote — focus —
 * is the only thing that drives this component. A click still opens a title. */

/* Titles a home row walks. Cut from 12 as part of the TV fill-rate pass: the strip paints at most
 * ~5 posters to the right of the billboard at 1080p, and every title past that is DOM and bitmap
 * nobody has seen — 13 rows made it the largest passive load on the screen. Nothing is lost: the
 * card at the end of every row opens the full browse grid. Rows that ARE a page (TV / Movies /
 * Anime) pass their own `max` and are unaffected. */
const SPOT_MAX = 10;

/* ms the remote must sit still on a title before its trailer is even asked for.
 *
 * Cut from 1500 to claw back the only part of the wait that is ours to spend. Everything after this
 * used to belong to YouTube — fetching the key, loading the embed, and above all the ~4.5s of
 * playback its pause glyph occupied — so this is where a faster start had to come from. All of that
 * wait is now gone with the embed itself; this timer keeps the job it always had, which is not
 * starting a preview at all for a title someone is merely walking past.
 *
 * NOW 500, AND THE GUARANTEE IT PROTECTS HAS MOVED. At 800 this timer was doing two jobs: keeping a
 * passing title from mounting an embed, and keeping a walk along a row from firing twelve /api/meta
 * requests. The second job is now done better by warming the neighbours instead (see
 * TRAILER_PREFETCH_SPAN) — walking onto an adjacent card hits a cache rather than the network — so
 * the timer is free to shrink toward the only job it still has, which is the embed. 500ms is above
 * a deliberate walk and comfortably above a held key, and 300ms of pure dead time is gone. */
const TRAILER_DWELL = 500;
/* How far either side of the resting title to warm the next preview's data. One card each way,
 * because one card each way is what a press of Left or Right reaches, and the point is to have the
 * trailer in hand BEFORE the next rest rather than to cache the row. */
const TRAILER_PREFETCH_SPAN = 1;
/* THE YOUTUBE EMBED IS GONE FROM THIS ROW, AND IT WAS THE MOST EXPENSIVE THING ON THE SCREEN.
 *
 * It was a cross-origin iframe: a second player with its own JS, its own decoder and its own
 * compositing, mounted over a home screen that is already holding a dozen rows of artwork. On a
 * TV that is not a fallback, it is the thing that makes the shelf stutter — and it was also the
 * worst preview of the two, because YouTube stamps a pause glyph in the dead centre of the player
 * that no crop can reach and that took ~4.8 SECONDS of playback to fade (the whole of the old
 * TRAILER_REVEAL_AT, removed with it).
 *
 * WHAT A TITLE WITHOUT AN IMDb TRAILER DOES NOW: nothing. The artwork stays up, which is exactly
 * what a resting row already looks like, so the row loses a preview rather than gaining a defect.
 * The /api/meta lookup that used to fetch the embed's key is KEPT — but only to read the IMDb id
 * off it, which is what lets the ungated feeds (Upcoming, the Featured Hero) reach the file
 * engine at all. See `wantImdbLookup` below. */

/* MUST TRACK `.tv-spot-trailer-slot video`'s scale in tv.css. The preview is magnified to hide
 * the letterboxing IMDb bakes into its files, which means the video is sampled at more than the
 * billboard's width — so the rendition has to be chosen against the magnified size, not the box.
 * Wrong here and the picture goes soft for a reason nothing on screen explains. */
const BILLBOARD_TRAILER_CROP = 1.35;

/* How far the billboard's picture drifts while it changes. MEASURED, not chosen: 24px of travel on
 * a 753px card in the reference. The full derivation is in the parallax effect below. */
const BILLBOARD_PARALLAX = '3.2%';
/** MUST MATCH the strip's curve in tv.css. Fitted to the reference, not picked from a list — the
 *  derivation is on the strip's `transition` there. */
const PARALLAX_EASE = 'cubic-bezier(.25, .46, .45, .94)';

/* ---- HOW LONG THE STRIP TAKES TO MOVE ONE CARD. Reasoning is at `step`. -------------------- */
/** A deliberate press. The reference's drift reaches zero 13 frames after it starts at 30fps, and
 *  is half-travelled at frame 4 — so ~430ms with the curve below, checked against our own running
 *  page rather than assumed. */
const SLIDE_MS = 430;
/** A press that arrived while the last was still travelling — a held key. Roughly half, so a hold
 *  keeps up without the curve losing its shape. */
const SLIDE_MS_CHAINED = 320;
/** Under this gap between presses, the remote is being held rather than tapped. */
const SLIDE_CHAIN_WINDOW = 320;

/* How long a press will wait for the incoming billboard to be decoded before dissolving anyway.
 * The full reasoning is on the swap gate; the number is "comfortably under half of SLIDE_MS", so
 * even a capped-out swap lands while the strip is still moving. */
const SWAP_WAIT_CAP = 200;

/* ---- HOW FAST THE PHOTOGRAPH ITSELF COMES UP, and why a HELD key needs its own answer --------
 *
 * MEASURED, and it is not the thing it looks like. A held key leaves the billboard dim for about
 * half the walk, which reads exactly like artwork that has not loaded — so the obvious diagnosis
 * is caching, and the obvious fix is to fetch further ahead. That was tried and measured and it
 * does NOTHING: five cards of lookahead against one card came out at 52.8% vs 52.7%, because by
 * four presses in the whole row has already been requested either way.
 *
 * What the frames actually say is that on the dim frames the picture had ALREADY ARRIVED — `rdy`
 * was true on 18 of 20, with none waiting on bytes. It was mid-fade. `.art-photo` takes 450ms to
 * reach full opacity, a held key arrives every ~120ms, and a fade four presses long simply never
 * finishes: each card starts its rise, gets a fifth of the way up, and is replaced. The row was
 * not short of pictures, it was short of TIME TO SHOW THEM.
 *
 * So the fade follows the pressing, exactly as the slide already does (SLIDE_MS /
 * SLIDE_MS_CHAINED, same `chained` test, same one idea about how this build answers a held key).
 * A deliberate press keeps the full 450ms, which is the settle the reference has and what makes a
 * single press feel like weight rather than a cut. A chained press gets a fade that FITS INSIDE
 * one press, so every card you fly past is a picture at full strength instead of a fifth of one. */
const ART_FADE_MS = 450;
/** Comfortably inside the ~120ms of a held key, so each card completes before the next arrives. */
const ART_FADE_MS_CHAINED = 90;

/* URLs already asked for by the warm-ahead, so walking back and forth over a row does not build a
 * fresh Image per press for a picture the browser already has. Module-scoped because the whole
 * point is that it OUTLIVES the row: this is what makes a return visit to a row free.
 * Strings only — no bitmaps are pinned here, which is the note on the warm effect. */
const warmed = new Set<string>();

/* Renditions sized to what is painted, not to the source. The billboard is 16:9 of a <=380px
 * row (~675px wide) and thumbs paint at ~228px — see the note in lib/hero.ts for why reaching
 * for `original` on a TV is fatal rather than merely wasteful. */
const BILLBOARD_RENDITION = 'w780';
const THUMB_RENDITION = 'w342';
/** Wordmarks paint at 201px wide at most on the billboard; w500 was 2.5x that. */
const LOGO_RENDITION = 'w300';

/* THE SOUND BADGE'S TWO GLYPHS, and they are the player's own — same 24-unit box, same filled
 * cone, same 1.8 stroke on the waves and on the cross. Copied rather than imported because the
 * player is a lazily-loaded chunk and a home row must not pull it in for two paths; a private
 * icon that quietly diverged from the one beside it would be the worse outcome, so if either
 * moves, both move (VideoPlayer's IcVolHud / IcVolMuteHud).
 *
 * Sized at 1em so a single font-size in tv.css drives them across both TV resolutions. */
const IcSoundOn = (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const IcSoundOff = (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

function isSeries(it: MediaItem) {
  return it.type === 'tv' || it.type === 'series';
}

export interface TvSpotlightProps {
  items: MediaItem[];
  /** Row heading. Defaults to "Featured". */
  title?: string;
  /** Category slug behind the row — the destination of its "see all" card. */
  cat?: string;
  onSelect?: (m: MediaItem) => void;
  onSeeAll?: (cat: string) => void;
  /* ---- THE TWO PROPS CONTINUE WATCHING NEEDS, AND NOTHING ELSE USES ---------------------------
   * That row was the last rail left on the TV home, and the reason recorded in tv.css was that
   * its cards carry two things a billboard has nowhere to put. Both turn out to be small.
   *
   * `resumeOf` is the first: how far through a title you are, which is the whole point of the
   * row. It draws as a bar across the foot of the billboard and of every strip tile, and its
   * note (S2:E4) leads the info line. The remove ✕ is the one thing genuinely dropped — a
   * corner button is a mouse affordance with no D-pad stop, and the row tidies itself anyway
   * (a title watched to the end leaves it without being asked). */
  resumeOf?: (item: MediaItem) => { pct: number; note?: string } | undefined;
  /** `enrich` is the second: watch history stores a poster and a title and nothing else, so
   *  unlike a catalogue card these arrive with no backdrop, no wordmark and no synopsis — the
   *  billboard would be a portrait poster cropped to 16:9 above an empty panel. Set this and the
   *  row fetches the rested title's detail to fill those three in (one request, cached by React
   *  Query, with the neighbours warmed so walking the row is instant).
   *
   *  IT IS ALSO WHAT PUTS A WORDMARK ON THE BROWSE ROWS. `titleLogo` is a per-title lookup the
   *  server does only for /api/home (the `logos=1` flag — see queries.ts); /api/browse ignores it
   *  and answers with plain text titles, so the TV / Movies / Anime billboards were the one place
   *  in the build showing a title set in type next to rows showing the real artwork. The detail
   *  payload carries the same logo, so enriching those rows closes the gap from this side without
   *  waiting on the backend to learn the flag. */
  enrich?: boolean;
  /** How many titles the row walks. Home rows keep the SPOT_MAX default; a page that IS one row
   *  (the TV / Movies / Anime surfaces) raises it, because there the row is the whole screen. */
  max?: number;
  /* ---- THE OTHER THING THE END CARD CAN BE ----------------------------------------------------
   * A row that has no page of its own to send you to, because it already IS the page, ends in a
   * card that LENGTHENS it instead of leaving it. Same card, same single focus stop, different
   * verb — see the note on `canSeeAll`. Mutually exclusive with `cat`/`onSeeAll`: two end cards
   * would be two answers to "what is past the last title", and the row only has room for one. */
  onMore?: () => void;
  /** Reflected on the end card while the next batch is in flight, so OK gives feedback instead of
   *  appearing to do nothing on a slow connection. */
  moreBusy?: boolean;
}

/* WHAT THE BILLBOARD IS SHOWING. A row walks its titles and then one stop past them, onto its own
 * category page or onto more of itself — so the thing on the billboard is a title OR that final
 * card, and both the cross-dissolve and the strip have to be able to hold either. */
type Slot = MediaItem | 'end';

export default function TvSpotlight({ items, title, cat, onSelect, onSeeAll, resumeOf, enrich, max, onMore, moreBusy }: TvSpotlightProps) {
  const t = useT();
  const genre = useGenre();
  const list = useMemo(() => items.slice(0, max || SPOT_MAX), [items, max]);
  const n = list.length;
  const heading = title || t('tv.featured');

  /* ---- THE ROW'S OWN PAGE, REACHED FROM THE END OF THE ROW ---------------------------------
   * The web rail puts "see all" in its HEADING, and this component's heading used to carry a
   * note explaining that a TV row simply could not have one: the billboard is the row's only
   * focus stop, so a button above it is not something a remote can ever land on. True, and it
   * left the TV build with no way to open a category at all — the drill-down pages exist and
   * were unreachable.
   *
   * The fix follows the row's own grammar instead of fighting it. Walking right past the last
   * title lands on ONE MORE STOP: a blank card at the end of the strip, which becomes the
   * billboard like any other card, and whose OK opens /browse/<cat>. Nothing new to focus and no
   * second affordance to explain — the row just got one card longer.
   *
   * It is conditional on a destination existing. Add-on catalogue rows (AddonRows) render through
   * the same component with no `cat`, and a card that goes nowhere is worse than no card. */
  const canSeeAll = !!cat && !!onSeeAll;
  const canMore = !canSeeAll && !!onMore;
  const hasEnd = canSeeAll || canMore;
  const stops = n + (hasEnd ? 1 : 0);
  /** What sits at walk position `i` — a title, or the end card in the extra slot past them. */
  const slotAt = (i: number): Slot => (i < n ? list[i] : 'end');
  /* The end card's two forms. "See all" leaves for the category page; "load more" makes the row
   * longer and, because the walk does not move, the card the billboard is showing simply becomes
   * the first of the titles that just arrived. */
  const endLabel = canSeeAll ? t('cat.see_all') : (moreBusy ? t('grid.loading') : t('grid.load_more'));
  const endIcon = canSeeAll ? '→' : '+';
  const goEnd = () => { if (canSeeAll && cat) onSeeAll?.(cat); else if (canMore && !moreBusy) onMore?.(); };

  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  /* Sticky: set once the row first comes near the viewport, never cleared — scrolling past a row
   * must not throw its bitmaps away and re-fetch them on the way back. */
  const [visible, setVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // Two billboard layers that swap which is on top, so a change cross-dissolves rather than cuts.
  const [xfade, setXfade] = useState<{ a: Slot; b: Slot | null; front: 'a' | 'b' }>(
    () => ({ a: list[0], b: null, front: 'a' }),
  );
  const firstRun = useRef(true);
  const trackRef = useRef<HTMLDivElement>(null);
  /** When the strip last moved — `step` reads it to tell a held key from a deliberate press.
   *  Up here with the other refs because `step` is defined past an early return. */
  const lastStepAt = useRef(0);
  const railRef = useRef<HTMLDivElement>(null);
  const prevActiveRef = useRef(0);

  /* ---- WHEN THE STRIP'S DUPLICATE COPY IS ALLOWED TO EXIST -----------------------------------
   * See the note in `thumbs`. The copy is the row's endless up-next preview and it is only ever
   * LOOKED at near the end of a walk, so a row nobody has touched should not be paying for it.
   * Two things can expose it, and both are latched rather than tracked — once built it stays, so
   * walking back and forth never re-decodes a poster:
   *
   *   THE ROW WAS FOCUSED. A walk cannot begin any other way, and mounting on the focus itself is
   *   a whole press earlier than the first Left/Right that could need it. Deliberately not a
   *   threshold on `active`: how many posters fit beside the billboard depends on the panel, so
   *   any fixed number is wrong somewhere.
   *
   *   THE STRIP DOES NOT FILL THE RAIL. On a very wide set (a 4K panel holds ~12 posters beside
   *   the billboard) the last title of the first copy can sit short of the right edge with the
   *   row at rest, which would leave visible empty track. Measured rather than derived: one pair
   *   of rects, once, against the real layout — no CSS-variable arithmetic to keep in step. */
  const [dup, setDup] = useState(false);
  useEffect(() => {
    if (dup) return;
    if (open) { setDup(true); return; }
    if (!visible) return;
    const rail = railRef.current, track = trackRef.current;
    if (!rail || !track) return;
    // A frame late, so the measurement is of a settled strip rather than of one mid-transition.
    const id = requestAnimationFrame(() => {
      if (track.getBoundingClientRect().right < rail.getBoundingClientRect().right - 1) setDup(true);
    });
    return () => cancelAnimationFrame(id);
  }, [dup, open, visible, n]);

  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---- THE PREVIEW ON THE SHELF ------------------------------------------------------------
   * Rest on a title and its trailer starts playing behind the title plate, muted; move on and it
   * is gone.
   *
   * ONE ENGINE, AND IT IS A FILE WE PLAY OURSELVES. IMDb publishes its trailers as ordinary video
   * files; our backend resolves them at /api/imdb-trailer/:imdb, and a <video> we own has no pause
   * glyph, no branding, no ads and no region gate — so it opens in a third of a second
   * (useVideoTrailer). Rows are keyed by the IMDb id the CARD already carries, so it usually costs
   * no detail request to find out. A title IMDb has nothing for simply keeps its artwork; there is
   * no embed behind it any more, for the reason at the head of the file.
   *
   * WHY A DWELL RATHER THAN A FETCH PER PRESS. Walking a row must not fire twelve requests, so
   * nothing is asked for until the remote has STOPPED on a title for TRAILER_DWELL. Flicking
   * along a shelf is then free, and the request only happens for a card someone is actually
   * looking at. React Query caches it per title, so coming back to a row costs nothing.
   *
   * The whole thing hangs off `open` — the row's own focus state — so leaving the row, opening a
   * title, or launching the player all tear the embed down for free. */
  const heroBtnRef = useRef<HTMLButtonElement>(null);
  const trailerSlotRef = useRef<HTMLDivElement>(null);
  const rowTrailers = useSettings((s) => s.settings.tvRowTrailers);
  /* ---- THE BILLBOARD'S PARALLAX, MEASURED ---------------------------------------------------
   *
   * The reference clip was pulled apart frame by frame and then correlated numerically — a single
   * row of pixels out of the billboard, matched against the settled frame for the best (scale,
   * offset) at each step. Eyeballing contact sheets got this wrong twice, in both directions, and
   * the numbers are worth writing down so nobody has to guess a third time:
   *
   *   SCALE = 1.000, every frame. There is no zoom, no Ken Burns, no card growing out of the
   *   strip. Whatever it looks like, the picture is never resized.
   *
   *   OFFSET decays +24px → 0 across frames 10-23 at 30fps: 24, 22, 18, 15, 12, 9, 7, 5, 4, 3, 2,
   *   1, 1, 0. So the incoming artwork DOES drift — 24px on a 753px card, 3.2% — arriving from the
   *   side the press came from and easing into place. At 3.2% it is invisible in a downscaled
   *   contact sheet, which is exactly why reading the tiles said "nothing moves"; in motion it is
   *   the whole feel.
   *
   *   THE STRIP DECAYS AT THE SAME RATE — measured 57, 47, 38, 31, 24, 19, 14, 10, 7, 5 — a ratio
   *   of ~0.82 per frame, identical to the artwork's. One curve, one duration, two distances. That
   *   ratio is an exponential settle with a ~170ms time constant, which is why the easing below is
   *   an expo-style ease-out and not the ease-in-out an earlier pass used: the movement is fastest
   *   at the very first frame and spends most of its life almost stopped.
   *
   * DRIVEN RATHER THAN DECLARED for the reason it always was: the two layers alternate, so the one
   * element that is not-front has to mean "about to enter" before the swap and "just left" after
   * it — one class, two opposite offsets, impossible in a stylesheet. `Element.animate` restarts
   * cleanly per press, needs no remount, and composites. */
  useEffect(() => {
    const root = sectionRef.current;
    if (!root || reduceMotion) return;
    const cs = getComputedStyle(root);
    const dir = Number(cs.getPropertyValue('--sp-dir')) || 0;
    if (!dir) return;   // the first paint of a row was not reached by a press; nothing to explain
    const slide = parseFloat(cs.getPropertyValue('--sp-slide')) || SLIDE_MS;
    const from = `translateX(calc(${dir} * ${BILLBOARD_PARALLAX}))`;
    const away = `translateX(calc(${-dir} * ${BILLBOARD_PARALLAX}))`;
    /* THE PICTURE MOVES, NOT THE LAYER. The layer also carries the title plate, and the reference
     * holds that still — drifting it would make the billboard slide as one panel, which is the
     * opposite of parallax. `.tv-spot-art` is the photograph alone, and it is overscanned in
     * tv.css so the drift never pulls an edge into frame. */
    const anims = Array.from(root.querySelectorAll<HTMLElement>('.tv-spot-art')).map((el) => {
      const entering = !!el.closest('.tv-spot-layer')?.classList.contains('on');
      return el.animate(
        entering ? [{ transform: from }, { transform: 'none' }] : [{ transform: 'none' }, { transform: away }],
        { duration: slide, easing: PARALLAX_EASE },
      );
    });
    return () => anims.forEach((a) => a.cancel());
    /* KEYED ON `xfade.front`, NOT ON `active`, AND THAT IS A BUG FIX RATHER THAN A TIDY-UP.
     *
     * Which layer is entering is read off the DOM (`.on`), so this has to run AFTER the swap has
     * been committed. `active` changes one commit EARLIER — the cross-fade slots are updated by
     * their own effect, which is state, so it lands a commit later. Keyed on `active`, this ran
     * while the OLD layer still carried `.on`: it gave the outgoing picture the entering
     * animation, gave the incoming one nothing, and the drift was on the wrong element and in the
     * wrong direction.
     *
     * It was invisible by inspection and obvious the moment the running page was measured — the
     * front layer's transform went 0 → -23px and then snapped back, which is the "leaving"
     * keyframe playing on the arriving card. `xfade.front` is the signal that means "the swap has
     * happened", so it is the one to hang this on. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xfade.front]);
  /* Selected field by field rather than as one object: every row on the screen subscribes to
   * this store, and a selector returning `{on, toggle}` would build a new object per render and
   * re-render all dozen of them on any state change anywhere. */
  const soundOn = usePreviewSound((s) => s.on);
  const toggleSound = usePreviewSound((s) => s.toggle);
  const [dwelt, setDwelt] = useState<MediaItem | null>(null);
  /* Set when the video engine reports it could not play this title's file — a link whose
   * signature has expired, a codec a set will not decode, a refused autoplay. It drops that
   * title to the embed for as long as it is the one being rested on, and clears with the dwell,
   * so the next visit tries the good path again rather than inheriting a verdict. */
  const [videoFailed, setVideoFailed] = useState(false);
  // The title being rested on, or nothing when the walk is parked on the see-all card.
  const resting: MediaItem | undefined = active < n ? list[active] : undefined;
  useEffect(() => {
    /* DROPPED FIRST, ARMED SECOND, and the order is the whole correctness of this. Clearing only
     * in the bail-out branch left the OLD title's video playing while the billboard had already
     * dissolved to the new one — so for the second and a half before the next trailer replaced it,
     * the row showed one film's trailer under another film's name. Whatever was playing belongs to
     * the title just left, so it goes the moment focus moves; the artwork comes back with it. */
    setDwelt(null);
    setVideoFailed(false);
    setMetaImdb(undefined);
    if (!rowTrailers || !open || !resting) return;
    const id = window.setTimeout(() => setDwelt(resting), TRAILER_DWELL);
    return () => window.clearTimeout(id);
    // Keyed on the title's ID rather than the object: the rows arrive inside a fresh array on
    // every render of Home, and re-arming this timer each time would mean it never fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowTrailers, open, resting?.id]);
  /* Warm the cards either side of the one being rested on, so the NEXT rest does not begin with a
   * round-trip. Hung off `dwelt` rather than `resting` on purpose: it fires only once the dwell has
   * already been satisfied, so a walk along the row still warms nothing, and the request goes out
   * while the current trailer is loading — time that was being spent waiting anyway. */
  const prefetchMeta = usePrefetchMeta();
  const prefetchImdbTrailer = usePrefetchImdbTrailer();
  useEffect(() => {
    if (!rowTrailers || !open || !dwelt || n < 2) return;
    const at = list.findIndex((it) => it.id === dwelt.id);
    if (at < 0) return;
    const near: MediaItem[] = [];
    for (let d = 1; d <= TRAILER_PREFETCH_SPAN; d++) {
      // Wrapped, because the walk itself wraps — the card left of the first is the last.
      near.push(list[(at + d) % n], list[(at - d + n) % n]);
    }
    /* Each neighbour is warmed on the path IT will take, not on one path for the row. A card
     * with an IMDb id is going to play a file, so its trailer link is what wants fetching early;
     * a card without one still needs the embed's key out of /api/meta. Warming both for every
     * neighbour would double a fan-out that exists precisely to stay small. */
    const kept = near.filter(Boolean);
    prefetchImdbTrailer(kept.map((it) => it.imdb).filter(Boolean) as string[]);
    const noImdb = kept.filter((it) => !it.imdb);
    if (noImdb.length) prefetchMeta(noImdb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowTrailers, open, dwelt?.id, n]);

  /* ---- ONE ENGINE, AND A TITLE EITHER HAS A TRAILER OR IT DOES NOT ---------------------------
   * IMDb's file, played by a <video> we own. There is no second engine any more — see the note
   * at the head of the file for why the embed went. */
  const armed = !!dwelt && rowTrailers;
  /* LATCHED, AND THE LATCH IS WHAT KEEPS THIS FROM OSCILLATING. Most cards carry their IMDb id,
   * but the ungated feeds (Upcoming, the Featured Hero) do not, and without one there is nothing
   * to ask /api/imdb-trailer with. Reading the id straight off `trailerMeta` would spin: an id
   * found there arms the video, the armed video would disarm the lookup, the query goes idle and
   * the id vanishes again. Held in state, it survives the request that produced it. Cleared with
   * the dwell. */
  const [metaImdb, setMetaImdb] = useState<string | undefined>(undefined);
  const imdbId = armed ? (dwelt?.imdb || metaImdb) : undefined;
  const imdbTrailer = useImdbTrailer(videoFailed ? undefined : imdbId);
  const videoUrl = videoFailed ? undefined : (imdbTrailer.data?.url || undefined);
  /* /api/meta IS ONLY EVER ASKED FOR AN ID WE DO NOT ALREADY HAVE. It is a whole detail payload
   * fetched for one string, so it goes out only for a card that arrived without an IMDb id — and
   * never for a card that has one, which is the common case and now costs exactly one request for
   * the preview. (`enrich` rows resolve the same id from the detail they already fetch, below.) */
  const wantImdbLookup = armed && !dwelt?.imdb && !metaImdb;
  const { data: trailerMeta } = useMeta(wantImdbLookup ? dwelt?.id : undefined, dwelt?.type);
  useEffect(() => {
    if (typeof trailerMeta?.imdb === 'string' && !dwelt?.imdb) setMetaImdb(trailerMeta.imdb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailerMeta?.imdb, dwelt?.id]);

  useVideoTrailer(
    trailerSlotRef,
    heroBtnRef,
    videoUrl,
    dwelt?.title || '',
    {
      // The dwell above has already served as the "don't mount for a passing title" delay.
      mountDelay: 0,
      /* PAST THE INTRO, BUT ONLY JUST — AND THE "ONLY JUST" IS THE WHOLE DESIGN.
       *
       * This row has had both extremes. It used to start a third of the way in
       * (trailerStartOffset, still there and still right about WHICH second of a trailer is worth
       * showing), which skipped the logos, the rating card and the franchise recap — and cost far
       * more than it looked, because seeking into a 60 MB progressive MP4 means the decoder cannot
       * present a frame until it has the byte range at that offset AND enough after it to decode.
       * Measured on this row: ~2.5s, against ~0.4s at byte zero. So it was deleted, and the shelf
       * opened on whatever the trailer opened on — which is a distributor logo, every time.
       *
       * INTRO_SKIP is neither. A seek's cost tracks how far into the file it lands, and ten
       * seconds is on the flat part of that curve: it is a few hundred KB into a download that is
       * already running (the engine keeps `preload: 'auto'` for an offset this small, precisely so
       * the seek lands in bytes we already have), so it costs a fraction of the deep seek while
       * still clearing the thing anyone actually notices. The recap survives; see INTRO_SKIP for
       * why that is the accepted half of the trade rather than an oversight. */
      startAt: INTRO_SKIP,
      /* Let the engine measure the billboard and take the rendition that suits it, rather than
       * playing the one the backend guessed at. The crop is the magnification in tv.css, and it
       * belongs in this number: a video blown up 1.35x is sampled at 1.35x its box. */
      renditions: imdbTrailer.data?.urls,
      cropScale: BILLBOARD_TRAILER_CROP,
      /* Nowhere to fall back TO any more, so this is just "stop trying this title": the file is
       * dropped, the artwork stays, and the flag clears with the dwell so the next visit tries
       * the link again rather than inheriting a verdict about an expired signature. */
      onFail: () => setVideoFailed(true),
      /* Sound is the store's, not the engine's — see previewSound.ts. The engine still starts
       * every file muted for the autoplay policy and applies this the moment it is playing. */
      sound: soundOn,
    },
  );

  /* ---- THE RED BUTTON --------------------------------------------------------------------
   * Volume up/down was the ask and it cannot be done — Android routes those keys to the system
   * before the WebView, webOS handles them in firmware, and Tizen only yields them to a
   * registerKey that steals them from the television. The full reasoning is on isPreviewSoundKey.
   * Red is what a TV platform will actually hand an app, and it is on every remote in the room.
   *
   * SCOPED TO THE ROW THE REMOTE IS ON, which is what `open` means and why the listener lives
   * here rather than in tvKeys beside its predicate. A home screen mounts a dozen of these and
   * exactly one is focused, so exactly one is listening — and opening a title or the player
   * clears `open`, which unbinds this for free along with tearing the preview down. Pressing red
   * anywhere else on the app does nothing at all, which is correct: there is no preview to hear.
   *
   * NOT PREVENTED, NOT STOPPED. The press is read and passed on. Red carries no meaning to the
   * platform outside an app that claims it, and the keyboard's mute key must go on muting the
   * machine — swallowing it would leave someone unable to silence a set from our screen. */
  useEffect(() => {
    if (!open || !rowTrailers) return;
    const onKey = (e: KeyboardEvent) => { if (isPreviewSoundKey(e)) toggleSound(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, rowTrailers, toggleSound]);

  /* ---- THE ARTWORK A HISTORY CARD DOES NOT CARRY (`enrich`) ---------------------------------
   * NOT ON A DWELL, unlike the trailer above, and the difference is the point: a trailer is
   * something you opt into by stopping, while the backdrop IS the billboard — half a second of
   * cropped poster before it appears would read as the row loading twice. So the rested title's
   * detail is asked for the moment focus lands on it, and the walk is made free instead by
   * warming the neighbours (the same one-card-either-way span the preview uses, for the same
   * reason: one press of Left or Right is what happens next).
   *
   * Gated on `visible` rather than on `open`, to match the artwork it feeds — a row nowhere near
   * the viewport requests nothing, and a row you can see has its billboard filled in whether or
   * not the remote has ever been on it.
   *
   * ACCUMULATED IN A MAP RATHER THAN READ STRAIGHT OFF THE QUERY, because the billboard
   * cross-dissolves: for half a second the OUTGOING layer is still painting the title just left,
   * and a lookup that only knew the current one would drop that layer back to a bare gradient
   * mid-fade — a flash of the fallback on every press. The map keeps what it has seen, so both
   * layers can always answer for themselves. */
  const [artById, setArtById] = useState<Record<string, Partial<MediaItem>>>({});
  const { data: detail } = useMeta(enrich && visible ? resting?.id : undefined, resting?.type);
  useEffect(() => {
    if (!enrich || !detail || !resting) return;
    const k = String(resting.id);
    // The detail we fetched for the artwork also carries the IMDb id, which is the key to the
    // preview that is NOT a YouTube embed — so an enriched row gets the fast trailer path for
    // free, on a request it was already making. (The latch it feeds is documented above.)
    if (typeof detail.imdb === 'string') setMetaImdb(detail.imdb);
    const add: Partial<MediaItem> = {};
    if (detail.backdrop) add.backdrop = detail.backdrop;
    if (detail.titleLogo) add.titleLogo = detail.titleLogo;
    if (detail.plot) add.overview = detail.plot;
    if (!Object.keys(add).length) return;
    // Written once per title: re-setting an entry that already exists would re-render this row
    // for no change, and on a state update keyed off a query result that is a loop.
    setArtById((m) => (m[k] ? m : { ...m, [k]: add }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich, detail, resting?.id]);
  useEffect(() => {
    if (!enrich || !open || !visible || n < 2) return;
    const near: MediaItem[] = [];
    for (let d = 1; d <= TRAILER_PREFETCH_SPAN; d++) near.push(list[(active + d) % n], list[(active - d + n) % n]);
    prefetchMeta(near.filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich, open, visible, active, n]);
  /** A card as the billboard should paint it — its own fields, plus whatever `enrich` found. */
  const withArt = (it: MediaItem): MediaItem => {
    const a = enrich ? artById[String(it.id)] : undefined;
    return a ? { ...it, ...a } : it;
  };

  /* THE BILLBOARD'S URL, IN ONE PLACE, because three things now ask for it and a fourth would be
   * a bug. The warm-ahead below fetches it, the swap gate decodes it, and `heroArt` paints it — if
   * any of them built the string itself and drifted by a rendition, the warm would be a cache MISS
   * that still looks like a hit from here, and the blink would come back with nothing to show why.
   *
   * ON AN `enrich` ROW A POSTER IS NOT AN ACCEPTABLE STAND-IN for the backdrop that has not
   * arrived yet: it is a portrait crammed into 16:9, which reads as a broken picture rather than
   * as a card waiting. The branded gradient already exists for exactly this and holds the frame
   * for the one request. Catalogue rows keep the old fallback — their cards genuinely sometimes
   * have a poster and no backdrop, with nothing else coming. */
  const billboardUrl = (it: MediaItem): string => {
    const source = enrich ? it.backdrop : (it.backdrop || it.poster);
    return visible ? imgW(source || '', BILLBOARD_RENDITION) : '';
  };

  /* THE STRIP IS MEMOISED, AND THAT IS A SCROLL FIX, NOT A MICRO-OPTIMISATION.
   *
   * Every arrow press flips `open` on two rows. Without this, React would rebuild 24 <button>
   * elements per row and diff them — on the exact frame the scroll animation starts, which is
   * where a dropped frame is most visible. The strip depends on nothing that a focus change
   * touches, so it is built once per data change and the open/close toggle becomes what it
   * should be: one class name on the section. */
  const thumbs = useMemo(() => {
    const tile = (it: MediaItem, key: string) => {
      const src = imgW(it.poster || it.backdrop || '', THUMB_RENDITION);
      const res = resumeOf?.(it);
      return (
        <button
          key={key}
          type="button"
          role="listitem"
          tabIndex={-1}
          className="tv-spot-thumb"
          style={{ background: heroFallbackGradient(it) }}
          aria-label={it.title}
          onClick={() => onSelect?.(it)}
        >
          {/* `data-src`, NOT `src` — the effect below decides which tiles are close enough to the
              walk to be worth a bitmap. See the note there; `loading="lazy"` cannot do this job.

              THE GRADIENT IS DROPPED THE MOMENT THE POSTER COVERS IT. It is the plate a tile shows
              while it has no picture, and it was staying underneath one forever: measured on a
              settled home screen, 106 of 147 tiles were painting a gradient beneath a fully opaque
              poster, so every repaint of a row filled each of those rects twice. Cleared straight
              on the node rather than through state — this lives inside a useMemo whose entire
              purpose is to not rebuild on a focus change, and a setState per poster load would
              undo that for a change no one can see. */}
          {src && (
            <img
              className="tv-spot-thumbimg"
              data-src={src}
              loading="lazy"
              decoding="async"
              alt=""
              /* NOT `useImageReady` HERE, and that is deliberate rather than an oversight. These
                 carry `data-src` because a home screen holds ~147 of them and they are fetched
                 lazily; a hook would preload every one on mount and undo the memory work the
                 comment above describes. `load` is the weaker guarantee (bytes, not bitmap) but a
                 228px portrait has no visible band to hide — the fade is here so a tile arrives
                 rather than pops, which is all this size of picture needs.
                 Both writes go straight to the nodes for the same reason the background clear
                 does: this lives inside a useMemo that must not rebuild on a poster load. */
              onLoad={(e) => {
                const img = e.currentTarget;
                const t = img.parentElement;
                if (t) t.style.background = 'none';
                img.classList.add('rdy');
              }}
            />
          )}
          {!!res && res.pct > 0.01 && <span className="tv-spot-progress" aria-hidden="true"><i style={{ width: `${(Math.min(res.pct, 1) * 100).toFixed(1)}%` }} /></span>}
        </button>
      );
    };
    const endCard = (
      <button
        key="end"
        type="button"
        role="listitem"
        tabIndex={-1}
        className="tv-spot-thumb is-seeall"
        aria-label={`${heading} — ${endLabel}`}
        onClick={goEnd}
      >
        <span className="tv-spot-blank-ic" aria-hidden="true">{endIcon}</span>
        <span className="tv-spot-blank-label">{endLabel}</span>
      </button>
    );
    const copy = (pass: number) => list.map((it, i) => tile(it, `p${pass}-${i}`));
    /* THE SECOND COPY IS NOT BUILT UNTIL SOMETHING COULD SEE IT — the single biggest cut in the
     * TV build's passive load. The duplicate exists only so the up-next area is never empty near
     * the END of a walk; a row nobody has touched is parked at index 0 with the copy sitting
     * entirely off the right of a strip that is `overflow: hidden`. Home shows ~13 of these rows
     * and 12 of them are never focused, so the browser was rastering a second full set of posters
     * per row purely to keep them clipped.
     *
     * `dup` latches on the first thing that can expose it (see the `wrap` effect) and never
     * clears — unmounting a copy the walk might come back to would throw away decoded bitmaps and
     * pop them back in, which is the artefact this whole component is arranged to avoid. */
    if (!dup) return hasEnd ? [...copy(0), endCard] : copy(0);
    if (!hasEnd) return [...copy(0), ...copy(1)];
    /* POSITION IS THE WHOLE TRICK. The strip is translated so the tile at index `active` hides
     * behind the billboard and its successors peek to the right, so putting the card at index n —
     * straight after the last title of the FIRST copy — makes it both the thing you see appear at
     * the end of the posters and the thing the billboard becomes when you reach it. The second
     * copy still follows it, so the row's endless up-next preview is unbroken. */
    return [...copy(0), endCard, ...copy(1)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, onSelect, hasEnd, dup, canSeeAll, cat, onSeeAll, onMore, moreBusy, endLabel, endIcon, heading, t, resumeOf]);

  /* ---- ONLY THE TILES THE WALK CAN REACH GET A BITMAP -------------------------------------
   * A row holds 21 tiles and shows six. The other fifteen sit past the right edge of a strip
   * that is `overflow: hidden` — and they were being downloaded and decoded anyway. Measured on
   * a settled home screen: 56 posters fully decoded entirely off the right edge, 37.5 MB of
   * bitmap for pictures nobody could see.
   *
   * `loading="lazy"` DOES NOT COVER THIS, which is the whole reason this exists. Lazy loading is
   * about the VIEWPORT, and these tiles are inside it — they are only clipped horizontally by an
   * ancestor's overflow, which the browser does not treat as off-screen. The attribute stays on
   * anyway; it still earns its keep for rows below the fold.
   *
   * DONE ON THE NODES, NOT THROUGH RENDER, and that is the constraint that shaped it. The strip
   * is memoised precisely so a keypress does not rebuild 24 buttons (see the note on `thumbs`),
   * so making the tile list depend on `active` would trade one cost for the one it was built to
   * avoid. Instead every tile renders with `data-src` and this effect promotes the few in range
   * — a handful of attribute writes per press, no reconciliation at all.
   *
   * ONCE SET, NEVER UNSET. Walking back over a tile must not re-download it, and an `img` whose
   * src is removed drops its decoded frame; the window only ever grows. The ceiling is the row,
   * and a row is 21 tiles.
   *
   * The forward margin is runway: at ~300ms a press, nine tiles is about three seconds of
   * walking, and a poster is ~30 KB from a CDN that answers in 90ms. A tile that does outrun it
   * shows its gradient plate for a beat rather than a hole. */
  const THUMB_AHEAD = 9;
  const THUMB_BEHIND = 2;
  useEffect(() => {
    if (!visible) return;
    const track = trackRef.current;
    if (!track) return;
    const promote = () => {
      const tiles = track.children;
      const from = Math.max(0, active - THUMB_BEHIND);
      const to = Math.min(tiles.length - 1, active + THUMB_AHEAD);
      for (let i = from; i <= to; i++) {
        const img = tiles[i]?.querySelector<HTMLImageElement>('img[data-src]');
        if (!img) continue;                     // the see-all card, or a tile already promoted
        img.src = img.dataset.src || '';
        delete img.dataset.src;
      }
    };
    /* ON THE IDLE FRAME, NEVER ON THE KEYPRESS FRAME, and this is the correction that makes the
     * window worth having at all. Promoting inline looked right and measured WORSE than loading
     * everything up front — 1.69s of task time across ten presses became 2.20s, with four janky
     * frames where there had been none. The window had not removed the decodes, it had moved them
     * out of the quiet moment after load and into the one frame that is animating a cross-fade.
     *
     * Deferred, the work lands between presses, where the row is doing nothing anyway. The 600ms
     * timeout is the floor under that promise: an idle callback with no deadline can be starved
     * indefinitely, and a tile that never gets a bitmap is a hole on the shelf. `decoding="async"`
     * keeps the decode itself off the main thread once the bytes are in. */
    const ric = window.requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(promote, { timeout: 600 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(promote, 120);
    return () => window.clearTimeout(id);
    // `thumbs` is in here because a row whose data changed has brand-new nodes to promote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active, thumbs]);

  /* Arm the artwork a screenful before the row arrives, so it is decoded by the time it is
   * scrolled to and nothing pops in. Disconnects on the first hit — this is a one-way latch. */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* Drive the cross-dissolve off `active`: load the focused title into the hidden layer and flip
   * it to the front.
   *
   * ALSO OFF `n`, which is what makes the "load more" card work. Pressing OK on it does not move
   * the walk — the position it is standing on simply stops being the end card and becomes the
   * first title of the batch that just arrived. Without the length in here nothing would tell the
   * billboard that, and it would go on showing a "+" card until the next press. */
  /* ---- THE SWAP WAITS FOR A PICTURE TO SWAP TO ----------------------------------------------
   * THE DEFECT: the billboard blinked through black on every press, briefly and unmistakably.
   *
   * It was the two fades disagreeing about what they were for. The LAYER cross-dissolves in 90ms
   * (tv.css) — deliberately, it is a reaction and not a journey — but the PHOTOGRAPH inside it is
   * held at zero until `decode()` resolves and then takes 450ms to arrive (FadeBg). So the layers
   * traded places long before the incoming layer had anything in it, and for the gap between them
   * the billboard was showing the only thing that layer HAD: `heroFallbackGradient`, which is
   * hsl(0 0% 14%) → hsl(0 0% 6%). That gradient is doing its real job on a cold row, where it
   * holds the frame while the first picture loads. Mid-walk it is just black.
   *
   * FadeBg could not have fixed this from the inside. It guarantees a picture arrives WHOLE, which
   * it does — the banding is gone. It cannot know that the thing underneath it is a layer being
   * dissolved to, and nothing at that level can: the decision "is there anything to dissolve to
   * yet" belongs to whoever owns both layers, which is here.
   *
   * So the press now holds the swap until the incoming bitmap is decoded, and the cross-dissolve
   * goes picture → picture the way it always read as intending to. The gradient stays exactly
   * where it was for the case it was written for and is never seen on a walk.
   *
   * THE ROW IS NOT HELD WITH IT. The strip slides off `active` and moves on the press frame
   * regardless, so the press is always answered instantly — it is the artwork that arrives on the
   * beat rather than early and empty, which is also what the reference does.
   *
   * WARM, THIS COSTS NOTHING AND IS THE NORMAL CASE: `complete && naturalWidth` is checked first,
   * so a neighbour the effect below already fetched flips synchronously, with no wait at all and
   * not a frame's delay against the old behaviour. */
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const slot = slotAt(active);
    let spent = false;
    const flip = () => {
      if (spent) return;
      spent = true;
      setXfade((s) => {
        const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
        return { ...s, [back]: slot, front: back };
      });
    };
    /* The end card has no artwork by design, and an `enrich` row whose detail has not landed yet
     * has none to wait for either — both dissolve immediately, exactly as before. */
    const url = slot === 'end' ? '' : billboardUrl(withArt(slot));
    if (!url) { flip(); return; }

    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.complete && img.naturalWidth > 0) { flip(); return; }
    if (typeof img.decode === 'function') img.decode().then(flip, flip);
    else { img.onload = flip; img.onerror = flip; }
    /* THE CAP IS WHAT KEEPS A GATE FROM BECOMING A STALL. A cold row on a slow set must not leave
     * the billboard on the title you just walked off — past this the swap happens anyway and the
     * old behaviour takes over (gradient, then the photo fading in when it lands), which is a
     * worse frame but never a stuck one. Under half of SLIDE_MS on purpose: even at the cap the
     * artwork changes while the strip is still travelling, so the press stays one gesture.
     *
     * A chained press cancels a pending flip through the cleanup rather than queueing behind it —
     * holding a direction walks to where the remote actually is, not through every card on the
     * way. */
    const capId = window.setTimeout(flip, SWAP_WAIT_CAP);
    return () => { spent = true; window.clearTimeout(capId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, n]);

  /* ---- THE NEXT BILLBOARD IS FETCHED BEFORE IT IS ASKED FOR ---------------------------------
   * The gate above removes the black frame; this is what keeps it from costing anything, and the
   * two are one change. Without it every press waits out a cold fetch AND a decode of a 780px
   * JPEG, so the gate would trade a blink for a lag — the same defect wearing the other hat.
   *
   * NOTHING WAS WARMING THIS. The strip promotes its tiles nine cards ahead of the walk, which
   * looks like it should already cover the billboard and does not: those are THUMB_RENDITION
   * (w342) off `poster || backdrop`, and the billboard is BILLBOARD_RENDITION (w780) off
   * `backdrop || poster`. Different rendition of a different picture — a different URL, and so a
   * different cache entry. The billboard was the one bitmap on this row that was always cold.
   *
   * ONE CARD EITHER WAY, matching the span the preview and `enrich` already use, and for the same
   * reason: one press of Left or Right is what happens next. The walk wraps, so the warm wraps.
   *
   * NOT RETAINED, DELIBERATELY. The Image is dropped as soon as it has decoded — holding it would
   * pin a ~1.4MB pixmap per neighbour per row, and thirteen rows of that is precisely the passive
   * load this component is arranged to avoid (see the note on `visible`). The BYTES stay in the
   * HTTP cache, which is the part that costs a round trip; the re-decode at the gate is fast and
   * off the main thread.
   *
   * ON THE IDLE FRAME, for the reason the tile promotion records one screenful down: decoding
   * artwork on the keypress frame measured WORSE than not windowing at all, because it lands on
   * the one frame that is animating a cross-fade. Between presses the row is doing nothing. */
  const BILLBOARD_WARM_SPAN = 1;
  useEffect(() => {
    if (!visible || stops < 2) return;
    const warm = () => {
      for (let d = 1; d <= BILLBOARD_WARM_SPAN; d++) {
        for (const i of [(active + d) % stops, (active - d + stops) % stops]) {
          const slot = slotAt(i);
          if (slot === 'end') continue;
          const url = billboardUrl(withArt(slot));
          if (!url || warmed.has(url)) continue;
          warmed.add(url);
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          if (typeof img.decode === 'function') img.decode().catch(() => { /* 404 / expired signature — the gate's cap covers it */ });
        }
      }
    };
    const ric = window.requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(warm, { timeout: 600 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(warm, 120);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active, stops, artById]);

  // Suppress the strip's scroll animation on a wrap / multi-step jump, so it resets instead of
  // rewinding through every card.
  useEffect(() => {
    const track = trackRef.current;
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (track && Math.abs(active - prev) > 1) {
      track.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
    }
  }, [active]);

  if (!n) return null;
  /** True while the walk is parked on the end card rather than on a title. */
  const onSeeAllCard = hasEnd && active >= n;
  const cur = list[Math.min(active, n - 1)] || list[0];

  /* ---- THE SLIDE, AND WHY IT IS NOT ONE DURATION -------------------------------------------
   *
   * A row is walked two ways and they want opposite things. A DELIBERATE press is one card, and
   * it should take its time — a long ease-in-out reads as a shelf with weight on it, which is the
   * whole feel this row is after. A HELD key is a burst of presses ~120ms apart, and against a
   * 460ms slide that means every press interrupts a transition three-quarters unfinished: the
   * strip re-aims from wherever it is toward a target two cards further on, and does it again
   * before it arrives. The result is a strip that never travels at the speed of the pressing and
   * lands somewhere behind it — which is exactly what "the scroll feels off" turns out to be.
   *
   * So a chained press gets a shorter slide. It is not a different animation: the same curve, run
   * faster, so holding a direction reads as the shelf ACCELERATING under a continuous push rather
   * than as a queue of little journeys. Let go and the next press is deliberate again.
   *
   * This is the same rule, and the same two numbers, that TvSpatialNav's page scroll already uses
   * (SCROLL_MS / SCROLL_MS_CHAINED) — one idea about how this build answers a held key.
   *
   * WRITTEN STRAIGHT TO THE NODE, not through state. A held key is the one moment this component
   * must not do more work than it has to, and a re-render per press to change a duration nobody
   * can name would be exactly that.
   *
   * SET ON THE SECTION, NOT ON THE STRIP, because two things move on every press and they have to
   * agree: the strip slides, and the billboard cross-dissolves to the title it lands on. A custom
   * property inherits, and the section is the nearest element that is an ancestor of BOTH — put it
   * on the strip and the dissolve could not see it, so a held key would slide at 260ms while the
   * artwork took 500ms to catch up, which is stale art under a card that has already moved on. */
  const step = (delta: number) => {
    const now = performance.now();
    const chained = now - lastStepAt.current < SLIDE_CHAIN_WINDOW;
    lastStepAt.current = now;
    const el = sectionRef.current;
    if (el) {
      el.style.setProperty('--sp-slide', `${chained ? SLIDE_MS_CHAINED : SLIDE_MS}ms`);
      /* The photograph's own rise, on the same test as the slide — the reasoning, and the
       * measurement that says this is a fade problem rather than the caching problem it looks
       * like, are at ART_FADE_MS. Set on the SECTION for the reason `--sp-slide` is: it has to
       * inherit down to both cross-fade layers, and the section is the nearest ancestor of both. */
      el.style.setProperty('--sp-art-fade', `${chained ? ART_FADE_MS_CHAINED : ART_FADE_MS}ms`);
      /* WHICH WAY THE PRESS WENT. The artwork's drift needs it — it enters from the side the
       * remote came from — and CSS cannot work it out, because CSS only ever sees the new state.
       * +1 is rightward. The COPY does not use it: measured across every frame of the reference,
       * the text's horizontal offset is exactly 0. */
      el.style.setProperty('--sp-dir', delta > 0 ? '1' : '-1');
    }
    setActive((a) => (a + delta + stops) % stops);
  };

  /* Until the row is near the viewport the layer keeps the branded gradient and requests no
   * bitmap at all — see the memory note in the header. */
  const heroArt = (it: MediaItem) => {
    /* THROUGH `billboardUrl`, never built here — the warm-ahead and the swap gate both target
     * this exact string, and a second copy of the rendition logic is how they would silently stop
     * matching it. The reasoning about which source a row may fall back to is up there with it. */
    const bg = billboardUrl(it);
    /* The gradient is no longer an EITHER/OR with the picture — it is what sits underneath one.
     * See FadeBg: the billboard is the largest bitmap on the home screen, and a 676px-wide JPEG
     * decoding straight into the document is the "loads top to bottom" band-by-band paint that
     * this row was the most obvious victim of. It is also no longer seen DURING a walk, which is
     * a separate defect with its own note on the swap gate. */
    return {
      url: bg || undefined,
      fallback: heroFallbackGradient(it),
      backgroundPosition: heroBgPosition(it),
    };
  };
  const tagFor = (it: MediaItem) => (isSeries(it) ? t('nav.series') : t('nav.movies'));
  /* AT THE SIZE IT IS PAINTED, which for a wordmark on the billboard is 201px wide at most (62%
   * of the card, capped at 84px tall — see tv.css). The URL arrives as w500 and was used as it
   * came, so every logo on the screen was a 2.5x oversample: fetched, decoded and held at four
   * times the pixels it can show. w300 is the next step TMDB offers and still leaves headroom on
   * a HiDPI panel. Non-TMDB URLs pass through imgW untouched. */
  const logoOf = (it: MediaItem) => imgW(it.titleLogo || it.logo || '', LOGO_RENDITION) || undefined;

  /* [S2:E4 ·] genre · year · rating is built PER SLOT now, down in the info block, not once for
   * `cur`. The two copy blocks cross-fade, so for the length of a press two different titles are
   * on screen at once and each has to be able to answer for itself — a single line computed from
   * the current title would have re-written the outgoing block's text under it as it faded. The
   * episode leads when there is one, because on a resume row it is the most specific thing the
   * line can say. The see-all card has no metadata of its own and stays blank. */

  const onHeroKey = (e: ReactKeyboardEvent) => {
    // Left/Right walk the row and are consumed here so the global D-pad handler doesn't also
    // move focus off the billboard. Up/Down bubble on through to it.
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
  };

  /* OK opens the title. Plain, and worth a note saying it is plain ON PURPOSE.
   *
   * This briefly handed the billboard's PLAYING trailer to the title screen, which grew it out of
   * this box to fill the screen. It was removed — the full account of what it was and why it went
   * is at the head of TvDetail.tsx, beside the note about the trailer embed that screen had
   * already declined once for the same reason. `useVideoTrailer` accordingly has no `detach` any
   * more: this row owns its preview from the dwell that starts it to the teardown that ends it,
   * and nothing takes it anywhere. */
  const openTitle = () => {
    if (onSeeAllCard) { goEnd(); return; }
    onSelect?.(cur);
  };

  return (
    <section
      ref={sectionRef}
      className={`tv-spot${open ? ' is-open' : ''}${reduceMotion ? ' no-anim' : ''}`}
      aria-label={heading}
      onFocus={() => setOpen(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      {/* A plain heading. The web rail's "see all" lives here; on a TV it is the card at the end
          of the strip instead — see the note above `canSeeAll`. */}
      <h2 className="tv-spot-rowtitle">{heading}</h2>

      <div className="tv-spot-stage">
        {/* The strip's window — it carries the clip the stage used to, so the billboard on top is
            free to grow past the row when the remote reaches it. See tv.css. */}
        <div className="tv-spot-rail" ref={railRef}>
          {/* STRIP TRACK — all titles, portrait; translated so the focused one hides behind the
              billboard and its successors peek to the right. `--active` drives the transform. */}
          <div className="tv-spot-strip" ref={trackRef} style={{ '--active': active } as CSSProperties} role="list">
            {/* The list is rendered TWICE so the up-next area is never empty near the end: when
                `active` reaches the last real title, the successors come from the second copy,
                giving the reference's endless loop. tabindex -1 → the strip is a preview, not a
                D-pad stop (the billboard is the focus target); hover maps back to the real index. */}
            {thumbs}
          </div>
        </div>

        {/* BILLBOARD — pinned left, over the strip, at 16:9 in every state. */}
        <button
          type="button"
          ref={heroBtnRef}
          className="tv-spot-hero"
          aria-label={onSeeAllCard ? `${heading} — ${endLabel}` : cur.title}
          onClick={openTitle}
          onKeyDown={onHeroKey}
        >
          {/* The preview sits UNDER the artwork rather than over it, and `has-trailer` fades the
              artwork away to uncover it — which is what keeps the title plate above the video
              instead of the video swallowing it. See tv.css. */}
          <div className="tv-spot-trailer-slot" ref={trailerSlotRef} aria-hidden="true" />
          {(['a', 'b'] as const).map((slot) => {
            const it = xfade[slot];
            const on = xfade.front === slot;
            if (!it) return <div key={slot} className="tv-spot-layer" aria-hidden="true" />;
            /* The end card as the billboard: no artwork to request, so it reads as a hole at the
               end of the row rather than as another title — which is what tells you the row has
               ended. Same two layers, so arriving on it dissolves like everything else. */
            if (it === 'end') {
              return (
                <div key={slot} className={`tv-spot-layer${on ? ' on' : ''}`} aria-hidden={!on}>
                  <div className="tv-spot-blank">
                    <span className="tv-spot-blank-ic" aria-hidden="true">{endIcon}</span>
                  </div>
                  <div className="tv-spot-card-in">
                    <span className="tv-spot-tag">{endLabel}</span>
                    <span className="tv-spot-cardtitle">{heading}</span>
                  </div>
                </div>
              );
            }
            const art = withArt(it);
            const logo = logoOf(art);
            const res = resumeOf?.(it);
            return (
              <div key={slot} className={`tv-spot-layer${on ? ' on' : ''}`} aria-hidden={!on}>
                <FadeBg className="tv-spot-art" {...heroArt(art)} />
                <div className="tv-spot-card-in">
                  <span className="tv-spot-tag">{tagFor(it)}</span>
                  {/* The wordmark falls back to the plain title, and it must not do BOTH in turn:
                      text first and a logo a beat later is the same swap the backdrop had. FadeImg
                      renders the fallback only when there is no logo to wait for. */}
                  <FadeImg
                    className="tv-spot-logo"
                    src={logo || undefined}
                    alt={it.title}
                    fallback={<span className="tv-spot-cardtitle">{it.title}</span>}
                  />
                </div>
                {/* Outside the plate and pinned to the card's own bottom edge, so it survives the
                    trailer taking the artwork away — where you are in a title is not a thing that
                    should blink out because a preview started. */}
                {!!res && res.pct > 0.01 && <span className="tv-spot-progress" aria-hidden="true"><i style={{ width: `${(Math.min(res.pct, 1) * 100).toFixed(1)}%` }} /></span>}
              </div>
            );
          })}
          {/* THE SOUND BADGE. A speaker, crossed while the preview is muted — the STATE of the
              thing playing, not the action red performs, which is how every player on this screen
              already reads (see the same pair of glyphs in VideoPlayer).

              SHOWN ONLY WHILE A TRAILER IS ACTUALLY UP, and that is CSS rather than state: the
              engine puts `has-trailer` on this button at the reveal and takes it off at teardown,
              so the badge is tied to the thing it controls without this component having to learn
              when playback began. Decorative to a screen reader — it reports the state of a
              preview that is itself `aria-hidden`. */}
          <span className="tv-spot-sound" aria-hidden="true">
            {soundOn ? IcSoundOn : IcSoundOff}
          </span>
        </button>
      </div>

      {/* INFO — TWO SLOTS THAT CROSS-FADE, on the billboard's own `xfade` state and therefore in
          exact step with the picture they describe.
          It was one block with a keyed remount, which meant the outgoing copy did not leave: it
          was destroyed in the frame the new one appeared, so a press replaced a paragraph
          instantly and then slid the replacement in. Half a transition reads worse than none,
          because the eye catches the half that cut. Now the old text drifts out and dims while the
          new drifts in — the same two-layer shape as the artwork above, sharing its slots so the
          two can never disagree about which title is being shown.
          Height is still reserved on the container, so opening a row never pushes the rows below
          it, and the two blocks stack inside that reserved box. */}
      <div className="tv-spot-info">
        {(['a', 'b'] as const).map((slot) => {
          const it = xfade[slot];
          const on = xfade.front === slot;
          if (!it || it === 'end') return <div key={slot} className={`tv-spot-infoblk${on ? ' on' : ''}`} />;
          const a = withArt(it);
          const bits = [
            resumeOf?.(it)?.note || '',
            genre(a.genre || (a.genres && a.genres[0]) || ''),
            a.year ? String(a.year) : '',
            a.rating ? `★ ${a.rating}` : '',
          ].filter(Boolean);
          return (
            <div key={slot} className={`tv-spot-infoblk${on ? ' on' : ''}`} aria-hidden={!on}>
              <div className="tv-spot-meta">
                {bits.map((b, i) => <span key={i}>{b}</span>)}
              </div>
              {a.overview && <p className="tv-spot-plot">{a.overview}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
