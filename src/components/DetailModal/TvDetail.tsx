import { useMemo, useState } from 'react';
import { useT, useGenre } from '../../i18n/i18n';
import { imgW } from '../../lib/img';
import { useSeason } from '../../lib/queries';
import { langName, type AddonStream } from '../../lib/addonClient';
import { pickWatchServices } from '../../lib/watchProviders';
import type { MetaDetail, Episode, SeasonInfo } from '../../lib/types';
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
 *   · Episode stills. A season is up to 24 more pictures. `E3 · Name` is what a remote needs.
 *   · The second, blurred copy of the poster behind the backdrop (pure ambience).
 *   · The two dropdowns (source / language). A menu that opens over itself is a mouse control;
 *     both are now pills that are simply THERE, so Left/Right walks them.
 *   · The trailer embed. It never ran here anyway (the low-power gate in useTrailer reads a TV
 *     as low-power), and the row billboards already preview.
 *
 * That is ~4 images on open where the web modal loads ~30, and 6-ish stops to a playing film.
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
  watchLabel: string;
  onWatch: () => void;
  hasResume: boolean;
  resumePct: number;
  resumeMin: number;
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

/* ---- Episodes, as a list of lines ---------------------------------------------------------
 * The web chooser (EpisodeChooser.tsx) is a card grid with a 16:9 still per episode. Here the
 * same data is a text list: number, name, and nothing else. It is not a downgrade for its own
 * sake — a still is 150px wide and carries no information the name doesn't, while a season of
 * them is two dozen network requests for a panel the viewer passes through on the way to
 * pressing play. */
function TvEpisodes({ meta, picked, onPick }: {
  meta: MetaDetail;
  picked: { season: number; ep: number } | null;
  onPick: (season: number, ep: number) => void;
}) {
  const t = useT();
  const seasons: SeasonInfo[] = useMemo(() => {
    if (meta.seasonList?.length) return meta.seasonList;
    if (meta.seasons) return Array.from({ length: meta.seasons }, (_, i) => ({ season: i + 1, episodes: 0 }));
    return [];
  }, [meta.seasonList, meta.seasons]);
  const firstSeason = useMemo(() => (seasons.find((s) => s.season >= 1) || seasons[0])?.season, [seasons]);
  const [openSeason, setOpenSeason] = useState<number | undefined>(picked?.season ?? firstSeason);
  const season = openSeason ?? firstSeason;
  const { data, isLoading } = useSeason(meta.id, season);

  if (!seasons.length || !meta.imdb) return null;
  const episodes: Episode[] = data?.episodes ?? [];

  return (
    <>
      {seasons.length > 1 && (
        <div className="tv-det-pills tv-det-seasons">
          {seasons.map((s) => (
            <button
              key={s.season}
              type="button"
              className={`tv-det-pill${s.season === season ? ' on' : ''}`}
              onClick={() => setOpenSeason(s.season)}
            >
              {s.name || t('modal.season', { n: s.season })}
            </button>
          ))}
        </div>
      )}
      <div className="tv-det-list">
        {isLoading ? (
          <div className="tv-det-note">{t('modal.loading_synopsis')}</div>
        ) : episodes.length ? (
          episodes.map((e) => (
            <button
              key={e.episode}
              type="button"
              className={`tv-det-row tv-det-ep${picked && picked.season === season && picked.ep === e.episode ? ' on' : ''}`}
              onClick={() => onPick(season!, e.episode)}
            >
              <span className="tv-det-epn">E{e.episode}</span>
              <span className="tv-det-rowtitle">{e.name || t('modal.episode_n', { n: e.episode })}</span>
              <span className="tv-det-chev" aria-hidden="true">›</span>
            </button>
          ))
        ) : (
          <div className="tv-det-note">{t('modal.episodes_unavailable')}</div>
        )}
      </div>
    </>
  );
}

export default function TvDetail(p: TvDetailProps) {
  const t = useT();
  const genre = useGenre();
  const {
    target, meta, ready, isSeries, title, titleLogo, rating, year, genreChips, plot, epTotal,
    close, watchLabel, onWatch, hasResume, resumePct, resumeMin, added, onAdd, onReport,
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
  const needsEpisode = isSeries && !pickedEp;

  /* THE PANEL IS ONE THING AT A TIME. A series shows its episodes until one is chosen, then the
   * sources FOR that episode — with a way back. Showing both at once is what makes the web
   * version a scroll: two stacked lists, neither of which fits. */
  const sources = (
    <>
      <div className="tv-det-panel-head">
        {isSeries && pickedEp && (
          <button type="button" className="tv-det-back" onClick={() => setPickedEp(null)}>
            <span aria-hidden="true">‹</span> {t('modal.episodes')}
          </button>
        )}
        <h3 className="tv-det-panel-title">
          {t('modal.streams')}
          {pickedEp && <span className="tv-det-panel-sub"> · S{pickedEp.season} E{pickedEp.ep}</span>}
        </h3>
      </div>

      <div className="tv-det-pills">
        <button type="button" className={`tv-det-pill${srcTab === 'services' ? ' on' : ''}`} onClick={() => setSrcTab('services')}>
          {t('modal.tab_streaming')}
        </button>
        <button type="button" className={`tv-det-pill${srcTab === 'addons' ? ' on' : ''}`} onClick={() => setSrcTab('addons')}>
          {t('modal.tab_addons')}
        </button>
      </div>

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
            {t('modal.signin_addon')}
            <button type="button" className="tv-det-pill on tv-det-signin" onClick={() => openAuth()}>{t('auth.signin')}</button>
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
    </>
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

      <button className="tv-det-close" id="closeModal" type="button" aria-label={t('modal.close_aria')} onClick={close}>✕</button>

      {!ready ? (
        <div className="m-load-veil" role="status" aria-busy="true" aria-label={t('modal.loading_synopsis')}>
          <span className="cat-loader" aria-hidden="true" />
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

            <div className="tv-det-actions">
              <button className={`tv-det-watch${hasResume ? ' has-resume' : ''}`} id="mWatch" type="button" onClick={onWatch}>
                <span className="ic" aria-hidden="true">▶</span>
                <span>{watchLabel}{hasResume ? <span className="tv-det-resume-at"> · {resumeMin} min</span> : null}</span>
                {hasResume ? <span className="hero-progress" aria-hidden="true"><span className="hero-progress-fill" style={{ width: `${resumePct}%` }} /></span> : null}
              </button>
              <button className={`tv-det-disc${added ? ' on' : ''}`} id="mAdd" type="button"
                      aria-pressed={added} aria-label={t(added ? 'mylist.remove' : 'mylist.add')} onClick={onAdd}>
                {added ? '✓' : '+'}
              </button>
              <button className="tv-det-disc" id="mReport" type="button"
                      aria-label={t('report.cta')} title={t('report.cta')} onClick={onReport}>⚑</button>
            </div>
          </div>

          <div className="tv-det-panel">
            {needsEpisode && meta
              ? (<>
                  <div className="tv-det-panel-head">
                    <h3 className="tv-det-panel-title">{t('modal.episodes')}</h3>
                  </div>
                  <TvEpisodes meta={meta} picked={pickedEp} onPick={(s, e) => setPickedEp({ season: s, ep: e })} />
                </>)
              : sources}
          </div>
        </div>
      )}
    </div>
  );
}
