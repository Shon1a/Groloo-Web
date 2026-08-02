import { useEffect, useRef } from 'react';
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
/** Cast names shown on the one-line credits row. Past this it is a wall of text, not a cue. */
const CAST_LINE = 6;

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

  const backdrop = meta?.backdrop || target.poster;

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
    const parked = !ae || ae === document.body || ae.id === 'closeModal';
    if (!cameFromDeck && (panelSeeded.current || !parked)) { panelSeeded.current = true; return; }

    const first = panelRef.current?.querySelector<HTMLElement>('.tv-chipmenu-btn, .tv-det-row, .tv-det-pill');
    if (first) { first.focus({ preventScroll: true }); panelSeeded.current = true; }
  }, [deck, ready, srcTab, shownStreams.length, services.length]);

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

  /* ONE close button, placed in two different places depending on whether there is a row to put
   * it in yet. While /api/meta is still in flight the screen is a loading veil with no chip row,
   * and a title you cannot back out of visually is not acceptable just because Back happens to
   * work — so it keeps its corner there. The id is what TvSpatialNav looks for when deciding
   * whether focus is merely parked, so the two must never both render (they cannot: `ready`
   * chooses exactly one). */
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

      <div className="tv-det-list">
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
        {backdrop && <img src={imgW(backdrop, BACKDROP_RENDITION)} alt="" decoding="async" />}
      </div>
      <div className="tv-det-scrim" aria-hidden="true" />

      {!ready ? (
        <div className="m-load-veil" role="status" aria-busy="true" aria-label={t('modal.loading_synopsis')}>
          <span className="cat-loader" aria-hidden="true" />
          {/* The corner placement, for the one state that has no chip row to put it in. */}
          <div className="tv-det-close-corner">{closeBtn}</div>
        </div>
      ) : (
        <div className="tv-det-grid">
          <div className="tv-det-info">
            <h2 id="mTitle" className={titleLogo ? 'tv-det-title has-logo' : 'tv-det-title'}>
              {titleLogo ? <img className="title-logo" src={titleLogo} alt={title} /> : title}
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
