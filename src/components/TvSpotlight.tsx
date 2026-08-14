import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { useVideoTrailer, INTRO_SKIP } from './DetailModal/useVideoTrailer';
import { useMeta, usePrefetchMeta, useImdbTrailer, usePrefetchImdbTrailer } from '../lib/queries';
import { retainImage, isDecoded } from '../lib/useImageReady';
import { useSettings } from '../stores/settings';
import { previewsAllowed, previewDwellMs } from '../lib/tvPreviewPolicy';
import { registerTvRow, rowIndexOf } from '../lib/tvRowRegistry';
import { parallaxEnabled } from '../lib/tvMotionFlags';
import { tvRowsMode, rowInWindow, subscribeRowWindow, getActiveRowIndex } from '../lib/tvRowWindow';
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
export const SPOT_MAX = 10;

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
/* MEASURED AND RAISED FROM 500. At 500ms this fired while somebody was still BROWSING: a
 * deliberate press lands about 900ms after the last, so the dwell always elapsed, a <video> always
 * mounted, and the next press always destroyed it. One media pipeline acquired and released per
 * keypress, on the weakest hardware the app runs on.
 *
 * A/B on the television, both arms with the preview ON, order reversed between rounds:
 *
 *              worst frame    frames on time
 *   500ms       78, 73ms       82.9%, 80.9%
 *   1200ms      52, 53ms       92.6%, 90.4%
 *
 * Ten points and 23ms of worst frame, for one constant — and it recovers essentially all of what
 * turning the preview OFF entirely was worth (93% / 57ms), so the feature costs nothing now.
 *
 * IT ALSO EXPLAINS THE RESULT THAT DEFEATED EVERY OTHER THEORY. Turning off all eleven of the
 * row's animations left the worst frame unchanged to the millisecond. A platform media call has no
 * CSS surface to remove, which is why nothing on the style side ever moved it.
 *
 * NOT the teardown specifically: deferring the `load()` that destroys the pipeline was built and
 * measured and came back flat, so the cost is the mount, or simply having a video on the row at
 * all. Raising the dwell avoids all of it by only ever starting one when the viewer has genuinely
 * stopped, which is what the feature was always for.
 *
 * THE COST, STATED PLAINLY: a preview now begins 1.2s after you settle rather than 0.5s. That is
 * the whole of the trade.
 *
 * THE NUMBER HAS MOVED TO lib/tvPreviewPolicy.ts AND IS NOW 2400. Everything above is still the
 * reasoning that got it to 1200; what it did not test was the cadence a television is actually used
 * at — stopping on a title for several seconds to read it, which at 1200 mounts a pipeline every
 * time. Measured on the reference set, that cadence was much the worst of the three: 26.9% of frames
 * on time against 79.6% for a deliberate walk. The policy module also owns the low-end gate and the
 * one-pipeline-at-a-time register, because all three are the same decision. */
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
/** 1 — the preview is no longer magnified; see `.tv-spot-trailer-slot video` in tv.css for what the
 *  1.35 was removing and what removing it costs. Kept as a named constant rather than deleted
 *  because it must move WITH that rule: it tells useVideoTrailer how much CSS blows the video up
 *  over its box, so a crop that came back here and not there would pick a rendition too small for
 *  the pixels actually on screen. */
const BILLBOARD_TRAILER_CROP = 1;

/* How far the billboard's picture drifts while it changes. MEASURED, not chosen: 24px of travel on
 * a 753px card in the reference. The full derivation is in the parallax effect below. */
const BILLBOARD_PARALLAX = '3.2%';
/** MUST MATCH the strip's curve in tv.css — and for a while it did not, which is the whole reason
 *  this note is longer than the line it explains. The strip was moved to `cubic-bezier(.22,1,.36,1)`
 *  when the slide was cut to 230ms; this constant was left on the fitted curve, so the two came
 *  apart. MEASURED ON THE 65UT8100: 46ms into a move the strip was 67.4% travelled and the drift
 *  36.9%, a 30-point gap held across the whole middle of every press. They are one movement in the
 *  reference and they are one movement here. Change them together or not at all. */
const PARALLAX_EASE = 'cubic-bezier(.22, 1, .36, 1)';

/* ---- HOW LONG THE STRIP TAKES TO MOVE ONE CARD. Reasoning is at `step`. -------------------- */
/** A deliberate press. The reference's drift reaches zero 13 frames after it starts at 30fps and is
 *  half-travelled at frame 4, which the fitted curve reproduced in ~430ms — and that was the value
 *  here until the set started painting this move at a 16.7ms median instead of ~26fps. At 60fps a
 *  230ms glide gets ~14 painted frames, more than the 430ms one ever had, in half the time. The
 *  curve changed with it; see PARALLAX_EASE above and the strip's `transition` in tv.css, and move
 *  all three together. Measured on the television at 233-241ms end to end, three runs. */
const SLIDE_MS = 230;
/* SLIDE_MS_CHAINED IS GONE, and what replaced it is the point. It was 320ms of the same
 * decelerating curve — "roughly half, so a hold keeps up without the curve losing its shape". The
 * curve was the problem: keeping its shape is what made a hold read as a sequence of arrivals
 * rather than one movement. A held key now uses HELD_SLIDE_MS with linear timing instead; a
 * deliberate press is unchanged and still uses SLIDE_MS. */
/** Under this gap between presses, the remote is being held rather than tapped. */
const SLIDE_CHAIN_WINDOW = 320;

/* ---- HOW FAST A HELD KEY IS ALLOWED TO WALK -------------------------------------------------
 * The television repeats a held key about every 120ms (the figure this file already records at
 * ART_FADE_MS). One step per repeat is therefore about EIGHT posters a second, and once the held
 * path stopped rendering — which is what took it from 52% of frames on time to 97% — that rate
 * stopped being hidden behind the stutter and became the thing you notice: the row bolts.
 *
 * A ten-title row wraps in a little over a second, which is not browsing, it is a blur. The
 * reference paces a held key at roughly four or five titles a second, slow enough to read a poster
 * as it goes by.
 *
 * So repeats that arrive sooner than this are SWALLOWED rather than queued. Swallowed matters:
 * queueing them would make the row keep travelling after the button is released, which is the
 * thing that feels broken on a remote. `lastStepAt` is only moved by an ACCEPTED step, so the
 * limiter measures from the last thing the viewer actually saw.
 *
 * Deliberately below SLIDE_CHAIN_WINDOW (320ms), so an accepted held step still counts as chained
 * and keeps the fast slide, the suppressed decoration and the `is-fast` class. */
const HELD_STEP_MIN_MS = 220;

/* ---- AND WHY A HELD KEY GLIDES RATHER THAN STEPS --------------------------------------------
 * Pacing alone did not fix the feel. Each press eases with `cubic-bezier(.25,.46,.45,.94)`, which
 * is a DECELERATING curve — it is most of the way there in the first third and then crawls. That
 * is exactly right for a single deliberate press, where the row should arrive and settle. Held, it
 * means the strip slows almost to a stop and is then re-launched by the next repeat, and a
 * sequence of little arrivals is what reads as stepping.
 *
 * So while the key is held the strip moves LINEARLY (see `.tv-spot.is-fast .tv-spot-strip` in
 * tv.css) and its duration is set a little LONGER than the pace, so the transition is always
 * re-targeted while still in flight and never completes and stalls. Constant velocity, no arrival,
 * no relaunch: one glide for as long as the button is down. Let go and the last step lands on the
 * deliberate curve, so the row still settles rather than stopping dead. */
const HELD_SLIDE_MS = 260;

/* How long the focus state waits before committing — see `setOpenNow`.
 *
 * NOT TvSpatialNav's SCROLL_MS, which is what it was first set to and which is subtly wrong. That
 * constant is the ease's NOMINAL duration; the scroll measured on the television actually spans
 * 478-489ms, because the ease cannot finish until it has been given its last frame and the page is
 * not painting every frame. Committing at 420ms therefore dropped two row re-renders into the tail
 * of the very glide they were deferred to stay out of.
 *
 * MEASURED AND REVERTED: pushing it to 700ms to clear that span changed nothing — 15.25 painted
 * scroll frames at 420ms against 14.95 at 700ms, inside the noise. The two deferred re-renders are
 * evidently not what the scroll is losing frames to, so the constant stays at the ease's own
 * duration rather than carrying an unexplained margin. */
const OPEN_COMMIT_MS = 420;

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
 * HELD_SLIDE_MS, same `chained` test, same one idea about how this build answers a held key).
 * A deliberate press keeps the full 450ms, which is the settle the reference has and what makes a
 * single press feel like weight rather than a cut. A chained press gets a fade that FITS INSIDE
 * one press, so every card you fly past is a picture at full strength instead of a fifth of one. */
const ART_FADE_MS = 110;
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
   * the same component with no `cat`, and a card that goes nowhere is worse than no card.
   *
   * NO CALLER PASSES `cat`/`onSeeAll` ANY MORE — the home rows were the last, and they now end in
   * the "+" card instead (TvHomeRow), so a row lengthens rather than navigating away. The branch is
   * kept because it is the honest answer for a row whose contents are NOT a category the API can
   * page through, which is the next kind of row anyone adds. */
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

  /* ---- THE ROW WINDOW, `groloo.tvrows = 'virtual'` --------------------------------------------
   *
   * WHAT IT DOES: a row further than two from the focused one drops its ARTWORK — every poster src
   * and the billboard picture — while keeping its DOM, its height, its heading and its focus target
   * exactly where they were. `artOn` below is `visible` (the IntersectionObserver latch) narrowed by
   * the window, and every artwork gate in this file reads it instead.
   *
   * WHY IT IS DONE THIS WAY RATHER THAN BY UNMOUNTING ROWS. The measured problem is not React and it
   * is not the DOM: it is `MajorGC` at 230ms with `V8.MemoryPressureNotification` beside it, and the
   * GPU thread busy 183-288ms inside the bad frames. That is webOS raising memory pressure over
   * decoded bitmaps and GPU textures, which are freed by dropping the `src` — not by removing the
   * <div> around it. Unmounting rows would additionally risk the two failures the brief forbids:
   * focus landing on a row that no longer exists, and the document changing height under the
   * viewer. Keeping the row as its own stable slot avoids both by construction.
   *
   * THE RECYCLE NEVER LANDS ON THE KEYPRESS FRAME — `setActiveRowIndex` defers the commit past the
   * scroll ease (see lib/tvRowWindow.ts), so the re-render happens after the movement, not inside
   * it. */
  const rowsVirtual = tvRowsMode() === 'virtual';
  const [activeRow, setActiveRow] = useState(() => getActiveRowIndex());
  useEffect(() => (rowsVirtual ? subscribeRowWindow(setActiveRow) : undefined), [rowsVirtual]);
  const myRow = useRef(-1);
  /* Position is read from the register (document order), not passed down as a prop — threading an
   * index from Home through Row and TvHomeRow would have to survive three components that legitimately
   * do not care, and the register already knows the answer. */
  useEffect(() => {
    const el = sectionRef.current;
    if (el) myRow.current = rowIndexOf(el);
  });
  const inWindow = !rowsVirtual || myRow.current < 0 || rowInWindow(myRow.current, activeRow);
  /** Artwork is allowed only when the row is BOTH near the viewport and inside the window. */
  const artOn = visible && inWindow;
  const sectionRef = useRef<HTMLElement>(null);
  /* ENROL IN THE ROW REGISTER, so vertical movement can step an index instead of measuring the whole
   * page. Registration is by DOM node and the register sorts by document position, so it does not
   * matter what order React mounts the rows in or that "load more" appends to a live list.
   * See lib/tvRowRegistry.ts for what the fast path does and does not claim to handle. */
  useEffect(() => {
    const el = sectionRef.current;
    return el ? registerTvRow(el) : undefined;
  }, []);
  // Two billboard layers that swap which is on top, so a change cross-dissolves rather than cuts.
  const [xfade, setXfade] = useState<{ a: Slot; b: Slot | null; front: 'a' | 'b' }>(
    () => ({ a: list[0], b: null, front: 'a' }),
  );
  const firstRun = useRef(true);
  const trackRef = useRef<HTMLDivElement>(null);
  /** When the strip last moved — `step` reads it to tell a held key from a deliberate press.
   *  Up here with the other refs because `step` is defined past an early return. */
  const lastStepAt = useRef(0);
  /* ---- WHERE THE WALK ACTUALLY IS, WHILE THE KEY IS HELD -------------------------------------
   * A chained press no longer calls setActive (see `step`), so for the length of a hold the React
   * state is stale on purpose and THIS is the truth. `chaining` says a commit is owed; `endChain`
   * pays it when the remote lets go. Everything that must not lag behind a hold — OK opening a
   * title, chiefly — reads `liveActive` rather than `active`. */
  const liveActive = useRef(0);
  const chaining = useRef(false);
  /** The dwell timer, hoisted out of its effect so a held key can cancel it without a re-render. */
  const dwellId = useRef(0);
  /** One in-flight tile promotion at a time — see `promoteSoon`. */
  const promoteId = useRef(0);
  /* ---- THE STRIP'S POSITION IS NOT ALWAYS THE WALK'S POSITION -----------------------------
   * They agree everywhere except one press: stepping RIGHT off the end card. The walk wraps to 0,
   * but the strip glides FORWARD onto `stops` — the first tile of the duplicate copy, which is the
   * same picture — and is then re-seated on 0 with the transition suppressed. Identical pixels
   * either side of that swap, so the re-seat cannot be seen and the lurch is gone.
   * `stripPos` drives the node; `liveActive` stays the truth about where the walk is. */
  const stripPos = useRef(0);
  /* Where the strip was standing when a hold ended, or -1. Consumed by the layout effect that owns
   * `--active`, which uses it to hop invisibly before animating the press itself. */
  const silentFrom = useRef(-1);
  const reseatId = useRef(0);
  /* ---- THE ACTIVE-ROW HIGHLIGHT IS A CLASS, NOT A RENDER ------------------------------------
   * `open` drives two quite different things: the LOOK of the focused row (a class, and every
   * `.tv-spot.is-open` rule hanging off it) and the BEHAVIOUR of being focused — arming the
   * trailer dwell, the neighbour prefetches, the red-button listener, the duplicate-strip latch.
   * The look has to be instant. The behaviour does not: all of it is work that happens half a
   * second later anyway.
   *
   * MEASURED: an up/down press re-rendered TWO whole rows — the one being left and the one being
   * arrived at — each rebuilding its art layers, plates and info panel purely to change which one
   * looks active. ~74-85ms of style and ~100-146ms of script per press, and at that cost the set
   * paints only 8 of the ~25 frames of the 420ms scroll ease. That is the "vertical jumps instead
   * of gliding" complaint, in numbers.
   *
   * So the class goes straight to the node on focus, costing nothing, and the state commit that
   * re-arms the behaviour waits for the scroll to land. `openRef` is the truth in between, and a
   * layout effect re-asserts the class after any render so React cannot take it back. Same shape
   * as `--active` and `liveActive` above — one idea, applied twice. */
  const openRef = useRef(false);
  const openCommit = useRef(0);
  /** Clears `is-fast` once the remote stops chaining — see the note in `step`. */
  const fastOff = useRef(0);
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
    if (!artOn) return;
    const rail = railRef.current, track = trackRef.current;
    if (!rail || !track) return;
    // A frame late, so the measurement is of a settled strip rather than of one mid-transition.
    const id = requestAnimationFrame(() => {
      if (track.getBoundingClientRect().right < rail.getBoundingClientRect().right - 1) setDup(true);
    });
    return () => cancelAnimationFrame(id);
  }, [dup, open, artOn, n]);

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
  /* THE SWITCH, AND THE SET'S OWN VERDICT ON THE SWITCH. `previewsAllowed` returns false on hardware
   * that cannot afford a preview whatever the viewer chose — a webOS below the Chromium 87 floor, a
   * 1GB panel, a single core. The setting stays visible and stays theirs; it simply cannot turn on a
   * feature the set will stutter through. See lib/tvPreviewPolicy.ts for how a set is classed and
   * why the test errs toward leaving the feature ON. */
  const rowTrailers = previewsAllowed(useSettings((s) => s.settings.tvRowTrailers));
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
    /* MEASUREMENT SWITCH, default on. Two `Element.animate()` calls per press are two compositor
     * animations, and `Layerize` appears in the traced bad frames — so this needs to be separable
     * from everything else the press does. See lib/tvMotionFlags.ts. */
    if (!parallaxEnabled()) return;
    /* NO DRIFT WHILE THE KEY IS HELD — and this is a correction of a correction, so the reasoning
     * is worth keeping straight.
     *
     * The drift was originally suppressed on a held key. That was removed because the billboard had
     * nothing at all when you held a direction, which read as broken. But restoring it for HOLDS
     * TOO was the wrong half of the fix: `Element.animate` RESTARTS on every press, so the artwork
     * is yanked back to its 3.2% offset and released again, over and over. Measured on the
     * television: the artwork jumped by more than 8px 69 times in 12.6 seconds — about five resets
     * a second, up to 62px each. That is not drift, it is a shudder, and it is why it looks fine on
     * a PC (where presses are slower and each animation gets to finish) and bad on a TV.
     *
     * A settle needs time to settle. So the drift belongs to a considered press, where it has the
     * full slide to play out, and a hold gets a clean linear slide with the picture held still. */
    if (root.classList.contains('is-fast')) return;
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
    /* NOT SEEKED TO THE STRIP'S CLOCK, AND THE ATTEMPT IS WORTH RECORDING so nobody spends the
     * television time on it twice. The theory was that this effect starts late — it waits for the
     * swap commit, for the reason below — so the drift should be created and then advanced to
     * wherever the strip's transition already is. Built, shipped to the set, measured: no change.
     *
     * `document.getAnimations()` on the moving row says why. Censused on the first frame the strip
     * actually moves, the strip's transition is 17ms in and these animations are at 0 — ONE FRAME
     * apart, not the tenth of a second the earlier reading suggested. There is nothing to seek to,
     * so the seek never fired and the code was pure weight. The lag that reading appeared to show
     * came from the metric, not the app: the leaving layer animates none -> away, so its transform
     * does not differ from its resting value until the animation is already under way, and "when
     * did it last change" then lands at the post-animation snap back to none.
     *
     * What DID matter was the curve, which is one constant and is fixed at PARALLAX_EASE. */
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
    /* HELD IN A REF so a chained press can cancel it without going through React — during a hold
     * this effect does not re-run at all (`active` is deliberately not moving), and the dwell must
     * still be dropped on every press or a trailer would arm for a card already scrolled past. */
    dwellId.current = window.setTimeout(() => { dwellId.current = 0; setDwelt(resting); }, previewDwellMs());
    return () => { window.clearTimeout(dwellId.current); dwellId.current = 0; };
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
      /* 720p AND NO HIGHER, because on this shelf a preview that starts sooner beats a preview
       * that is sharper. The billboard was pulling the 1080p file on every rest — roughly twice
       * the bytes before a frame can be presented, on a surface the viewer is already waiting on
       * behind a dwell, and shown in a box under a thousand pixels wide where the difference is
       * not visible from a sofa. The floor in pickTrailerRendition still applies underneath, so
       * this is a ceiling and not a downgrade. */
      maxRenditionPx: 1280,
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
  const { data: detail } = useMeta(enrich && artOn ? resting?.id : undefined, resting?.type);
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
    if (!enrich || !open || !artOn || n < 2) return;
    const near: MediaItem[] = [];
    for (let d = 1; d <= TRAILER_PREFETCH_SPAN; d++) near.push(list[(active + d) % n], list[(active - d + n) % n]);
    prefetchMeta(near.filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich, open, artOn, active, n]);
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
    return artOn ? imgW(source || '', BILLBOARD_RENDITION) : '';
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
    /* ---- THE WRAP DUPLICATE IS CAPPED, AND THE REASON IS THE COMPOSITOR ----------------------
     *
     * The strip animates `transform`, so it is a promoted layer, and a promoted layer's texture is
     * sized by its CONTENT — not by the box that clips it. Measured on the reference set with a
     * layer census: the full `[10 titles][end card][10 titles]` strip is a single
     * **6892 x 509 layer, 13.4MB**, of which about six tiles are ever on screen. Cutting the strip
     * to eight tiles took that same layer to **2616 x 509, 5.1MB**, and the frame numbers moved with
     * it — horizontal held 85.8% -> 93.0% on time, worst frame 70ms -> 63.4ms.
     *
     * It is NOT about painting. Tiles past the right edge of an `overflow: hidden` rail never paint
     * either way; they cost because they make the layer bigger, and the GPU is what this device runs
     * out of first. That also rules out the tidy-looking alternative: `content-visibility: auto` on
     * each tile was measured and LOST on every block (horizontal deliberate 83.9% -> 79.8%, vertical
     * held 76.8% -> 70.4%), because ~190 extra elements in Blink's intersection machinery cost more
     * than the skipped paint saves.
     *
     * AND YET THE CAP IS OFF, because the illusion needs more of the duplicate than it looks like.
     * Capping it at six was built, measured and REVERTED:
     *
     *   · the frame gain was +0.1 to +1.2 points across four blocks — inside the run-to-run noise
     *     band, because a 19% smaller layer buys about a seventh of what the 62% ablation did;
     *   · and it broke the thing the duplicate is for. Walking 26 steps along an open row with a
     *     six-tile duplicate, the strip's right edge fell short of the rail's on FIVE of them —
     *     which on screen is the up-next area emptying itself mid-walk, exactly the defect the full
     *     copy prevents. Verified in desktop Chrome against `vite preview --mode tv`; the strip
     *     geometry does not depend on the panel.
     *
     * A visible gap is not worth a gain that cannot be distinguished from noise. If the strip layer
     * is attacked again, the lever is the number of TITLES a row carries (SPOT_MAX), which shortens
     * both copies together and keeps the wrap whole — not trimming the copy that makes it work. */
    const DUP_TILES = undefined;
    const copy = (pass: number, limit?: number) =>
      (limit ? list.slice(0, limit) : list).map((it, i) => tile(it, `p${pass}-${i}`));
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
    if (!hasEnd) return [...copy(0), ...copy(1, DUP_TILES)];
    /* POSITION IS THE WHOLE TRICK. The strip is translated so the tile at index `active` hides
     * behind the billboard and its successors peek to the right, so putting the card at index n —
     * straight after the last title of the FIRST copy — makes it both the thing you see appear at
     * the end of the posters and the thing the billboard becomes when you reach it. The second
     * copy still follows it, so the row's endless up-next preview is unbroken. */
    return [...copy(0), endCard, ...copy(1, DUP_TILES)];
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
   * ancestor's overflow, which the browser does not treat as off-screen.
   *
   * AND THE ATTRIBUTE IS NOW GONE, WHICH REVERSES WHAT THIS NOTE USED TO SAY. It said lazy stayed
   * on because it "still earns its keep for rows below the fold". It does not, and cannot: a tile
   * only ever receives a `src` from the effect below, the effect returns early unless `visible`,
   * and `visible` is an IntersectionObserver latch. A row below the fold therefore has no `src` on
   * any tile, and `loading` on an image with no source is inert — there was nothing left for it to
   * defer. `content-visibility: auto` on the rail covers those rows besides.
   *
   * What it DID still cost is registration: every promoted tile joined Blink's internal lazy-load
   * observer, on a screen carrying ~121 images, and a trace of an eight-press walk put
   * `IntersectionObserverController::computeIntersections` at 36.5ms per press — during a
   * HORIZONTAL walk, where nothing scrolls and no intersection can have changed. Removing a
   * redundant observer registration per tile is the cheapest thing on that line. Unmeasured as
   * yet; it wants the same four-arm treatment as the rest.
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
  /* ---- ONE PROMOTION IN FLIGHT, AND IT READS THE WALK WHEN IT FIRES -------------------------
   * This used to be an effect keyed on `active`: every press cancelled the pending idle callback
   * and armed a new one, so at a held key's ~120ms cadence the callback was cancelled and rebuilt
   * before it could ever run — thirty presses of scheduling for zero promotions, then one at the
   * end. Pure churn on the frame that can least afford it.
   *
   * Now `step` calls this directly and it is idempotent: if one is already scheduled, nothing
   * happens. The window is computed from `liveActive` INSIDE the callback rather than captured
   * when it was scheduled, so the one that eventually runs promotes where the walk actually
   * ENDED UP rather than where it was thirty presses ago — which is the tile the viewer is
   * looking at. */
  const promoteSoon = () => {
    if (promoteId.current) return;
    const track = trackRef.current;
    if (!track || !artOn) return;
    const run = () => {
      promoteId.current = 0;
      const tiles = track.children;
      const at = liveActive.current;
      const from = Math.max(0, at - THUMB_BEHIND);
      const to = Math.min(tiles.length - 1, at + THUMB_AHEAD);
      for (let i = from; i <= to; i++) {
        const img = tiles[i]?.querySelector<HTMLImageElement>('img[data-src]');
        if (!img) continue;                     // the see-all card, or a tile already promoted
        img.src = img.dataset.src || '';
        delete img.dataset.src;
      }
    };
    const ric = window.requestIdleCallback;
    promoteId.current = typeof ric === 'function'
      ? ric(run, { timeout: 600 })
      : window.setTimeout(run, 120);
  };

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
  }, [artOn, active, thumbs]);

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
  /* What the walk is currently pointing AT, as a stable string. `end` is its own value because the
   * end card is a real stop with no id of its own. */
  /* The committed state is the source of truth whenever React DOES commit; `liveActive` only runs
   * ahead of it during a hold. Re-syncing here keeps a deliberate press, a catalogue change and the
   * load-more reset from leaving the two disagreeing. */
  if (!chaining.current) liveActive.current = active;
  /* Not while a wrap re-seat is pending: the strip is parked on the duplicate for the length of
   * that glide, and a render landing mid-way must not drag it back.
   *
   * WHEN A HOLD ENDS THE STRIP MAY BE DEEP IN THE DUPLICATE, and this line hauls it back to the
   * walk's own index in one go. Left to the layout effect that writes `--active`, that is an
   * ANIMATED slide across fifteen posters — measured at 4935px over 483ms, the row visibly
   * rewinding after the button is released. The distance is recorded here so the write can be split
   * into an invisible hop and the ordinary one-tile glide. */
  if (!chaining.current && !reseatId.current) {
    if (stripPos.current !== liveActive.current) silentFrom.current = stripPos.current;
    stripPos.current = liveActive.current;
  }

  const activeSlot = slotAt(active);
  const activeKey = activeSlot === 'end' ? 'end' : String(activeSlot?.id ?? '');

  /* ---- A NEW CATALOGUE IS A NEW ROW ---------------------------------------------------------
   * The three top-level pages share one component instance (see the note on `activeKey` in the
   * effect below), so nothing about a route change resets this row on its own: the walk stays
   * where it was on the previous page and the cross-fade layers still hold its artwork. Landing
   * on Anime at card nine of Movies is not a state anyone asked for.
   *
   * DETECTED FROM THE HEAD OF THE LIST rather than from a `cat` prop, because these rows are not
   * given one — TvCatalogRow passes items and nothing else. The first title's id is the cheapest
   * thing that changes when the catalogue does and stays put when it does not: appending a page
   * of results does not touch it, and neither does `enrich` filling artwork into a card already
   * on screen.
   *
   * THE BILLBOARD IS CUT, NOT DISSOLVED. Both layers are rewritten in one go rather than left to
   * the swap effect: a cross-fade means "this row moved to its neighbour", and a whole page
   * changing underneath is not that. Dissolving Movies' billboard into Anime's would read as one
   * row walking sideways across a page boundary. */
  const headId = list.length ? String(list[0].id) : '';
  const prevHead = useRef(headId);
  useEffect(() => {
    if (prevHead.current === headId) return;
    prevHead.current = headId;
    setActive(0);
    setXfade({ a: list[0], b: null, front: 'a' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headId]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    /* `?? list[0]` because `active` can outlive the list it indexes. The reset above puts it back
     * to 0, but that is state and lands a commit later — so for one render after a new category
     * arrives, a walk that had reached card twelve of a twenty-card row is indexing a six-card
     * one. Falling back to the head rather than reading `undefined` keeps that frame on the first
     * title of what actually arrived instead of throwing inside `withArt`. */
    const slot = slotAt(active) ?? list[0] ?? 'end';
    let spent = false;
    const flip = () => {
      if (spent) return;
      spent = true;
      setXfade((s) => {
        const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
        return { ...s, [back]: slot, front: back };
      });
    };
    /* ---- THE WORDMARK IS PART OF THE SWAP, NOT SOMETHING THAT CATCHES UP WITH IT --------------
     * THE DEFECT: the picture arrived whole and the title did not. The gate below waited on the
     * BACKDROP only, so a press flipped the layers the moment the photograph was decoded and the
     * plate began its rise 110ms later with whatever the logo happened to be — which for a cold
     * card is nothing at all. The wordmark then faded in on its own clock a few hundred
     * milliseconds after the card it belongs to, and on a walk it read as the billboard changing
     * twice: first the photograph, then, separately, the name of what you are looking at.
     *
     * The cascade this row is built around is picture → wordmark → copy, and that is a matter of
     * TIMING, not of readiness: each beat is deliberate and each one is supposed to be complete
     * when it starts. A logo that is merely late is not the third beat arriving, it is the second
     * beat failing.
     *
     * So both pictures are decoded before the layers trade places. They are asked for together
     * rather than in sequence — a wordmark is a ~20KB PNG against a 780px JPEG, so it is almost
     * never the one being waited on, and serialising them would add its round trip to the
     * backdrop's for no reason. The cap below covers the pair exactly as it covered the one.
     *
     * The end card has no artwork by design, and an `enrich` row whose detail has not landed yet
     * has none to wait for either — both dissolve immediately, exactly as before. */
    const art = slot === 'end' ? null : withArt(slot);
    const urls = art ? [billboardUrl(art), logoOf(art) || ''].filter(Boolean) : [];
    if (!urls.length) { flip(); return; }

    let left = urls.length;
    // Only the LAST of the two releases the swap; either failing still counts, because a missing
    // wordmark is a card that falls back to type and must not hold the picture behind it.
    const done = () => { if (--left <= 0) flip(); };
    for (const url of urls) {
      /* THROUGH THE RETAINED CACHE, not a fresh Image per press. This gate, the warm-ahead below
       * and FadeBg's `useImageReady` all used to build their own element for the same URL, so one
       * press could ask the engine to decode one backdrop three times over — ~130ms per press of
       * decoding on a warm row, measured. They now share one element, so the warm-ahead's decode
       * IS this gate's decode, and the common case here is the synchronous hit below. */
      const img = retainImage(url);
      if (isDecoded(img)) { done(); continue; }
      if (typeof img.decode === 'function') img.decode().then(done, done);
      else {
        // addEventListener rather than onload: the element is shared, and assigning would unhook
        // whichever other waiter registered first.
        const off = () => { img.removeEventListener('load', off); img.removeEventListener('error', off); done(); };
        img.addEventListener('load', off);
        img.addEventListener('error', off);
      }
    }
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
    /* `activeKey` IS IN HERE BECAUSE THE INDEX IS NOT THE PICTURE.
     *
     * Keyed on `[active, n]` alone this asked "has the walk moved, or has the row got longer" —
     * and missed the third way the billboard goes stale: the same index now points at a different
     * title. That is exactly what a page change does. Series, Movies and Anime are one `Browse`
     * component in one position of the tree, so React keeps its state across the route change and
     * hands it a new `items` array; `active` is still 0 and, for two catalogues that happen to be
     * the same length, `n` is unchanged too. Neither dependency moved, the effect never ran, and
     * the billboard kept showing the title from the page you had just left.
     *
     * The id of whatever sits under the walk is the honest dependency: it changes whenever the
     * artwork should, and does not change when a row merely lengthens (load-more appends past
     * `active`) or when `enrich` fills a logo into the card already showing. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, n, activeKey]);

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
    if (!artOn || stops < 2) return;
    const warm = () => {
      for (let d = 1; d <= BILLBOARD_WARM_SPAN; d++) {
        for (const i of [(active + d) % stops, (active - d + stops) % stops]) {
          const slot = slotAt(i);
          if (slot === 'end') continue;
          const art = withArt(slot);
          /* THE WORDMARK IS WARMED WITH THE PHOTOGRAPH, because the swap now waits for BOTH (see
           * the gate above) and a gate is only free if everything it waits on is already in hand.
           * Warming just the backdrop would have moved the stall rather than removed it: every
           * press would sit out a cold ~20KB PNG and, often as not, hit the 200ms cap — which is
           * the exact "blink traded for a lag" this warm exists to prevent. */
          for (const url of [billboardUrl(art), logoOf(art) || '']) {
            if (!url || warmed.has(url)) continue;
            warmed.add(url);
            /* RETAINED NOW, WHICH IS THE POINT OF THE WARM. Dropping the element the moment it had
             * decoded — what this did — made the decoded frame immediately evictable, so the warm
             * bought a cached BYTE RANGE and the gate one press later paid for the decode anyway.
             * Holding it in the bounded LRU is what turns the warm into a warm. The ceiling lives
             * on RETAIN_MAX and is global, so this no longer scales with rows on screen, which is
             * what the old note was right to worry about. */
            const img = retainImage(url);
            if (typeof img.decode === 'function') img.decode().catch(() => { /* 404 / expired signature — the gate's cap covers it */ });
          }
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
  }, [artOn, active, stops, artById]);

  /* Suppress the strip's scroll animation on a wrap / multi-step jump, so it resets instead of
   * rewinding through every card.
   *
   * TWO COORDINATE SYSTEMS SHARED ONE REF, AND THAT IS WHAT KILLED THE GLIDE. `prevActiveRef` is
   * written by `step()` as a STRIP index, which is deliberately allowed to run on into the
   * duplicate copy (17…33 on an extended row); `active` is the WALK index and stays inside
   * 0…stops-1. Comparing one against the other made `Math.abs` large on nearly every press, so this
   * effect turned the transition off constantly and every step became a hard cut.
   *
   * It only began firing when the billboard was made to track a hold: before that `active` stood
   * still for the whole hold and this effect never ran. And it bites hardest right after "load
   * more", because from then on the walk spends almost all its time in the duplicate — which is
   * exactly where the row was reported as jumping instead of sliding. Measured on the television:
   * 55% of steps completed in a single frame, against 10-28 frames for a real slide.
   *
   * So: a ref of its own for the commit-to-commit comparison, and no interference at all while a
   * hold is running, when `step()` owns the node and the strip is not React's to animate. */
  const prevCommitRef = useRef(active);
  useEffect(() => {
    const prev = prevCommitRef.current;
    prevCommitRef.current = active;
    if (chaining.current) return;
    const track = trackRef.current;
    const jumped = Math.abs(active - prev) > 1;
    /* Re-sync the strip's own ref on the way past: a deliberate press never enters the duplicate,
     * so the two systems agree here and the next held press starts from a truthful value. */
    prevActiveRef.current = active;
    if (track && jumped) {
      track.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
    }
  }, [active]);

  /* ---- THE STRIP'S POSITION IS WRITTEN TO THE NODE, NOT RENDERED --------------------------
   * `--active` used to be an inline style on the strip, which meant moving the row required a
   * React render. A held key is ~8 presses a second and each one cost two commits (setActive, then
   * setXfade from the swap gate) — measured at ~20.5ms of script per press, which became the
   * largest single item once the animation work was cut.
   *
   * So during a hold `step` writes this property straight to the node and React is not involved at
   * all. This hook exists for the OTHER direction: whenever a render does happen — mount, a new
   * catalogue, a deliberate press, the row lengthening — it re-asserts the committed value, so the
   * node and the state can never disagree.
   *
   * `useLayoutEffect` and NO dependency array, deliberately. Layout-effect so there is no frame
   * where a freshly mounted strip sits at the property's initial value; no deps because it must
   * follow every commit, and during a hold there are no commits, so it costs nothing.
   *
   * ABOVE `if (!n) return null` because that is an early return and a hook below it would not run
   * on an empty row — the rules-of-hooks trap this file's shape sets for exactly this change. */
  useLayoutEffect(() => {
    const t = trackRef.current;
    if (t) {
      /* THE HOP IS SILENT, THE PRESS IS NOT. Tile i and tile i+stops are the same picture, so
       * bringing the strip back inside the real range is invisible as long as it does not animate —
       * and the press that triggered this commit still gets its own one-tile slide, because the hop
       * is flushed first and the real value written after. Writing only the final value made the
       * row rewind across the whole duplicate in plain sight. */
      const from = silentFrom.current;
      silentFrom.current = -1;
      if (from >= 0 && stops > 0) {
        const same = ((from % stops) + stops) % stops;   // same artwork, inside the real range
        /* Compared against where the strip PHYSICALLY is, not against where it is going. Comparing
         * it to the destination skipped the hop whenever the press happened to land on the parked
         * position's own equivalent — and then the write animated the entire rewind, 4606px over
         * 900ms of the row running backwards. */
        if (same !== from) {
          t.style.transition = 'none';
          t.style.setProperty('--active', String(same));
          void t.offsetWidth;
          t.style.transition = '';
        }
      }
      t.style.setProperty('--active', String(stripPos.current));
    }
    /* `is-open` is owned by the node too, for the reason above: it is deliberately NOT in the
     * rendered className, so a render triggered by anything else cannot write a stale value over
     * the class the focus handler already set. */
    sectionRef.current?.classList.toggle('is-open', openRef.current);
  });

  /* ---- FOCUS PAINTS IMMEDIATELY, COMMITS LATER ----------------------------------------------
   * The class is the whole visible effect of gaining or losing focus, and it costs one classList
   * write. The state commit behind it re-runs the effects that arm the preview, the prefetches and
   * the duplicate strip — none of which anyone can perceive inside half a second — so it is held
   * until the scroll ease has finished rather than landing in the middle of it.
   *
   * OPEN_COMMIT_MS tracks TvSpatialNav's SCROLL_MS. Holding a direction keeps re-scheduling it, so
   * a run down the page produces ONE commit per row that is actually stopped on, instead of two
   * full row re-renders per press on the way past. */
  const setOpenNow = (v: boolean) => {
    openRef.current = v;
    sectionRef.current?.classList.toggle('is-open', v);
    if (openCommit.current) window.clearTimeout(openCommit.current);
    if (reseatId.current) window.clearTimeout(reseatId.current);
    openCommit.current = window.setTimeout(() => {
      openCommit.current = 0;
      setOpen(v);
    }, OPEN_COMMIT_MS);
  };

  /* ---- LOADING MORE REBUILDS THE STRIP UNDER THE WALK --------------------------------------
   * Pressing OK on the end card appends a batch, so the strip goes from `[titles][+][titles]` to
   * the same shape with MORE titles in each copy — and every index past the first copy now means a
   * different tile than it did. If the walk is parked in the duplicate, which is exactly where the
   * seamless wrap leaves it, the strip is suddenly pointing at the wrong card and the next press
   * jumps.
   *
   * So the strip is re-seated onto the real index the moment the count changes. Invisible: titles
   * are APPENDED and keep their positions (see the note on `all`), so the card at `liveActive` is
   * the same picture it was a frame ago — only its index in the rebuilt strip has moved.
   *
   * `useLayoutEffect`, AND THAT IS THE WHOLE FIX RATHER THAN A DETAIL. As a passive effect this ran
   * after the browser had already painted, and the layout effect above had by then written the OLD
   * `stripPos` to a strip that no longer means the same thing at that index — so one frame showed
   * the wrong card and the correction that followed was a teleport. Measured on the television with
   * the row lengthening MID-HOLD: 22.6 px/ms, against ~1.3 for a legal step. Running before paint
   * means the two writes land in the same frame and the viewer sees only the settled one.
   *
   * DECLARED BELOW THE HOOK THAT WRITES `--active` ON EVERY COMMIT, deliberately: layout effects run
   * in declaration order, so this one has the last word in the commit that rebuilt the strip.
   *
   * The earlier version of this test loaded more while PARKED and reported clean, which is why the
   * fault survived a round. Loading more mid-hold is the case that matters — a parked walk has
   * `stripPos === liveActive` and takes the early return below without doing anything at all. */
  const prevN = useRef(n);
  useLayoutEffect(() => {
    if (prevN.current === n) return;
    prevN.current = n;
    if (stripPos.current === liveActive.current) return;
    stripPos.current = liveActive.current;
    const t = trackRef.current;
    if (!t) return;
    t.style.transition = 'none';
    t.style.setProperty('--active', String(stripPos.current));
    prevActiveRef.current = stripPos.current;
    requestAnimationFrame(() => requestAnimationFrame(() => { t.style.transition = ''; }));
  }, [n]);

  /* Chained presses leave a commit owed; if the row unmounts mid-hold the timer must not fire. */
  useEffect(() => () => {
    if (fastOff.current) window.clearTimeout(fastOff.current);
    if (dwellId.current) window.clearTimeout(dwellId.current);
    if (openCommit.current) window.clearTimeout(openCommit.current);
    if (promoteId.current) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(promoteId.current);
      else window.clearTimeout(promoteId.current);
    }
  }, []);

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
    const since = now - lastStepAt.current;
    const chained = since < SLIDE_CHAIN_WINDOW;
    /* A held key repeating faster than the row is allowed to walk — see HELD_STEP_MIN_MS. Dropped
     * outright, and `lastStepAt` deliberately not moved, so the pace is measured from the last
     * step the viewer actually saw rather than from the last repeat the platform sent. */
    if (chained && since < HELD_STEP_MIN_MS) return;
    lastStepAt.current = now;
    const el = sectionRef.current;
    if (el) {
      el.style.setProperty('--sp-slide', `${chained ? HELD_SLIDE_MS : SLIDE_MS}ms`);
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
      /* ---- A HELD KEY GETS THE SLIDE AND NOTHING ELSE -------------------------------------
       * One press starts ELEVEN animations, measured off `document.getAnimations()` on the
       * television: the strip's own transform, two parallax drifts on the artwork, two layer
       * dissolves, two title plates, two synopsis blocks and the info panel. Exactly ONE of those
       * is the row moving; the other ten decorate it. Turning all of them off was the only arm of
       * six to escape the noise band — frames over 33ms 75.5% -> 41.0%, median 41.7 -> 16.7ms.
       *
       * So they come off WHILE THE KEY IS HELD, which is the only time the lag is felt, and come
       * straight back for a deliberate press, which is when the cascade is what makes the row feel
       * like it has weight. Same `chained` test that already picks the slide duration — no new
       * idea, just applied to the decoration rather than only to its timing.
       *
       * The class is cleared on a timer rather than on the next press, so letting go of the button
       * restores the full effect for the card you actually stop on. */
      el.classList.toggle('is-fast', chained);
      if (fastOff.current) window.clearTimeout(fastOff.current);
      fastOff.current = window.setTimeout(endChain, SLIDE_CHAIN_WINDOW);
    }

    const raw = liveActive.current + delta;
    const next = (raw + stops) % stops;
    liveActive.current = next;

    /* ---- WALKING OFF THE END KEEPS GOING, IT DOES NOT SNAP BACK ---------------------------
     * Measured: `--active` ran 8, 9, 10 (the end card) and then 0 — ten cards backwards in one
     * press, suppressed to be instant so it did not rewind the whole strip. Instant or rewound,
     * both read as the row lurching.
     *
     * The strip renders `[titles][end card][titles again]` — 21 tiles for ten titles — so every
     * tile past the end card is the SAME PICTURE as one near the start. The walk therefore wraps
     * (the billboard is title 0 again) while the STRIP simply carries on: 10, 11, 12 … through the
     * duplicate. Consecutive single steps, so the glide is unbroken for the whole of the copy.
     *
     * A FIRST ATTEMPT RE-SEATED AFTER ONE TILE and was wrong in exactly the way this is right. It
     * glided to 11 and scheduled a hop back to 0 once the slide finished — but a held key arrives
     * every ~240ms and the slide takes 260ms, so the NEXT press cancelled that timer, asked for
     * tile 1, and snapped back ten. Glide, jump, stop, resume: the reported symptom, caused by the
     * fix for it.
     *
     * The re-seat still has to happen — the duplicate is finite — but it now waits until the strip
     * has genuinely run out of tiles, which is a full lap rather than a single step, and until then
     * `stripPos` is simply allowed to exceed the walk. `stripPos` drives the node; `liveActive`
     * stays the truth about which title is showing. */
    const track0 = trackRef.current;
    const tiles = track0 ? track0.children.length : stops;
    /* ---- WRAP WHILE THE UP-NEXT AREA IS STILL FULL, NOT AT THE LAST TILE --------------------
     * Letting `stripPos` run all the way to `tiles - 1` puts the walk on the FINAL tile of the
     * strip, where there is nothing to its right at all. The previews therefore thin out — six
     * ahead, then four, then one, then none — and only afterwards does the wrap snap them back.
     *
     * That is what "the glide breaks after see more" is. Loading more makes it far worse for a
     * reason that is not obvious: the end card DISAPPEARS once the row has been extended, so the
     * strip goes from [10 titles][+][10 titles] to [17 titles][17 titles] — measured on the
     * television — and the duplicate the walk may run into grows from ten tiles to seventeen. The
     * empty stretch goes from a flicker to something like a second and a half of watching the row
     * empty itself.
     *
     * Rebasing is a VISUAL NO-OP: tile i and tile i+stops are the same picture. That was checked
     * against the DOM rather than assumed — all 34 pairs identical, none different — because the
     * whole trick collapses if it is ever false.
     *
     * HELD PRESSES ONLY. A deliberate press re-syncs `stripPos` from `liveActive` further up, so it
     * is never in the duplicate to begin with, and the early return below would leave a rebase to
     * be written by the layout effect WITH its transition on — a full-width slide across the row. */
    const AHEAD = 8;
    let base = stripPos.current;
    let rebased = false;
    if (chained && base >= stops && base + AHEAD > tiles - 1) { base -= stops; rebased = true; }
    let sp = base + delta;
    let ranOut = false;
    if (sp > tiles - 1) { sp -= stops; ranOut = true; }   // past the last duplicate tile
    if (sp < 0) { sp += stops; ranOut = true; }           // off the front, where there is no copy
    stripPos.current = sp;
    /* Bring the strip back into the real range once the walk settles, so it never drifts far into
     * the duplicate and the next lap has room. Invisible: the tile it lands on is the same picture.
     * Rescheduled by each press, so it only fires when the remote has actually stopped. */
    if (reseatId.current) { window.clearTimeout(reseatId.current); reseatId.current = 0; }
    if (sp >= stops) {
      reseatId.current = window.setTimeout(() => {
        reseatId.current = 0;
        const t = trackRef.current;
        if (!t) return;
        stripPos.current = ((stripPos.current % stops) + stops) % stops;
        t.style.transition = 'none';
        t.style.setProperty('--active', String(stripPos.current));
        prevActiveRef.current = stripPos.current;
        requestAnimationFrame(() => requestAnimationFrame(() => { t.style.transition = ''; }));
      }, (chained ? HELD_SLIDE_MS : SLIDE_MS) + 120);
    }

    /* A DELIBERATE PRESS IS UNCHANGED — same single setActive it always did, so everything that
     * hangs off it (the cross-dissolve, the wordmark, the synopsis, the warm-ahead) behaves
     * exactly as measured. Only a HELD key takes the path below. */
    if (!chained) { setActive(next); return; }

    /* ---- A HELD PRESS DOES NOT RENDER ------------------------------------------------------
     * The row moves by writing the property the transform reads, and that is the whole press:
     * no setState, no reconcile, no commit, and none of the effects keyed on `active` — the swap
     * gate, the warm-ahead, the prefetches — which at this cadence all produce work that is
     * replaced before it can be seen. `endChain` commits once, on release.
     *
     * The wrap suppression is done inline here rather than left to the effect above, because that
     * effect is keyed on `active` and `active` is deliberately standing still. `prevActiveRef` is
     * moved with it so the commit at the end sees a delta of zero and does not kill the transition
     * a second time for a jump that already happened. */
    chaining.current = true;
    if (dwellId.current) { window.clearTimeout(dwellId.current); dwellId.current = 0; }
    const track = trackRef.current;
    if (track) {
      /* Judged on the STRIP's own movement. A wrap into the duplicate is one ordinary tile and
       * must keep its transition; only a genuine hop (running out of copy, or a multi-card jump)
       * gets suppressed. */
      /* THE REBASE IS INSTANT, NOT ANIMATED. Writing it with the transition off and flushing before
       * the real write was meant to keep the press's own slide, but measured on the television the
       * flush did not reliably take: the strip animated the whole way back instead — 5264px in
       * 217ms, the row rewinding sixteen posters in front of the viewer. An instant hop cannot be
       * seen at all, because tile i and tile i+stops are the same picture; the only cost is that
       * this ONE press does not slide, and it happens about once every sixteen. A press that does
       * not animate is a far smaller thing than the row running backwards. */
      if (rebased || ranOut || Math.abs(stripPos.current - prevActiveRef.current) > 1) {
        track.style.transition = 'none';
        requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
      }
      track.style.setProperty('--active', String(stripPos.current));
    }
    prevActiveRef.current = stripPos.current;
    promoteSoon();

    /* ---- AND THE BILLBOARD KEEPS UP -------------------------------------------------------
     * This deliberately did NOT commit, and that was right when it was written and wrong now.
     * The artwork, wordmark and synopsis were left frozen for the length of a hold so a held key
     * did no React work at all — which took it from 52% of frames on time to 97%.
     *
     * The cost of that was you could not see what you were scrolling past. The billboard sat on
     * the title the hold STARTED on and only caught up on release.
     *
     * The conditions that justified it are gone. A hold is now paced to ~4.5 presses a second
     * rather than ~8 (HELD_STEP_MIN_MS), and the ten decorative transitions are already suppressed
     * while `is-fast` is set — so the commit this used to avoid is a fraction of what it was.
     * Measured, both arms with the preview off, order reversed: distinct backdrops shown across a
     * 30-press hold went 6-7 -> 10 of 10, while frames on time were 88.3/83.4% frozen against
     * 91.0/82.5% tracking and p95 was identical. The picture keeps up and nothing pays for it.
     *
     * The strip is still moved by the node write above, so it starts travelling on the press frame
     * rather than waiting for React — that half of the decouple is what still earns its keep. */
    setActive(next);
  };

  /* ---- PAYING THE COMMIT THE HOLD RAN UP ---------------------------------------------------
   * Fires SLIDE_CHAIN_WINDOW after the last press, i.e. when the remote has actually let go. It
   * restores the full cascade (drops `is-fast`, puts the deliberate durations back) and then hands
   * React the position the walk really reached, which re-arms the artwork, the wordmark, the
   * synopsis and the dwell for the one card the viewer has stopped on.
   *
   * `setActive` with an unchanged value is a React bailout — no render, and therefore no effect
   * re-run — which happens whenever a hold wraps exactly back to where it started. The dwell is
   * armed by hand in that case, because the effect that normally does it is keyed on the resting
   * title's id and that id has not moved. */
  function endChain() {
    const el = sectionRef.current;
    if (el) {
      el.classList.remove('is-fast');
      el.style.setProperty('--sp-slide', `${SLIDE_MS}ms`);
      el.style.setProperty('--sp-art-fade', `${ART_FADE_MS}ms`);
    }
    if (!chaining.current) return;
    chaining.current = false;
    const at = liveActive.current % stops;
    liveActive.current = at;
    if (at === active) {
      const rest = at < n ? list[at] : undefined;
      /* `openRef`, not `open` — a hold can end before the focus commit has landed, and the state
       * would still say the row is not focused when it plainly is. */
      if (rowTrailers && openRef.current && rest && !dwellId.current) {
        dwellId.current = window.setTimeout(() => { dwellId.current = 0; setDwelt(rest); }, previewDwellMs());
      }
      return;
    }
    setActive(at);
  }

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
  /* READS `liveActive`, NOT `active`, AND THAT IS THE ONE CORRECTNESS BUG THIS CHANGE COULD HAVE
   * SHIPPED. During a hold the committed state lags on purpose, so OK pressed within
   * SLIDE_CHAIN_WINDOW of releasing the button would have opened the title the hold STARTED on —
   * the viewer looking straight at one poster and getting another. The pending commit is flushed
   * first so the row is left in a consistent state either way. */
  const openTitle = () => {
    if (chaining.current) endChain();
    const at = liveActive.current;
    if (hasEnd && at >= n) { goEnd(); return; }
    onSelect?.(list[Math.min(at, n - 1)] || list[0]);
  };

  return (
    <section
      ref={sectionRef}
      /* `is-open` is absent here ON PURPOSE — the layout effect above owns it, so a render cannot
       * write a stale value over the class focus just set. `is-settled` is the opposite: it is the
       * DEFERRED half, rendered from state, and it carries the three compositor promotions so they
       * land after the scroll instead of during it (see the note in tv.css). */
      className={`tv-spot${open ? ' is-settled' : ''}${reduceMotion ? ' no-anim' : ''}`}
      aria-label={heading}
      onFocus={() => setOpenNow(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpenNow(false); }}
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
          <div className="tv-spot-strip" ref={trackRef} role="list">
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
                </div>
              );
            }
            return (
              <div key={slot} className={`tv-spot-layer${on ? ' on' : ''}`} aria-hidden={!on}>
                <FadeBg className="tv-spot-art" {...heroArt(withArt(it))} />
              </div>
            );
          })}

          {/* ---- THE SCRIM IS ONE ELEMENT AND IT NEVER MOVES -----------------------------------
              It used to be the background of `.tv-spot-card-in`, one per layer, which meant it
              cross-dissolved WITH the plate — and the plate's timing is deliberately not the
              layer's: the outgoing one leaves in 90ms and the incoming one does not begin its
              rise until 110ms after that. For the gap between them there was no scrim on the card
              at all, so every press flicked the black off the bottom of the billboard and back
              on. It read as a fault in the artwork rather than as a cascade.
              Hoisted here it is drawn once, above both art layers and below both plates, and a
              press cannot touch it. Same fix, same reason, as `.tv-hero-scrim` in TvHero. */}
          <div className="tv-spot-scrim" aria-hidden="true" />

          {/* THE PLATES CROSS-FADE, THE SCRIM UNDER THEM DOES NOT. Split out of the art layers so
              the two can keep their own clocks (see the note above): the tag, the wordmark and the
              resume bar are per-title and must change with the picture, while the black they are
              legible against belongs to the billboard. */}
          {(['a', 'b'] as const).map((slot) => {
            const it = xfade[slot];
            const on = xfade.front === slot;
            if (!it) return <div key={slot} className="tv-spot-plate" aria-hidden="true" />;
            if (it === 'end') {
              return (
                <div key={slot} className={`tv-spot-plate${on ? ' on' : ''}`} aria-hidden={!on}>
                  <div className="tv-spot-card-in">
                    <span className="tv-spot-tag">{endLabel}</span>
                    <span className="tv-spot-cardtitle">{heading}</span>
                  </div>
                </div>
              );
            }
            const logo = logoOf(withArt(it));
            const res = resumeOf?.(it);
            return (
              <div key={slot} className={`tv-spot-plate${on ? ' on' : ''}`} aria-hidden={!on}>
                <div className="tv-spot-card-in">
                  {/* NO "MOVIE" / "SERIES" TAG. It sat above every wordmark saying the one thing
                      the artwork already says, on a row whose whole job is to show the title —
                      and on a billboard with a tall logo it was the line that pushed the plate
                      into the picture. The end card keeps a tag because its label ("see all" /
                      "load more") is the only thing that card has to say. */}
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
                {/* Outside the plate's own box and pinned to the card's bottom edge, so it survives
                    the trailer taking the artwork away — where you are in a title is not a thing
                    that should blink out because a preview started. */}
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
