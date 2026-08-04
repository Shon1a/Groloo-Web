import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useT, useGenre } from '../../i18n/i18n';
import { imgW } from '../../lib/img';
import { langName, type AddonStream } from '../../lib/addonClient';
import { pickWatchServices } from '../../lib/watchProviders';
import { registerBackHandler } from '../../lib/tvKeys';
import TvChipMenu from './TvChipMenu';
import TvEpisodeDeck, { hasEpisodeDeck } from './TvEpisodeDeck';
import type { MetaDetail } from '../../lib/types';
import type { ModalTarget } from '../../stores/modal';

/* ============================================================================
 * THE TITLE SCREEN ON A TV — a different SHAPE, not a stripped copy of the web modal.
 *
 * WHY IT EXISTS. The web modal is a tall scrolling card: hero picture, then synopsis, then
 * episodes, then sources, then a cast column, then twenty recommendation tiles. Stretched to
 * fill a 1080p panel that is a web page on a television — the one control the viewer actually
 * came for (a source to press play on) sits below the fold, reached by holding DOWN past a
 * dropdown, a column of headshots and a grid of thumbnails. Roughly thirty images and thirty
 * D-pad stops to start a film.
 *
 * WHAT THIS IS INSTEAD. One screen, two columns, no page scroll:
 *
 *     ┌───────────────────────────────────────────────────────────┐
 *     │  backdrop, scrimmed                                       │
 *     │   LOGO                                    ┌─────────────┐ │
 *     │   ★ 8.9 · 2026 · 1h 42m                   │  EPISODES   │ │
 *     │   Adventure · Animation · Family          │  or         │ │
 *     │   three lines of synopsis…                │  SOURCES    │ │
 *     │   With Michael B. Jordan, Juno Temple     │  (scrolls)  │ │
 *     │   [▶ WATCH] [+] [⚑]                       └─────────────┘ │
 *     └───────────────────────────────────────────────────────────┘
 *
 * LEFT IS WHAT IT IS, RIGHT IS WHAT YOU DO. The left column never scrolls and never changes
 * height, so the picture behind it is never pushed around; the right panel is the only thing
 * that moves, and it is the only place the remote has to travel. TvSpatialNav finds it on its
 * own — `scrollParent()` walks up to the nearest overflowing ancestor — so no wiring is needed
 * here beyond giving the panel its own overflow.
 *
 * WHAT WAS DROPPED, AND WHY EACH IS SAFE TO DROP ON A TV:
 *   · The recommendations grid. ~20 thumbnails and ~20 D-pad stops, for browsing — which is
 *     what the home rows are already for, one Back press away.
 *   · Cast headshots. A dozen circular avatars at 38px are unreadable from a sofa; the names
 *     are the information, so they ship as one line of text.
 *   · The second, blurred copy of the poster behind the backdrop (pure ambience).
 *   · The two dropdowns (source / language). A menu that opens over itself is a mouse control;
 *     both are now pills that are simply THERE, so Left/Right walks them.
 *   · The trailer embed. It never ran here anyway (the low-power gate in useTrailer reads a TV
 *     as low-power), and the row billboards already preview.
 *
 * EPISODE STILLS ARE THE ONE THING THAT CAME BACK. They were dropped with the rest, on the
 * grounds that a season is two dozen more pictures — true of a LIST, which shows all of them at
 * once. The panel is a card deck now (TvEpisodeDeck), and a deck only ever has eight cards on it
 * however long the season is, so the picture is affordable again and it is doing real work: it
 * is what makes "where you are in this show" readable from a sofa. The count, not the still, was
 * the problem.
 *
 * That is ~12 images on open where the web modal loads ~30, and 6-ish stops to a playing film.
 * Styling lives in the "TV TITLE SCREEN" section of src/styles/tv.css.
 * ==========================================================================*/

const BACKDROP_RENDITION = 'w1280';
/** Longest the loading veil waits on the backdrop's decode before opening without it. */
const ART_WAIT_MAX = 2500;
/** Cast names shown on the one-line credits row. Past this it is a wall of text, not a cue. */
const CAST_LINE = 6;

/* NO TRAILER PLAYS ON THIS SCREEN, and the note at the head of this file — "the trailer embed…
 * never ran here anyway" — is load-bearing rather than historical.
 *
 * IT WAS BUILT AND REMOVED, so here is what it was and why it went. Pressing OK on a row billboard
 * that was previewing handed the SAME playing <video> to this screen (a module-level baton, since
 * the row and this overlay are siblings with nothing to thread a prop through), which re-parented
 * it and grew it out of the billboard's box to fill the screen — no cut to black, the picture you
 * pressed OK on simply became the background.
 *
 * It worked, and it cost more than it was worth. A full-screen video repaints under the scrim and
 * the whole right-hand panel at its own frame rate, and unlike the ROW — which only ever previews
 * after a dwell, so video and navigation are mutually exclusive by construction — this screen has
 * no such guarantee: the video plays exactly while the remote is walking the deck, opening the
 * season menu and switching sources. On real hardware that was a UI that visibly answered late.
 *
 * Everything cheap was tried first and none of it was enough: dropping the 1.35 crop, removing
 * every transform and clip while it played, a rendition upgrade (removed — bigger decode, slower
 * remote), holding the screen's own render until the zoom landed (removed — 440ms of nothing after
 * a keypress reads as the app being slow), a six-second cap, ending on the first keypress, and
 * finally restricting it to films, where there is no deck to navigate.
 *
 * Films were the last thing standing and they went too, on the plain ground that a screen does not
 * get to be built twice: one title screen, one behaviour, no class of title that opens differently
 * from another. What is left in its place is the arrival animation on `.tv-det` in tv.css, which
 * gives the screen a way in that costs nothing to run. */

export interface TvDetailProps {
  target: ModalTarget;
  meta?: MetaDetail;
  /** /api/meta has landed (or failed) — until then only the loading veil shows. */
  ready: boolean;
  /** the title is a series (not the TV BUILD — see DetailModal's `isTv`) */
  isSeries: boolean;
  title: string;
  titleLogo?: string;
  rating?: number;
  year?: string | number;
  genreChips: string[];
  plot: string;
  epTotal: number;
  close: () => void;
  /* No `onWatch`/`watchLabel`/resume props: the TV build has no WATCH button — see the note in
   * DetailModal where `onWatchTv` used to be. Sources are chosen from the panel. */
  added: boolean;
  onAdd: () => void;
  onReport: () => void;
  srcTab: 'services' | 'addons';
  setSrcTab: (s: 'services' | 'addons') => void;
  signedIn: boolean;
  openAuth: () => void;
  streamsLoading: boolean;
  shownStreams: AddonStream[];
  availableLangs: string[];
  lang: string;
  setLang: (l: string) => void;
  playStream: (s: AddonStream) => void;
  streamTitle: string;
  pickedEp: { season: number; ep: number } | null;
  setPickedEp: (e: { season: number; ep: number } | null) => void;
}

const qualClass = (q: string) => (q === '4K' ? 'q-4k' : q === '1080p' ? 'q-1080' : 'q-720');

/* ---- THE DISC GLYPHS, AS DRAWN ICONS -------------------------------------------------------
 * `+`, `✓` and `⚑` were typed characters, and that is why they never matched each other: a text
 * glyph's weight belongs to the font, and in this one the plus is a hairline at a size where the
 * flag is a solid shape. No font-weight fixes it — `+` has no bold in most faces, and even
 * where it does it thickens the strokes without squaring the ends.
 *
 * Drawn instead, at the house icon spec (24-unit box, `currentColor`, round caps and joins) but
 * at stroke 3 rather than 2 — the nav icons sit alone at 28px, these sit inside a 44px disc next
 * to a filled glyph, and 2 reads as thin against it.
 *
 * `1em` rather than a pixel size, so they inherit the disc's own `font-size` clamp and keep
 * tracking it across resolutions instead of needing a second set of numbers. */
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1.14em" height="1.14em" fill="none" stroke="currentColor"
         strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1.14em" height="1.14em" fill="none" stroke="currentColor"
         strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
/* THE FLAG WAS THE LAST TYPED GLYPH IN THE ROW, and on the TV it was the one that broke: `⚑`
 * (U+2691) is missing from the system faces most TV browsers ship, so it fell through to the
 * emoji font and came back as a colour bitmap — an orange-and-white pennant in a box, ignoring
 * `color`, so it stayed that way through hover and through the white focus fill where every
 * other glyph flips to dark. Where even the emoji font lacks it the fallback is tofu, a literal
 * square. Drawn, it is the same shape everywhere and inherits `currentColor` like its siblings.
 *
 * Same spec as the two above, and the banner is deliberately open (stroke, not fill) so its
 * visual weight lands beside a stroked `+` rather than beside the solid block the text glyph
 * was. */
function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1.14em" height="1.14em" fill="none" stroke="currentColor"
         strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V3.6" />
      <path d="M6 4.8h12.4L15.3 9.6l3.1 4.8H6" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1.14em" height="1.14em" fill="none" stroke="currentColor"
         strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export default function TvDetail(p: TvDetailProps) {
  const t = useT();
  const genre = useGenre();
  const {
    target, meta, ready, isSeries, title, titleLogo, rating, year, genreChips, plot, epTotal,
    close, added, onAdd, onReport,
    srcTab, setSrcTab, signedIn, openAuth, streamsLoading, shownStreams, availableLangs,
    lang, setLang, playStream, streamTitle, pickedEp, setPickedEp,
  } = p;

  /* ---- ONE PICTURE, SHOWN ONCE, AND NOT BEFORE IT IS READY ----------------------------------
   *
   * THERE IS NO LONGER ANYTHING TO CROSS-FADE, AND THAT IS THE FIX. This screen used to open on
   * `target.poster` — a PORTRAIT poster cropped to fill a 1920x1080 panel, which for most titles
   * is a hard magnification of some corner of the same photograph the backdrop shows properly —
   * and then swap to `meta.backdrop` when it arrived. A dissolve was tried, and it worked: the
   * swap became smooth. It was still a swap, and a swap the viewer can see is a swap that should
   * not have happened. The poster was never information; it was a placeholder standing in for a
   * picture that was 300ms away, and the honest answer to "how do I hide the change" is to not
   * change anything.
   *
   * SO THE BACKDROP IS NOT CHOSEN UNTIL /api/meta HAS LANDED. Before that the art layer is empty
   * and the loading veil is over it, which is exactly what the veil is for. The poster survives
   * only as the fallback for a title whose meta genuinely has no backdrop — a real absence rather
   * than a temporary one, and in that case it is the first and only picture, so there is still
   * nothing to see changing.
   *
   * AND THE VEIL WAITS FOR THE DECODE, NOT JUST THE FETCH. Knowing the URL is not the same as
   * having the picture: revealing on `meta` alone would raise the veil on a screen whose backdrop
   * was still arriving, so the copy would land on black and the artwork would appear underneath it
   * a beat later. That is the same defect one layer further down. The image is decoded into a
   * detached Image() behind the veil, and only then does the screen open — complete, with its
   * backdrop already on it. */
  const backdrop = ready ? (meta?.backdrop || target.poster) : '';
  const backdropUrl = backdrop ? imgW(backdrop, BACKDROP_RENDITION) : '';
  const [artReady, setArtReady] = useState(false);
  useEffect(() => {
    if (!backdropUrl) return;
    let cancelled = false;
    const done = () => { if (!cancelled) setArtReady(true); };
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = backdropUrl;
    // `complete` covers the cached case, where `load` may never fire at all.
    if (pre.complete) done();
    else { pre.onload = done; pre.onerror = done; }
    /* A slow CDN must never hold the screen shut. Past this the title opens on whatever it has —
     * a late backdrop then fades in on its own, which is the old behaviour and an acceptable worst
     * case, where a spinner that never ends is not. */
    const cap = window.setTimeout(done, ART_WAIT_MAX);
    return () => { cancelled = true; window.clearTimeout(cap); };
  }, [backdropUrl]);
  /** The screen is ready to be seen: the data has landed AND its picture is decoded. */
  const shown = ready && (artReady || !backdropUrl);

  const [logoShown, setLogoShown] = useState(false);

  /* One line of credits, director first. The web modal gives this a whole sticky column with a
   * photo each; the names are the part that survives the trip across the room. */
  const director = meta?.director || meta?.creators?.[0]?.name || '';
  const castNames = (meta?.cast ?? []).slice(0, CAST_LINE).map((c) => c.name).filter(Boolean);

  const metaBits = [
    rating ? `★ ${rating}` : '',
    year ? String(year) : '',
    meta?.runtime || '',
    isSeries && meta?.seasons
      ? [meta.seasons === 1 ? t('modal.season_one') : t('modal.seasons_count', { n: meta.seasons }),
         epTotal ? t('modal.episodes_count', { n: epTotal }) : ''].filter(Boolean).join(' · ')
      : '',
  ].filter(Boolean);

  const services = srcTab === 'services' ? pickWatchServices(meta?.providers, title) : [];
  /* A series shows its episodes until one is chosen. `hasEpisodeDeck` is the same guard the deck
   * applies to itself — asked here too, so a series with no season data falls through to the
   * sources panel rather than leaving an empty, chrome-less column. */
  const deck = isSeries && !pickedEp && hasEpisodeDeck(meta);

  /* WHICH EPISODE THE DECK OPENS ON, in order of how much each answer knows:
   *
   *   1. `pickedEp`      — null whenever the deck is showing (a picked episode is what turns the
   *                        deck off); in the expression only for completeness.
   *   2. `lastPicked`    — the episode this viewer opened a moment ago and then backed out of.
   *   3. `target.resumeEp` — what Continue Watching was showing, or what a deep link named.
   *   4. nothing         — the deck infers "up next" from the progress map.
   *
   * (2) IS WHAT MAKES BACK RETURN TO WHERE YOU WERE. Picking an episode unmounts the deck, and
   * Back mounts a fresh one — which had no memory of the choice, so it fell through to (4) and
   * re-opened on episode 1. Choosing episode 8, glancing at its sources and pressing Back put the
   * remote seven cards from where it started, every time.
   *
   * It is keyed by title id and checked rather than cleared in an effect: TvDetail is not
   * remounted when the modal moves to a different title, so a bare ref would hand one show's
   * episode to the next one — and an effect that resets it runs AFTER the render that would
   * already have used it. */
  const lastPicked = useRef<{ id: string; season: number; ep: number } | null>(null);
  const remembered = lastPicked.current?.id === String(target.id)
    ? { season: lastPicked.current!.season, ep: lastPicked.current!.ep }
    : null;
  const deckPicked = pickedEp
    ?? remembered
    ?? (target.resumeEp ? { season: target.resumeEp.season, ep: target.resumeEp.episode } : null);

  const choose = (season: number, ep: number) => {
    lastPicked.current = { id: String(target.id), season, ep };
    setPickedEp({ season, ep });
  };

  /* CHOOSING AN EPISODE HANDS THE REMOTE TO THE SOURCE CHIP.
   *
   * The deck unmounts on that press, so the element focus was on ceases to exist and the browser
   * gives focus back to <body>. TvSpatialNav notices and re-seeds — with `#mWatch`, because that
   * is the one seed it knows. That is the wrong end of the screen: the viewer has just committed
   * to an episode and is looking at the panel that appeared, not at the button on the far left.
   *
   * Seeded here rather than by teaching TvSpatialNav a second rule, because this is the only
   * place that knows the transition happened. `prevDeck` is what distinguishes "an episode was
   * just chosen" from "this screen opened straight onto sources", which is every film and any
   * series deep-linked to an episode — neither should have focus yanked into the panel. */
  const panelRef = useRef<HTMLDivElement>(null);
  const prevDeck = useRef(deck);
  const panelSeeded = useRef(false);
  /* THE CHIP TAKEN ONLY BECAUSE THERE WAS NO LIST YET, held so it can be handed back.
   *
   * The panel almost never arrives with its sources already in it — /api/meta lands, the panel
   * renders its "loading" note, and the addon streams turn up a beat later. So the seed below
   * runs first against a panel whose only control is the chip, parks there, sets `panelSeeded`,
   * and the run that fires when the rows finally exist bails on that flag. The remote would have
   * sat on the dropdown for exactly the reason the seed was changed to avoid.
   *
   * Recording WHAT was seeded is what separates "we parked here for want of anything better" from
   * "the viewer chose this". A provisional chip is still parked focus; a chip the viewer walked
   * back up to is not, and the check below can tell them apart because in the second case focus
   * has moved at least once in between. */
  const provisional = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const cameFromDeck = prevDeck.current && !deck;
    prevDeck.current = deck;
    if (deck) return;   // the deck seeds itself

    /* SOMETHING HAS TO CLAIM THE REMOTE NOW THAT WATCH IS GONE. TvSpatialNav's seed was
     * `#mWatch`, and the TV build no longer renders it — so on a film, or on a series once an
     * episode is chosen, nothing took focus and it sat on the ✕ in the corner. The panel is the
     * only thing on this screen there is to do, so the panel claims it.
     *
     * Two triggers, one guard. `cameFromDeck` is the press that swapped the deck out; the
     * `panelSeeded` path covers a film, where there was never a deck and the panel simply
     * arrives. Either way it only ever takes focus that nobody chose — the ✕ or nothing at
     * all — so a viewer who has already moved is left alone. */
    const ae = document.activeElement as HTMLElement | null;
    // Focus on the chip we parked on ourselves counts as nobody having chosen anything yet.
    const onProvisional = !!provisional.current && ae === provisional.current;
    const parked = !ae || ae === document.body || ae.id === 'closeModal' || onProvisional;
    if (!cameFromDeck && !parked) { panelSeeded.current = true; provisional.current = null; return; }
    if (!cameFromDeck && panelSeeded.current && !onProvisional) return;

    /* THE FIRST SOURCE, NOT THE DROPDOWN ABOVE IT — this is the difference between one press and
     * three. The panel arrives with its head row on top (the chip, +, flag, ✕), then the language
     * pills, then the list, so seeding the chip put the remote two Downs away from the only thing
     * anybody opened this screen to do. Playing the first source cost Down, Down, OK; it now costs
     * OK. The chip is a control for the rare case where the list is the wrong list, and a control
     * that is used occasionally should not sit in front of the one used every time.
     *
     * ORDERED LOOKUPS, NOT ONE COMMA-SELECTOR, and here that is load-bearing rather than
     * pedantry: `querySelector` returns the first match in DOCUMENT order, and the chip is first
     * in the markup — so a comma list would go on picking the chip and this change would look
     * applied while doing nothing. (The same trap is called out on TvSpatialNav's recovery list.)
     *
     * The fallbacks are the cases where there is no row to take: a list still loading, an empty
     * one where the chip is genuinely all there is, and the signed-out addons panel, whose SIGN
     * IN is a pill. The first of those is the common one, which is what `provisional` is for. */
    const row = panelRef.current?.querySelector<HTMLElement>('.tv-det-row');
    const first = row
      || panelRef.current?.querySelector<HTMLElement>('.tv-chipmenu-btn')
      || panelRef.current?.querySelector<HTMLElement>('.tv-det-pill');
    if (!first) return;
    // Re-focusing what already has focus would be a no-op that still fires a focus event; skip it.
    if (first !== ae) first.focus({ preventScroll: true });
    panelSeeded.current = true;
    provisional.current = row ? null : first;
    /* `shown`, NOT `ready` — the panel does not exist until the veil lifts. The two used to be the
     * same instant; now the veil also waits for the backdrop to decode, so a seed keyed to `ready`
     * would run against an empty overlay, find nothing, and never re-run (the deps would not have
     * changed by the time the panel actually mounted). The remote would land on a title screen with
     * no selection on it. */
  }, [deck, shown, srcTab, shownStreams.length, services.length]);

  /* THE MOMENT THE REMOTE MOVES, THE CHIP IS NO LONGER PROVISIONAL — and this listener is what
   * stops the upgrade above from becoming a yank.
   *
   * Without it the flag is positional rather than historical: a viewer who walks Down to a
   * language pill and back Up to the chip is sitting on the same element the seed parked on, so
   * `onProvisional` reads true and the next arriving list would pull focus off a control they
   * deliberately returned to. Clearing on the first focus change anywhere makes the flag mean
   * what it is supposed to mean — "focus has not moved since we parked it" — rather than "focus
   * happens to be here now".
   *
   * `focusin` rather than `blur` because it bubbles, so one document-level listener covers every
   * control in the panel without any of them knowing about this. */
  useEffect(() => {
    const onFocusIn = () => {
      if (provisional.current && document.activeElement !== provisional.current) provisional.current = null;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  /* BACK IS THE WAY BACK TO THE EPISODES — there is no button for it any more.
   *
   * There was one ("‹ EPISODES", top-left of the panel) and it was the wrong shape of answer: a
   * TV remote has a dedicated Back key, so an on-screen back control is a second way to do the
   * same thing that costs a D-pad stop and a corner of the panel. Registering here instead puts
   * it on the app's existing chain, which means the remote's Back, webOS's, Tizen's, Android's
   * bridge call and the desktop keyboard all reach it without this component knowing which.
   *
   * ORDER MATTERS AND FALLS OUT FOR FREE. `registerBackHandler` runs most-recently-registered
   * first, so an open chip menu (registered later, while it is open) closes before this does, and
   * this runs before the modal's own close in `handleBack`. One press, one layer, every time. */
  useEffect(() => {
    if (!isSeries || !pickedEp) return;
    return registerBackHandler(() => { setPickedEp(null); return true; });
  }, [isSeries, pickedEp, setPickedEp]);

  /* ONE close button, and it lives in the chip row — so it does not exist at all until /api/meta
   * lands, because the row does not.
   *
   * IT USED TO ALSO RENDER IN THE TOP-RIGHT CORNER OF THE LOADING VEIL, on the argument that a
   * title you cannot visually back out of is not acceptable just because Back happens to work.
   * That was wrong on this build for two reasons.
   *
   * It is the only rendered control on the veil, which means it is the only CANDIDATE on the
   * layer — so TvSpatialNav's recovery, having nothing real to offer the remote, parked focus on
   * it and drew a ring around it. The first thing a viewer saw after pressing OK on a title was a
   * spinner and a highlighted ✕: an interface whose one visible, one selected affordance is
   * "undo that". The veil is a few hundred milliseconds of nothing; it should look like nothing.
   *
   * And the affordance was never the only way out. Back closes the modal from step 3 of
   * `handleBack` — a store-backed overlay, closed by reading `useModal`, with no dependence on
   * anything being rendered — so the remote's Back, webOS's, Tizen's, Android's bridge call and
   * the desktop Escape all worked during the veil and still do. Nothing about the way out changed
   * here; what changed is that the veil no longer renders a control to say so.
   *
   * The id is what TvSpatialNav looks for when deciding whether focus is merely parked. */
  const closeBtn = (
    <button className="tv-det-disc tv-det-close" id="closeModal" type="button"
            aria-label={t('modal.close_aria')} onClick={close}>
      <CloseIcon />
    </button>
  );

  /* ADD AND REPORT LIVE IN THE CHIP ROW, and they are defined once here because that row is
   * rendered in two places — TvEpisodeDeck's head for a series, the sources head below for
   * everything else. Passing the same nodes into both is what keeps them one control rather than
   * two copies that drift the first time one is changed.
   *
   * They were an action row under the credits, beside WATCH. With WATCH gone that left two small
   * circles adrift at the bottom of the left column, furthest from anything they act on and last
   * in the remote's path. Beside the dropdown they sit with the other controls, in the column the
   * remote is already in. */
  const actions = (
    <>
      <div className="tv-det-actions">
        <button className={`tv-det-disc${added ? ' on' : ''}`} id="mAdd" type="button"
                aria-pressed={added} aria-label={t(added ? 'mylist.remove' : 'mylist.add')} onClick={onAdd}>
          {added ? <CheckIcon /> : <PlusIcon />}
        </button>
        <button className="tv-det-disc" id="mReport" type="button"
                aria-label={t('report.cta')} title={t('report.cta')} onClick={onReport}>
          <FlagIcon />
        </button>
      </div>
      {/* CLOSE JOINS THE ROW, pushed to its far end (`margin-left: auto` in tv.css).
          It was pinned to the top-left corner of the overlay — the one control that was nowhere
          near any other, on the opposite side of a 1920px screen from everything the remote
          visits. Here it is the last stop on a row the remote is already walking, and it looks
          like what it is: another disc. */}
      {closeBtn}
    </>
  );

  /* LEFT LEAVES THE LIST, because otherwise it is a key that does nothing and the way out is
   * twenty presses of Up.
   *
   * The source rows are the full width of a single-column panel, so there is never a neighbour
   * beside one: TvSpatialNav's `pick` finds no candidate to the left or the right of a row, and
   * both keys are inert for as long as the remote is in the list. Meanwhile the only route back
   * to the head row — change the language, switch to Streaming, close the title — is Up, once per
   * row, and a well-seeded addon can be thirty of them. Sitting on row 24 with two dead keys and
   * a two-dozen-press exit is the discomfort; this is one press.
   *
   * LEFT RATHER THAN RIGHT, because the panel is the right-hand column of the screen and left is
   * where the rest of it is — the direction a viewer already presses to get out of a list on
   * every other TV app. Right stays dead, deliberately: one escape is a gesture, two is a
   * coin toss about which one you meant.
   *
   * IT AIMS AT THE CHIP, not at the language pills that may sit between. The pills are a filter
   * on the list you are leaving, so landing there means the escape hatch dropped you inside the
   * same region at a different altitude; the chip is the head of the panel and the row the other
   * three controls live on. From there Down re-enters the list — and `unreachable` in
   * TvSpatialNav means it re-enters on a row that is actually on screen, so leaving and coming
   * back keeps your place rather than snapping to the top. */
  const leaveList = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' || e.altKey || e.ctrlKey || e.metaKey) return;
    const chip = panelRef.current?.querySelector<HTMLElement>('.tv-chipmenu-btn');
    if (!chip) return;   // no head to go back to; leave the key alone rather than swallow it
    e.preventDefault();
    /* Stopped here so it never reaches TvSpatialNav's window listener. `move('left')` would find
     * nothing and return false, so this is belt-and-braces rather than a fix — but it keeps the
     * press from being scored against every candidate in the layer for an answer we have already
     * given. */
    e.stopPropagation();
    chip.focus({ preventScroll: true });
  };

  /* THE PANEL IS ONE THING AT A TIME. A series shows its episodes until one is chosen, then the
   * sources FOR that episode — with a way back. Showing both at once is what makes the web
   * version a scroll: two stacked lists, neither of which fits. */
  /* WRAPPED, so the swap can be animated. The panel element itself survives the change from
   * episodes to sources — same node, different children — so a CSS animation on it would never
   * re-run. This div is mounted fresh by that change and its animation plays once, which is what
   * turns a hard cut into the panel arriving. It has to carry the panel's own column layout
   * (`.tv-src`, in tv.css) because it now sits between the panel and the list that stretches. */
  const sources = (
    <div className="tv-src">
      {/* THE ROW ABOVE THE SLAB IS THE SAME ROW THE EPISODE DECK HAS: the chip that picks what the
          panel is showing, right-aligned, floating on the artwork. The source tabs used to be two
          flat pills INSIDE the panel, which meant the one control that changes what you are
          looking at sat in a different place, and in a different shape, depending on whether you
          were looking at episodes or at sources. Getting back to the episodes is the Back key's
          job now — see the handler above. */}
      <div className="tv-ep-head tv-src-head">
        <TvChipMenu
          ariaLabel={t('modal.streams')}
          value={srcTab}
          onSelect={(k) => setSrcTab(k as 'services' | 'addons')}
          options={[
            { key: 'services', label: t('modal.tab_streaming') },
            { key: 'addons', label: t('modal.tab_addons') },
          ]}
        />
        {actions}
      </div>

      <div className="tv-src-card">
      {/* Present, not drawn — the same call as the deck's "EPISODES". On screen it labelled a list
          of sources with the word "sources", directly under a chip already saying which kind; off
          screen it is the only thing naming this region, so a reader would otherwise meet an
          unlabelled group of buttons. The S1 E1 stays in it for that reason too. */}
      <h3 className="tv-det-panel-title sr-only">
        {t('modal.streams')}
        {pickedEp && <span className="tv-det-panel-sub"> · S{pickedEp.season} E{pickedEp.ep}</span>}
      </h3>

      {/* The language dropdown, flattened. Only when there is a choice to make. */}
      {srcTab === 'addons' && availableLangs.length > 1 && (
        <div className="tv-det-pills tv-det-langs">
          {availableLangs.map((l) => (
            <button key={l} type="button" className={`tv-det-pill${l === lang ? ' on' : ''}`} onClick={() => setLang(l)}>
              <i className={`flag flag-${l}`} />{langName(l)}
            </button>
          ))}
        </div>
      )}

      <div className="tv-det-list" onKeyDown={leaveList}>
        {srcTab === 'services' ? (
          services.length ? services.map((s) => (
            <a className="tv-det-row" key={s.key} href={s.link} target="_blank" rel="noopener noreferrer"
               aria-label={t('modal.watch_on', { name: s.name })}>
              <span className="tv-det-logo" aria-hidden="true">{s.logo && <img src={s.logo} alt="" decoding="async" />}</span>
              <span className="tv-det-rowtitle">{s.name}</span>
              <span className="tv-det-chev" aria-hidden="true">›</span>
            </a>
          )) : <div className="tv-det-note">{t('modal.no_providers')}</div>
        ) : !signedIn ? (
          <div className="tv-det-note">
            {/* The button was an inline child of this paragraph, which put a pill in the middle of
                a sentence and let the two overlap once the text wrapped. It is its own block now
                — and the remote needs it to be, since an inline control at the end of a wrapped
                line is the hardest kind of thing for spatial navigation to land on cleanly. */}
            <span>{t('modal.signin_addon')}</span>
            <button type="button" className="tv-det-pill tv-det-signin" onClick={() => openAuth()}>{t('auth.signin')}</button>
          </div>
        ) : streamsLoading ? (
          <div className="tv-det-note">{t('modal.loading_synopsis')}</div>
        ) : shownStreams.length ? (
          shownStreams.map((s, i) => (
            <button className="tv-det-row" type="button" key={i} aria-label={streamTitle} onClick={() => playStream(s)}>
              <span className={`quality-badge ${qualClass(s.quality)}`}>{s.quality || 'SD'}</span>
              <span className="tv-det-rowtitle">
                {s.label || streamTitle}
                <span className="tv-det-rowsub">{[s.size, s.source].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="tv-det-chev" aria-hidden="true">›</span>
            </button>
          ))
        ) : <div className="tv-det-note">{t('modal.no_streams')}</div>}
      </div>
      </div>
    </div>
  );

  return (
    <div
      className="overlay open tv-det"
      id="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mTitle"
      aria-hidden="false"
    >
      <div className="tv-det-art" aria-hidden="true">
        {/* Mounted invisible behind the veil and revealed with it, so its arrival is the screen's
            arrival rather than an event of its own. `rdy` is a class change on an element that
            already exists — set it in the same commit that creates the <img> and the browser has
            no previous value to transition from, and it would simply appear. */}
        {backdropUrl && (
          <img className={artReady ? 'rdy' : undefined} src={backdropUrl} alt="" decoding="async" />
        )}
      </div>
      <div className="tv-det-scrim" aria-hidden="true" />

      {/* RENDERED IMMEDIATELY. This was briefly gated on the flight being over — the argument
          being that React mounting the grid, the episode deck and a dozen stills during the same
          380ms the transform was animating is real work landing on the frames that could least
          afford it, which is true.
          It was reverted because it bought smoothness with the one thing a remote is least
          forgiving about: 440ms in which pressing OK produced a picture and no screen. That reads
          as the app being slow, and it was reported as exactly that. A few dropped frames in an
          animation nobody is interacting with is the cheaper of the two — the flight is decoration
          and the response to a keypress is not. */}
      {!shown ? (
        // The spinner and nothing else — no ✕ in the corner. Back gets out; see the note on
        // `closeBtn`.
        <div className="m-load-veil" role="status" aria-busy="true" aria-label={t('modal.loading_synopsis')}>
          <span className="cat-loader" aria-hidden="true" />
        </div>
      ) : (
        <div className="tv-det-grid">
          <div className="tv-det-info">
            <h2 id="mTitle" className={titleLogo ? 'tv-det-title has-logo' : 'tv-det-title'}>
              {/* The wordmark arrives with /api/meta and used to appear in the frame it decoded,
                  which on this screen is the same frame the backdrop was swapping in — two pops
                  at once. It fades like every other picture here now; `complete` is checked for
                  the cached case, see the same pattern on the episode stills. */}
              {titleLogo
                ? (
                  <img
                    className={logoShown ? 'title-logo rdy' : 'title-logo'}
                    src={titleLogo}
                    alt={title}
                    decoding="async"
                    ref={(el) => { if (el?.complete && !logoShown) setLogoShown(true); }}
                    onLoad={() => setLogoShown(true)}
                  />
                )
                : title}
            </h2>

            {metaBits.length > 0 && <div className="tv-det-meta">{metaBits.join('  ·  ')}</div>}
            {genreChips.length > 0 && <div className="tv-det-genres">{genreChips.map(genre).join(' · ')}</div>}

            <p className="tv-det-plot">{plot}</p>

            {(director || castNames.length > 0) && (
              <div className="tv-det-credits">
                {director && (
                  <div className="tv-det-credit">
                    <span className="tv-det-credit-role">{t(isSeries ? 'modal.creator' : 'modal.director')}</span>
                    {director}
                  </div>
                )}
                {castNames.length > 0 && (
                  <div className="tv-det-credit">
                    <span className="tv-det-credit-role">{t('modal.cast_credits')}</span>
                    {castNames.join(' · ')}
                  </div>
                )}
              </div>
            )}

          </div>

          {/* THE PANEL GIVES UP ITS CHROME FOR THE DECK. The dark slab exists to buy a LIST its
              contrast against a full-bleed photograph; a deck's cards are opaque surfaces that
              carry their own, so a box around them is a second frame around the first. Sources
              are still a list, and still get the slab. */}
          <div className={`tv-det-panel${deck ? ' is-deck' : ''}`} ref={panelRef}>
            {deck
              ? <TvEpisodeDeck meta={meta!} titleId={target.id} picked={deckPicked} actions={actions}
                               onPick={choose} />
              : sources}
          </div>
        </div>
      )}
    </div>
  );
}
