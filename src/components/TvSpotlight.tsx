import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW, artW, artPosition } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { tvRowCards } from '../lib/tvRowSize';
import { useVideoTrailer, INTRO_SKIP } from './DetailModal/useVideoTrailer';
import { useMeta, usePrefetchMeta, useImdbTrailer, usePrefetchImdbTrailer, useAwards, useWarmDetail, apiIdOf } from '../lib/queries';
import { useGlanceResolver } from './glance/useGlance';
import { GlanceIcon } from './glance/GlanceIcons';

/* THE ROW CALLOUT IS AN ARM, like the other per-press costs this file carries: on by default,
 * `localStorage['groloo.tvglance'] = 'off'` drops it, so its cost can be A/B'd on one build
 * (scripts/tv-bench-local.mjs --ls=groloo.tvglance=off, or tv-measure.mjs on the set). Read once. */
const ROW_GLANCE = (() => { try { return localStorage.getItem('groloo.tvglance') !== 'off'; } catch { return true; } })();
import { retainImage, isDecoded, retainedReady } from '../lib/useImageReady';
import { useSettings } from '../stores/settings';
import { useHistory } from '../stores/history';
import { previewsAllowed, previewDwellMs } from '../lib/tvPreviewPolicy';
import { registerTvRow, rowIndexOf, prepareRowWindow, ROW_PREPARE_EVENT } from '../lib/tvRowRegistry';
import { tileFadeAlways } from '../lib/tvMotionFlags';
import { tvRowsMode, rowInWindow, subscribeRowWindow, getActiveRowIndex } from '../lib/tvRowWindow';
import { usePreviewSound } from '../stores/previewSound';
import { isPreviewSoundKey } from '../lib/tvKeys';
import { barItemHere } from '../lib/tvBar';
import { prefetchArt } from '../lib/artPrefetch';
import { whenQuiet } from '../lib/tvQuiet';
import { TvRowStage, SLIDE_MS, PRESS_SETTLED_MS, type StageSlot, type StagePeek } from '../lib/tvRowStage';

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

/* Titles a home row walks. Was 12, then cut to 10 in the TV fill-rate pass on the grounds that the
 * strip paints at most ~5 posters to the right of the billboard at 1080p, so every title past that
 * was DOM and bitmap nobody had seen — and across 13 rows that was the largest passive load on the
 * screen. Rows that ARE a page (TV / Movies / Anime) pass their own `max` and are unaffected.
 *
 * NOW 40, AND HALF THAT ARGUMENT NO LONGER HOLDS. The BITMAP half was answered by the src window
 * below (THUMB_BEHIND/THUMB_AHEAD): a tile only receives a `src` when the walk comes within a dozen
 * cards of it, so a 40-title row decodes exactly as many posters as a 10-title one — the twelve
 * around wherever you are standing. Lengthening the row costs nothing in decoded pictures.
 *
 * WHAT IT USED TO COST, AND NO LONGER DOES, because the strip is a WINDOW now (see TILES_AHEAD):
 *
 *   · THE STRIP LAYER. The settled row's strip is promoted (`will-change` in tv.css, scoped to
 *     `.is-settled`) and a promoted layer is sized by its content, not by the box that clips it.
 *     Measured on the reference set: `[10][end][10]` = 21 tiles = one 6892x509 layer, 13.4MB. At
 *     40 titles the strip was `[40][end][40]` = 81 tiles — measured in the desktop harness as a
 *     single 13,143px-wide layer for a 40-title row before the duplicate even latched. The row now
 *     mounts only the dozen tiles around the walk, whatever SPOT_MAX is, so the layer is ~12 tiles
 *     wide at any row length and this constant no longer sizes it.
 *   · THE content-visibility ACTIVATION. Every row carries `content-visibility: auto`, and a row's
 *     activation cost tracks how much is inside it. That, too, is now a dozen tiles per row rather
 *     than one or two copies of the whole list. */
export const SPOT_MAX = tvRowCards();

/* ---- THE STRIP IS A WINDOW ONTO AN ENDLESS ROW, NOT A LIST RENDERED TWICE --------------------
 *
 * WHAT IT WAS. The strip rendered every title, then the end card, then every title AGAIN — the
 * duplicate copy is what let a walk run off the end of the row and keep gliding onto the first
 * title without the up-next area ever emptying. It worked, and it cost exactly what the two notes
 * above say: a promoted compositor layer as wide as 81 tiles, a `content-visibility` activation as
 * dear as 81 tiles, and 81 <button>s per row for React to hold. It also needed a "rebase" — an
 * un-animated hop back into the first copy when the duplicate ran out — which on the reference set
 * meant one press in every sixteen did not slide at all.
 *
 * WHAT IT IS. The strip renders a bounded window of tiles around the walk, and the row is treated
 * as endless: a tile sits at a PHYSICAL position `p` (an integer that only ever moves by one per
 * press and never wraps), positioned absolutely at `p * pitch`, and shows the title
 * `(active + (p - pos)) mod stops` — the walk index one gets by counting from the card under the
 * billboard. Position `stops` shows title 0, `stops + 1` shows title 1, and so on for ever: the
 * duplicate copy is implied by the arithmetic instead of being built. Walking right mounts one
 * tile at the leading edge and unmounts one at the trailing edge; nothing else in the strip is
 * touched, so the compositor layer is the window's width whatever the row's length, and there is
 * nothing to rebase because the strip cannot run out.
 *
 * THE INVARIANT EVERYTHING BELOW RESTS ON: `(pos, active)` is an anchor — the physical position
 * the strip is standing on and the walk index it shows — and both move together on every press.
 * Because titles are counted FROM that anchor, a row growing under the walk ("load more") changes
 * nothing in the window: the card under the billboard keeps its title and the cards ahead of it
 * simply become the titles that just arrived, which is what the old code needed a layout-effect
 * re-seat to achieve.
 *
 * WHAT IS NOT DIFFERENT, because the brief is that nothing visible changes: the tile geometry
 * (`--sp-wp`, `--sp-gap`, `--active` and the strip's transform in tv.css are untouched), the slide
 * and its curve, which tiles carry a bitmap (the window IS the old THUMB_BEHIND/THUMB_AHEAD
 * promotion window, so the same dozen posters are decoded at any moment), the idle-frame promotion
 * that keeps decodes off the keypress frame, and the peek at the screen edge. The one visible
 * change is an improvement the old notes asked for: a press off the end card glides forward onto
 * title 0 instead of hopping.
 *
 * THE WINDOW'S SHAPE. Two behind, because walking back must not fetch: the tile the walk is about
 * to return to has to be decoded before it slides out from behind the billboard, and two presses
 * of runway is enough at any pace a remote can produce. Nine ahead, the same runway the bitmap
 * window always had — at ~300ms a press that is about three seconds of walking, and a poster is
 * ~30 KB from a CDN that answers in 90ms. Tiles further behind than two are clipped by the rail's
 * `clip-path` and never seen, so dropping them costs nothing visible; when the walk comes back for
 * one it is mounted three presses before it can appear, and a cached picture decodes in far less.
 *
 * KEYS AND POSITIONS ARE BOUNDED SEPARATELY. React keys are `p mod TILE_KEYS` joined to the
 * title's id, so a node keeps its identity for as long as its position shows the same title and
 * remounts (plate, then fade-in — the old behaviour for a new picture) the moment it does not.
 * The physical position itself is left to grow, because rebasing it is what made the old strip
 * hop; but it is not left to grow FOR EVER. The compositor stores a layer's offset in single
 * precision, and at a few million pixels that is a quarter-pixel of quantisation. So once the
 * walk has taken REBASE_AT presses without leaving the row, and only while the row is at rest,
 * the position is brought back by a whole multiple of TILE_KEYS. Every key survives (the modulus
 * is the same multiple), every title survives (the anchor moves with it), and `--active` is
 * rewritten with the transition suppressed — the same silent hop the old wrap used, now once per
 * ~2000 presses instead of once per lap. */
const TILES_BEHIND = 2;
const TILES_AHEAD = 9;
const TILE_KEYS = 1024;
const REBASE_AT = 2 * TILE_KEYS;
/** Always-positive modulo, so a physical position left of the origin still maps to a title. */
const mod = (a: number, m: number): number => ((a % m) + m) % m;
/** Where a tile at physical position `p` sits in the strip, as CSS — the strip's own pitch, plus
 *  the room left for every end card before it (`ends` of them). An end card is a poster with a stack
 *  of cards standing after it (see THE END CARD in tv.css), so everything past one sits that much
 *  further right; the strip's own transform takes the same amount off for each one the walk has
 *  passed (`--ends`, written by putActive). */
const tileLeft = (p: number, ends = 0): string => (ends
  ? `calc(${p} * (var(--sp-wp) + var(--sp-gap)) + ${ends} * var(--sp-end-extra))`
  : `calc(${p} * (var(--sp-wp) + var(--sp-gap)))`);
/** How many end cards stand before physical position `p`, when they stand at every position
 *  congruent to `endAt` (mod `stops`). Counted from the one at `endAt` itself, so the value can be
 *  zero or negative to the left of it — only differences matter, since the tiles and the strip
 *  both subtract the same count. */
const endsBefore = (p: number, endAt: number, stops: number): number => Math.floor((p - endAt - 1) / stops) + 1;

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
/** How long the remote must have been still, on a card, before its title screen is made ready (see
 *  `warmDetail`). Longer than a vertical press's scroll (~450ms) and the row's focus commit, so the
 *  warm's requests and decodes cannot land in the frames of the move that reached the card. */
const DETAIL_WARM_MS = 900;
/** How long the remote must have been still on a row before the rest of its titles are fetched
 *  (`onOpen` — TvHomeRow's catalogue page). Same reasoning: not inside the next press's scroll. */
const OPEN_FETCH_QUIET_MS = 900;
/** How long the remote must have been still before the row it is on takes its compositor layers and
 *  the row it left gives them up (`primeSoon`): past the end of a vertical press's scroll (~450ms). */
const PRIME_QUIET_MS = 600;
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
/* ---- HOW MUCH TO MAGNIFY A PREVIEW, WHICH DEPENDS ON WHAT IT IS ------------------------------
 *
 * IMDb encodes every trailer into a 16:9 container, so what arrives depends on how the thing was
 * shot, and the two cases want opposite treatment:
 *
 *   LIVE ACTION IS USUALLY SCOPE. A 2.39:1 image inside a 1.78 frame fills 1.78/2.39 = 74.4% of
 *   the height and the remaining quarter arrives as black bands — as PICTURE CONTENT, pixels in
 *   the file, which no object-fit can reach. 1/0.744 = 1.345, so 1.35 removes exactly those bands.
 *
 *   ANIME IS USUALLY 16:9 ALREADY. There are no bands to remove, and 1.35 would simply throw away
 *   a third of the frame — which is what it was doing.
 *
 * WHY GENRE AND NOT SOMETHING BETTER. The honest answer is that nothing better is available here:
 * the file is cross-origin, so its pixels cannot be read, and `videoWidth`/`videoHeight` report the
 * 16:9 CONTAINER in both cases — the bands are inside the picture, so the dimensions are identical
 * whether they are there or not. Genre is a proxy for how something was shot, and a decent one.
 *
 * WHERE THE PROXY IS WRONG, stated so it is recognised rather than rediscovered: a Western animated
 * FEATURE (Pixar, Illumination) is tagged Animation and is usually scope, so it will keep its
 * bands. Narrow this to `type` series as well if that turns out to matter more than anime films
 * losing their framing — both are one predicate, and neither is measurable from here. */
const TRAILER_CROP_LETTERBOXED = 1.35;
const TRAILER_CROP_NATIVE = 1;

/** True when a title is animated, which here means "probably framed 16:9 and not letterboxed".
 *  Both shapes are handled because the feeds disagree: /api/home sends `genre` as a single string,
 *  the typed model carries `genres` as an array, and an item can arrive with either. */
function isAnimated(it: MediaItem | null | undefined): boolean {
  if (!it) return false;
  const hit = (s: unknown) => typeof s === 'string' && /animation|anime/i.test(s);
  const bag = it as MediaItem & { genre?: string | string[] };
  if (Array.isArray(bag.genres) && bag.genres.some(hit)) return true;
  if (Array.isArray(bag.genre) && bag.genre.some(hit)) return true;
  return hit(bag.genre);
}

/* ---- THE DELIBERATE PRESS HAS NO DRIFT AT ALL, AND THAT IS A MEASUREMENT ---------------------
 *
 * `BILLBOARD_PARALLAX = '3.2%'` LIVED HERE and drove an `Element.animate` on every considered
 * press. It was justified by a frame-by-frame reading of the reference — "24px of travel on a
 * 753px card" — and a clean 1080p30 capture of the same interface does not reproduce it.
 *
 * THE METHOD MATTERS, because the obvious one cannot answer this. Consecutive-frame correlation
 * measures the CROSS-DISSOLVE, not the drift: the picture is changing, so the best-matching offset
 * between two frames is a property of two different photographs. Each frame has to be correlated
 * against the SETTLED frame instead. Done that way, across the three clean presses in the clip:
 *
 *   press A (t=126.87s)   +18.9, +11.9, +7.1, +0.46, +0.28, +0.10, 0   px
 *   press B (t=128.23s)    -0.1,  -0.06, +0.04, +0.07, +0.05, +0.02, 0
 *   press C (t=136.13s)     0,    -0.03, -0.03, -0.07, -0.12, -0.18, 0
 *
 * TWO OF THREE ARE FLAT TO A TENTH OF A PIXEL. The third shows ~19px, but only across the two
 * frames where the dissolve is still mixing two pictures — which is exactly where this measurement
 * is least trustworthy — and it is under half a pixel by 100ms. A 3.2% drift (~29px on the 902px
 * card in this capture) running the full length of the slide would be plainly visible at 133ms and
 * 167ms in all three. It is not there.
 *
 * So the reference's billboard cross-dissolves IN PLACE, and every horizontal movement on the
 * screen belongs to the poster strip. The drift on a deliberate press is gone with the constant.
 *
 * WHAT IS KEPT, AND WHY IT IS NOT A CONTRADICTION: the HELD drift below. The clip contains no held
 * key anywhere in its 266 seconds — 53 strip movements, every one a discrete press, the closest
 * pair 633ms apart — so it cannot speak to that case either way, and the small fast drift a hold
 * gets was asked for on its own merits. It is un-referenced rather than contradicted.
 *
 * ---- AND WHAT A HELD KEY GETS, WHICH IS A SHORTER VERSION OF A MOVE NOTHING ELSE MAKES NOW ----
 *
 * A hold used to get no drift at all, and the note on the effect below records exactly why: the
 * animation RESTARTS on every press, so at ~8 presses a second the artwork was yanked back to its
 * 3.2% offset and released again — measured on the television at 69 jumps over 8px in 12.6 seconds,
 * up to 62px each. That is not a settle, it is a shudder, and suppressing it was right.
 *
 * IT IS THE OVERLAP THAT SHUDDERS, NOT THE DRIFT. An animation that is still running when the next
 * press restarts it is discarded from wherever it happened to be; one that has FINISHED is sitting
 * at zero offset, and restarting from zero is the same thing a deliberate press does. So the fix is
 * not to remove the movement, it is to size it so it completes inside one press — which is now
 * possible only because HELD_STEP_MIN_MS paces a hold at 300ms rather than 120ms.
 *
 * TWO NUMBERS, BOTH FALLING OUT OF THAT PACE:
 *
 *   180ms, comfortably inside 400ms with room for a repeat that arrives a frame early, so each
 *   drift is done before the next one starts and the picture is never pulled backwards.
 *
 *   1.6%. There is no longer a "deliberate distance" for this to be half of — see above — so it
 *   stands on the pace alone: a hold covers ground fast, and a drift big enough to notice on a
 *   card that is replaced every 400ms is a drift that draws the eye off the posters. Small and
 *   over quickly is the whole brief.
 *
 * LINEAR, for the reason the strip is linear while held (see HELD_SLIDE_MS): a decelerating curve
 * makes a hold read as a sequence of little arrivals. The strip glides at constant velocity during
 * a hold and the artwork glides with it. */
/* (THE DRIFT'S DISTANCES AND DURATIONS — 3.2% over 300ms for a press, 1.6% over 180ms linear for a hold —
 * LIVE WITH THE CODE THAT RUNS THEM NOW: lib/tvRowStage.ts.) */

/* ---- HOW LONG THE STRIP TAKES TO MOVE ONE CARD. Reasoning is at `step`. -------------------- */
/** A deliberate press. MEASURED OFF A CLEAN 1080p30 CAPTURE, three presses identical to the frame:
 *  116, 81, 54, 35, 21, 12, 6, 3, 1 px — 329px, which is one poster pitch, over 8 frames = 267ms.
 *  The curve that reproduces it is `cubic-bezier(.33,1,.68,1)`, a cubic ease-out, fitted at 1.30%
 *  RMS against the nine points; the full table of what else was tried, and the account of the two
 *  values that shipped before this one (430ms quadratic, then 230ms quintic), is on the strip's
 *  `transition` in tv.css. MOVE THE TWO TOGETHER — a duration without its curve is how the last
 *  pair went wrong. */
/* SLIDE_MS and HELD_SLIDE_MS are imported from lib/tvRowStage.ts, where the press that uses them runs. */

/* ---- THE TWO ART LAYERS DO NOT TRADE PLACES SYMMETRICALLY ------------------------------------
 * The outgoing picture collapses in its first two frames and keeps a long tail; the incoming one
 * rises evenly. Composited as stacked siblings their opacities do not sum to 1, so the billboard
 * passes through a dark trough — bottoming at 0.59 against 0.75 for the symmetric pair this
 * replaces. That asymmetry IS the transition — the full measurement, and the two wrong answers it took to find it, are on
 * `.tv-spot-layer` in tv.css.
 *
 * A HELD KEY GETS NEITHER — it gets a symmetric 90ms, for the reason ART_FADE_MS_CHAINED exists:
 * neither duration fits inside the 300ms of a held press, and a trough repeated four times a
 * second is a flicker rather than a beat.
 *
 * (SUPERSEDED: the pair of layers no longer fade against each other at all — see the stage's
 * LAYER_IN_MS and the `.tv-spot-layer` note in tv.css. What is recorded here is why the asymmetric
 * pair existed; the cost of keeping it is why it does not.) */
/* ---- THE SPRING ARM'S TWO CONSTANTS ----------------------------------------------------------
 * Critically damped: c = 2*sqrt(k), so the strip settles without ever crossing its target. A row
 * that overshoots and comes back is the one thing a poster strip must not do — the card under the
 * focus would change twice for one press.
 *
 * TUNED TO THE MEASUREMENT, not to taste. For a critically damped spring the remaining distance is
 * (1 + wt)e^-wt, which reaches 1% at wt = 6.64; the reference settles one card in 267ms, so
 * w = 6.64/0.267 = 24.9, k = w^2 = 620 and c = 2w = 50. It half-travels in 67ms against the
 * reference's measured 53ms — close, and closer than any of the curves suggested for it.
 *
 * Only read when `springEnabled()`; the shipped transition arm ignores both. */
/* (THE SPRING ARM IS GONE. It was an experiment, off by default, that drove the strip from a rAF loop;
 * a main-thread write per frame is the one thing the press path no longer does. The measurement that
 * ruled it out is the paragraph above, and `springEnabled` is still exported from tvMotionFlags.) */

/* A genuine overlap: the previous billboard remains readable while the next one rises through it.
 * Equal clocks avoid the hold-then-cut produced by the old asymmetric pair. */
/* SLIDE_MS_CHAINED IS GONE, and what replaced it is the point. It was 320ms of the same
 * decelerating curve — "roughly half, so a hold keeps up without the curve losing its shape". The
 * curve was the problem: keeping its shape is what made a hold read as a sequence of arrivals
 * rather than one movement. A held key now uses HELD_SLIDE_MS with linear timing instead; a
 * deliberate press is unchanged and still uses SLIDE_MS. */
/** Under this gap between presses, the remote is being held rather than tapped. */
/* Raised with the pace (see HELD_STEP_MIN_MS): it has to sit comfortably ABOVE the pace or a
 * held press lands outside the window and takes the deliberate path.
 *
 * IT USED TO BE THE WHOLE TEST, AND THAT WAS THE BUG. The window was picked to sit "comfortably
 * below a real deliberate press (~900ms)", which is an assumption about how fast a person taps,
 * and it is wrong: press Right twice in under half a second — which anyone walking a row does —
 * and the second press was read as a hold. It got the linear glide, it got the decoration
 * stripped off, and worst of all it was DROPPED outright if it landed inside HELD_STEP_MIN_MS,
 * so the row both slid when it should have stepped and ignored presses while doing it.
 *
 * The window is still here and still right; it is just no longer sufficient on its own. A press
 * now has to be recent AND arrive while the button is still down — see `heldKey` below. */
const SLIDE_CHAIN_WINDOW = 400;

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
 * Deliberately below SLIDE_CHAIN_WINDOW (400ms), so an accepted held step still counts as chained
 * and keeps the fast slide, the suppressed decoration and the `is-fast` class. */

/* ---- MEASURED ON THE 65UT8100, 2026-08-19 ---------------------------------------------------
 * Driving synthetic presses at a fixed gap emulates this pace exactly, because the limiter only
 * ever DROPS presses that arrive sooner — drive slower than it and every one lands, so the gap IS
 * the pace. Both arms therefore ran against one binary. Four rounds, axis order reversed each
 * round, idle control 100%% on-time in all four:
 *
 *   HORIZONTAL   on-time / frames over 67ms      VERTICAL     on-time / frames over 67ms
 *     240ms        54.6%% / 33.3                   240ms         57.5%% / 14.8
 *     300ms        62.9%% / 12.5                   300ms         79.6%% /  5.3
 *
 * 300 won every round on both axes. Vertical, the worse axis, gained 22 points of on-time and lost
 * two thirds of its bad frames; median input latency fell with it (61ms -> 8ms in round one).
 *
 * It costs traversal speed — a row walks 36%% slower — which is the trade, and roughly the pacing
 * a viewer already recognises from other ten-foot apps.
 *
 * THE THREE CONSTANTS MOVE TOGETHER OR THE GLIDE BREAKS. The pace was measured against the OLD
 * slide and chain window, where a 300ms gap left a 260ms slide finishing early and stalling — the
 * stepping this file's own note warns about — and sat only 20ms under the chain window, so jitter
 * would drop a held press into the deliberate path mid-walk. Both are corrected below. */
/* BACK TO THE MEASURED 300. This was 400 "by preference over the measured 300" — a taste call
 * made against the round above, and the taste turned out to be wrong on the set: a hold at 400ms
 * is two and a half posters a second, and it reads as the row dragging its feet. 300 is a third
 * faster, it is what the four rounds above actually chose, and it is where this sat one commit
 * before the preference was applied.
 *
 * 300 IS ALSO THE FLOOR, and that is the half worth keeping in view. The round below it was
 * measured, not guessed: 240ms cost 8 points of on-time horizontally and 22 vertically, and
 * tripled the frames over 67ms on the horizontal axis. So if a hold still reads as slow, the next
 * step down is not free and should be measured on the panel rather than tuned by feel. */
const HELD_STEP_MIN_MS = 300;

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
/* HELD_SLIDE_MS (340ms — a little LONGER than the 300ms pace, per the note above) is in lib/tvRowStage.ts. */

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
 * The full reasoning is on the swap gate; what this number has to satisfy is that even a capped-out
 * swap begins while the strip is STILL MOVING, so the press stays one gesture — 200 against a
 * 267ms slide, with the 170ms dissolve then finishing after the strip has settled.
 *
 * THE OLD NOTE HERE CLAIMED "comfortably under half of SLIDE_MS" AND WAS NEVER TRUE: half of the
 * 230ms slide it was written against is 115ms. The rule it states is a stricter one than the
 * behaviour needs, and it is the behaviour that has always been correct — recorded rather than
 * quietly fixed, because "under half" is the kind of invariant someone later enforces. */
/* 200 -> 260 (2026-09-23): on the 65UT8100 pictures decode slower than on a PC, and a swap that
 * capped out before its picture was ready dissolved to the placeholder and then popped the photo in
 * with no drift — the "skips its animation" the user saw when pressing fast. 260 is still under the
 * 267ms slide, so the rule above holds, and taps are now paced at TAP_STEP_MIN_MS (300) so the extra
 * wait always fits between two steps. */
const SWAP_WAIT_CAP = 260;

/* ---- TAPS WALK AT A STEADY PACE, LIKE A HELD KEY — AND LIKE THE REFERENCE ----------------------
 * Spam Right on Netflix and the row does not try to follow every press: it steps at an even rate
 * and the extra presses simply ride along. This row used to take every tap the moment it arrived,
 * so fast tapping cancelled each drift, dissolve and copy arrival part-way and the billboard jumped
 * between titles instead of moving — and on the set, where pictures decode slower, the swap often
 * outran its own picture.
 *
 * So a tap closer than this to the last step is NOT dropped (a deliberate press must never be lost —
 * see the note on `chained` in `step`); it is held and taken the moment the pace allows. Only ONE is
 * ever held: further taps inside the window replace its direction rather than queueing more steps,
 * so letting go stops the row at once instead of letting a backlog play out. Same number as
 * HELD_STEP_MIN_MS, measured best on the set, so a tapped walk and a held walk go at one speed. */
const TAP_STEP_MIN_MS = HELD_STEP_MIN_MS;


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
/* ART_FADE_MS (110) and ART_FADE_MS_CHAINED (90 — comfortably inside the ~120ms of a held key, so each
 * card completes before the next arrives) are in lib/tvRowStage.ts. */

/* Elements the warm-ahead has already asked to decode. It used to be a Set of URLS that latched
 * for the life of the page — which, once the warm started RETAINING into a 10-entry LRU, meant a
 * picture evicted from that LRU was never warmed again: walk a row forward and back and every
 * billboard on the way back was cold. Keyed on the ELEMENT instead, so an evicted URL comes back
 * as a new element and is warmed like a new one, and a retained one is not decoded twice. */
const warmDecoded = new WeakSet<HTMLImageElement>();

/* Renditions sized to what is painted, not to the source. The billboard is 16:9 of a <=380px
 * row (~675px wide) and thumbs paint at ~228px — see the note in lib/hero.ts for why reaching
 * for `original` on a TV is fatal rather than merely wasteful. */
/* ONE RENDITION FOR BOTH ROLES, and it has to be sized for the harder one.
 *
 * A poster tile shows only 34.6% of a 16:9 backdrop's width (0.615 / (16/9)), so
 * whatever this is, the tile gets about a third of it. At the w342 the strip used
 * to fetch that was 118px of actual poster width in a slot 313 CSS px wide — which
 * is what "the poster looks poor and the billboard looks fine" was: the billboard
 * shows the whole frame, the tile shows a third of it.
 *
 * Sharing is also only real if both ask for the SAME url. Two renditions would mean
 * two files, two cache entries and two decodes for one picture. */
/* w780, AND SMALLER WAS TRIED ON THE SET. w500 (0.56MB decoded per title against 1.4MB) shipped in
 * e8dab1d and was reverted the same day on the user's verdict from the 65UT8100: "nothing changed on
 * smoothness but quality is very bad". Picture size is not what the stutter is made of — together
 * with the RETAIN_MAX experiment (decode cut 85%, frames unmoved) that is two results saying so.
 * Do not shrink this again to chase frames. */
const BILLBOARD_RENDITION = 'w780';
const THUMB_RENDITION = 'w342';
/** Wordmarks paint at 201px wide at most on the billboard; w500 was 2.5x that. */
const LOGO_RENDITION = 'w300';

/* ---- ONE PICTURE PER TITLE, AND THE BAKED CROP IS ONLY A POSITION IN IT --------------------------
 * The add-on rows glided and the movie rows did not, and the difference was not the rows: on an
 * add-on row the billboard IS the tile's picture — one URL, decoded nine tiles ahead by the strip's
 * own promotion — so the swap gate always found it in hand. A row with baked art held TWO pictures
 * per title, the pre-cut portrait slice for the tile and the 16:9 backdrop for the billboard, and
 * every press asked for the one the strip had never touched.
 *
 * The slice was never a different picture. `/crop` cuts a full-height, tile-shaped window out of
 * the w1280 of this same backdrop, positioned by the number in its URL (`f4231` = 42.31% of the way
 * across — art.js `travelFraction`), and that number means exactly what CSS object-position means.
 * So the tile shows the backdrop itself at that position: framed identically, and now the same
 * file, the same cache entry and the same decoded bitmap as the billboard — which is what makes a
 * movie row behave like an add-on row.
 *
 * BILLBOARD_RENDITION (w780), BY CHOICE, NOT w1280. At w1280 the tile's 34.6% slice is 443 source
 * pixels — exactly what the pre-cut had — and at w780 it is 270, a little softer on a 626px box.
 * w500 (173) went too far and was reverted. w1280 is still one key away (`groloo.tvart=shared1280`).
 *
 * Only when the crop really is a slice of THIS backdrop: the file named in the crop URL has to be
 * the backdrop's file. Anything else — no crop, a crop of another frame — renders as before. */
/* ---- EXPERIMENT ARM: `localStorage['groloo.tvart']` — WHICH PICTURES A TILE AND BILLBOARD USE --
 * One picture per title fixed the billboard swap but made each tile's bitmap 1280x720 (3.7MB) where
 * the pre-cut was 640x1040 (2.7MB), and GPU is what the 65UT8100 runs out of first. Whether the
 * shared picture's swap outweighs its texture cost is a question only the set can answer, so the
 * candidates are one key apart and can be run interleaved by scripts/tv-measure.mjs (`--ls`):
 *   (unset)     one picture at BILLBOARD_RENDITION (w780) — THE DEFAULT: 1.4MB per title where
 *               w1280 was 3.7MB; w500 was tried and rejected on the set, see BILLBOARD_RENDITION
 *   shared1280  one picture, w1280 — tile crops it in CSS at the pre-cut's own 443px of source
 *   crop        two pictures: the w640 pre-cut tile + a w780 billboard (before 70992e4)
 *   crop320     two pictures: a w320 pre-cut tile (1/4 of the pixels) + a w780 billboard
 * Read once: a TV does not change arms mid-session, and a per-tile read would be storage I/O per card. */
const TV_ART: '' | 'shared1280' | 'crop' | 'crop320' = (() => {
  try {
    const v = localStorage.getItem('groloo.tvart');
    return v === 'shared1280' || v === 'crop' || v === 'crop320' ? v : '';
  } catch { return ''; }
})();
const SHARED_RENDITION =
  TV_ART === 'shared1280' && typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5
    ? 'w1280' : BILLBOARD_RENDITION;
/** The pre-cut size the `crop` arms ask for; the default follows the screen (artSize). */
const CROP_SIZE = TV_ART === 'crop320' ? 'w320' as const : undefined;
function sharedArtOf(it: MediaItem): PeekArt | null {
  if (TV_ART === 'crop' || TV_ART === 'crop320') return null;
  const cut = it.posterArt;
  if (!cut || !it.backdrop) return null;
  const m = /\/crop\/w\d+\/f(\d+)\/([A-Za-z0-9]+)\.webp/.exec(cut);
  if (!m || !it.backdrop.includes(`/${m[2]}.`)) return null;
  const travel = Math.min(10000, Number(m[1])) / 100;
  return { src: imgW(it.backdrop, SHARED_RENDITION), pos: `${travel.toFixed(2)}% 50%` };
}

/** What the peek at the screen edge shows: a picture and where to sit it in the tile's
 *  box. Same choice the tile makes, so the card you walked past keeps the artwork it
 *  had rather than reverting to TMDB's poster on its way out. */
type PeekArt = { src: string; pos: string };
const EMPTY_PEEK: PeekArt = { src: '', pos: '50% 50%' };
function peekArtOf(it: MediaItem): PeekArt {
  const one = sharedArtOf(it);
  if (one) return one;                                // the billboard's own picture
  const cut = artW(it.posterArt, CROP_SIZE);
  if (cut) return { src: cut, pos: '50% 50%' };      // already the tile's shape
  const shared = imgW(it.backdrop || '', BILLBOARD_RENDITION);
  if (shared) return { src: shared, pos: artPosition(it.artFocusX as number | null) };
  return { src: imgW(it.poster || '', THUMB_RENDITION), pos: '50% 50%' };
}

/** A tile's picture, its one fallback, and where to sit it — the Tile's choice, in one place so the
 *  prefetch below asks for exactly the URL the tile will. */
function tilePictureOf(it: MediaItem): { src: string; fallbackSrc: string; pos: string; own: boolean } {
  /* THE BILLBOARD'S OWN PICTURE FIRST — see `sharedArtOf`. The pre-cut slice is now the fallback
   * for when that one fails to load, which is the role the backdrop used to play for it. */
  const one = sharedArtOf(it);
  const cut = one ? '' : artW(it.posterArt, CROP_SIZE);
  const shared = one ? '' : imgW(it.backdrop || '', BILLBOARD_RENDITION);
  return {
    src: one?.src || cut || shared || imgW(it.poster || '', THUMB_RENDITION),
    fallbackSrc: one ? artW(it.posterArt, CROP_SIZE) : cut ? (shared || '') : (shared ? imgW(it.poster || '', THUMB_RENDITION) : ''),
    // A pre-cut slice is already the tile's shape, so there is nothing left to pan.
    pos: one ? one.pos : cut ? '50% 50%' : (shared ? artPosition(it.artFocusX as number | null) : '50% 50%'),
    // Our own artwork (not TMDB's lettered poster), so the tile names it — see `name` in Tile.
    own: !!(one || cut || shared),
  };
}

/** The billboard's picture for a card. On an `enrich` row a poster is not a stand-in for a
 *  backdrop that has not arrived — see the note on `billboardUrl`, which is this gated on `artOn`. */
function billboardSrcOf(it: MediaItem, enrich: boolean): string {
  /* The picture the tile under it is already showing, when there is one — see `sharedArtOf`. */
  const one = sharedArtOf(it);
  if (one) return one.src;
  /* `enrich` withholds the poster only while a backdrop could still ARRIVE — and enrichment can
   * only look up a title by an id our API speaks. An add-on's own title (a Continue Watching
   * entry from a third-party catalog) has none, so nothing is coming: holding out for a backdrop
   * left it a permanent grey panel. Its poster is the only picture there is, so it is used. */
  const waiting = enrich && !!apiIdOf(it);
  const source = waiting ? it.backdrop : (it.backdrop || it.poster);
  return imgW(source || '', BILLBOARD_RENDITION);
}

/* THE SOUND BADGE'S TWO ICONS, from the Groloo 3D set (components/glance) — the same cobalt
 * speaker the title screens and post-play use, its arcs lit when the preview has sound and a violet
 * cross when it has not. One shared sprite cell each: nothing here draws per frame. Sized in em off
 * the badge's font-size in tv.css. */
const IcSoundOn = <span className="ic3"><GlanceIcon name="soundOn" /></span>;
const IcSoundOff = <span className="ic3"><GlanceIcon name="soundOff" /></span>;

/* ---- ONE POSTER TILE, MEMOISED SO A PRESS TOUCHES ONE OF THEM ----------------------------------
 * The strip used to be one `useMemo` holding every tile, built so a focus change could not rebuild
 * it. The window rebuilds on every press by design — that is how a tile enters at one edge and
 * leaves at the other — so the cost has to be bounded per TILE instead: `memo`, and props that are
 * primitives or stable references, so the ten tiles that merely stayed in the window bail out of
 * rendering entirely and React's work per press is one mount, one unmount, and eleven identity
 * checks. `onOpen` is a stable function the row keeps in a ref, never the caller's own callback,
 * because Home hands every row a fresh closure per render and that would re-render every tile.
 *
 * Everything written to the NODES here — `src` promotion, the `rdy` class, the plate being cleared
 * under a loaded picture — is deliberately outside React's knowledge (see the notes on `data-src`
 * below), which is safe precisely because a tile is never re-rendered with different props: a node
 * is created for one title at one position and destroyed with it. */
interface TileProps {
  item: MediaItem;
  /** The tile's `left`, as CSS — see `tileLeft`. Fixed for the life of the node. */
  left: string;
  /** Watch progress, 0..1, or 0 when the row does not show one. A primitive, so memo can compare it. */
  pct: number;
  onOpen: (it: MediaItem) => void;
}

const Tile = memo(function Tile({ item: it, left, pct, onOpen }: TileProps) {
  /* ONE PICTURE, SHOWN TWICE. The tile crops the same backdrop the billboard
   * above it displays, so the two are one entry in the browser cache and one
   * decoded bitmap in memory — which on a screen holding ~147 tiles is the cost
   * that actually matters.
   *
   * The crop is `object-fit: cover` plus an object-position derived from the
   * face detector's focal point; the wordmark and its scrim are elements over
   * the top. Nothing is composited on a server any more, so correcting a poster
   * changes a NUMBER in this payload rather than a cached picture — which is
   * why an edit takes effect on the next load instead of outliving three caches.
   *
   * `poster` stays as the onError fallback: a title with no backdrop at all
   * still renders what this row rendered before any of this existed. */
  /* (Before `sharedArtOf`) PRE-CUT IF WE HAVE ONE, otherwise crop the shared backdrop here.
   *
   * `posterArt` is the slice already cut to the tile's shape — exactly the pixels
   * shown, so it is both sharper and smaller than fetching the whole frame to
   * discard two thirds of it. Its url contains the crop, so a correction is a new
   * url and nothing needs invalidating.
   *
   * Falling back to the shared backdrop is not a degradation to paper over: it is
   * how a title with no focal point yet, or one whose crop we declined, renders —
   * the same picture, cropped by object-fit, at lower detail. */
  const { src, fallbackSrc, pos: objectPosition, own } = tilePictureOf(it);
  const mark = imgW(it.titleLogo || it.logo || '', LOGO_RENDITION);
  /* A PICTURE ALREADY DECODED IS TAKEN AT ONCE. The row's warm-ahead (`warmNow`) keeps the cards ahead of
   * the walk decoded in the shared cache, and a tile is the same file: there is nothing left to defer,
   * so it mounts with its `src` rather than waiting for the next idle moment's promotion — which on a
   * set busy with a walk could be most of a second, the posters-arriving-late a viewer sees at the
   * right-hand edge. Already `rdy`, so a new element has no fade to run. */
  const warmPic = !!src && retainedReady(src);
  const warmMark = !!mark && retainedReady(mark);
  /* What names this tile: its wordmark, its title in type, or nothing at all when it
   * has fallen back to a plain poster that already carries its own. */
  const name: 'mark' | 'text' | null = mark ? 'mark' : (own ? 'text' : null);
  return (
    <button
      type="button"
      role="listitem"
      tabIndex={-1}
      className="tv-spot-thumb"
      style={{ left, background: heroFallbackGradient(it) }}
      aria-label={it.title}
      onClick={() => onOpen(it)}
    >
      {/* `data-src`, NOT `src` — the promotion effect in the row decides when a tile is worth a
          bitmap, and it does so on an idle frame rather than on the press that mounted the tile.
          See the note there; `loading="lazy"` cannot do this job.

          THE GRADIENT IS DROPPED THE MOMENT THE POSTER COVERS IT. It is the plate a tile shows
          while it has no picture, and it was staying underneath one forever: measured on a
          settled home screen, 106 of 147 tiles were painting a gradient beneath a fully opaque
          poster, so every repaint of a row filled each of those rects twice. Cleared straight
          on the node rather than through state — a setState per poster load would re-render a
          tile for a change no one can see. */}
      {src && (
        <img
          className={warmPic ? 'tv-spot-thumbimg rdy' : 'tv-spot-thumbimg'}
          src={warmPic ? src : undefined}
          data-src={warmPic ? undefined : src}
          decoding="async"
          style={{ objectPosition }}
          alt=""
          /* NOT `useImageReady` HERE, and that is deliberate rather than an oversight. These
             carry `data-src` because a home screen holds ~150 of them and they are fetched
             lazily; a hook would preload every one on mount and undo the memory work the
             comment above describes. `load` is the weaker guarantee (bytes, not bitmap) but a
             228px portrait has no visible band to hide — the fade is here so a tile arrives
             rather than pops, which is all this size of picture needs.
             Both writes go straight to the nodes for the same reason the background clear
             does: a tile must not re-render for a poster load. */
          onLoad={(e) => {
            const img = e.currentTarget;
            const t = img.parentElement;
            if (t) t.style.background = 'none';
            img.classList.add('rdy');
          }}
          /* One retry, onto the ordinary poster, and then never again — `dataset.fell`
             latches so a poster that is ALSO broken cannot ping-pong the two URLs. The
             art service is a separate deploy from this app: if it is down, or was never
             stood up, every tile quietly renders what it renders today. */
          onError={(e) => {
            const img = e.currentTarget;
            if (!fallbackSrc || img.dataset.fell) return;
            img.dataset.fell = '1';
            img.src = fallbackSrc;
          }}
        />
      )}
      {/* The wordmark and the darkening that keeps it readable, drawn only when a
          mark exists — and when it does not, the title is SET IN TYPE in the same
          place rather than left off, so no tile is ever nameless. That covers three
          cases at once: a title TMDB has no wordmark for at all, one whose wordmark
          the page's budget has not resolved yet (it arrives on a later load), and an
          add-on card that never had one.

          NOT text-first-then-logo. The billboard settled that already — swapping type
          for a wordmark a beat later is the same flicker the backdrop had — so a tile
          shows one or the other and never both in turn.

          AND ONLY OVER OUR OWN ARTWORK. When a tile has fallen all the way back to the
          plain TMDB poster, that poster already has the title printed on it, so setting
          it again in type would print it twice. `data-src` for the same reason the picture
          uses it: the promotion effect promotes these, so a row never fetches a dozen at once. */}
      {/* The scrim exists to make a NAME legible, so it paints only when there is one.
          Rendering it unconditionally put a gradient over every tile that shows neither
          — a plain TMDB poster carries its own title and needs no help. */}
      {/* No scrim span: no gradient over any picture on the browse pages (tv.css, where the
          `.tv-spot-thumbscrim` rule used to be). */}
      {name === 'text' && (
        <span className="tv-spot-thumbtitle" aria-hidden="true">{it.title}</span>
      )}
      {!!mark && (
        <img
          className={warmMark ? 'tv-spot-thumbmark rdy' : 'tv-spot-thumbmark'}
          src={warmMark ? mark : undefined}
          data-src={warmMark ? undefined : mark}
          decoding="async"
          alt=""
          onLoad={(e) => e.currentTarget.classList.add('rdy')}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      {pct > 0.01 && <span className="tv-spot-progress" aria-hidden="true"><i style={{ width: `${(Math.min(pct, 1) * 100).toFixed(1)}%` }} /></span>}
    </button>
  );
});

/* The row's last stop: "see all" or "+ load more". Same window, same absolute position; its
 * label changes while a batch is in flight, which is the one prop that legitimately re-renders it. */
interface EndTileProps {
  left: string;
  label: string;
  icon: string;
  heading: string;
  /** A batch is in flight: the ring around the icon turns into a spinner. */
  busy: boolean;
  onGo: () => void;
}

const EndTile = memo(function EndTile({ left, label, icon, heading, busy, onGo }: EndTileProps) {
  return (
    <button
      type="button"
      role="listitem"
      tabIndex={-1}
      className={`tv-spot-thumb is-seeall${busy ? ' is-busy' : ''}`}
      style={{ left }}
      aria-label={`${heading} — ${label}`}
      onClick={onGo}
    >
      {/* A poster-sized front card with three more standing after it, on the right — "there are
          more of these" — and the light running down them. Back to front, so each paints over the
          one behind. The stack stands outside the tile's box, in room the strip leaves for it (see
          tileLeft). On the billboard only the front card is drawn (endFront in tvRowStage): this
          tile is then the one under the billboard, and its stack shows past the billboard's edge. */}
      <span className="tv-end-stack" aria-hidden="true">
        <span className="tv-end-back is-3"><span className="tv-end-glint" /></span>
        <span className="tv-end-back is-2"><span className="tv-end-glint" /></span>
        <span className="tv-end-back is-1"><span className="tv-end-glint" /></span>
        <span className="tv-end-front">
          <span className="tv-end-sheen" />
          <span className="tv-end-ring"><span className="tv-spot-blank-ic">{icon}</span></span>
          <span className="tv-spot-blank-label">{label}</span>
        </span>
      </span>
    </button>
  );
});

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
  /** Fired when the remote first settles on this row, and on every settle after. A row whose titles
   *  are not all in hand yet uses it to go and get the rest (TvHomeRow) — see the effect below for
   *  why this is the trigger rather than mount or visibility. */
  onOpen?: () => void;
}

/* WHAT THE BILLBOARD IS SHOWING. A row walks its titles and then one stop past them, onto its own
 * category page or onto more of itself — so the thing on the billboard is a title OR that final
 * card, and both the cross-dissolve and the strip have to be able to hold either. */
type Slot = MediaItem | 'end';

/** What the stage shows for a stop that is not there (no title, no end card). */
const NO_SLOT: StageSlot = {
  key: 'none', kind: 'none', bgUrl: '', fallback: '', bgPos: '50% 50%', logoUrl: '', title: '',
  progress: 0, endLabel: '', endIcon: '', endBusy: false, heading: '', meta: [], plot: '',
};
/* A SYNOPSIS WITHOUT PICTOGRAPHS. An emoji is not in the page's typeface, so the first time one is laid out
 * the engine goes looking for a font that has it and loads that — and a colour-emoji font is the largest
 * thing on a television's system: measured on the desktop at the set's speed, ONE synopsis with two emoji
 * in it cost ~290ms of layout, in the frame the card arrived, against ~10ms for the same length of plain
 * text. They are decoration in a paragraph read from three metres away, so the billboard's copy leaves
 * them out. (`Emoji_Presentation` is the set that draws as a picture by default — it deliberately does not
 * include ™ © ® or the other marks that are ordinary text. The expression is built at run time so an engine
 * without Unicode property escapes keeps the text as it is instead of failing to parse this file.) */
let PICTOGRAPH: RegExp | null = null;
try { PICTOGRAPH = new RegExp('[\\p{Emoji_Presentation}\\u{FE0F}\\u{200D}\\u{20E3}]+', 'gu'); } catch { /* left as it is */ }
const plain = (s: string): string => (PICTOGRAPH && s ? s.replace(PICTOGRAPH, '').replace(/\s{2,}/g, ' ').trim() : s);

/** How long the walk must be still before React is told where it has got to. See `scheduleSync`.
 *  AFTER THE PRESS HAS FINISHED MOVING, not partway through it. This was 260ms, which was "as the
 *  animations end" when the strip's 267ms slide was the longest of them; the copy's arrival runs to
 *  395ms, so the render and commit landed in the last third of every deliberate press — traced at the
 *  television's speed as two of the three late frames a single press had. (`endChain`, SLIDE_CHAIN_WINDOW
 *  after the press, also hands React the walk; whichever comes first does it, and both are now past
 *  the last animation.) */
const SYNC_SETTLE_MS = PRESS_SETTLED_MS + 20;
/** The same for a hold, whose steps are ~300ms apart. */
const SYNC_SETTLE_HELD_MS = 700;
/** The walk may get this far ahead of the mounted window before React is made to catch up at once:
 *  the window carries TILES_AHEAD (9) tiles beyond the strip and the strip shows ~6. */
const SYNC_AHEAD = 3;
/** And this far back: TILES_BEHIND (2) tiles are mounted behind the billboard. */
const SYNC_BEHIND = 2;
/** How long after a press the next card is built, and how long the walk must have been still. */
const PREFILL_AFTER_MS = 420;
const PREFILL_QUIET_MS = 380;
/** And during a hold: a beat after each step, with only a beat of stillness required. */
const PREFILL_AFTER_HELD_MS = 120;
const PREFILL_QUIET_HELD_MS = 80;

export default function TvSpotlight({ items, title, cat, onSelect, onSeeAll, resumeOf, enrich, max, onMore, moreBusy, onOpen }: TvSpotlightProps) {
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
  /* The strip's PHYSICAL position — which tile is behind the billboard, counted from wherever the
   * strip started. Unbounded and monotonic under a walk (see TILES_AHEAD): it is `active` without
   * the wrap. React state, because the window of mounted tiles is rendered from it. */
  const [pos, setPos] = useState(0);
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
  /** This row's distance from the row the remote is on (`focused`, -1 when it is on none) — how the
   *  art prefetch ranks this row's pictures (lib/artPrefetch). A ref read, so it costs nothing to ask. */
  const rowDistance = useRef((focused: number): number => {
    const me = myRow.current;
    if (me < 0) return 99;
    return focused < 0 ? me : Math.abs(me - focused);
  }).current;
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
  const trackRef = useRef<HTMLDivElement>(null);
  /** When the strip last moved — `step` reads it to tell a held key from a deliberate press.
   *  Up here with the other refs because `step` is defined past an early return. */
  const lastStepAt = useRef(0);
  /** The one tap held back by TAP_STEP_MIN_MS, and its timer. Up here, above `if (!n) return null`,
   *  with the other press refs — `paced` itself is below that early return, and a hook there is
   *  called conditionally (lint caught it; a row that renders empty and then fills would throw). */
  const pendingTap = useRef<{ delta: number; id: number } | null>(null);
  useEffect(() => () => { if (pendingTap.current) window.clearTimeout(pendingTap.current.id); }, []);
  /* WHICH ARROW IS PHYSICALLY DOWN, which is the difference between a hold and fast tapping and
   * cannot be inferred from timing (see SLIDE_CHAIN_WINDOW). A hold sends keydown after keydown
   * with no keyup between them; separate presses each send a keyup. So a keydown that arrives
   * while this still names the same key is a repeat, and anything else is a fresh press.
   *
   * `e.repeat` is checked first because it is the direct answer where the platform sets it, and
   * this ref is the fallback for the ones that do not. The ref is also cleared by `endChain`, so
   * a set that somehow swallows a keyup cannot leave the row believing a button is held forever —
   * the worst case is one press treated as a hold, not every press after it. */
  const heldKey = useRef<string | null>(null);
  /* ON THE WINDOW, not on the billboard: focus can move mid-gesture — Left off the first card
   * deliberately jumps to the nav bar — and a keyup delivered somewhere else would otherwise
   * never be seen, leaving the row believing the button was still down. */
  useEffect(() => {
    const up = (e: KeyboardEvent) => { if (heldKey.current === e.key) heldKey.current = null; };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, []);
  /** Which way the last press went (+1 right). Read while rendering the peek's tile order. */
  const lastDir = useRef(1);
  /** Clears `is-cut` after a catalogue change; held so a second change cannot leave it stuck on. */
  const cutId = useRef(0);
  /* ---- THE STAGE'S NODES ---------------------------------------------------------------------
   * The two billboard layers and their plates, the copy block and the peek are EMPTY CONTAINERS as
   * far as React is concerned — it renders them once and never their children — and lib/tvRowStage.ts
   * fills them and flips them. These refs are how it finds them. They live up here rather than
   * beside the markup because there is an `if (!n) return null` between the two, and a hook below
   * an early return does not run on an empty row. */
  const stageRef = useRef<TvRowStage | null>(null);
  const layerARef = useRef<HTMLDivElement>(null);
  const layerBRef = useRef<HTMLDivElement>(null);
  const plateARef = useRef<HTMLDivElement>(null);
  const plateBRef = useRef<HTMLDivElement>(null);
  const infoARef = useRef<HTMLDivElement>(null);
  const infoBRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLDivElement>(null);
  const prevTrackRef = useRef<HTMLDivElement>(null);
  /** The walk index whose slot is on the front layer — what `refresh` repaints, and what a swap
   *  still waiting on a decode has not yet replaced. */
  const shownAt = useRef(0);
  /** A swap waiting on a decode: the token that tells a stale one, and the timer that caps it. */
  const gate = useRef({ id: 0, timer: 0 });
  /** Whether the stage is on the held-key timings, so they are written when they change and not on
   *  every press. */
  const paceHeld = useRef(false);
  /** A commit is owed to React: the walk is ahead of `active` / `pos`. `syncId` is its coalescing
   *  timer. See `syncNow`. */
  const syncOwed = useRef(false);
  const syncId = useRef(0);
  /** The prefill's timer, and how long the walk must have been still for it to run. */
  const prefillTimer = useRef(0);
  const prefillQuiet = useRef(PREFILL_QUIET_MS);
  /* Latest-render closures, for the timers and callbacks that outlive the render that made them. */
  const endChainRef = useRef<() => void>(() => {});
  const syncLatest = useRef<() => void>(() => {});
  const describeLatest = useRef<(s: Slot | undefined) => StageSlot>(() => NO_SLOT);
  const peekLatest = useRef<(at: number) => StagePeek>(() => ({ art: null, gradient: '' }));
  /** The committed state, mirrored, so `syncNow` can tell whether a commit would change anything. */
  const activeLatest = useRef(0);
  const posLatest = useRef(0);
  const dweltRef = useRef<MediaItem | null>(null);
  useEffect(() => () => {
    window.clearTimeout(syncId.current);
    window.clearTimeout(gate.current.timer);
    window.clearTimeout(prefillTimer.current);
    gate.current.id++;
    if (cutId.current) window.clearTimeout(cutId.current);
  }, []);

  /* ---- WHERE THE WALK ACTUALLY IS ------------------------------------------------------------
   * The walk's truth is these two refs, not the React state: a press writes the nodes and moves
   * them, and the state follows in a transition a few tens of milliseconds later (`syncNow`).
   * Everything that must not lag the remote — OK opening a title, chiefly — reads `liveActive`
   * rather than `active`. */
  const liveActive = useRef(0);
  /** The dwell timer, hoisted out of its effect so a held key can cancel it without a re-render. */
  const dwellId = useRef(0);
  /** One in-flight tile promotion at a time — see `promoteSoon`. */
  const promoteId = useRef(0);
  /** Whether this row has ever promoted tiles. The first pass is the one a viewer can see fade —
   *  see the note in `promoteSoon`. Per ROW, because each row gets its artwork on its own clock. */
  const firstPromote = useRef(true);
  /* ---- THE STRIP'S POSITION IS NOT THE WALK'S POSITION ------------------------------------
   * `liveActive` is the walk index and wraps at `stops`; `stripPos` is the physical position and
   * never wraps — stepping RIGHT off the end card takes the walk to 0 and the strip forward by one,
   * onto the position that SHOWS title 0 (see TILES_AHEAD). The two are an anchor: what is under
   * the billboard, and where the strip is standing to show it. `stripPos` drives the node and is
   * the imperative twin of the `pos` state above, exactly as `liveActive` is of `active`. */
  const stripPos = useRef(0);
  /* Set when the NEXT write of `--active` must not be seen: a catalogue cut, or the rare rebase
   * that brings a long walk's position back toward the origin. Consumed by the layout effect that
   * owns `--active`, which suppresses the transition around that one write. */
  const silentHop = useRef(false);
  /* ---- THE ACTIVE-ROW HIGHLIGHT IS A CLASS, NOT A RENDER ------------------------------------
   * `open` drives two quite different things: the LOOK of the focused row (a class, and every
   * `.tv-spot.is-open` rule hanging off it) and the BEHAVIOUR of being focused — arming the
   * trailer dwell, the neighbour prefetches, the red-button listener.
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
  /* ---- THE ROW'S COMPOSITOR LAYERS FOLLOW THE REMOTE ONLY ONCE IT IS STILL ----------------------
   * The open row promotes its strip and its two billboard layers (`.tv-spot.is-primed` in tv.css), so
   * the first slide or dissolve after the remote arrives does not have to build and raster a layer on
   * its own press. Those promotions used to hang off the focus COMMIT, 420ms after a vertical press —
   * the tail of that press's scroll — and the row being left lost its own in the same moment, while it
   * was still scrolling off the screen: two rows' worth of layers built, torn down and rastered again
   * (the strip's content back into the page's layer) at the end of every vertical move, on the GPU this
   * set has least of.
   *
   * Now the class follows the remote only when it has been still for PRIME_QUIET_MS (lib/tvQuiet): a
   * walk down the page builds and destroys no layers at all, the row the viewer stops on is promoted a
   * beat after they stop, and the row they left gives its layers up then, off screen. The live state is
   * `primedRef`, re-asserted after every render like `is-open` (React's className write would drop it). */
  const primedRef = useRef(false);
  const primeCancel = useRef<(() => void) | null>(null);
  const primeSoon = () => {
    primeCancel.current?.();
    primeCancel.current = whenQuiet(() => {
      primeCancel.current = null;
      if (primedRef.current === openRef.current) return;
      primedRef.current = openRef.current;
      sectionRef.current?.classList.toggle('is-primed', primedRef.current);
    }, PRIME_QUIET_MS);
  };
  useEffect(() => () => { primeCancel.current?.(); }, []);
  /** Clears `is-fast` once the remote stops chaining — see the note in `step`. */
  const fastOff = useRef(0);
  const railRef = useRef<HTMLDivElement>(null);
  /* THE CALLER'S CALLBACKS, BEHIND STABLE ONES. Home builds a new `onSelect` every render and
   * TvHomeRow a new `onMore`; a tile that took either as a prop would re-render whenever its row's
   * parent did. The tiles get these two functions instead, created once, reading the latest
   * callback through a ref — so a tile's props are stable for as long as its title and position
   * are, which is what lets `memo` bail it out of every press. */
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const goEndRef = useRef(goEnd);
  goEndRef.current = goEnd;
  const openTile = useRef((it: MediaItem) => { onSelectRef.current?.(it); }).current;
  const goEndStable = useRef(() => { goEndRef.current(); }).current;

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
  /* ---- THE BILLBOARD'S PARALLAX, MEASURED — and where it runs now -------------------------------
   *
   * The reference clip was pulled apart frame by frame and correlated numerically against the
   * settled frame. SCALE = 1.000, every frame: no zoom, no Ken Burns. OFFSET decays +24px -> 0
   * across frames 10-23 at 30fps (24, 22, 18, 15, 12, 9, 7, 5, 4, 3, 2, 1, 1, 0) — 3.2% of a 753px
   * card, arriving from the side the press came from; the strip decays at the same ratio, one curve
   * and one duration with two distances. At 3.2% it is invisible in a downscaled contact sheet,
   * which is exactly why reading the tiles said "nothing moves"; in motion it is the whole feel.
   *
   * THE PICTURE MOVES, NOT THE LAYER: the layer also carries the title plate, and the reference
   * holds that still — drifting it would make the billboard slide as one panel, the opposite of
   * parallax. `.tv-spot-art` is the photograph alone, overscanned in tv.css so the drift never pulls
   * an edge into frame. The incoming picture only: the leaving one is fading out in its first two
   * frames, where 1.6-3.2% of movement cannot be seen.
   *
   * THE COPY MOVES WITH THE PICTURE, NOT AFTER IT. The genre/year/rating line and the synopsis change
   * in the same frame as the billboard and arrive with the same motion, so picture and text read as
   * one card changing. A deliberate press gets the reference's own copy motion (quartic ease-out,
   * 41.5px, 395ms; quadratic fade, 365ms); a hold gets the picture's short linear drift, because a
   * 395ms arrival cannot finish inside a 300ms walking pace.
   *
   * It used to be an effect keyed on which layer was in front, which could only run a commit AFTER
   * the swap; it is one call inside the stage's `show` now (lib/tvRowStage.ts `arrive`), made in the
   * same task as the swap, so the picture and its copy cannot drift apart. The localStorage switch
   * is unchanged (lib/tvMotionFlags.ts `parallaxEnabled`). */
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
  /* Per TITLE, not per row: an Animation entry sitting in a mixed row still wants its own framing,
   * and the row a thing appears in says nothing about how it was shot. See the crop constants. */
  const trailerCrop = isAnimated(dwelt) ? TRAILER_CROP_NATIVE : TRAILER_CROP_LETTERBOXED;
  /* LATCHED, AND THE LATCH IS WHAT KEEPS THIS FROM OSCILLATING. Most cards carry their IMDb id,
   * but the ungated feeds (Upcoming, the Featured Hero) do not, and without one there is nothing
   * to ask /api/imdb-trailer with. Reading the id straight off `trailerMeta` would spin: an id
   * found there arms the video, the armed video would disarm the lookup, the query goes idle and
   * the id vanishes again. Held in state, it survives the request that produced it. Cleared with
   * the dwell. */
  const [metaImdb, setMetaImdb] = useState<string | undefined>(undefined);
  const imdbId = armed ? (dwelt?.imdb || metaImdb) : undefined;
  /* AWARDS FOR THE CARD THAT HAS COME TO REST, never for one walked past — one small request per
   * rest, cached for a day, and the facts line picks the callout up when it lands (see glance). */
  useAwards(dwelt ? (dwelt.imdb || metaImdb) : undefined);
  const imdbTrailer = useImdbTrailer(videoFailed ? undefined : imdbId);
  const videoUrl = videoFailed ? undefined : (imdbTrailer.data?.url || undefined);
  /* /api/meta IS ONLY EVER ASKED FOR AN ID WE DO NOT ALREADY HAVE. It is a whole detail payload
   * fetched for one string, so it goes out only for a card that arrived without an IMDb id — and
   * never for a card that has one, which is the common case and now costs exactly one request for
   * the preview. (`enrich` rows resolve the same id from the detail they already fetch, below.) */
  const wantImdbLookup = armed && !dwelt?.imdb && !metaImdb;
  const { data: trailerMeta } = useMeta(wantImdbLookup ? apiIdOf(dwelt) : undefined, dwelt?.type);
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
      /* THE CROP ITSELF, applied by the engine: it lays the <video> out this much larger than the
       * billboard, centred, and the slot clips the rest (see `place` in useVideoTrailer — a CSS
       * transform did not reach the picture on the set). It also sizes the rendition, since a
       * preview cropped 1.35x is sampled at 1.35x its box. */
      cropScale: trailerCrop,
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
  const { data: detail } = useMeta(enrich && artOn ? apiIdOf(resting) : undefined, resting?.type);
  useEffect(() => {
    if (!enrich || !detail || !resting) return;
    const k = String(resting.id);
    // The detail we fetched for the artwork also carries the IMDb id, which is the key to the
    // preview that is NOT a YouTube embed — so an enriched row gets the fast trailer path for
    // free, on a request it was already making. (The latch it feeds is documented above.)
    if (typeof detail.imdb === 'string') setMetaImdb(detail.imdb);
    const add: Partial<MediaItem> = {};
    /* ---- IT FILLS WHAT IS MISSING. IT NEVER REPLACES WHAT IS ALREADY ON SCREEN. --------------
     *
     * THE DEFECT, MEASURED, on a fresh load of the home screen: rest on "Upcoming Movies &
     * Series", press Down, and the Trending Movies billboard changed its PICTURE about two
     * seconds later — Spider-Man's close-up became the wide shot. Reading the layer off the DOM
     * against the network:
     *
     *     t=4931  billboard = qeQJx07rK2xm   row takes focus (is-open)
     *     t=5065  GET /api/meta/969681       `enrich` switches on with `started`
     *     t=5444  billboard = vjMvFSmGUxEt   the detail landed and repainted it
     *
     * and the two URLs are two different server fields for the same title: /api/home answers
     * `backdrop: qeQJx07r…`, /api/meta answers `artBackdrop: vjMvFSmGUxEt…`. Both are correct
     * pictures of the film. Only one of them was already on the screen.
     *
     * WHY IT ONLY EVER HAPPENS ONCE, AND ONLY AFTER A RELOAD: `enrich` is `started` from
     * TvHomeRow, which latches the first time the remote settles on the row. So the swap fires on
     * the first visit to each row and never again — which is exactly what makes it read as "it
     * changes when I focus it" rather than as a row still loading.
     *
     * THE INTENT WAS RIGHT AND THE REACH WAS WRONG. `artBackdrop` is the textless frame the baked
     * poster was cropped from, so preferring it makes the billboard and the tile agree — worth
     * having on a card that arrived with NO artwork, which is the case this whole block exists
     * for (history cards carry a poster and a title and nothing else; titles appended from
     * /api/browse past the server's wordmark cap carry no logo). It was never worth having on a
     * card whose picture the viewer is already looking at. A swap under the eye is a worse fault
     * than a billboard and a tile showing two frames of the same film — especially as the tile
     * beside the billboard belongs to the NEXT title, so the two are never actually compared.
     *
     * The same rule applies to all three fields, not just the artwork: /api/home ships a wordmark
     * (`logos=1`) and a synopsis for its seeded titles, and overwriting either of those on focus
     * is the identical defect in a quieter register. */
    if (!resting.backdrop && (detail.artBackdrop || detail.backdrop)) {
      add.backdrop = detail.artBackdrop || detail.backdrop;
    }
    if (!(resting.titleLogo || resting.logo) && detail.titleLogo) add.titleLogo = detail.titleLogo;
    if (!resting.overview && detail.plot) add.overview = detail.plot;
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

  /* ---- OK OPENS A TITLE THAT IS ALREADY THERE ---------------------------------------------------
   * Resting on a card for DETAIL_WARM_MS fetches its detail and decodes the backdrop and wordmark its
   * title screen will paint (lib/queries `useWarmDetail`), so OK opens straight onto a finished screen
   * instead of a veil.
   *
   * TIMED FROM THE PRESS, AND EVERY PRESS CANCELS IT. It was keyed on the committed walk, which lands
   * ~400ms after a press (see `syncNow`) — so at the pace of a deliberate walk, a card every 700ms or
   * so, the warm for the card just left fired 300ms into the NEXT press, its requests and decodes
   * landing on the frames that press was animating. Armed by the press itself (`step`), it fires only
   * when the remote has really stopped for DETAIL_WARM_MS, and it reads where the walk IS then. A held
   * key re-arms it on every repeat, so a walk past a card still warms nothing. */
  /* ---- AND "STOPPED" MEANS THE REMOTE, NOT THIS ROW ---------------------------------------------
   * The warm was a timer per row, armed when the row's focus COMMITTED (420ms after the press that
   * reached it) and cancelled only when the row's loss of focus committed in turn — 420ms after the
   * press that LEFT it. At the pace of somebody walking down the page, a press a second, it therefore
   * fired just after the next press, every time: a detail request, a backdrop and a wordmark decoded,
   * five faces, and for a series a season and its stills, all landing in the frames of the scroll that
   * press had started. Measured on the first walk down a fresh home screen, that and its siblings were
   * most of what made the first walk heavier than the second.
   *
   * So it waits for the REMOTE to have been still for DETAIL_WARM_MS (any key anywhere pushes it back,
   * lib/tvQuiet), it is cancelled the moment focus leaves the row rather than a commit later, and its
   * pictures are only decoded if the viewer is still on that card when the detail arrives. */
  const warmDetail = useWarmDetail();
  const detailWarmCancel = useRef<(() => void) | null>(null);
  const detailWarmLatest = useRef<() => void>(() => {});
  detailWarmLatest.current = () => {
    if (!openRef.current || !artOn) return;
    const at = liveActive.current;
    const it = at < n ? list[at] : undefined;
    if (!it) return;
    /* Continue Watching (the row with `resumeOf`) opens a series on the episode it names, so its deck
     * is warmed on that one — ContinueRow's `openEntry` reads the same history entry. */
    const e = resumeOf ? useHistory.getState().history.find((h) => String(h.id) === String(it.id)) : undefined;
    const resumeEp = e && e.season != null && e.episode != null ? { season: e.season, episode: e.episode } : undefined;
    warmDetail(withArt(it), resumeEp, () => openRef.current && liveActive.current === at);
  };
  const cancelDetailWarm = () => { detailWarmCancel.current?.(); detailWarmCancel.current = null; };
  const armDetailWarm = () => {
    cancelDetailWarm();
    detailWarmCancel.current = whenQuiet(() => { detailWarmCancel.current = null; detailWarmLatest.current(); }, DETAIL_WARM_MS);
  };
  /* Arriving on the row with the remote is a rest like any other. */
  useEffect(() => {
    if (!open || !artOn) return;
    armDetailWarm();
    return cancelDetailWarm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, artOn]);

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
  const billboardUrl = (it: MediaItem): string => (artOn ? billboardSrcOf(it, !!enrich) : '');

  /* ---- A ROW NOT YET REACHED DOWNLOADS ITS FIRST SCREEN AHEAD OF TIME -------------------------
   * The billboard, the tiles beside it and their wordmarks — the pictures this row shows the
   * moment the remote arrives — handed to lib/artPrefetch, which downloads them (bytes only, no
   * decode) once the home screen has settled, nearest rows to the remote first. A row that already
   * has its artwork on is doing this itself through `promoteSoon`, so it queues nothing. */
  const PREFETCH_TITLES = 12;
  useEffect(() => {
    if (artOn || !n) return;
    const urls: string[] = [];
    for (let d = 0; d < Math.min(PREFETCH_TITLES, n); d++) {
      const it = list[(active + d) % n];
      if (!it) continue;
      const a = withArt(it);
      if (d === 0) urls.push(billboardSrcOf(a, !!enrich));
      urls.push(tilePictureOf(a).src, logoOf(a) || '');
    }
    prefetchArt(urls, rowDistance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artOn, list, n]);

  /* THE ROW THE REMOTE IS ON DOWNLOADS THE REST OF ITSELF. The warm-ahead decodes the next six cards and
   * the strip's window holds a dozen; past those, a walk used to meet each new poster as a request at
   * the moment it slid in — fine on a desktop, a visible late arrival on a television on Wi-Fi. So the
   * row being walked queues the bytes of the cards after that (lib/artPrefetch: idle, three at a time,
   * this row first), and a walk of any length finds them in the cache. Bytes only — nothing is decoded
   * until the warm-ahead reaches it. */
  useEffect(() => {
    if (!open || !artOn || n < 8) return;
    const urls: string[] = [];
    for (let d = 7; d <= Math.min(n - 1, 26); d++) {
      const it = list[(active + d) % n];
      if (!it) continue;
      const a = withArt(it);
      urls.push(tilePictureOf(a).src, logoOf(a) || '');
    }
    /* Ranked like any row's: first while the remote is on this row, and no longer once it has left. */
    prefetchArt(urls, rowDistance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, artOn, n, list]);

  /* ---- THE WINDOW, BUILT FRESH ON EVERY PRESS AND CHEAP BECAUSE OF IT -------------------------
   * The strip used to be one memo holding every tile, guarded against rebuilding on a focus change
   * because 24 (then 81) <button>s were too many to diff on the keypress frame. The window is a
   * dozen elements whose children are `memo` components with stable props, so rebuilding the list
   * costs a dozen identity checks and React's real work per press is one mount and one unmount —
   * both off-screen, at the window's two ends. Still memoised, so a render that changes none of
   * these (a query settling, the focus commit, a dwell firing) hands React the identical array.
   *
   * WHAT SITS AT EACH POSITION is `slotAt(itemAt(p))`: the walk index counted from the anchor,
   * wrapped at `stops`, and the end card wherever that wrap lands on `n`. The key carries the
   * title's id next to the bounded position so that a position whose title changes — the cards
   * past a "+" once more have been loaded — gets a fresh node with a plate and a fade-in, exactly
   * as those tiles arrived before, while every other node in the window is untouched. */
  const thumbs = useMemo(() => {
    /** Which walk index a tile at physical position `p` shows, counted from the anchor. */
    const itemAt = (p: number): number => mod(active + (p - pos), stops);
    const out: ReactElement[] = [];
    if (!stops) return out;
    /* Where the end cards stand: every position whose walk index is `n`. Fixed while the row only
     * walks (a wrap moves the anchor by a whole lap), so a tile keeps its `left` for its whole life
     * and only the row lengthening moves them — see `endsAt` for the strip's half. */
    const endAt = mod(pos - active + n, stops);
    const leftOf = (p: number): string => tileLeft(p, hasEnd ? endsBefore(p, endAt, stops) : 0);
    /* Nothing left of the origin. Left off the first title leaves the row for the nav bar (see
     * `onHeroKey`), so in the first lap a tile at a negative position could never be walked back
     * onto — it would be two clipped, decoded posters per row that the old strip never held. Once
     * the walk has wrapped, or been rebased, the two behind are at positive positions anyway. */
    for (let p = Math.max(0, pos - TILES_BEHIND); p <= pos + TILES_AHEAD; p++) {
      const slot = slotAt(itemAt(p));
      const k = mod(p, TILE_KEYS);
      if (slot === 'end') {
        out.push(<EndTile key={`${k}:end`} left={leftOf(p)} label={endLabel} icon={endIcon} heading={heading} busy={canMore && !!moreBusy} onGo={goEndStable} />);
      } else if (slot) {
        const res = resumeOf?.(slot);
        out.push(<Tile key={`${k}:${slot.id}`} item={slot} left={leftOf(p)} pct={res?.pct ?? 0} onOpen={openTile} />);
      }
    }
    return out;
    // `slotAt` is rebuilt every render and closes over `list` and `n`, which are in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, n, stops, pos, active, hasEnd, endLabel, endIcon, heading, resumeOf]);

  /* ---- ONLY THE TILES THE WALK CAN REACH GET A BITMAP -------------------------------------
   * The strip used to hold 21 tiles and show six, with the other fifteen downloaded and decoded
   * anyway: measured on a settled home screen, 56 posters fully decoded entirely off the right
   * edge, 37.5 MB of bitmap for pictures nobody could see. A `data-src` window fixed that, and the
   * DOM window (TILES_BEHIND / TILES_AHEAD) is now the SAME window — a tile exists exactly while
   * it is close enough to the walk to deserve a picture — so promotion is simply "every tile
   * mounted in this strip": whichever tiles the window holds when the callback fires.
   *
   * `loading="lazy"` DOES NOT COVER THIS, which is the whole reason this exists. Lazy loading is
   * about the VIEWPORT, and these tiles are inside it — they are only clipped horizontally by an
   * ancestor's overflow, which the browser does not treat as off-screen. And a tile only ever
   * receives a `src` from here, gated on `visible` (the IntersectionObserver latch) through
   * `artOn`, so a row below the fold has no `src` on any tile and `content-visibility: auto` on
   * the rail covers those rows besides.
   *
   * ONE PROMOTION IN FLIGHT, IDEMPOTENT, AND IT READS THE STRIP WHEN IT FIRES. This used to be an
   * effect that cancelled and re-armed its idle callback on every press, so at a held key's
   * cadence the callback was rebuilt before it could ever run — thirty presses of scheduling for
   * zero promotions, then one at the end. Now every path (a press, a commit that changed the
   * window, the row coming near the viewport) calls the same scheduler, which does nothing if a
   * callback is already pending, and the one that eventually runs promotes what is mounted THEN —
   * where the walk actually ended up, which is what the viewer is looking at.
   *
   * ON THE IDLE FRAME, NEVER ON THE KEYPRESS FRAME, and this is the correction that makes the
   * window worth having at all. Promoting inline looked right and measured WORSE than loading
   * everything up front — 1.69s of task time across ten presses became 2.20s, with four janky
   * frames where there had been none. The window had not removed the decodes, it had moved them
   * out of the quiet moment after load and into the one frame that is animating a cross-fade.
   * Deferred, the work lands between presses, where the row is doing nothing anyway. The 600ms
   * timeout is the floor under that promise: an idle callback with no deadline can be starved
   * indefinitely, and a tile that never gets a bitmap is a hole on the shelf. `decoding="async"`
   * keeps the decode itself off the main thread once the bytes are in.
   *
   * A tile keeps its `src` for as long as it is mounted — walking back over it never re-downloads
   * — and a tile that leaves the window takes its <img> with it. The next time the walk reaches
   * that title a fresh tile is mounted two positions behind the billboard, where nothing is ever
   * visible, and its picture comes back out of the HTTP cache three presses before it could
   * appear. Both the picture and the wordmark are promoted together: a tile holds TWO deferred
   * images, and promoting only the first is why lettering used to arrive a beat after the art. */
  const promoteSoon = () => {
    if (promoteId.current) return;
    const track = trackRef.current;
    if (!track || !artOn) return;
    const run = () => {
      promoteId.current = 0;
      const imgs = track.querySelectorAll<HTMLImageElement>('img[data-src]');
      /* ---- ONLY THE FIRST PASS FADES, BECAUSE ONLY THE FIRST PASS IS VISIBLE ----------------
       * The arrival fade belongs to a row getting its artwork: a dozen tiles promote together,
       * in place, where they can be seen. Every pass AFTER that promotes exactly the tiles the
       * walk has just mounted at the two edges of the window — nine ahead, behind the rail's
       * clip, or two behind, under the billboard — so their 350ms fade is a compositor
       * animation on something ~1800px off the side of the screen. Measured, with the boxes,
       * at lib/tvMotionFlags.ts; two of the thirteen animations a press runs.
       *
       * Written to the node rather than through a class, for the reason every other write in
       * this function is: a tile must not re-render to load a picture. The node is created for
       * one title at one position and destroyed with it, so it has no later fade to lose. */
      /* AND THE FIRST PASS ONLY FADES IF IT CAN BE SEEN. A row is now given its artwork while it is still
       * a few rows away (the row window, and the finale of the start-up intro for the first rows), so its
       * first pass usually happens off screen — two dozen opacity transitions per row, each with its
       * run/start/end events and a style pass on every frame they live, on the first walk down a fresh
       * home screen, for a fade nobody is looking at. Read in an idle callback, where layout is clean. */
      let fade = tileFadeAlways();
      if (!fade && firstPromote.current) {
        const r = sectionRef.current?.getBoundingClientRect();
        fade = !!r && r.bottom > 0 && r.top < window.innerHeight;
      }
      firstPromote.current = false;
      for (const img of imgs) {
        if (!fade) img.style.transition = 'none';
        img.src = img.dataset.src || '';
        delete img.dataset.src;
      }
    };
    const ric = window.requestIdleCallback;
    promoteId.current = typeof ric === 'function'
      ? ric(run, { timeout: 600 })
      : window.setTimeout(run, 120);
  };
  /* After every commit that could have mounted a tile: the window moving, the data changing, the
   * row coming near the viewport. `promoteSoon` coalesces them into one callback. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { promoteSoon(); }, [artOn, thumbs]);

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
    /* THE ROW WINDOW ARMS IT FIRST, WHEN IT CAN — lib/tvRowRegistry `prepareRowWindow` fires this on
     * an idle callback for the rows around the remote, so the latch (and the render that hands the
     * tiles their `src`) happens between presses instead of on a frame of the vertical scroll, which
     * is when the observer above would otherwise get there. The observer stays as the fallback. */
    const arm = () => { setVisible(true); io.disconnect(); };
    el.addEventListener(ROW_PREPARE_EVENT, arm);
    return () => { io.disconnect(); el.removeEventListener(ROW_PREPARE_EVENT, arm); };
  }, []);
  /* The first row the remote lands on has not been reached by a vertical move, which is the only
   * thing that prepared the window — so the rows below the first focus were cold until the first
   * Down. Opening a row prepares around it. */
  useEffect(() => { if (open) prepareRowWindow(sectionRef.current); }, [open]);

  /* ---- THE STAGE — what the billboard, its plate, the copy and the peek show -------------------
   * Written by lib/tvRowStage.ts, driven from here. These four functions are the whole interface
   * between this component's data (items, artwork the row has been allowed, what `enrich` found, the
   * resume bar) and the nodes the stage owns: they turn a stop of the walk into plain strings.
   *
   * THEY READ THE LATEST RENDER THROUGH A REF (`describeLatest`, `peekLatest`), because the stage is
   * called from key handlers, timers and decode callbacks created in earlier renders — a closure
   * from then would describe the row as it was, not as it is. */
  /* AT THE SIZE IT IS PAINTED, which for a wordmark on the billboard is 201px wide at most (62% of
   * the card, capped at 84px tall — see tv.css). The URL arrives as w500 and was used as it came,
   * so every logo on the screen was a 2.5x oversample: fetched, decoded and held at four times the
   * pixels it can show. w300 is the next step TMDB offers and still leaves headroom on a HiDPI
   * panel. Non-TMDB URLs pass through imgW untouched. */
  const logoOf = (it: MediaItem) => imgW(it.titleLogo || it.logo || '', LOGO_RENDITION) || undefined;
  /* The card's strongest at-a-glance callout, led into the facts line. Read from what is already
   * cached (home rankings, taste, a detail or awards someone else fetched) — a press never asks the
   * network for it. See useGlanceResolver. */
  const glanceFor = useGlanceResolver();

  const describeSlot = (slot: Slot | undefined): StageSlot => {
    if (!slot) return NO_SLOT;
    if (slot === 'end') {
      return { ...NO_SLOT, key: `end|${endLabel}|${endIcon}|${heading}`, kind: 'end', endLabel, endIcon, endBusy: canMore && !!moreBusy, heading };
    }
    const a = withArt(slot);
    const res = resumeOf?.(slot);
    /* THROUGH `billboardUrl`, never built here — the warm-ahead and the swap gate both target this
     * exact string, and a second copy of the rendition logic is how they would silently stop
     * matching it. Until the row is near the viewport it is '' and the layer keeps the branded
     * gradient, requesting no bitmap at all. */
    const bgUrl = billboardUrl(a);
    const logoUrl = logoOf(a) || '';
    const bgPos = heroBgPosition(a);
    const progress = res?.pct ?? 0;
    return {
      key: `t|${slot.id}|${bgUrl}|${bgPos}|${logoUrl}|${a.title}|${progress.toFixed(3)}`,
      kind: 'title',
      bgUrl,
      fallback: heroFallbackGradient(a),
      bgPos,
      logoUrl,
      title: a.title || '',
      progress,
      endLabel: '',
      endIcon: '',
      endBusy: false,
      heading: '',
      /* [S2:E4 ·] genre · year · rating. The episode leads when there is one, because on a resume
       * row it is the most specific thing the line can say. The see-all card has no facts. */
      meta: [
        res?.note || '',
        genre(a.genre || (a.genres && a.genres[0]) || ''),
        a.year ? String(a.year) : '',
        a.rating ? `★ ${a.rating}` : '',
      ].filter(Boolean),
      plot: plain(a.overview || ''),
      glance: ROW_GLANCE ? glanceFor(a).slice(0, 2).map((g) => ({ icon: g.icon, text: g.text, kind: g.kind })) : undefined,
    };
  };

  /* ---- THE FIRST CARD HAS NOTHING BEFORE IT --------------------------------------------------
   * Standing on the first title nothing has been walked past, so there is nothing to leave at the
   * screen edge — the reference shows an empty band at the head of a row. (This used to wrap, and
   * parked the LAST title there as though the walk had come from it.) The END card keeps its peek:
   * standing past the last title, the last title IS the thing just walked off. The picture is the
   * one the tile would show, chosen the same way (the shared backdrop cropped around the focal
   * point, else the pre-cut slice, else the poster) — no wordmark, since only a trailing sliver is
   * ever visible. */
  const peekFor = (at: number): StagePeek => {
    const previous = at >= n ? list[n - 1] : (at > 0 ? list[at - 1] : undefined);
    if (!previous) return { art: null, gradient: '' };
    return { art: artOn ? peekArtOf(previous) : EMPTY_PEEK, gradient: heroFallbackGradient(previous) };
  };
  describeLatest.current = describeSlot;
  peekLatest.current = peekFor;
  activeLatest.current = active;
  posLatest.current = pos;
  dweltRef.current = dwelt;

  /* ---- THE SWAP WAITS FOR A PICTURE TO SWAP TO ----------------------------------------------
   * THE DEFECT THIS GATE REMOVED: the billboard blinked through black on every press. The layers
   * traded places before the incoming one had anything in it, and for the gap between them the
   * billboard showed the only thing that layer HAD — `heroFallbackGradient`, which mid-walk is just
   * black. That gradient is doing its real job on a cold row, holding the frame while the first
   * picture loads; it must never be seen on a walk.
   *
   * So a press holds the SWAP — not the strip, which moves on the press frame regardless, so the
   * press is always answered instantly — until the incoming photograph AND wordmark are decoded, and
   * the dissolve goes picture to picture. Both are asked for together rather than in sequence (a
   * wordmark is a ~20KB PNG against a 780px JPEG, so it is almost never the one waited on).
   *
   * WARM, THIS COSTS NOTHING AND IS THE NORMAL CASE: `isDecoded` is checked first, and the warm-ahead
   * has usually retained both, so the whole swap — fill, flip, animations — runs synchronously
   * inside the key handler, in the same frame the strip starts to move.
   *
   * THE CAP KEEPS A GATE FROM BECOMING A STALL: past SWAP_WAIT_CAP the swap happens anyway and the
   * gradient-then-photo path takes over — a worse frame but never a stuck one. A newer press
   * supersedes a pending swap rather than queueing behind it: holding a direction walks to where
   * the remote actually is, not through every card on the way. */
  const showSlot = (at: number, dir: 1 | -1, chained: boolean) => {
    const stage = stageRef.current;
    if (!stage) return;
    const g = gate.current;
    const token = ++g.id;
    window.clearTimeout(g.timer);
    g.timer = 0;
    const slot = slotAt(at) ?? list[0] ?? 'end';
    const info = describeSlot(slot);
    const peek = peekFor(at);
    /* THE BILLBOARD'S NAME MOVES WITH THE PRESS, not with the lazy React sync: the hero is the
     * focused element, so its label is what webOS audio guidance reads. Same string the JSX renders,
     * so the later commit writes an identical value. */
    const btn = heroBtnRef.current;
    const label = info.kind === 'end' ? `${heading} — ${endLabel}` : info.title;
    if (btn && btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    let spent = false;
    const go = () => {
      if (spent || gate.current.id !== token) return;
      spent = true;
      window.clearTimeout(gate.current.timer);
      gate.current.timer = 0;
      shownAt.current = at;
      stage.show(info, peek, { dir, held: chained, animate: !reduceMotion });
      prefillSoon(chained);
    };
    const urls = [info.bgUrl, info.logoUrl].filter(Boolean);
    let left = urls.length;
    if (!left) { go(); return; }
    const done = () => { if (--left <= 0) go(); };
    for (const url of urls) {
      /* THROUGH THE RETAINED CACHE, not a fresh Image per press: this gate, the warm-ahead and the
       * stage's own decode check share one element per URL, so the warm-ahead's decode IS this
       * gate's decode. */
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
    if (!spent) g.timer = window.setTimeout(go, SWAP_WAIT_CAP);
  };

  /* ---- REACT CATCHES UP, IN A TRANSITION, AFTER THE PRESS ---------------------------------------
   * The mirror (`active` / `pos`) feeds the window of mounted tiles, the preview dwell and the
   * prefetches — none of which anyone can perceive a few tens of milliseconds late, and all of which
   * cost a render. It is committed as a TRANSITION, so React slices the render into small pieces
   * between frames instead of running it as one task, and it is coalesced: a run of presses commits
   * the position the walk has actually reached, once. `endChain` flushes it when the remote lets go.
   *
   * If the state already agrees (a hold that wrapped exactly back to where it started) there is no
   * render and so no effect re-run — the preview dwell is armed by hand in that case, because the
   * effect that normally arms it is keyed on the resting title's id and that id has not moved. */
  function syncNow() {
    if (syncId.current) { window.clearTimeout(syncId.current); syncId.current = 0; }
    if (!syncOwed.current) return;
    syncOwed.current = false;
    const at = liveActive.current;
    const sp = stripPos.current;
    if (at === activeLatest.current && sp === posLatest.current) {
      const rest = at < n ? list[at] : undefined;
      /* `openRef`, not `open` — a hold can end before the focus commit has landed, and the state
       * would still say the row is not focused when it plainly is. */
      if (rowTrailers && openRef.current && rest && !dwellId.current && !dweltRef.current) {
        dwellId.current = window.setTimeout(() => { dwellId.current = 0; setDwelt(rest); }, previewDwellMs());
      }
      return;
    }
    startTransition(() => { setActive(at); setPos(sp); });
  }
  syncLatest.current = syncNow;
  /* WHEN: AT A LULL, NOT ON A CLOCK. The commit is debounced — every press pushes it back — so a run
   * of presses commits once, after the remote has paused, instead of landing mid-glide; and it is
   * forced early only when the walk is about to outrun the window of mounted tiles (more than
   * SYNC_AHEAD positions forward, where the strip would show a gap on the right, or SYNC_BEHIND
   * back). A single deliberate press therefore commits ~SYNC_SETTLE_MS after it, which is just as
   * its animations end and well before the next one. */
  const scheduleSync = (held: boolean) => {
    window.clearTimeout(syncId.current);
    const lead = stripPos.current - posLatest.current;
    const urgent = lead >= SYNC_AHEAD || -lead >= SYNC_BEHIND;
    /* A hold waits longer: its steps are ~300ms apart, so a settle shorter than that would commit
     * between every pair of them — a React render in the middle of each glide — where the guard
     * above already commits every third step, which is as often as the window needs it. */
    syncId.current = window.setTimeout(() => syncLatest.current(), urgent ? 0 : held ? SYNC_SETTLE_HELD_MS : SYNC_SETTLE_MS);
  };

  /* ---- THE NEXT CARD IS BUILT BEFORE IT IS ASKED FOR ------------------------------------------
   * Once a press has settled, and the walk has been still for a moment, the card the remote is
   * most likely to go to next — one more in the direction it was last going — is built on the card
   * that is not showing (stage.prefill): nodes created, the wordmark's <img> given its src, three
   * lines of synopsis laid out. The next press then flips to it instead of building it, which moves
   * ~all of the main-thread cost of a press to a moment nothing is happening. An idle callback with
   * a timeout, so it never lands inside a press and is never starved either. Cheap when it has
   * nothing to do: the stage compares keys and returns. */
  const prefillNow = () => {
    const stage = stageRef.current;
    if (!stage || stops < 2 || !artOn || gate.current.timer) return;
    if (performance.now() - lastStepAt.current < prefillQuiet.current) { prefillSoon(paceHeld.current); return; }
    stage.prefill(describeLatest.current(slotAt(mod(liveActive.current + lastDir.current, stops))), !paceHeld.current);
  };
  const prefillLatest = useRef(prefillNow);
  prefillLatest.current = prefillNow;
  function prefillSoon(held = false) {
    window.clearTimeout(prefillTimer.current);
    /* During a hold there is no "quiet" to wait for — steps arrive every ~300ms for as long as the key
     * is down — so the next card is built a beat after each step instead, in the gap before the one
     * after it, which is where the same work used to happen inside the key handler. */
    prefillQuiet.current = held ? PREFILL_QUIET_HELD_MS : PREFILL_QUIET_MS;
    /* A TIMER, NOT requestIdleCallback. On the television the main thread has no idle periods for a
     * good half second after a press (the animations keep it producing frames), and an idle callback
     * with a timeout is simply starved until the timeout — measured: the card was built ~800ms late
     * and the next press, a second after the last, found it unbuilt. The timer fires between frames
     * like any task, and the quiet-period check in `prefillNow` is what keeps it out of a walk. */
    prefillTimer.current = window.setTimeout(() => {
      prefillTimer.current = 0;
      prefillLatest.current();
    }, held ? PREFILL_AFTER_HELD_MS : PREFILL_AFTER_MS);
  }

  /* THE STAGE ITSELF: built once the row has titles, torn down if it loses them. A layout effect so
   * the first paint already has a billboard on it. */
  const hasRow = n > 0;
  useLayoutEffect(() => {
    const hero = heroBtnRef.current, strip = trackRef.current;
    const a = layerARef.current, b = layerBRef.current, pa = plateARef.current, pb = plateBRef.current;
    const ia = infoARef.current, ib = infoBRef.current;
    const prev = prevRef.current, prevTrack = prevTrackRef.current;
    if (!hasRow || !hero || !strip || !a || !b || !pa || !pb || !ia || !ib || !prev || !prevTrack) return;
    const stage = new TvRowStage({ hero, strip, layers: [a, b], plates: [pa, pb], infos: [ia, ib], prev, prevTrack });
    stageRef.current = stage;
    shownAt.current = liveActive.current;
    stage.cut(describeLatest.current(slotAt(shownAt.current)), peekLatest.current(shownAt.current));
    prefillSoon();
    return () => { stage.destroy(); if (stageRef.current === stage) stageRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRow]);

  /* THE FRONT CARD, KEPT TRUE WHILE THE WALK STANDS STILL. What is on the billboard changes without
   * a press when the row is first allowed its artwork, when `enrich` finds a backdrop or a synopsis
   * a card arrived without, when the end card's label flips to "loading", or when the language
   * changes. The signature is everything the stage would paint, so an unrelated render — a dwell
   * firing, a query settling — compares equal and does nothing. */
  const frontDesc = describeSlot(slotAt(shownAt.current));
  const frontPeek = peekFor(shownAt.current);
  const stageSig = `${frontDesc.key}|${(frontDesc.glance || []).map((g) => g.text).join('\u0001')}|${frontDesc.meta.join('\u0001')}|${frontDesc.plot}|${frontPeek.art ? `${frontPeek.art.src}|${frontPeek.art.pos}` : '-'}`;
  useEffect(() => {
    const changed = stageRef.current?.refresh(describeLatest.current(slotAt(shownAt.current)), peekLatest.current(shownAt.current));
    /* NOT ON EVERY COMMIT. After a walk this effect runs because React has caught up with a card the
     * stage is already showing — nothing changed — and re-arming the prefill then pushed the next card's
     * build to ~800ms after the press, past the moment a person tapping at an ordinary pace presses
     * again, so that press built the card (synopsis layout and all) inside its own key handler. A
     * prefill the press already scheduled is left where it is; one that has run is re-armed, which is a
     * key comparison if the next card is unchanged and a rebuild if its facts have moved — AT THE WALK'S
     * PACE: a hold's catch-up re-arming at the deliberate 420ms is what pushed every other held step's
     * card past the next step (traced: prefilled, built-in-the-press, prefilled, built-in-the-press…). */
    if (changed || !prefillTimer.current) prefillSoon(paceHeld.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSig]);

  /* ---- A NEW CATALOGUE IS A NEW ROW ---------------------------------------------------------
   * The three top-level pages share one component instance, so nothing about a route change resets
   * this row on its own: the walk stays where it was on the previous page and the layers still hold
   * its artwork. Landing on Anime at card nine of Movies is not a state anyone asked for.
   *
   * DETECTED FROM THE HEAD OF THE LIST rather than from a `cat` prop, because these rows are not
   * given one — TvCatalogRow passes items and nothing else. The first title's id is the cheapest
   * thing that changes when the catalogue does and stays put when it does not: appending a page
   * of results does not touch it, and neither does `enrich` filling artwork into a card already
   * on screen.
   *
   * THE BILLBOARD IS CUT, NOT DISSOLVED. A cross-fade means "this row moved to its neighbour", and a
   * whole page changing underneath is not that: dissolving Movies' billboard into Anime's would read
   * as one row walking sideways across a page boundary. The stage cuts into the layer that is
   * ALREADY in front, so `.on` never moves and nothing transitions. */
  const headId = list.length ? String(list[0].id) : '';
  const prevHead = useRef(headId);
  useEffect(() => {
    if (prevHead.current === headId) return;
    prevHead.current = headId;
    /* So the row is also marked for the length of the change and the stylesheet takes every
     * transition off (`.tv-spot.is-cut`, beside the `is-fast` block it is modelled on): whatever the
     * strip, the plates or the copy would otherwise do, nothing animates. The timer outlasts
     * `SWAP_WAIT_CAP` deliberately — the only thing it can wrongly catch is a walk begun inside a
     * quarter second of arriving on a new page. */
    const cutEl = sectionRef.current;
    cutEl?.classList.add('is-cut');
    if (cutId.current) window.clearTimeout(cutId.current);
    cutId.current = window.setTimeout(() => {
      cutId.current = 0;
      cutEl?.classList.remove('is-cut');
    }, SWAP_WAIT_CAP + 60);
    /* The strip goes back to its origin with the walk, and it must not be seen travelling there:
     * `is-cut` silences the billboard's transitions but the strip's own is a separate rule, so the
     * hop is flagged for the layout effect that writes `--active`. A swap still waiting on a decode
     * belongs to the catalogue just left. */
    liveActive.current = 0;
    stripPos.current = 0;
    silentHop.current = true;
    syncOwed.current = false;
    if (syncId.current) { window.clearTimeout(syncId.current); syncId.current = 0; }
    gate.current.id++;
    window.clearTimeout(gate.current.timer);
    gate.current.timer = 0;
    shownAt.current = 0;
    setActive(0);
    setPos(0);
    stageRef.current?.cut(describeLatest.current(list[0]), peekLatest.current(0));
    prefillSoon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headId]);

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
   * AHEAD IN THE DIRECTION OF TRAVEL, AND FURTHER THAN ONE CARD. It was one card either way, and
   * that is the whole difference between a catalogue row that glides and a movie row that does
   * not. On an add-on row the billboard IS the tile's picture — one URL, promoted nine tiles ahead
   * of the walk — so the gate below always finds it decoded and flips on the press frame. On a row
   * with baked poster art the tile is a portrait slice and the billboard a separate 16:9 backdrop
   * plus a wordmark, and only THIS warm stood between the press and a cold decode. One card of it
   * is gone after one press. So: three ahead the way the remote last went, one behind.
   *
   * ONE WARM IN FLIGHT, AND IT IS NOT CANCELLED BY A PRESS. It used to be an effect that cancelled
   * its idle callback in cleanup and re-armed it on every change of `active` — the exact defect
   * `promoteSoon` records for the tiles: at a walking cadence the callback is rebuilt before it
   * can run, so a sequence of presses warmed NOTHING and every one of them sat out the gate's cap.
   * Now every press calls `warmSoon`, which does nothing if a warm is already pending, and the one
   * that runs reads where the walk IS then (`liveActive`, `lastDir`) through a ref to this
   * render's closures, so it warms around the viewer rather than around the press that armed it.
   *
   * RETAINED, WHICH IS THE POINT OF THE WARM. Dropping the element the moment it had decoded made
   * the decoded frame immediately evictable, so the warm bought a cached BYTE RANGE and the gate
   * paid for the decode anyway. The ceiling is RETAIN_MAX, global, so this does not scale with
   * rows on screen. Farthest first, so the NEXT card is the most recently retained and the last
   * to be evicted.
   *
   * ON THE IDLE FRAME, for the reason the tile promotion records: decoding artwork on the keypress
   * frame measured WORSE than not windowing at all, because it lands on the one frame that is
   * animating a cross-fade. Between presses the row is doing nothing. */
  /* SIX AHEAD, NOT THREE. The billboard needed three; the TILES need the rest. A tile is the same picture
   * as its billboard, and the one sliding in at the right-hand edge on a press is four or five cards
   * ahead of the walk — beyond a three-card warm, so on a set it could arrive still decoding. Six covers
   * every card a press can bring on screen (RETAIN_MAX in useImageReady holds them). */
  const BILLBOARD_WARM_AHEAD = 6;
  const BILLBOARD_WARM_BEHIND = 1;
  const warmNow = () => {
    if (!artOn || stops < 2) return;
    const at = liveActive.current;
    const dir = lastDir.current;
    const order: number[] = [];
    for (let d = BILLBOARD_WARM_BEHIND; d >= 1; d--) order.push(mod(at - dir * d, stops));
    for (let d = BILLBOARD_WARM_AHEAD; d >= 1; d--) order.push(mod(at + dir * d, stops));
    for (const i of order) {
      const slot = slotAt(i);
      if (!slot || slot === 'end') continue;
      const art = withArt(slot);
      /* THE WORDMARK IS WARMED WITH THE PHOTOGRAPH, because the swap waits for BOTH (see the gate
       * above) and a gate is only free if everything it waits on is already in hand. */
      for (const url of [billboardUrl(art), logoOf(art) || '']) {
        if (!url) continue;
        const img = retainImage(url);
        if (warmDecoded.has(img)) continue;
        warmDecoded.add(img);
        if (typeof img.decode === 'function') img.decode().catch(() => { /* 404 / expired signature — the gate's cap covers it */ });
      }
    }
  };
  const warmLatest = useRef(warmNow);
  warmLatest.current = warmNow;
  const warmId = useRef(0);
  const warmSoon = () => {
    if (warmId.current) return;
    const run = () => { warmId.current = 0; warmLatest.current(); };
    const ric = window.requestIdleCallback;
    warmId.current = typeof ric === 'function' ? ric(run, { timeout: 600 }) : window.setTimeout(run, 120);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { warmSoon(); }, [artOn, active, stops, artById]);
  useEffect(() => () => {
    if (!warmId.current) return;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(warmId.current);
    else window.clearTimeout(warmId.current);
  }, []);

  /* ---- THE ROW GOT SHORTER UNDER THE WALK ------------------------------------------------------
   * The walk can outlive the number of stops it indexes: it is parked on the "+" card at position
   * n, the batch it asked for turns out to be empty, and the card is withdrawn — so `stops` falls to
   * n while the walk still says n. The tile under the billboard already shows title 0 (positions
   * are counted modulo `stops`); this brings the billboard into agreement with it. Reducing modulo
   * `stops` rather than clamping keeps every position's title where it is — the window is counted
   * from the anchor and only its value mod `stops` matters — so no tile remounts. A catalogue
   * change is not this case; it resets both halves itself above. */
  useEffect(() => {
    if (stops > 0 && liveActive.current >= stops) {
      liveActive.current = mod(liveActive.current, stops);
      syncOwed.current = true;
      syncNow();
      shownAt.current = liveActive.current;
      stageRef.current?.refresh(describeLatest.current(slotAt(shownAt.current)), peekLatest.current(shownAt.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  /* ---- THE REBASE: ONCE PER ~2000 PRESSES, AT REST, AND NEVER SEEN ----------------------------
   * See TILE_KEYS. Armed after the slide has had time to finish and cancelled by the next press
   * (the effect re-runs on `pos`); it only fires on a strip that has genuinely stopped, and it
   * moves the position by a multiple of TILE_KEYS so every key and every title survives. The
   * layout effect below suppresses the transition around the write. */
  useEffect(() => {
    if (pos < REBASE_AT || syncOwed.current) return;
    const id = window.setTimeout(() => {
      if (syncOwed.current || stripPos.current !== pos) return;   // pressed again since; try later
      const laps = Math.floor(pos / TILE_KEYS) - 1;
      stripPos.current = pos - laps * TILE_KEYS;
      silentHop.current = true;
      setPos(stripPos.current);
    }, SLIDE_MS + SLIDE_CHAIN_WINDOW);
    return () => window.clearTimeout(id);
  }, [pos]);

  /** How many end cards stand before physical position `sp` — the strip's half of the room each one
   *  takes (see `tileLeft`). Read from the walk's truth, `liveActive`, which every writer moves
   *  together with `stripPos`; the tiles get the same count from the committed pair in `thumbs`. */
  const endsAt = (sp: number): number => (hasEnd && stops ? endsBefore(sp, mod(sp - liveActive.current + n, stops), stops) : 0);
  /** The one writer of the strip's position: two custom properties the stylesheet turns into a
   *  transform (with a transition, which is the compositor's from there) — the tile under the walk,
   *  and how many end cards the walk has passed to get there. */
  const putActive = (el: HTMLElement, v: number) => {
    el.style.setProperty('--active', String(v));
    el.style.setProperty('--ends', String(endsAt(v)));
  };

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
      /* THE HOP IS SILENT. A catalogue cut or a rebase moves the strip by many tiles in one commit
       * and the tiles at the destination carry the same pictures (a cut re-keys them, a rebase
       * keeps them), so the write must not animate: the transition is taken off, the value written
       * and flushed, and the transition handed back — the same two-write shape the old wrap used,
       * now for a case that happens once per page change or once per two thousand presses. */
      /* SO IS THE ROW LENGTHENING UNDER A WALK THAT HAS PASSED AN END CARD. That moves where the end
       * cards stand, so the tiles take new places in this commit (`thumbs`) and the strip must take
       * its own without being seen to travel. A press writes both values itself in `step`, so after
       * one they already agree here; and a strip that has never had the value written (mount) has
       * nothing to suppress, so it is not made to pay the forced layout below. */
      const had = t.style.getPropertyValue('--ends');
      if (silentHop.current || (had !== '' && had !== String(endsAt(stripPos.current)))) {
        silentHop.current = false;
        t.style.transition = 'none';
        putActive(t, stripPos.current);
        void t.offsetWidth;
        t.style.transition = '';
      }
      putActive(t, stripPos.current);
    }
    /* `is-open` is owned by the node too, for the reason above: it is deliberately NOT in the
     * rendered className, so a render triggered by anything else cannot write a stale value over
     * the class the focus handler already set. `is-primed` likewise (see `primeSoon`). */
    sectionRef.current?.classList.toggle('is-open', openRef.current);
    sectionRef.current?.classList.toggle('is-primed', primedRef.current);
  });

  /* ---- FOCUS PAINTS IMMEDIATELY, COMMITS LATER ----------------------------------------------
   * The class is the whole visible effect of gaining or losing focus, and it costs one classList
   * write. The state commit behind it re-runs the effects that arm the preview and the prefetches
   * — none of which anyone can perceive inside half a second — so it is held
   * until the scroll ease has finished rather than landing in the middle of it.
   *
   * OPEN_COMMIT_MS tracks TvSpatialNav's SCROLL_MS. Holding a direction keeps re-scheduling it, so
   * a run down the page produces ONE commit per row that is actually stopped on, instead of two
   * full row re-renders per press on the way past. */
  const setOpenNow = (v: boolean) => {
    openRef.current = v;
    sectionRef.current?.classList.toggle('is-open', v);
    /* Leaving: nothing owed to this row's resting card is wanted any more — not in 420ms, now. */
    if (!v) cancelDetailWarm();
    primeSoon();
    if (openCommit.current) window.clearTimeout(openCommit.current);
    openCommit.current = window.setTimeout(() => {
      openCommit.current = 0;
      setOpen(v);
    }, OPEN_COMMIT_MS);
  };

  /* ---- THE ROW SAYS WHEN IT HAS BEEN REACHED --------------------------------------------------
   * A home row now opens at forty titles and /api/home carries about twenty of them, so the rest
   * have to be fetched — and the only interesting question is WHEN.
   *
   * NOT ON MOUNT, for the reason TvHomeRow's header already gives about its own query: a home
   * screen holds thirteen of these, and arming a catalogue request per row on load puts thirteen of
   * them on the network at exactly the moment the artwork is loading, for rows nobody has walked
   * to. NOT ON `visible` either — that latch fires a screenful early and for every row you merely
   * scroll past, which is most of them.
   *
   * FIRST FOCUS is the honest trigger: one request for the row the remote is actually standing on,
   * arriving while the viewer is still reading the billboard, and by the time they have walked the
   * ten cards they can see, the other thirty are there.
   *
   * KEYED ON `open`, NOT ON THE FOCUS HANDLER, and that is what keeps it cheap. `open` is the
   * COMMITTED state — OPEN_COMMIT_MS after the press, see setOpenNow — so running down the page
   * fires this once per row genuinely stopped on, rather than twice per press on the way past.
   * Held in a ref so a parent that rebuilds the callback every render cannot re-run the effect. */
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  /* AND ONLY ONCE THE REMOTE IS STILL ON IT. "First focus" was the commit 420ms after the press that
   * reached the row, which at a walking pace is just before the next press — so the page request, the
   * longer list it hands back and the render of it all landed in the next press's scroll, once for every
   * row a first walk passed through. The viewer who stops here gets it 900ms after their last press;
   * the one walking past never asks for it. */
  useEffect(() => {
    if (!open) return;
    return whenQuiet(() => onOpenRef.current?.(), OPEN_FETCH_QUIET_MS);
  }, [open]);

  /* ---- LOADING MORE NO LONGER MOVES THE STRIP AT ALL ------------------------------------------
   * There used to be a layout-effect re-seat here: with the strip rendered as two copies, every
   * index past the first copy meant a different tile once the row lengthened, so the strip had to
   * be hauled back onto the real index the moment the count changed — before paint, or one frame
   * showed the wrong card (measured mid-hold at 22.6 px/ms against ~1.3 for a legal step).
   *
   * The window counts titles FROM the anchor (see TILES_AHEAD), so a batch appended past the walk
   * changes the titles at positions AHEAD of the card under the billboard and nothing else: those
   * tiles get fresh nodes because their keys carry the title id, the card under the billboard and
   * everything behind it keep theirs, and `--active` does not move. Loading more mid-hold is the
   * case the old fix was for, and it is now the case that needs no fix. */

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

  /* ---- A PRESS: THE NODES FIRST, REACT AFTER ------------------------------------------------
   * Everything a viewer sees change — the strip sliding, the billboard dissolving, the wordmark, the
   * copy, the sliver at the screen edge — is written to the DOM from here, inside the key handler,
   * by the stage (lib/tvRowStage.ts) and one custom-property write. React is told afterwards, in a
   * transition, so the row's own state (the window of mounted tiles, the preview dwell, the
   * prefetches) catches up in slices instead of landing in the press frame. The header of the stage
   * has the measurement: the same press went from 52-61% of frames on time to 98-99%.
   *
   * THE TRUTH IS `liveActive` / `stripPos`, AND `active` / `pos` ARE A MIRROR THAT LAGS. That is safe
   * for the strip because a tile's title is a function of (physical position - anchor), and both
   * halves of the anchor move together on every press: the title at any physical position does not
   * change while the walk advances, so React only has to MOUNT tiles for positions it has not
   * reached yet — and the window carries nine of them ahead of a strip that shows six.
   *
   * A HOLD IS THE SAME CODE WITH A SHORTER SLIDE. `chained` picks the durations, and tv.css's
   * `.is-fast` picks the linear curve; the reasoning behind each number is in the notes at
   * HELD_STEP_MIN_MS and SLIDE_CHAIN_WINDOW above and was not changed. Both halves are required
   * for a hold: recent enough to be one gesture AND the button still down — timing alone cannot tell
   * a held key from a quick second tap. */
  const step = (delta: number, held = false) => {
    const now = performance.now();
    const since = now - lastStepAt.current;
    const chained = held && since < SLIDE_CHAIN_WINDOW;
    /* A held key repeating faster than the row is allowed to walk — see HELD_STEP_MIN_MS. Dropped
     * outright, and `lastStepAt` deliberately not moved, so the pace is measured from the last
     * step the viewer actually saw rather than from the last repeat the platform sent. */
    if (chained && since < HELD_STEP_MIN_MS) return;
    lastStepAt.current = now;
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    lastDir.current = dir;

    /* ---- A HELD KEY GETS THE SLIDE AND NOTHING ELSE ------------------------------------------
     * `is-fast` takes the decoration off while the key is held (the plates and the copy cut instead
     * of dissolving — see tv.css) and is cleared on a timer, so letting go restores the full cascade
     * for the card you actually stop on. */
    const el = sectionRef.current;
    if (el) {
      el.classList.toggle('is-fast', chained);
      if (fastOff.current) window.clearTimeout(fastOff.current);
      fastOff.current = window.setTimeout(() => endChainRef.current(), SLIDE_CHAIN_WINDOW);
    }
    if (paceHeld.current !== chained) { paceHeld.current = chained; stageRef.current?.setPace(chained); }

    const next = mod(liveActive.current + delta, stops);
    liveActive.current = next;
    /* WALKING OFF THE END KEEPS GOING, IT DOES NOT SNAP BACK. The walk wraps (the billboard is
     * title 0 again) and the strip simply moves one more tile, onto the position that shows title 0
     * — see TILES_AHEAD — so every press in either direction is one ordinary tile with its
     * transition on. */
    const sp = stripPos.current + delta;
    stripPos.current = sp;
    syncOwed.current = true;

    /* Whatever was playing belongs to the title just left: it goes the moment focus moves, so one
     * film's trailer is never under another film's name. Only an ARMED preview costs a render here;
     * with none, `dweltRef` is null and this is a comparison. */
    if (dwellId.current) { window.clearTimeout(dwellId.current); dwellId.current = 0; }
    if (dweltRef.current) setDwelt(null);

    const track = trackRef.current;
    if (track) putActive(track, sp);
    showSlot(next, dir, chained);
    scheduleSync(chained);
    promoteSoon();
    warmSoon();
    armDetailWarm();
  };

  /* ---- PAYING THE COMMIT THE WALK RAN UP ---------------------------------------------------
   * Fires SLIDE_CHAIN_WINDOW after the last press, i.e. when the remote has actually let go: it
   * restores the full cascade (drops `is-fast`, puts the deliberate durations back) and hands React
   * the position the walk really reached, which re-arms the preview dwell for the one card the
   * viewer has stopped on. */
  function endChain() {
    /* The chain is over by definition, so whatever we believed about the button is stale. This is
     * the backstop for a platform that drops keyups: without it one missing keyup would make every
     * later press look held. */
    heldKey.current = null;
    fastOff.current = 0;
    /* The copy a hold left unwritten goes up BEFORE `is-fast` comes off, so the one frame in which the
     * stylesheet stops hiding it already has the right words in it. */
    const stage = stageRef.current;
    if (stage && stops > 0) {
      stage.settle(describeLatest.current(slotAt(liveActive.current) ?? list[0] ?? 'end'), lastDir.current < 0 ? -1 : 1, !reduceMotion);
    }
    sectionRef.current?.classList.remove('is-fast');
    if (paceHeld.current) { paceHeld.current = false; stageRef.current?.setPace(false); }
    syncNow();
  }
  endChainRef.current = endChain;

  /** Step now, or — for a tap that came too soon after the last step — once the pace allows. */
  const paced = (delta: number, held: boolean) => {
    if (held) { step(delta, true); return; }   // a hold has its own pace (HELD_STEP_MIN_MS)
    const wait = TAP_STEP_MIN_MS - (performance.now() - lastStepAt.current);
    if (wait <= 0 && !pendingTap.current) { step(delta, false); return; }
    if (pendingTap.current) { pendingTap.current.delta = delta; return; }
    const id = window.setTimeout(() => {
      const p = pendingTap.current;
      pendingTap.current = null;
      if (!p) return;
      // The remote may have left the row (Down, Up, OK) while this waited — then it is not ours.
      if (!sectionRef.current?.contains(document.activeElement)) return;
      // Left off the first card leaves the row only on a press the viewer made there, not on one
      // that was queued behind the walk — a held-back tap that would run off the start just stops.
      if (p.delta < 0 && liveActive.current <= 0) return;
      step(p.delta, false);
    }, Math.max(0, wait));
    pendingTap.current = { delta, id };
  };

  const onHeroKey = (e: ReactKeyboardEvent) => {
    // Left/Right walk the row and are consumed here so the global D-pad handler doesn't also
    // move focus off the billboard. Up/Down bubble on through to it.
    /* A REPEAT, not merely a soon-after press: either the platform says so, or the same arrow was
     * already down when this arrived. Worked out before the branches because Left has an early
     * return of its own and both directions have to record the key either way. */
    const held = e.repeat || heldKey.current === e.key;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') heldKey.current = e.key;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); paced(1, held); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      /* ---- LEFT OFF THE FIRST CARD LEAVES THE ROW --------------------------------------------
       * The walk used to wrap here, so Left on the first title jumped to the last one — a full
       * lap backwards for a press that reads as "go back". There is nothing to the left of the
       * first card, so the press belongs to whatever is outside the row, and on this screen that
       * is the navigation bar.
       *
       * STRAIGHT TO THE PAGE'S OWN NAV ITEM (lib/tvBar.ts), not to the spatial handler. TvSpatialNav
       * already redirects every arrival in the bar to the same item for a reason recorded there —
       * geometry alone picks the search icon or the avatar, because the billboard is full-width
       * and every item is dead ahead. The same destination is chosen here rather than bubbling,
       * so the two paths cannot disagree about where "out of the row" goes. */
      if (liveActive.current <= 0) {
        /* A HELD KEY STOPS AT THE FIRST CARD; only a press made there leaves. Holding Left to rewind
         * the row used to overshoot: the repeat that arrived as the walk reached the start threw focus
         * into the nav bar and scrolled the page, mid-hold. Same rule `paced` keeps for a queued tap. */
        if (held) return;
        const nav = barItemHere() || document.querySelector<HTMLElement>('.tv-nav-item');
        if (nav) { nav.focus(); return; }
      }
      paced(-1, held);
    }
  };

  /* OK opens the title. Plain, and worth a note saying it is plain ON PURPOSE.
   *
   * This briefly handed the billboard's PLAYING trailer to the title screen, which grew it out of
   * this box to fill the screen. It was removed — the full account of what it was and why it went
   * is at the head of TvDetail.tsx, beside the note about the trailer embed that screen had
   * already declined once for the same reason. `useVideoTrailer` accordingly has no `detach` any
   * more: this row owns its preview from the dwell that starts it to the teardown that ends it,
   * and nothing takes it anywhere. */
  /* READS `liveActive`, NOT `active`, AND THAT IS THE ONE CORRECTNESS BUG THIS DESIGN COULD HAVE
   * SHIPPED. The committed state lags the walk on purpose (see `syncNow`), so OK pressed soon after
   * a press would have opened the title the walk had just LEFT — the viewer looking straight at one
   * poster and getting another. The pending commit is flushed first so the row is left in a
   * consistent state either way. */
  const openTitle = () => {
    if (syncOwed.current) syncNow();
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
      onFocus={(e) => {
        // Entering the row (not moving within it): the card on show plays its callouts' arrival.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) stageRef.current?.playFront();
        setOpenNow(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        /* Leaving: its callouts stop (and stand ready to play again, with no forced restart, if the remote
         * comes back) — a row scrolling away must not keep the main thread animating its icons. */
        stageRef.current?.quietFront();
        setOpenNow(false);
      }}
    >
      {/* A plain heading. The web rail's "see all" lives here; on a TV it is the card at the end
          of the strip instead — see the note above `canSeeAll`. */}
      <h2 className="tv-spot-rowtitle">{heading}</h2>

      <div className="tv-spot-stage">
        {/* The strip's window — it carries the clip the stage used to, so the billboard on top is
            free to grow past the row when the remote reaches it. See tv.css. */}
        <div className="tv-spot-rail" ref={railRef}>
          {/* STRIP TRACK — a window of tiles, portrait, each positioned at its own physical
              position; translated so the tile under the walk hides behind the billboard and its
              successors peek to the right. `--active` drives the transform. */}
          <div className="tv-spot-strip" ref={trackRef} role="list">
            {/* A dozen tiles around the walk and no more — the row is endless by arithmetic, so
                the up-next area is never empty near the end and no second copy is ever built
                (see TILES_AHEAD). tabindex -1 → the strip is a preview, not a D-pad stop (the
                billboard is the focus target); a click still opens the title. */}
            {thumbs}
          </div>
        </div>

        {/* THE PREVIOUS CARD, parked just beyond the left screen edge so only its trailing slice
            shows — outside `.tv-spot-rail`, whose left clip begins at the billboard edge. Hidden at
            the head of the row, where nothing has been walked past yet. An EMPTY CONTAINER, the
            stage fills it (see lib/tvRowStage.ts). */}
        <div className="tv-spot-prev" ref={prevRef} style={{ visibility: 'hidden' }} aria-hidden="true">
          <div className="tv-spot-prevtrack" ref={prevTrackRef}>
            {/* Two slots, always: the card going out and the card coming in. */}
            <div className="tv-spot-prevtile" />
            <div className="tv-spot-prevtile" />
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
          {/* TWO LAYERS AND TWO PLATES, EMPTY. The stage fills them and flips `.on` between them;
              the constant className below is why React never rewrites it (a prop that does not
              change is not written), so what the stage sets survives every render. The first layer
              and plate start `.on` so the first paint has a billboard rather than fading one in. */}
          <div className="tv-spot-layer on" ref={layerARef} aria-hidden="false" />
          <div className="tv-spot-layer" ref={layerBRef} aria-hidden="true" />
          {/* THE PLATES ARE THEIR OWN PAIR, NOT CHILDREN OF THE LAYERS — the tag, the wordmark and
              the resume bar change with the picture, while the picture dissolves on its own clock
              underneath (see `.tv-spot-plate` in tv.css). */}
          <div className="tv-spot-plate on" ref={plateARef} aria-hidden="false" />
          <div className="tv-spot-plate" ref={plateBRef} aria-hidden="true" />
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

      {/* INFO — two blocks that trade places like the billboard's layers: the stage builds the next
          one ahead of the press and flips `.on` between them in the same call that swaps the
          picture it describes, and animates the incoming one there too. Height is reserved on the
          container, so opening a row never pushes the rows below it. */}
      <div className="tv-spot-info">
        <div className="tv-spot-infoblk on" ref={infoARef} />
        <div className="tv-spot-infoblk" ref={infoBRef} />
      </div>
    </section>
  );
}
