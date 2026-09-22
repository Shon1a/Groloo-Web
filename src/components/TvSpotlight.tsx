import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW, artW, artPosition } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { tvRowCards } from '../lib/tvRowSize';
import { useVideoTrailer, INTRO_SKIP } from './DetailModal/useVideoTrailer';
import { useMeta, usePrefetchMeta, useImdbTrailer, usePrefetchImdbTrailer, apiIdOf } from '../lib/queries';
import { retainImage, isDecoded } from '../lib/useImageReady';
import { useSettings } from '../stores/settings';
import { previewsAllowed, previewDwellMs } from '../lib/tvPreviewPolicy';
import { registerTvRow, rowIndexOf } from '../lib/tvRowRegistry';
import { parallaxEnabled, springEnabled, tileFadeAlways } from '../lib/tvMotionFlags';
import { tvRowsMode, rowInWindow, subscribeRowWindow, getActiveRowIndex } from '../lib/tvRowWindow';
import { usePreviewSound } from '../stores/previewSound';
import { isPreviewSoundKey } from '../lib/tvKeys';
import { FadeBg, FadeImg } from './FadeArt';
import { prefetchArt } from '../lib/artPrefetch';

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
/** Where a tile at physical position `p` sits in the strip, as CSS — the strip's own pitch. */
const tileLeft = (p: number): string => `calc(${p} * (var(--sp-wp) + var(--sp-gap)))`;

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
const BILLBOARD_PARALLAX_HELD = '1.6%';
const HELD_PARALLAX_MS = 180;
const BILLBOARD_PARALLAX_PRESS = '3.2%';
const PRESS_PARALLAX_MS = 300;

/* ---- HOW LONG THE STRIP TAKES TO MOVE ONE CARD. Reasoning is at `step`. -------------------- */
/** A deliberate press. MEASURED OFF A CLEAN 1080p30 CAPTURE, three presses identical to the frame:
 *  116, 81, 54, 35, 21, 12, 6, 3, 1 px — 329px, which is one poster pitch, over 8 frames = 267ms.
 *  The curve that reproduces it is `cubic-bezier(.33,1,.68,1)`, a cubic ease-out, fitted at 1.30%
 *  RMS against the nine points; the full table of what else was tried, and the account of the two
 *  values that shipped before this one (430ms quadratic, then 230ms quintic), is on the strip's
 *  `transition` in tv.css. MOVE THE TWO TOGETHER — a duration without its curve is how the last
 *  pair went wrong. */
const SLIDE_MS = 267;

/* ---- THE TWO ART LAYERS DO NOT TRADE PLACES SYMMETRICALLY ------------------------------------
 * The outgoing picture collapses in its first two frames and keeps a long tail; the incoming one
 * rises evenly. Composited as stacked siblings their opacities do not sum to 1, so the billboard
 * passes through a dark trough — bottoming at 0.59 against 0.75 for the symmetric pair this
 * replaces. That asymmetry IS the transition — the full measurement, and the two wrong answers it took to find it, are on
 * `.tv-spot-layer` in tv.css.
 *
 * A HELD KEY GETS NEITHER — it gets a symmetric 90ms, for the reason ART_FADE_MS_CHAINED exists:
 * neither duration fits inside the 300ms of a held press, and a trough repeated four times a
 * second is a flicker rather than a beat. Written to `--sp-layer-out` and `--sp-layer-fade`. */
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
const SPRING_K = 620;
const SPRING_C = 50;

/* A genuine overlap: the previous billboard remains readable while the next one rises through it.
 * Equal clocks avoid the hold-then-cut produced by the old asymmetric pair. */
const LAYER_OUT_MS = 210;
const LAYER_FADE_MS = 190;
const LAYER_OUT_MS_CHAINED = 150;
const LAYER_FADE_MS_CHAINED = 150;
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
const HELD_SLIDE_MS = 340;   // a little LONGER than the 300ms pace, per the note above

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
 * So the tile shows the w1280 backdrop itself at that position: the same source pixels, framed
 * identically, and now the same file, the same cache entry and the same decoded bitmap as the
 * billboard — which is what makes a movie row behave like an add-on row.
 *
 * w1280 AND NOT w780 because the tile needs it: its slice is 34.6% of the width, 443 source pixels
 * at w1280 — exactly what the pre-cut had — against 270 at w780, which is the softness the crop was
 * invented to fix. It costs less than it replaced: one 1280x720 bitmap (3.7MB) where there were a
 * 640x1040 slice and a 780x439 backdrop (4.1MB), and one decode instead of two. The billboard gets
 * sharper for free. A dpr-1 screen cannot show the difference, so it keeps w780.
 *
 * Only when the crop really is a slice of THIS backdrop: the file named in the crop URL has to be
 * the backdrop's file. Anything else — no crop, a crop of another frame — renders as before. */
const SHARED_RENDITION =
  (typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5) ? 'w1280' : BILLBOARD_RENDITION;
function sharedArtOf(it: MediaItem): PeekArt | null {
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
  const cut = artW(it.posterArt);
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
  const cut = one ? '' : artW(it.posterArt);
  const shared = one ? '' : imgW(it.backdrop || '', BILLBOARD_RENDITION);
  return {
    src: one?.src || cut || shared || imgW(it.poster || '', THUMB_RENDITION),
    fallbackSrc: one ? artW(it.posterArt) : cut ? (shared || '') : (shared ? imgW(it.poster || '', THUMB_RENDITION) : ''),
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
  const source = enrich ? it.backdrop : (it.backdrop || it.poster);
  return imgW(source || '', BILLBOARD_RENDITION);
}

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
          className="tv-spot-thumbimg"
          data-src={src}
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
      {!!name && <span className="tv-spot-thumbscrim" aria-hidden="true" />}
      {name === 'text' && (
        <span className="tv-spot-thumbtitle" aria-hidden="true">{it.title}</span>
      )}
      {!!mark && (
        <img
          className="tv-spot-thumbmark"
          data-src={mark}
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
  onGo: () => void;
}

const EndTile = memo(function EndTile({ left, label, icon, heading, onGo }: EndTileProps) {
  return (
    <button
      type="button"
      role="listitem"
      tabIndex={-1}
      className="tv-spot-thumb is-seeall"
      style={{ left }}
      aria-label={`${heading} — ${label}`}
      onClick={onGo}
    >
      <span className="tv-spot-blank-ic" aria-hidden="true">{icon}</span>
      <span className="tv-spot-blank-label">{label}</span>
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
  /* ---- THE PEEK'S OUTGOING CARD, CARRIED ONE RENDER FORWARD --------------------------------
   * The two-tile peek needs the poster it is REPLACING as well as the new one. These live up here
   * rather than beside the markup that uses them because there is an `if (!n) return null` between
   * the two, and a hook below an early return does not run on an empty row — the rules-of-hooks
   * trap this file's shape sets, and which it already warns about at the `--active` layout effect.
   *
   * The effect carries no dependency array on purpose: it runs after every commit and simply moves
   * "current" into "previous", so the render below always sees the value from the commit before it.
   * Writing `peekSrcRef` during render is the same thing `liveActive` already does here. */
  const prevOutRef = useRef<PeekArt>(EMPTY_PEEK);
  const peekSrcRef = useRef<PeekArt>(EMPTY_PEEK);

  /* ---- THE PEEK SLIDES BY `animate()`, NOT BY REMOUNTING ------------------------------------
   * IT WAS A KEYED REMOUNT, and that is what made the peek go blank for the whole slide. A CSS
   * animation only restarts if the element is new, so the track was keyed on the incoming poster —
   * which remounted BOTH `FadeImg`s with it. Each one then began at `opacity: 0`, re-ran
   * `useImageReady` from scratch and faded up over 220ms, so the cards were invisible during
   * exactly the movement they were supposed to be performing.
   *
   * MEASURED, recording the built page and running the reference's own pipeline over it: the peek
   * band held mean 8.7 / sd 1.1 — a flat colour with no texture, which is the container's gradient
   * showing through two transparent images — for 280ms, and the poster only appeared at 320ms,
   * after the slide had finished. The reference never drops below sd ~9 and is textured throughout.
   *
   * `Element.animate` needs no remount, so the images keep their decoded bitmaps and their opacity.
   * Keyed on the incoming poster, which is what "the peek changed" means; the resting transform
   * stays in CSS, so when the animation releases there is nothing to snap back to. */
  const prevTrackRef = useRef<HTMLDivElement>(null);
  const peekAnim = useRef<Animation | null>(null);
  const peekFirst = useRef(true);
  useEffect(() => () => { peekAnim.current?.cancel(); if (cutId.current) window.clearTimeout(cutId.current); }, []);
  useEffect(() => {
    if (peekFirst.current) { peekFirst.current = false; return; }
    const el = prevTrackRef.current, root = sectionRef.current;
    if (!el || !root || reduceMotion) return;
    const dir = Number(getComputedStyle(root).getPropertyValue('--sp-dir')) || 1;
    /* ---- THE STRIDE IS MEASURED, NOT READ OFF A CUSTOM PROPERTY -----------------------------
     * `--sp-wp` and `--sp-gap` are UNREGISTERED, so their computed value is the token stream they
     * were written as — `calc(clamp(240px, …) * 0.615)` — and `parseFloat` of that is NaN. The
     * guard below then swallowed it and the slide silently never ran: probed in the browser,
     * `getAnimations()` returned 0 and the track sat at its resting -329px through every press.
     * The distance between the two tiles is the same number, already resolved, and costs one
     * layout read per deliberate press. */
    const tiles = el.children;
    if (tiles.length < 2) return;
    const stride = tiles[1].getBoundingClientRect().left - tiles[0].getBoundingClientRect().left;
    if (!Number.isFinite(stride) || stride <= 0) return;
    const end = dir > 0 ? -stride : 0;

    /* ---- A HELD KEY GLIDES, IT DOES NOT RE-RUN --------------------------------------------
     * THE DEFECT: holding a direction made the up-next posters glide while the peek stepped, since
     * this effect used to bail on `is-fast` entirely. It is the same rail; it has to move like one.
     *
     * WHY IT CANNOT SIMPLY REPLAY. A held press arrives every 300ms (HELD_STEP_MIN_MS) into a
     * 260ms glide, so the previous run is ~85% done when the next begins. Restarting from the
     * nominal start would throw the content backwards by the missing 15% — the stutter this row
     * spent a whole pass removing from the strip itself.
     *
     * THE SWAP IS WHAT MAKES CONTINUING EXACT. When the pair advances, the outgoing tile takes the
     * incoming one's place, so the SAME picture that was at track position x is now at x - stride.
     * Adding one stride to wherever the transform actually is therefore names the identical frame
     * under the new pair, and the glide carries on from precisely where it was rather than from
     * where it would have been. The extra distance is real and wanted: the walk owes it.
     *
     * Read BEFORE cancelling — cancelling reverts the computed transform to the resting value, and
     * then there is nothing left to continue from. That is also why the animation is held in a ref
     * and torn down on unmount rather than in this effect's cleanup, which runs first. */
    const held = root.classList.contains('is-fast');
    const prev = peekAnim.current;
    let from = end + dir * stride;
    if (prev && prev.playState === 'running') {
      from = new DOMMatrixReadOnly(getComputedStyle(el).transform).e + dir * stride;
      prev.cancel();
    }
    /* Linear while held, for the reason the strip is (see HELD_SLIDE_MS): a decelerating curve
     * re-aimed four times a second reads as a sequence of little arrivals rather than one move. */
    peekAnim.current = el.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${end}px)` }],
      held
        ? { duration: HELD_SLIDE_MS, easing: 'linear' }
        : { duration: SLIDE_MS, easing: 'cubic-bezier(.33, 1, .68, 1)' },
    );
    /* KEYED ON `active`, NOT ON THE POSTER URL. `peekSrcRef` is assigned in the render body BELOW
     * this hook, so reading it as a dependency captures the value from the PREVIOUS render and the
     * slide fires a press late — measured as a peek band frozen at mean 69.3 / sd 17.1 for the
     * whole press while the strip travelled underneath it. `active` is state declared above, it
     * changes exactly when the peek's card does, and it is already what every other press-driven
     * effect in this file hangs off. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
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
    const held = root.classList.contains('is-fast');
    const cs = getComputedStyle(root);
    const dir = Number(cs.getPropertyValue('--sp-dir')) || 0;
    if (!dir) return;   // the first paint of a row was not reached by a press; nothing to explain
    /* NOT `--sp-slide`. The strip's held duration (HELD_SLIDE_MS, 260ms) is deliberately LONGER
     * than the press pace so that it never completes and never stalls — and a drift built to the
     * same number would inherit exactly the overlap this is arranged to avoid. */
    const slide = held ? HELD_PARALLAX_MS : PRESS_PARALLAX_MS;
    const distance = held ? BILLBOARD_PARALLAX_HELD : BILLBOARD_PARALLAX_PRESS;
    const from = `translateX(calc(${dir} * ${distance}))`;
    const away = `translateX(calc(${-dir} * ${distance}))`;
    /* THE PICTURE MOVES, NOT THE LAYER. The layer also carries the title plate, and the reference
     * holds that still — drifting it would make the billboard slide as one panel, which is the
     * opposite of parallax. `.tv-spot-art` is the photograph alone, and it is overscanned in
     * tv.css so the drift never pulls an edge into frame. */
    const anims = Array.from(root.querySelectorAll<HTMLElement>('.tv-spot-art')).map((el) => {
      const entering = !!el.closest('.tv-spot-layer')?.classList.contains('on');
      return el.animate(
        entering ? [{ transform: from }, { transform: 'none' }] : [{ transform: 'none' }, { transform: away }],
        { duration: slide, easing: held ? 'linear' : 'cubic-bezier(.22, 1, .36, 1)' },
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
     * What DID matter was the curve. That reasoning belonged to the deliberate drift, which is now
     * gone; a held drift is linear and has nothing to be in step with but the pace. */
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
  /* Per TITLE, not per row: an Animation entry sitting in a mixed row still wants its own framing,
   * and the row a thing appears in says nothing about how it was shot. See the crop constants. */
  const trailerCrop = isAnimated(dwelt) ? TRAILER_CROP_NATIVE : TRAILER_CROP_LETTERBOXED;
  /* Written to the node rather than held in state, and set on the SECTION so it inherits down to
   * the slot: this changes at most once per dwell, long after the keypress it followed, and a
   * re-render of the whole row to carry one number would be work the shelf cannot afford. */
  useEffect(() => {
    sectionRef.current?.style.setProperty('--sp-trailer-crop', String(trailerCrop));
  }, [trailerCrop]);
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
      /* MUST BE THE SAME NUMBER THE STYLESHEET IS SCALING BY — it tells the engine how much CSS
       * magnifies the video over its box, so a preview cropped 1.35x is sampled at 1.35x. The one
       * value drives both, through `--sp-trailer-crop` below. */
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
  const PREFETCH_TITLES = 7;
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
    prefetchArt(urls, () => {
      const focused = rowIndexOf((document.activeElement?.closest('.tv-spot') as HTMLElement | null) ?? null);
      if (myRow.current < 0) return 99;
      return focused < 0 ? myRow.current : Math.abs(myRow.current - focused);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artOn, list, n]);

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
    /* Nothing left of the origin. Left off the first title leaves the row for the nav bar (see
     * `onHeroKey`), so in the first lap a tile at a negative position could never be walked back
     * onto — it would be two clipped, decoded posters per row that the old strip never held. Once
     * the walk has wrapped, or been rebased, the two behind are at positive positions anyway. */
    for (let p = Math.max(0, pos - TILES_BEHIND); p <= pos + TILES_AHEAD; p++) {
      const slot = slotAt(itemAt(p));
      const k = mod(p, TILE_KEYS);
      if (slot === 'end') {
        out.push(<EndTile key={`${k}:end`} left={tileLeft(p)} label={endLabel} icon={endIcon} heading={heading} onGo={goEndStable} />);
      } else if (slot) {
        const res = resumeOf?.(slot);
        out.push(<Tile key={`${k}:${slot.id}`} item={slot} left={tileLeft(p)} pct={res?.pct ?? 0} onOpen={openTile} />);
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
      const fade = tileFadeAlways() || firstPromote.current;
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
  /* Both halves of the anchor, together: `pos` is committed beside `active` on every press, so
   * the two refs can never disagree with the two states here. There is no longer anything to haul
   * back when a hold ends — the strip's position IS where the walk is, in a coordinate that does
   * not wrap — so the silent hop this used to arm exists only for the two cases that genuinely
   * teleport the strip (a catalogue cut, the rare rebase), and they set `silentHop` themselves. */
  if (!chaining.current) { liveActive.current = active; stripPos.current = pos; }

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
    /* ---- A CATALOGUE CHANGE IS A CUT, AND THIS IS WHAT ENFORCES IT ---------------------------
     * Rearranging the slots is not enough. A new catalogue also changes `activeKey` — the id of
     * the title under the walk — so the SWAP effect below fires on the same change and dissolves
     * the billboard and slides the copy, which is the walk animation playing itself on a page
     * change. Measured: opening Series from Movies gave 36 frames of copy slide and 21 of
     * cross-fade, and it moved around as the page order changed, because which slot was in front
     * decided whether the two effects happened to cancel.
     *
     * So the row is marked for the length of the change and the stylesheet takes every transition
     * off (`.tv-spot.is-cut`, beside the `is-fast` block it is modelled on). Whatever the slots do,
     * nothing animates.
     *
     * THE TIMER OUTLASTS `SWAP_WAIT_CAP` deliberately: the swap can be held up to 200ms waiting on
     * the incoming bitmap to decode, so a class dropped on the next frame would be gone before the
     * flip it exists to silence. 260ms is that cap plus a frame, and the only thing it can wrongly
     * catch is a walk begun inside a quarter second of arriving on a new page. */
    const cutEl = sectionRef.current;
    cutEl?.classList.add('is-cut');
    if (cutId.current) window.clearTimeout(cutId.current);
    cutId.current = window.setTimeout(() => {
      cutId.current = 0;
      cutEl?.classList.remove('is-cut');
    }, SWAP_WAIT_CAP + 60);
    /* The strip goes back to its origin with the walk, and it must not be seen travelling there:
     * `is-cut` silences the billboard's transitions but the strip's own is a separate rule, so the
     * hop is flagged for the layout effect that writes `--active`. The refs move now, because the
     * render this commit triggers re-syncs them from state and the two must already agree. */
    liveActive.current = 0;
    stripPos.current = 0;
    silentHop.current = true;
    setActive(0);
    setPos(0);
    /* ---- THE CUT KEEPS WHICHEVER LAYER IS ALREADY IN FRONT ----------------------------------
     * This wrote `{ a: list[0], b: null, front: 'a' }`, which is a cut in every respect except
     * one: it MOVES `front`. If the row had been walked an odd number of times, front was 'b', so
     * forcing it to 'a' handed `.on` to the other pair of elements — and both of them animate when
     * they receive it. The copy slid in from the side and the billboard cross-dissolved, on a page
     * change, which is precisely the "the row plays its walk animation on its own" this whole pass
     * is about.
     *
     * MEASURED: opening Series from Movies gave 24 frames of copy slide and 14 of cross-fade, and
     * ONLY on that transition — because the first reset leaves front at 'a', so every later page
     * change already matched and moved nothing. An intermittent fault with a one-shot cause.
     *
     * Writing the new title into the slot that is ALREADY front keeps `.on` where it is, so
     * nothing transitions and the change is the hard cut it was always meant to be. */
    setXfade((s) => (s.front === 'a'
      ? { a: list[0], b: null, front: 'a' }
      /* `a` is left as it was rather than nulled — it is the BACK layer here, so it is already at
         opacity 0 and invisible, and the slot is not nullable anyway. */
      : { ...s, b: list[0] }));
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
    /* ---- `n` IS NOT A DEPENDENCY, AND REMOVING IT IS THE FIX FOR A SPURIOUS WALK -------------
     * It was here for the load-more card, on the reasoning that pressing OK on it does not move
     * the walk — the position simply stops being the end card and becomes a real title — so the
     * length was the only thing that changed and the billboard had to be told. That case is real.
     * The dependency is not: `activeKey` ALREADY covers it, because standing on the end card it
     * reads 'end' and becomes the new title's id the moment the batch lands.
     *
     * What the length dependency did instead was fire on EVERY change of it, including the one
     * that has nothing to do with the walk: a row fetches its full catalogue the first time the
     * remote settles on it (see `onOpen`), so arriving from ABOVE grew the list from the seeded
     * ~20 to 40 and ran a cross-dissolve plus the copy's slide for a title that had not changed.
     *
     * MEASURED, both in the capture and in the browser. In a 60fps recording of a Down press the
     * synopsis jumped +42px right and eased back to 0 — and 42px is `--sp-copy-slide` exactly
     * (--sp-wl x 0.046 = 41.6px at 1080p), which is the horizontal WALK animation running on a
     * VERTICAL press. Traced live it is unmistakable: row "Trending Movies", tiles 81 (i.e. it had
     * just grown to 40 titles), copy transform 41.6 -> 38.8 -> 36 -> … -> 0 with no press but Down.
     *
     * Keyed on what is SHOWN rather than on how much there is to show, the row can grow underneath
     * a settled billboard without disturbing it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeKey]);

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
  const BILLBOARD_WARM_AHEAD = 3;
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

  /* ---- A JUMP IS NOT SLID, AND ONLY TWO THINGS JUMP -------------------------------------------
   * Compared in the strip's OWN coordinate. This used to compare the walk index, which wraps — so
   * stepping off the end card read as a jump of `stops` and the transition was killed on the very
   * press that is now the point of the endless strip. `pos` moves by exactly one per press, so a
   * difference of more than one is a genuine teleport: a catalogue cut or a rebase, both of which
   * also raise `silentHop` for the layout effect that writes `--active`. This is the belt to that
   * effect's braces — it holds the transition off for two frames after the write so nothing that
   * lands late can pick the hop up and animate it. No interference while a hold is running, when
   * `step()` owns the node. */
  const prevCommitRef = useRef(pos);
  useEffect(() => {
    const prev = prevCommitRef.current;
    prevCommitRef.current = pos;
    if (chaining.current) return;
    const track = trackRef.current;
    if (track && Math.abs(pos - prev) > 1) {
      track.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
    }
  }, [pos]);

  /* ---- THE ROW GOT SHORTER UNDER THE WALK ------------------------------------------------------
   * `active` can outlive the number of stops it indexes: the walk is parked on the "+" card at
   * position n, the batch it asked for turns out to be empty, and the card is withdrawn — so
   * `stops` falls to n while `active` still says n. The tile under the billboard already shows
   * title 0 (positions are counted modulo `stops`); this brings the billboard into agreement with
   * it. Reducing modulo `stops` rather than clamping keeps every position's title where it is —
   * the window is counted from `active` and only its value mod `stops` matters — so no tile
   * remounts. A catalogue change is not this case; it resets both halves itself above. */
  useEffect(() => {
    if (stops > 0 && active >= stops) {
      liveActive.current = mod(active, stops);
      setActive(liveActive.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  /* ---- THE REBASE: ONCE PER ~2000 PRESSES, AT REST, AND NEVER SEEN ----------------------------
   * See TILE_KEYS. Armed after the slide has had time to finish and cancelled by the next press
   * (the effect re-runs on `pos`); it only fires on a strip that has genuinely stopped, and it
   * moves the position by a multiple of TILE_KEYS so every key and every title survives. The
   * layout effect suppresses the transition around the write, and the jump effect above keeps it
   * suppressed for two frames after. */
  useEffect(() => {
    if (pos < REBASE_AT || chaining.current) return;
    const id = window.setTimeout(() => {
      if (chaining.current || stripPos.current !== pos) return;   // pressed again since; try later
      const laps = Math.floor(pos / TILE_KEYS) - 1;
      stripPos.current = pos - laps * TILE_KEYS;
      silentHop.current = true;
      setPos(stripPos.current);
    }, SLIDE_MS + SLIDE_CHAIN_WINDOW);
    return () => window.clearTimeout(id);
  }, [pos]);

  /* ---- THE SPRING ARM: ONE WRITER FOR THE STRIP'S POSITION ---------------------------------
   * Every `--active` write in this component goes through `putActive` so the two arms cannot both
   * own the transform. With the flag off it is exactly the assignment it replaced.
   *
   * THE TARGET IS `stripPos.current` ITSELF, which is what makes retargeting free: `step` already
   * updates that ref before asking for a write, so a press that lands mid-flight changes where the
   * loop is heading without touching where it IS or how fast it is going. That is the whole
   * property a re-aimed CSS transition cannot give — it restarts its curve over the new distance.
   *
   * INSTANT WRITES SNAP BOTH. The wrap re-seat and the silent hop are deliberately invisible jumps
   * between two tiles carrying the same picture; the spring has to be teleported with the node or
   * it would glide the whole way back, which is the 5264px rewind the note below records. */
  const springX = useRef(0);
  const springV = useRef(0);
  const springRaf = useRef(0);
  const springAt = useRef(0);

  const springTick = (now: number) => {
    springRaf.current = 0;
    const t = trackRef.current;
    if (!t) return;
    /* Clamped so a dropped frame or a backgrounded tab cannot fling the strip: at 30fps dt is
     * ~33ms and w*dt stays at 0.83, comfortably inside semi-implicit Euler's stability limit. */
    const dt = Math.min(0.034, Math.max(0.001, (now - springAt.current) / 1000));
    springAt.current = now;
    const target = stripPos.current;
    springV.current += (SPRING_K * (target - springX.current) - SPRING_C * springV.current) * dt;
    springX.current += springV.current * dt;
    if (Math.abs(target - springX.current) < 0.002 && Math.abs(springV.current) < 0.02) {
      springX.current = target;
      springV.current = 0;
      t.style.setProperty('--active', String(target));
      return;                                   // settled — the loop stops until the next press
    }
    t.style.setProperty('--active', springX.current.toFixed(4));
    springRaf.current = requestAnimationFrame(springTick);
  };

  /** `instant` means "this jump must not be seen": snap the spring with the node. */
  const putActive = (el: HTMLElement, v: number, instant = false) => {
    if (!springEnabled()) { el.style.setProperty('--active', String(v)); return; }
    if (instant) {
      if (springRaf.current) { cancelAnimationFrame(springRaf.current); springRaf.current = 0; }
      springX.current = v;
      springV.current = 0;
      el.style.setProperty('--active', String(v));
      return;
    }
    if (springRaf.current) return;               // already flying; `stripPos` is the new target
    springAt.current = performance.now();
    springRaf.current = requestAnimationFrame(springTick);
  };

  useEffect(() => {
    sectionRef.current?.classList.toggle('is-spring', springEnabled());
    return () => { if (springRaf.current) cancelAnimationFrame(springRaf.current); };
  }, []);

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
      if (silentHop.current) {
        silentHop.current = false;
        t.style.transition = 'none';
        putActive(t, stripPos.current, true);
        void t.offsetWidth;
        t.style.transition = '';
      }
      putActive(t, stripPos.current);
    }
    /* `is-open` is owned by the node too, for the reason above: it is deliberately NOT in the
     * rendered className, so a render triggered by anything else cannot write a stale value over
     * the class the focus handler already set. */
    sectionRef.current?.classList.toggle('is-open', openRef.current);
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
  useEffect(() => { if (open) onOpenRef.current?.(); }, [open]);

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
  /* Netflix keeps the immediately previous title parked just beyond the left screen edge. Only
   * its trailing slice is visible; after a Right press the billboard we just left becomes this
   * card, preserving spatial continuity instead of simply disappearing behind the billboard. */
  /* ---- THE FIRST CARD HAS NOTHING BEFORE IT --------------------------------------------------
   * This used to be `(active - 1 + n) % n`, which WRAPS: standing on the first title it resolved to
   * the LAST one and parked it at the screen edge as though the walk had come from there. Nothing
   * has been walked past yet, so there is nothing to leave behind — the reference shows an empty
   * band at the head of a row (measured: mean 0.0, sd 0.10 before the first press, against 21.8 /
   * 16.07 once one has been made).
   *
   * The END CARD keeps its peek: standing past the last title, the last title IS the thing just
   * walked off, and it is the one case where `active` is out of the list's range. */
  const previous = active >= n ? list[n - 1] : (active > 0 ? list[active - 1] : undefined);
  /* THE SAME PICTURE THE TILE WOULD SHOW, chosen the same way — the pre-cut slice if
   * there is one, else the shared backdrop cropped to the tile's shape around the same
   * focal point, else the plain poster.
   *
   * It used to prefer `poster` outright, so the card parked at the screen edge was the
   * one thing in the row still wearing TMDB's own artwork: walking past Reacher left a
   * sliver of the plain poster beside a strip of cut key art. No wordmark on it — only
   * a trailing sliver of this card is ever visible, and the lettering would be off
   * screen anyway. */
  const previousArt: PeekArt = previous && artOn ? peekArtOf(previous) : EMPTY_PEEK;

  /* ---- THE PEEK IS A TWO-TILE STRIP, NOT ONE PICTURE ---------------------------------------
   * MEASURED ON THE REFERENCE: that window is never empty. Its contrast runs 9.2 -> 10.1 -> 10.9
   * -> 22.3 straight through a press and never falls to the floor, because one card is sliding OUT
   * to the left while the next slides IN from behind the billboard. It is a plain slice of the
   * rail, and a rail always has a card in it.
   *
   * A single sliding image cannot reproduce that. Starting one stride to the right puts it wholly
   * outside its own 297px window, so the first half of every press showed the container's gradient
   * and the card then refilled it — the peek blinking while everything beside it slid.
   *
   * So the window holds the OUTGOING and INCOMING cards at the strip's own pitch and the pair is
   * translated by one stride. The DOM order is the strip's order, which flips with direction:
   * pressing Right, the card being replaced sits to the LEFT of its replacement; pressing Left it
   * sits to the right. `lastDir` carries that from `step` into this render. */
  /* ---- CARRY THE OUTGOING POSTER, AND ONLY WHEN IT ACTUALLY CHANGES ------------------------
   * This was an effect with no dependency array, which ran after EVERY commit and copied "current"
   * into "previous". The row re-renders for plenty of reasons that are not a press — the focus
   * commit at OPEN_COMMIT_MS, a dwell timer, a query settling — so by the time the next press
   * arrived the ref had already been overwritten with the current value and BOTH tiles rendered
   * the same poster. Probed in the browser: `Pa5y52cyqWscHR6NnN.jpg` twice, then
   * `kxn7TTNwKP93Vygx4D.jpg` twice. A two-tile strip showing one picture cannot slide.
   *
   * Guarded on the value having moved, it updates exactly once per change however many renders
   * that change is spread across. */
  if (peekSrcRef.current.src !== previousArt.src) {
    prevOutRef.current = peekSrcRef.current;
    peekSrcRef.current = previousArt;
  }
  const outgoingPeek = prevOutRef.current;
  const peekPair = lastDir.current > 0
    ? [outgoingPeek, previousArt]
    : [previousArt, outgoingPeek];

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
  const step = (delta: number, held = false) => {
    const now = performance.now();
    const since = now - lastStepAt.current;
    /* BOTH HALVES ARE REQUIRED. Recent enough to be one gesture, and the button still down —
     * timing alone cannot tell a held key from a quick second tap, and reading it as a hold is
     * what made the row glide (and swallow presses) under deliberate pressing. */
    const chained = held && since < SLIDE_CHAIN_WINDOW;
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
      /* The two art layers, on the same test again. A deliberate press gets the measured pair —
       * fast out, slower in, and the dark trough between them; a hold gets a symmetric 90ms that
       * fits inside its 220ms pace. Same ancestor, same reason — both layers have to inherit it. */
      el.style.setProperty('--sp-layer-out', `${chained ? LAYER_OUT_MS_CHAINED : LAYER_OUT_MS}ms`);
      el.style.setProperty('--sp-layer-fade', `${chained ? LAYER_FADE_MS_CHAINED : LAYER_FADE_MS}ms`);
      /* WHICH WAY THE PRESS WENT. The artwork's drift needs it — it enters from the side the
       * remote came from — and CSS cannot work it out, because CSS only ever sees the new state.
       * +1 is rightward. The COPY does not use it: measured across every frame of the reference,
       * the text's horizontal offset is exactly 0. */
      el.style.setProperty('--sp-dir', delta > 0 ? '1' : '-1');
      /* The peek renders TWO tiles and their DOM order is the strip's order, which depends on
       * which way the walk went — so the direction has to survive into the next render. The
       * custom property above is on the node and React cannot read it while rendering. */
      lastDir.current = delta > 0 ? 1 : -1;
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
    const next = mod(raw, stops);
    liveActive.current = next;

    /* ---- WALKING OFF THE END KEEPS GOING, IT DOES NOT SNAP BACK ---------------------------
     * Measured, on the strip that rendered its titles twice: `--active` ran 8, 9, 10 (the end
     * card) and then 0 — ten cards backwards in one press, suppressed to be instant so it did not
     * rewind the whole strip. Instant or rewound, both read as the row lurching. That strip fixed
     * it for a HELD key by letting the position run on into the duplicate copy and rebasing when
     * the copy ran out, which still left one press in sixteen un-animated, and a deliberate press
     * off the end card still snapped.
     *
     * The window has no copy to run out of. The walk wraps (the billboard is title 0 again) and
     * the strip simply moves one more tile, onto the position that shows title 0 — see
     * TILES_AHEAD — so every press in either direction is one ordinary tile with its transition
     * on. Nothing here is ever rebased; the once-per-two-thousand-presses rebase lives in its own
     * effect and only ever runs on a strip at rest. */
    const sp = stripPos.current + delta;
    stripPos.current = sp;

    /* A DELIBERATE PRESS IS UNCHANGED — the same single commit it always made, so everything that
     * hangs off `active` (the cross-dissolve, the wordmark, the synopsis, the warm-ahead) behaves
     * exactly as measured; `pos` rides in the same batch so the window moves with it. Only a HELD
     * key takes the path below. */
    if (!chained) { setActive(next); setPos(sp); return; }

    /* ---- A HELD PRESS MOVES THE NODE FIRST ---------------------------------------------------
     * The row moves by writing the property the transform reads, on the press frame, before React
     * is involved. The commit follows (see below) but the strip is already travelling by then.
     * The dwell is cancelled by hand because during a hold the effect that owns it is keyed on a
     * title that is deliberately changing under it every press. */
    chaining.current = true;
    if (dwellId.current) { window.clearTimeout(dwellId.current); dwellId.current = 0; }
    const track = trackRef.current;
    if (track) putActive(track, sp);
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
     * The window rides on the same commit: one tile mounts at the leading edge, one unmounts at
     * the trailing edge, and the ten between them are `memo` bail-outs. The strip is still moved
     * by the node write above, so it starts travelling on the press frame rather than waiting for
     * React — that half of the decouple is what still earns its keep. */
    setActive(next);
    setPos(sp);
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
    /* The chain is over by definition, so whatever we believed about the button is stale. This is
     * the backstop for a platform that drops keyups: without it one missing keyup would make every
     * later press look held. */
    heldKey.current = null;
    const el = sectionRef.current;
    if (el) {
      el.classList.remove('is-fast');
      el.style.setProperty('--sp-slide', `${SLIDE_MS}ms`);
      el.style.setProperty('--sp-art-fade', `${ART_FADE_MS}ms`);
      el.style.setProperty('--sp-layer-out', `${LAYER_OUT_MS}ms`);
      el.style.setProperty('--sp-layer-fade', `${LAYER_FADE_MS}ms`);
    }
    if (!chaining.current) return;
    chaining.current = false;
    const at = mod(liveActive.current, stops);
    liveActive.current = at;
    if (at === active && stripPos.current === pos) {
      const rest = at < n ? list[at] : undefined;
      /* `openRef`, not `open` — a hold can end before the focus commit has landed, and the state
       * would still say the row is not focused when it plainly is. */
      if (rowTrailers && openRef.current && rest && !dwellId.current) {
        dwellId.current = window.setTimeout(() => { dwellId.current = 0; setDwelt(rest); }, previewDwellMs());
      }
      return;
    }
    setActive(at);
    setPos(stripPos.current);
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
    /* A REPEAT, not merely a soon-after press: either the platform says so, or the same arrow was
     * already down when this arrived. Worked out before the branches because Left has an early
     * return of its own and both directions have to record the key either way. */
    const held = e.repeat || heldKey.current === e.key;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') heldKey.current = e.key;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1, held); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      /* ---- LEFT OFF THE FIRST CARD LEAVES THE ROW --------------------------------------------
       * The walk used to wrap here, so Left on the first title jumped to the last one — a full
       * lap backwards for a press that reads as "go back". There is nothing to the left of the
       * first card, so the press belongs to whatever is outside the row, and on this screen that
       * is the navigation bar.
       *
       * STRAIGHT TO `.tv-nav-item.active`, not to the spatial handler. TvSpatialNav already
       * redirects every arrival in the bar to the active page for a reason recorded there —
       * geometry alone picks the search icon or the avatar, because the billboard is full-width
       * and every item is dead ahead. The same destination is chosen here rather than bubbling,
       * so the two paths cannot disagree about where "out of the row" goes. */
      if (liveActive.current <= 0) {
        const nav = document.querySelector<HTMLElement>('.tv-nav-item.active')
          || document.querySelector<HTMLElement>('.tv-nav-item');
        if (nav) { nav.focus(); return; }
      }
      step(-1, held);
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

        {/* Previous title: deliberately outside `.tv-spot-rail`, whose left clip begins at the
            billboard edge. Its right edge sits one normal card gap left of the billboard, leaving
            the same narrow screen-edge peek as the Netflix row.

            NOT RENDERED AT THE HEAD OF THE ROW. The element carries a per-title background, so
            leaving it mounted with no title would put a plain coloured sliver at the screen edge —
            more conspicuous than the artwork it replaced. */}
        {previous && (
        <div
          className="tv-spot-prev"
          style={{ background: heroFallbackGradient(previous) }}
          aria-hidden="true"
        >
          <div className="tv-spot-prevtrack" ref={prevTrackRef}>
            {/* The SLOT always renders; only the picture is conditional. See `.tv-spot-prevtile`. */}
            {peekPair.map((art, i) => (
              <div className="tv-spot-prevtile" key={i}>
                {art.src
                  ? <FadeImg className="tv-spot-previmg" src={art.src} alt=""
                      style={{ objectPosition: art.pos }} />
                  : null}
              </div>
            ))}
          </div>
        </div>
        )}

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
