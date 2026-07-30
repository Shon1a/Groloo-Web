import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { useTrailer } from './DetailModal/useTrailer';
import { useVideoTrailer, trailerStartOffset } from './DetailModal/useVideoTrailer';
import { useMeta, usePrefetchMeta, useImdbTrailer, usePrefetchImdbTrailer } from '../lib/queries';
import { useSettings } from '../stores/settings';

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

const SPOT_MAX = 12;

/* ms the remote must sit still on a title before its trailer is even asked for.
 *
 * Cut from 1500 to claw back the only part of the wait that is ours to spend. Everything after this
 * used to belong to YouTube — fetching the key, loading the embed, and above all the ~4.5s of
 * playback its pause glyph occupies (see TRAILER_REVEAL_AT) — so this is where a faster start had
 * to come from. Most of that wait is now gone with the embed itself, on every title IMDb has a
 * trailer file for; this timer keeps the job it always had, which is not starting one at all for a
 * title someone is merely walking past.
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
/* ONLY THE YOUTUBE FALLBACK IS TIMED BY THIS — a title playing IMDb's own file reveals in a third
 * of a second (see useVideoTrailer), because none of what follows applies to a player we own.
 *
 * SECONDS OF THE TRAILER, not seconds on a stopwatch — and that distinction is the fix for a
 * reported bug rather than a nicety. YouTube stamps a large pause glyph in the dead centre of the
 * player when autoplay begins; it is not chrome at the edges, so no amount of cropping reaches it,
 * and the only way past it is to arrive later. A wall-clock delay measured here (2600ms, tuned off
 * real frames) still showed the glyph on a real TV, because a slower start pushes the glyph later
 * in real time while a stopwatch keeps ticking. Playback time cannot drift like that: at 3.5s of
 * video the glyph is long gone however long the video took to get going. It also means a set that
 * stalls mid-buffer simply waits rather than revealing a frozen frame.
 *
 * WHY 4.8 AND NOT LESS. Measured in this component, frame by frame against playback time: the
 * glyph is still on screen at 3.6s and gone by 4.4s. It is not a flash — it owns the opening of
 * every trailer. 4.0 was tried and is too tight; it read as clean here and still showed on a real
 * set, because the last of the fade has no fixed end. So the number is the measurement plus a
 * margin, and the honest summary is that YouTube owns the first ~4.5 seconds of any preview: there
 * is no combination of embed parameters or cropping that removes the glyph (it is drawn inside a
 * cross-origin player, dead centre, where a crop cannot reach), so waiting is the only lever, and
 * the only way to have both a fast start AND no glyph would be to stop using YouTube's player.
 *
 * WHICH IS WHAT THE PREFERRED PATH NOW DOES. This number survives as the fallback's, unchanged and
 * still correct for what it measures — it is simply no longer what most titles pay. */
const TRAILER_REVEAL_AT = 4.8;

/* MUST TRACK `.tv-spot-trailer-slot video`'s scale in tv.css. The preview is magnified to hide
 * the letterboxing IMDb bakes into its files, which means the video is sampled at more than the
 * billboard's width — so the rendition has to be chosen against the magnified size, not the box.
 * Wrong here and the picture goes soft for a reason nothing on screen explains. */
const BILLBOARD_TRAILER_CROP = 1.35;

/* Renditions sized to what is painted, not to the source. The billboard is 16:9 of a <=380px
 * row (~675px wide) and thumbs paint at ~228px — see the note in lib/hero.ts for why reaching
 * for `original` on a TV is fatal rather than merely wasteful. */
const BILLBOARD_RENDITION = 'w780';
const THUMB_RENDITION = 'w342';

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
  const prevActiveRef = useRef(0);

  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---- THE PREVIEW ON THE SHELF ------------------------------------------------------------
   * Rest on a title and its trailer starts playing behind the title plate, muted; move on and it
   * is gone. The embed machinery is the modal's, unchanged (useTrailer) — it already mounts late,
   * reveals only once the video genuinely plays, and gives up quietly on a trailer that is
   * region-blocked or has embedding disabled, which is most of the hard part.
   *
   * TWO ENGINES, AND THE BILLBOARD PREFERS THE ONE THAT IS NOT YOUTUBE. IMDb publishes its
   * trailers as ordinary video files; our backend resolves them at /api/imdb-trailer/:imdb, and a
   * file we play ourselves has no pause glyph, no branding, no ads and no region gate — so it
   * opens in a third of a second instead of after four and a half (useVideoTrailer). Rows are
   * keyed by the IMDb id the CARD already carries, so unlike the embed's key it costs no detail
   * request to find out. The embed remains the fallback, for the titles IMDb has nothing for and
   * for the feeds whose cards carry no id at all (the Featured Hero, Upcoming).
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

  /* ---- PICKING AN ENGINE, ONCE PER RESTED TITLE ---------------------------------------------
   * IMDb's file first; the YouTube embed only for what it cannot cover. The two hooks below are
   * both mounted and exactly one is ever armed — each takes `undefined` as "not you", tears its
   * own player down and leaves the slot alone, so the handover needs no coordination beyond
   * which of them is handed a source. */
  const armed = !!dwelt && rowTrailers;
  /* LATCHED, AND THE LATCH IS WHAT KEEPS THIS FROM OSCILLATING. Most cards carry their IMDb id,
   * but the ungated feeds (Upcoming, the Featured Hero) do not — and those titles fetch /api/meta
   * for the embed anyway, which carries the id. Reading it straight off `trailerMeta` would spin:
   * an id found there arms the video, the video disarms the embed, the embed's query goes idle and
   * the id vanishes again. Held in state, it survives the request that produced it, so an Upcoming
   * title gets the good engine on the round-trip it was already paying for. Cleared with the dwell. */
  const [metaImdb, setMetaImdb] = useState<string | undefined>(undefined);
  const imdbId = armed ? (dwelt?.imdb || metaImdb) : undefined;
  const imdbTrailer = useImdbTrailer(videoFailed ? undefined : imdbId);
  const videoUrl = videoFailed ? undefined : (imdbTrailer.data?.url || undefined);
  /* The embed is not asked for SPECULATIVELY, and that is the point of this line: /api/meta is a
   * whole detail payload fetched for one string, so it is requested only once IMDb has actually
   * come back without a trailer (or the card never had an id to ask with). The common case is one
   * request for the preview, not two. */
  const imdbSettled = !imdbId || imdbTrailer.isFetched || videoFailed;
  const wantEmbed = armed && imdbSettled && !videoUrl;
  const { data: trailerMeta } = useMeta(wantEmbed ? dwelt?.id : undefined, dwelt?.type);
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
      /* Not from the beginning — see trailerStartOffset. A preview is a few seconds long and the
       * opening of a trailer is logos, a rating card, and sometimes a recap of the earlier films;
       * IMDb gives us the runtime, so the preview can start where the film itself does. */
      startAt: trailerStartOffset(imdbTrailer.data?.runtime),
      /* Let the engine measure the billboard and take the rendition that suits it, rather than
       * playing the one the backend guessed at. The crop is the magnification in tv.css, and it
       * belongs in this number: a video blown up 1.35x is sampled at 1.35x its box. */
      renditions: imdbTrailer.data?.urls,
      cropScale: BILLBOARD_TRAILER_CROP,
      onFail: () => setVideoFailed(true),
    },
  );
  useTrailer(
    trailerSlotRef,
    heroBtnRef,
    wantEmbed ? (trailerMeta?.trailerKey || undefined) : undefined,
    dwelt?.title || '',
    // Same reasoning as above: the embed goes up as soon as its key lands.
    { mountDelay: 0, revealAtPlayTime: TRAILER_REVEAL_AT, ignoreLowPower: true },
  );

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
          {src && <img className="tv-spot-thumbimg" src={src} loading="lazy" decoding="async" alt="" />}
          {!!res && res.pct > 0.01 && <span className="tv-spot-progress" aria-hidden="true"><i style={{ width: `${(Math.min(res.pct, 1) * 100).toFixed(1)}%` }} /></span>}
        </button>
      );
    };
    const copy = (pass: number) => list.map((it, i) => tile(it, `p${pass}-${i}`));
    if (!hasEnd) return [...copy(0), ...copy(1)];
    /* POSITION IS THE WHOLE TRICK. The strip is translated so the tile at index `active` hides
     * behind the billboard and its successors peek to the right, so putting the card at index n —
     * straight after the last title of the FIRST copy — makes it both the thing you see appear at
     * the end of the posters and the thing the billboard becomes when you reach it. The second
     * copy still follows it, so the row's endless up-next preview is unbroken. */
    return [
      ...copy(0),
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
      </button>,
      ...copy(1),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, onSelect, hasEnd, canSeeAll, cat, onSeeAll, onMore, moreBusy, endLabel, endIcon, heading, t, resumeOf]);

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
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setXfade((s) => {
      const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
      return { ...s, [back]: slotAt(active), front: back };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, n]);

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

  // One stop longer than the list when the row has a page of its own; still wraps, so the card
  // is also one press LEFT from the first title.
  const step = (delta: number) => setActive((a) => (a + delta + stops) % stops);

  /* Until the row is near the viewport the layer keeps the branded gradient and requests no
   * bitmap at all — see the memory note in the header. */
  const heroArt = (it: MediaItem) => {
    /* ON AN `enrich` ROW A POSTER IS NOT AN ACCEPTABLE STAND-IN for the backdrop that has not
     * arrived yet: it is a portrait crammed into 16:9, which reads as a broken picture rather
     * than as a card waiting. The branded gradient already exists for exactly this and holds the
     * frame for the one request. Catalogue rows keep the old fallback — their cards genuinely
     * sometimes have a poster and no backdrop, with nothing else coming. */
    const source = enrich ? it.backdrop : (it.backdrop || it.poster);
    const bg = visible ? imgW(source || '', BILLBOARD_RENDITION) : '';
    return {
      backgroundImage: bg ? `url('${bg}')` : heroFallbackGradient(it),
      backgroundPosition: heroBgPosition(it),
    };
  };
  const tagFor = (it: MediaItem) => (isSeries(it) ? t('nav.series') : t('nav.movies'));
  const logoOf = (it: MediaItem) => it.titleLogo || it.logo;

  const curArt = withArt(cur);
  // [S2:E4 ·] genre · year · rating — the type isn't repeated here, it's the tag on the billboard.
  // The episode leads when there is one, because on a resume row it is the most specific thing the
  // line can say. The see-all card has no metadata of its own; the panel keeps its reserved height
  // and stays blank.
  const metaBits = onSeeAllCard ? [] : [
    (!onSeeAllCard && resumeOf?.(cur)?.note) || '',
    genre(curArt.genre || (curArt.genres && curArt.genres[0]) || ''),
    curArt.year ? String(curArt.year) : '',
    curArt.rating ? `★ ${curArt.rating}` : '',
  ].filter(Boolean);

  const onHeroKey = (e: ReactKeyboardEvent) => {
    // Left/Right walk the row and are consumed here so the global D-pad handler doesn't also
    // move focus off the billboard. Up/Down bubble on through to it.
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
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
        <div className="tv-spot-rail">
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
          onClick={() => (onSeeAllCard ? goEnd() : onSelect?.(cur))}
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
                <div className="tv-spot-art" style={heroArt(art)} />
                <div className="tv-spot-card-in">
                  <span className="tv-spot-tag">{tagFor(it)}</span>
                  {logo
                    ? <img className="tv-spot-logo" src={logo} alt={it.title} />
                    : <span className="tv-spot-cardtitle">{it.title}</span>}
                </div>
                {/* Outside the plate and pinned to the card's own bottom edge, so it survives the
                    trailer taking the artwork away — where you are in a title is not a thing that
                    should blink out because a preview started. */}
                {!!res && res.pct > 0.01 && <span className="tv-spot-progress" aria-hidden="true"><i style={{ width: `${(Math.min(res.pct, 1) * 100).toFixed(1)}%` }} /></span>}
              </div>
            );
          })}
        </button>
      </div>

      {/* INFO — cross-fades with the billboard (keyed remount → fade-in). Its height is reserved
          in both states, so opening a row never pushes the rows below it. */}
      <div className="tv-spot-info" key={`info-${active}`}>
        <div className="tv-spot-meta">
          {metaBits.map((b, i) => <span key={i}>{b}</span>)}
        </div>
        {!onSeeAllCard && curArt.overview && <p className="tv-spot-plot">{curArt.overview}</p>}
      </div>
    </section>
  );
}
