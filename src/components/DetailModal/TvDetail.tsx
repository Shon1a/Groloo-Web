import { useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useT, useGenre } from '../../i18n/i18n';
import { imgW, rasterLogo } from '../../lib/img';
import { retainedReady } from '../../lib/useImageReady';
import { epLabel } from '../../lib/utils';
import { langName, sourceNote, type AddonStream } from '../../lib/addonClient';
import { pickWatchServices } from '../../lib/watchProviders';
import { registerBackHandler } from '../../lib/tvKeys';
import type { Episode, MetaDetail } from '../../lib/types';
import { useImdbVideos, useSeason, type ImdbTrailer } from '../../lib/queries';
import { currentEp } from '../../lib/episodeNumbering';
import { useModal, type ModalTarget } from '../../stores/modal';
import { useHistory, type Progress } from '../../stores/history';
import { usePlayer } from '../../stores/player';
import { useRatings, type Thumb } from '../../stores/ratings';
import { useGlanceReady, useSettledGlance } from '../glance/useGlance';
import { WATCHED, deckOpensOn, dur, firstSeasonOf, seasonsOf } from './deckGeometry';
import ThumbIcon from './ThumbIcon';
import TvTrailerBox from './TvTrailerBox';
import TvTitlePage, { EpisodeCell, MoreCell, type PageSection } from './TvTitlePage';
import { ARROWS, HELD_STEP_MS, hideMark, moveMark, offsetIn } from './tvGlide';

/* ============================================================================
 * THE TITLE SCREEN ON A TV — Netflix's TV title page, from the user's references (Oct 20).
 *
 *     ┌───────────────────────────────────────────────────────────┐
 *     │  LOGO                      ┌──────────────────────────────│
 *     │  74% Match  2018  [TV-14]  │  the artwork, top right,      │
 *     │  New Episode Thursday      │  its left and bottom edges    │
 *     │  Episode name / tagline    │  fading into the black        │
 *     │  three lines of synopsis…  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
 *     │  Cast: …  Creator: …  genres                               │
 *     │  👎  👍  👍👍                                               │
 *     │  [▶ Resume  S1:E2          ]  ← one white box, gliding     │
 *     │   ⧉ Episodes & More                                       │
 *     │   + My List                                                │
 *     │   ≋ Sources                                                │
 *     │   ▦ More like this                                         │
 *     └───────────────────────────────────────────────────────────┘
 *
 * WHAT IT IS on top, WHAT YOU DO under it, and nothing on the right but the picture. Every list the
 * screen used to hold beside the copy — the episode deck, the sources — is a page of its own now
 * (TvTitlePage), opened from the menu and left with Back:
 *
 *   · Episodes & More → the seasons, Trailers & More and More Like This on the left, the season's
 *     episodes on the right. OK on an episode PLAYS it (the best source, as Play does).
 *   · Trailers & More (a film's menu) and More like this open the same page at that section. The
 *     trailers are every one IMDb has (/api/imdb-videos), in a grid like More Like This.
 *   · Sources → Streaming Services and the add-ons' languages on the left, their sources on the right
 *     — the way to choose a source by hand, and where Play and an episode go when nothing can start.
 *
 * THE BOX. One white mark under the menu travels from item to item (and morphs into the circle
 * behind a thumb), on the top bar's pill's 480ms clock; the item's label turns black under it because
 * the mark carries a black copy of the menu, held still while the mark moves (`ink`, tv.css).
 * Styling lives in the "TV TITLE SCREEN" section of src/styles/tv.css.
 * ==========================================================================*/

const BACKDROP_RENDITION = 'w1280';
/** Longest the loading veil waits on the backdrop's decode before opening without it. */
const ART_WAIT_MAX = 2500;
/** Longest the callouts (and so the copy, which arrives with them) wait on their sources. */
const GLANCE_WAIT_MS = 1600;

export interface TvDetailProps {
  target: ModalTarget;
  meta?: MetaDetail;
  /** /api/meta has landed (or failed) — until then only the loading veil shows. */
  ready: boolean;
  /** DetailModal already put the veil up on the press: this screen takes over from it without fading in again. */
  veiled?: boolean;
  /** the title is a series (not the TV BUILD — see DetailModal's `isTv`) */
  isSeries: boolean;
  title: string;
  titleLogo?: string;
  rating?: number;
  year?: string | number;
  genreChips: string[];
  plot: string;
  /** Start the best source for this film (`null`) or this episode, the way the player's Next
   *  Episode does. Resolves false when there was nothing it could start — the caller then shows
   *  the sources instead. */
  onPlayNow: (ep: { season: number; ep: number } | null) => Promise<boolean>;
  /** IMDb's trailer file, once /api/imdb-trailer has answered with one. */
  trailer?: ImdbTrailer;
  added: boolean;
  onAdd: () => void;
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

/* ---- WHAT PLAY PLAYS ON A SERIES -----------------------------------------------------------------
 * The episode this viewer touched last — or, if they finished it, the one after it (the next season's
 * first when that was a finale). Nothing watched: the episode Continue Watching named, else the first
 * real season's first. `known` is false only for that last guess — the screen then talks about the
 * show rather than about an episode nobody chose. */
interface UpNext { season: number; ep: number; pct: number; leftSec: number; known: boolean }
function seriesUpNext(
  meta: MetaDetail | undefined,
  titleId: string | number,
  progress: Record<string, Progress>,
  fallback: { season: number; ep: number } | null,
): UpNext | null {
  if (!meta) return null;
  const prefix = `${titleId}:S`;
  let last: { season: number; ep: number; p: Progress } | null = null;
  for (const [k, p] of Object.entries(progress)) {
    if (!k.startsWith(prefix) || !(p.dur > 0)) continue;
    const m = /^S(\d+)E(\d+)$/.exec(k.slice(prefix.length - 1));
    if (m && (!last || (p.at || 0) > (last.p.at || 0))) last = { season: +m[1], ep: +m[2], p };
  }
  if (last) {
    const pct = Math.min(100, (last.p.pos / last.p.dur) * 100);
    if (pct < WATCHED * 100) return { season: last.season, ep: last.ep, pct, leftSec: Math.max(0, last.p.dur - last.p.pos), known: true };
    const seasons = seasonsOf(meta).filter((s) => s.season >= 1);
    const here = seasons.find((s) => s.season === last!.season);
    if (here && here.episodes > last.ep) return { season: last.season, ep: last.ep + 1, pct: 0, leftSec: 0, known: true };
    const after = seasons.find((s) => s.season > last!.season);
    if (after) return { season: after.season, ep: 1, pct: 0, leftSec: 0, known: true };
    // The finale, finished: Play starts it again rather than offering nothing.
    return { season: last.season, ep: last.ep, pct: 0, leftSec: 0, known: true };
  }
  if (fallback) return { ...fallback, pct: 0, leftSec: 0, known: true };
  const first = firstSeasonOf(meta);
  return first === undefined ? null : { season: first, ep: 1, pct: 0, leftSec: 0, known: false };
}

/** A season's episodes: TMDB's, or the add-on's own `videos[]` for a title TMDB cannot name. */
function episodesOf(meta: MetaDetail | undefined, season: number | undefined, fetched?: Episode[]): Episode[] {
  if (!meta || season == null) return [];
  if (meta.addonEpisodes) {
    return meta.addonEpisodes.filter((e) => e.season === season).map((e) => ({
      episode: e.episode, name: e.name, overview: e.overview, still: e.still, air_date: e.air_date,
    }));
  }
  return fetched ?? [];
}

/* ---- THE ICONS: plain white line glyphs, as Netflix draws them — they go black under the box with
 * the label, so they are drawn in `currentColor` rather than taken from the coloured set. */
type MenuGlyph = 'play' | 'episodes' | 'add' | 'added' | 'sources' | 'trailers' | 'more';
function MenuIcon({ name }: { name: MenuGlyph }) {
  const d: Record<MenuGlyph, ReactNode> = {
    play: <path d="M6.5 4.6v14.8c0 .7.8 1.1 1.4.7l11.6-7.4a.8.8 0 0 0 0-1.4L7.9 3.9c-.6-.4-1.4 0-1.4.7z" fill="currentColor" stroke="none" />,
    episodes: <><rect x="3" y="7.5" width="13.5" height="13.5" rx="1.3" /><path d="M7.5 3.5h11.8c.7 0 1.2.5 1.2 1.2v11.8" /></>,
    add: <path d="M12 3.5v17M3.5 12h17" />,
    added: <path d="M4 12.5l5.2 5.2L20 6.8" />,
    sources: <path d="M12 3.5l8.5 4.6-8.5 4.6-8.5-4.6zM3.5 12.2l8.5 4.6 8.5-4.6M3.5 16.3l8.5 4.6 8.5-4.6" />,
    trailers: <><rect x="3" y="4.5" width="18" height="15" rx="1.6" /><path d="M10 9.2v5.6l4.6-2.8z" /></>,
    more: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></>,
  };
  return (
    <svg className="tv-dm-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d[name]}
    </svg>
  );
}

const THUMBS: Thumb[] = ['down', 'up', 'love'];

type View = 'main' | 'browse' | 'sources';
interface MenuItem { key: string; glyph: MenuGlyph; label: string; sub?: string; bar?: number; run: () => void }

export default function TvDetail(p: TvDetailProps) {
  const t = useT();
  const genre = useGenre();
  const {
    target, meta, ready, isSeries, title, titleLogo, rating, year, genreChips, plot,
    onPlayNow, trailer, added, onAdd,
    srcTab, setSrcTab, signedIn, openAuth, streamsLoading, shownStreams, availableLangs,
    lang, setLang, playStream, streamTitle, pickedEp, setPickedEp,
  } = p;
  /* Read once: a class that came off later would restart the fade it suppresses. */
  const [noIn] = useState(!!p.veiled);

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
   * backdrop already on it.
   *
   * A PICTURE ALREADY IN HAND OPENS WITH THE SCREEN. Resting on a card decodes this backdrop and its
   * wordmark ahead of the OK (lib/queries `useWarmDetail`), and /api/meta is usually cached by then
   * too — so at mount there is nothing left to wait for, and asking the effect below to find that
   * out cost a whole extra commit: the veil drawn for one frame, then the grid. Read synchronously
   * instead, the screen's first commit is the finished screen, arriving inside the overlay's own
   * fade (`tvDetIn`) rather than after it. */
  const backdrop = ready ? (meta?.backdrop || target.poster) : '';
  const backdropUrl = backdrop ? imgW(backdrop, BACKDROP_RENDITION) : '';
  const [artReady, setArtReady] = useState(() => !!backdropUrl && retainedReady(backdropUrl));
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

  const [logoShown, setLogoShown] = useState(() => !!titleLogo && retainedReady(rasterLogo(titleLogo, 'original')));
  const logo = (big: boolean) => (
    <h2 id={big ? 'mTitle' : undefined} className={`tv-det-title${titleLogo ? ' has-logo' : ''}${big ? '' : ' is-small'}`}>
      {/* The wordmark fades in like every other picture here; `complete` is checked for the cached
          case, where `load` can fire before the handler is attached. */}
      {titleLogo
        ? (
          <img
            className={logoShown ? 'title-logo rdy' : 'title-logo'}
            src={rasterLogo(titleLogo, 'original')}
            alt={title}
            decoding="async"
            ref={(el) => { if (el?.complete && !logoShown) setLogoShown(true); }}
            onLoad={() => setLogoShown(true)}
          />
        )
        : title}
    </h2>
  );

  /* ---- THE FACTS: ONE LINE, AS NETFLIX SETS IT ----------------------------------------------------
   *   84% Match   2020   [12]   2 Seasons        (a film: its runtime where the seasons are)
   * Spaced, not ruled. The match is the public score as a percentage, in Netflix's green: the user's
   * call (Oct 20), there being no personal match to show. The certificate is a CHIP — the board's own
   * string, printed as issued ("12" is German, "PG-13" American; rewriting either into the other's
   * shape would invent a rating) — which is why the line is nodes rather than a joined string. */
  const seasonsText = isSeries && meta?.seasons
    ? (meta.seasons === 1 ? t('modal.season_one') : t('modal.seasons_count', { n: meta.seasons }))
    : '';
  const match = typeof rating === 'number' && rating > 0 ? Math.round(Math.min(10, rating) * 10) : 0;
  const facts: ReactNode[] = [
    match ? <span key="match" className="tv-dm-match">{t('tv.match', { n: match })}</span> : '',
    year ? String(year) : '',
    meta?.certification ? <span key="cert" className="tv-det-age">{meta.certification}</span> : '',
    seasonsText,
    !isSeries ? meta?.runtime || '' : '',
  ].filter(Boolean);
  const factsLine = (list: ReactNode[]) => (list.length > 0 && (
    <div className="tv-dm-facts">{list.map((b, i) => <span key={i}>{b}</span>)}</div>
  ));
  /* Info at a glance — a new season, a top-ten place, an award — as Netflix prints it under the facts:
   * a line of bold text ("Season 2 Coming March 8"), no chip and no icon. */
  const glance = { item: { id: target.id, type: target.type, year, rating, genre: target.genre }, meta, awards: true };
  const callouts = useSettledGlance(glance, `${target.type}:${target.id}`, { waitForMeta: true, maxWaitMs: GLANCE_WAIT_MS }).slice(0, 2);
  /* THE COPY ARRIVES ONCE, WITH ITS CALLOUTS. The column comes in a line at a time (tv.css `.tv-dm.is-in`),
   * and a callout settling after that would be a line pushed in under the cascade, shoving everything
   * below it down. So the column waits for the callouts' sources (awards — usually already asked for by
   * the row's dwell), or for the same wait the callouts themselves give up at; the picture does not. */
  const glanceReady = useGlanceReady(glance, true);
  const [glanceLate, setGlanceLate] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setGlanceLate(true), GLANCE_WAIT_MS);
    return () => window.clearTimeout(id);
  }, []);
  /* Opened from the Prime page (routes/PrimeTest), the column starts with that page's title panel as it
   * stood — its wordmark, tags, facts and synopsis, in its own markup and sizes (prime.css) — in place
   * of this screen's head: no match, no callouts, no tagline, so nothing to wait for. */
  const pv = target.pv;
  const copyIn = shown && (!!pv || glanceReady || glanceLate);
  /* Facts the panel did not have yet fade in when they come, as they would have there. */
  const pvFirst = useRef(pv?.facts.map((f) => f.text));

  /* ---- THE CREDITS: Netflix's three small lines — the cast, who made it, what kind of thing it is. */
  const castLine = (meta?.cast ?? []).slice(0, 3).map((c) => c.name).filter(Boolean).join(', ');
  const makers = isSeries ? (meta?.creators ?? []).slice(0, 2).map((c) => c.name).filter(Boolean) : [];
  const makerLine = isSeries ? makers.join(', ') : (meta?.director || '');
  const makerLabel = isSeries ? (makers.length > 1 ? t('tv.creators') : t('modal.creator')) : t('modal.director');
  const genresLine = genreChips.slice(0, 3).map(genre).join(', ');

  /* ---- PLAY: ONE PRESS TO A PLAYING TITLE ---------------------------------------------------------
   * Up next on a series (`seriesUpNext`), or the film, from the best source, the way the player's Next
   * Episode does (`playEpisode` in DetailModal, via `onPlayNow`). WHEN IT CANNOT — signed out (add-on
   * sources need an account), or no source that can start here — it opens the sources for it. */
  const progress = useHistory((s) => s.progress);
  const resumeEp = currentEp(meta, target.resumeEp);
  const named = resumeEp ? { season: resumeEp.season, ep: resumeEp.episode } : null;
  const upNext: UpNext | null = isSeries ? seriesUpNext(meta, target.id, progress, named) : null;
  const filmP = !isSeries ? progress[String(target.id)] : undefined;
  const filmPct = filmP && filmP.dur > 0 ? (filmP.pos / filmP.dur) * 100 : 0;
  const filmResume = filmPct >= 1 && filmPct < WATCHED * 100;
  const resuming = isSeries ? !!upNext && upNext.pct >= 1 : filmResume;
  const canPlay = !isSeries || !!upNext;

  /* The up-next episode's own name and synopsis take the show's place, as Netflix does once you have
   * started — but only if its season is already in hand when the screen opens (the rest warm-up reads
   * it). Decided once: a season arriving a beat later must not rewrite the copy under the viewer. */
  const upSeason = useSeason(meta?.id, isSeries && upNext?.known && !meta?.addonEpisodes ? upNext.season : undefined, meta?.imdb);
  const upEps = episodesOf(meta, upNext?.known ? upNext.season : undefined, upSeason.data?.episodes);
  const upEpisode = upNext ? upEps.find((e) => e.episode === upNext.ep) : undefined;
  const epMode = useRef<boolean | null>(null);
  if (shown && epMode.current === null) epMode.current = !!upEpisode;
  const showEp = !!epMode.current && !!upEpisode;
  const headline = showEp
    ? `${epLabel(upNext!.season, upNext!.ep)} · ${upEpisode!.name || t('modal.episode_n', { n: upNext!.ep })}`
    : (meta?.tagline?.trim() || '');
  const synopsis = showEp && upEpisode!.overview ? upEpisode!.overview : plot;

  const [playBusy, setPlayBusy] = useState(false);
  const [busyEp, setBusyEp] = useState<string | null>(null);

  /* ---- THE PAGES: a stack, so Back walks out the way the remote walked in ----------------------- */
  const [stack, setStack] = useState<View[]>(['main']);
  const view = stack[stack.length - 1];
  const [browseSec, setBrowseSec] = useState('');
  /** The menu item a page was opened from — where the remote lands when Back returns to the menu. */
  const returnTo = useRef('play');
  /** The episode last chosen on the page — where the remote returns to on it. */
  const lastEp = useRef<{ season: number; ep: number } | null>(null);
  const push = (v: View) => setStack((s) => [...s, v]);
  useEffect(() => {
    if (stack.length < 2) return;
    return registerBackHandler(() => {
      // The sources were for one episode; leaving them lets Play go back to naming up next.
      if (view === 'sources' && isSeries) setPickedEp(null);
      setStack((s) => s.slice(0, -1));
      return true;
    });
  }, [stack, view, isSeries, setPickedEp]);

  const openSources = (ep: { season: number; ep: number } | null) => {
    if (isSeries && ep) setPickedEp(ep);
    push('sources');
  };
  /* ---- THE PARKED FILM (stores/player `parked`) ------------------------------------------------
   * Back from the film it started leaves this screen over it, Netflix's way: the film paused, its frame
   * left where it stopped, under this screen (tv.css `.tv-det[data-parked]`), the column arriving again
   * with the remote on Resume.
   * Play — or that episode chosen on the page — picks the film up on the same frame; anything else
   * started replaces it, and this screen closing ends it (VideoPlayer). */
  const parkedKey = usePlayer((s) => (s.parked ? s.source?.media?.key ?? '' : ''));
  const parked = !!parkedKey;
  const isParked = (ep: { season: number; ep: number } | null) =>
    parked && parkedKey === (ep ? `${target.id}:S${ep.season}E${ep.ep}` : String(target.id));
  const [parkRun, setParkRun] = useState(0);
  useEffect(() => {
    if (!parked) return;
    returnTo.current = 'play';
    setStack(['main']);
    setParkRun((n) => n + 1);
  }, [parked]);

  const play = async () => {
    if (playBusy || !canPlay) return;
    const ep = upNext ? { season: upNext.season, ep: upNext.ep } : null;
    if (isParked(ep)) { usePlayer.getState().resume(); return; }
    if (!signedIn) { returnTo.current = 'play'; openSources(ep); return; }
    setPlayBusy(true);
    let started = false;
    try { started = await onPlayNow(ep); } catch { started = false; } finally { setPlayBusy(false); }
    if (!started) { returnTo.current = 'play'; openSources(ep); }
  };
  const playEp = async (season: number, ep: number) => {
    lastEp.current = { season, ep };
    if (busyEp) return;
    if (isParked({ season, ep })) { usePlayer.getState().resume(); return; }
    if (!signedIn) { openSources({ season, ep }); return; }
    setBusyEp(`${season}:${ep}`);
    let started = false;
    try { started = await onPlayNow({ season, ep }); } catch { started = false; } finally { setBusyEp(null); }
    if (!started) openSources({ season, ep });
  };

  const openTitle = useModal((s) => s.open);
  const recs = (meta?.recommendations ?? []).filter((r) => r && (r.backdrop || r.poster)).slice(0, 12);
  /* Every trailer IMDb has; until that answers (or when it has none), the one the screen already has —
   * IMDb's latest file, or a YouTube key alone, which gets the box full screen only. */
  const videos = useImdbVideos(shown ? meta?.imdb : undefined).data?.videos ?? [];
  const showTrailer = videos.length > 0 || !!trailer?.url || !!meta?.trailerKey;
  const videoCount = videos.length || 1;
  const seasons = isSeries && meta ? seasonsOf(meta) : [];

  const browseSections: PageSection[] = [
    ...seasons.map((s) => ({
      key: `s${s.season}`,
      label: s.name || t('modal.season', { n: s.season }),
      count: s.episodes ? t('modal.episodes_count', { n: s.episodes }) : undefined,
    })),
    ...(showTrailer ? [{ key: 'trailers', label: t('tv.trailers_more'), count: videoCount === 1 ? t('tv.video_one') : t('tv.videos_count', { n: videoCount }) }] : []),
    ...(recs.length ? [{ key: 'more', label: t('tv.more_like_this'), count: t('tv.titles_count', { n: recs.length }) }] : []),
  ];
  const openBrowse = (sec: string, from: string) => {
    returnTo.current = from;
    setBrowseSec(sec);
    push('browse');
  };

  const rated = useRatings((s) => s.ratings[String(target.id)]?.r ?? null);
  const rate = useRatings((s) => s.rate);

  const menu: MenuItem[] = [
    ...(canPlay ? [{
      key: 'play',
      glyph: 'play' as const,
      label: t(resuming ? 'tv.resume' : 'tv.play'),
      sub: isSeries
        ? (upNext ? `S${upNext.season}:E${upNext.ep}` : '')
        : (filmResume && filmP ? t('modal.ep_left', { time: dur(filmP.dur - filmP.pos) }) : ''),
      bar: resuming ? (isSeries ? upNext!.pct : filmPct) : undefined,
      run: () => { void play(); },
    }] : []),
    ...(isSeries && seasons.length ? [{
      key: 'episodes', glyph: 'episodes' as const, label: t('tv.episodes_more'),
      run: () => openBrowse(`s${upNext?.season ?? seasons[0].season}`, 'episodes'),
    }] : []),
    ...(!isSeries && showTrailer ? [{
      key: 'trailers', glyph: 'trailers' as const, label: t('tv.trailers_more'),
      run: () => openBrowse('trailers', 'trailers'),
    }] : []),
    { key: 'list', glyph: added ? 'added' as const : 'add' as const, label: t(added ? 'mylist.remove' : 'mylist.add'), run: onAdd },
    {
      key: 'sources', glyph: 'sources' as const, label: t('tv.sources'),
      run: () => { returnTo.current = 'sources'; openSources(upNext ? { season: upNext.season, ep: upNext.ep } : null); },
    },
    ...(recs.length ? [{
      key: 'more', glyph: 'more' as const, label: t('tv.more_like_this'),
      run: () => openBrowse('more', 'more'),
    }] : []),
  ];

  /* ---- THE BOX ON THE MENU ----------------------------------------------------------------------
   * `.tv-dm-acts` is the box's frame of reference. The mark moves to the focused item (or the circle
   * behind a focused thumb); the ink inside it — a black copy of the menu — moves the other way by the
   * same amount on the same clock, so it never moves on screen at all, and wherever the mark is, the
   * label under it reads black. */
  const actsRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const lastIcon = useRef(0);
  const lastStep = useRef(0);
  const placeMain = (el: HTMLElement) => {
    const scope = actsRef.current;
    const mark = markRef.current;
    const ink = inkRef.current;
    const list = menuRef.current;
    if (!scope || !mark || !ink || !list) return;
    const { x, y } = offsetIn(el, scope);
    mark.classList.toggle('is-round', el.classList.contains('tv-dm-icon'));
    ink.style.transform = `translate3d(${list.offsetLeft - x}px, ${list.offsetTop - y}px, 0)`;
    moveMark(mark, x, y, el.offsetWidth, el.offsetHeight);
  };
  const onMainFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!el.matches('.tv-dm-item, .tv-dm-icon')) return;
    if (el.classList.contains('tv-dm-icon')) {
      lastIcon.current = Array.from(iconsRef.current?.querySelectorAll('.tv-dm-icon') ?? []).indexOf(el);
    }
    placeMain(el);
  };
  const onMainBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) hideMark(markRef.current);
  };
  /* The menu walks Up and Down, the thumbs Left and Right; Up off the menu's top is the thumb you were
   * last on, Down off the thumbs is the menu's first item. Answered here and stopped, like the pages. */
  const onMainKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!ARROWS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    const now = performance.now();
    if (e.repeat && now - lastStep.current < HELD_STEP_MS) { e.preventDefault(); return; }
    const icons = Array.from(iconsRef.current?.querySelectorAll<HTMLElement>('.tv-dm-icon') ?? []);
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.tv-dm-item') ?? []);
    const ae = document.activeElement as HTMLElement | null;
    const ii = ae ? items.indexOf(ae) : -1;
    const ci = ae ? icons.indexOf(ae) : -1;
    let to: HTMLElement | undefined;
    if (ii >= 0) {
      if (e.key === 'ArrowDown') to = items[ii + 1];
      else if (e.key === 'ArrowUp') to = ii > 0 ? items[ii - 1] : icons[Math.min(lastIcon.current, icons.length - 1)];
    } else if (ci >= 0) {
      if (e.key === 'ArrowLeft') to = icons[ci - 1];
      else if (e.key === 'ArrowRight') to = icons[ci + 1];
      else if (e.key === 'ArrowDown') to = items[0];
    } else to = items[0];
    if (!to) return;
    e.preventDefault();
    lastStep.current = now;
    to.focus({ preventScroll: true });
  };
  /* THE MENU TAKES THE REMOTE when it appears: Play on opening, the item a page was opened from on the
   * way back. Only off nothing — focus already in the menu is the viewer's. */
  useEffect(() => {
    if (!shown || view !== 'main') return;
    const root = actsRef.current;
    const ae = document.activeElement;
    if (!root || (ae && root.contains(ae))) return;
    (root.querySelector<HTMLElement>(`[data-act="${returnTo.current}"]`)
      ?? root.querySelector<HTMLElement>('.tv-dm-item'))?.focus({ preventScroll: true });
  }, [shown, view, parkRun]);

  // TvSpatialNav's recovery (`[data-tv-recover]`) lands where this effect would.
  const recoverKey = menu.some((m) => m.key === returnTo.current) ? returnTo.current : menu[0]?.key;
  const menuRow = (it: MenuItem, ink: boolean) => {
    const inner = (
      <>
        <MenuIcon name={it.glyph} />
        <span className="tv-dm-label">{it.label}</span>
        {it.sub && <span className="tv-dm-sub">{it.sub}</span>}
        {it.bar !== undefined && <span className="tv-dm-bar"><i style={{ width: `${it.bar}%` }} /></span>}
      </>
    );
    const cls = `tv-dm-item${it.key === 'play' && playBusy ? ' is-busy' : ''}`;
    if (ink) return <span key={it.key} className={cls}>{inner}</span>;
    return (
      <button
        key={it.key}
        type="button"
        className={cls}
        data-act={it.key}
        data-tv-recover={it.key === recoverKey ? '' : undefined}
        aria-busy={it.key === 'play' ? playBusy : undefined}
        aria-pressed={it.key === 'list' ? added : undefined}
        onClick={it.run}
      >
        {inner}
      </button>
    );
  };

  const mainView = (
    <div key={parkRun} className={`tv-det-grid tv-dm${copyIn ? ' is-in' : ''}${pv ? ' is-pv' : ''}`}>
      <div className="tv-dm-col">
        {pv ? (
          <div className="pv-head">
            <h2 id="mTitle">
              {pv.logo ? <img className="pv-logo" src={pv.logo} alt={pv.name} decoding="sync" /> : <span className="pv-title">{pv.name}</span>}
            </h2>
            {(pv.badge || pv.callout) && (
              <p className="pv-tags">
                {pv.badge && <span className="pv-badge">{pv.badge}</span>}
                {pv.callout && <span className="pv-callout">{pv.callout}</span>}
              </p>
            )}
            <p className="pv-meta">
              {pv.facts.map((f, i) => (
                <span key={f.key} className={`pv-${f.key}${f.text && !pvFirst.current?.[i] ? ' is-late' : ''}`}>{f.text}</span>
              ))}
            </p>
            {/* The whole synopsis, as the panel opens to it before handing over. */}
            {pv.synopsis && <p className="pv-synopsis is-full">{pv.synopsis}</p>}
          </div>
        ) : (
          <>
            {logo(true)}
            {factsLine(facts)}
            {callouts.length > 0 && <div className="tv-dm-callouts">{callouts.map((c) => <p key={c.kind}>{c.text}</p>)}</div>}
            {headline && <p className="tv-dm-headline">{headline}</p>}
            {synopsis && <p className="tv-dm-plot">{synopsis}</p>}
          </>
        )}
        {(castLine || makerLine || genresLine) && (
          <div className="tv-dm-credits">
            {castLine && <p><span>{t('tv.cast')}:</span> {castLine}</p>}
            {makerLine && <p><span>{makerLabel}:</span> {makerLine}</p>}
            {genresLine && <p>{genresLine}</p>}
          </div>
        )}
        <div className="tv-dm-acts" ref={actsRef} onKeyDown={onMainKey} onFocus={onMainFocus} onBlur={onMainBlur}>
          <span className="tv-dm-mark" ref={markRef} aria-hidden="true">
            <span className="tv-dm-ink" ref={inkRef}>
              <span className="tv-dm-menu">{menu.map((it) => menuRow(it, true))}</span>
            </span>
          </span>
          <div className="tv-dm-icons" ref={iconsRef} role="group" aria-label={t('rate.cta')}>
            {THUMBS.map((r) => (
              <button
                key={r}
                type="button"
                className={`tv-dm-icon${rated === r ? ' on' : ''}`}
                aria-pressed={rated === r}
                aria-label={t(`rate.${r}`)}
                onClick={() => rate(target.id, rated === r ? null : r, { type: target.type, title, genres: meta?.genre })}
              >
                <ThumbIcon kind={r} />
                <span className="tv-dm-tip" aria-hidden="true">{t(`rate.${r}`)}</span>
              </button>
            ))}
          </div>
          <div className="tv-dm-menu" ref={menuRef}>{menu.map((it) => menuRow(it, false))}</div>
        </div>
      </div>
    </div>
  );

  /* ---- EPISODES & MORE ------------------------------------------------------------------------- */
  const sec = browseSections.find((s) => s.key === browseSec) ?? browseSections[0];
  const browseSeason = view === 'browse' && sec && /^s\d+$/.test(sec.key) ? Number(sec.key.slice(1)) : undefined;
  // The season on screen: the one the page shows, or the one the sources are for (its episode's name).
  const pageSeason = browseSeason ?? (view === 'sources' ? pickedEp?.season : undefined);
  const seasonQ = useSeason(meta?.id, meta?.addonEpisodes ? undefined : pageSeason, meta?.imdb);
  const browseEps = episodesOf(meta, browseSeason, seasonQ.data?.episodes);
  const resumeOf = (season: number, ep: number) => {
    const pr = progress[`${target.id}:S${season}E${ep}`];
    return pr && pr.dur > 0 ? { pct: Math.min(100, (pr.pos / pr.dur) * 100), at: pr.at || 0 } : { pct: 0, at: 0 };
  };
  const pageHead = (sub?: string) => (
    <>
      {logo(false)}
      {factsLine([year ? String(year) : '', seasonsText, !isSeries ? meta?.runtime || '' : ''].filter(Boolean))}
      {sub && <p className="tv-tp-headsub">{sub}</p>}
    </>
  );

  let browsePage: ReactNode = null;
  if (view === 'browse') {
    let heading: ReactNode = sec?.label;
    let cells: ReactNode = null;
    let cols = 1;
    let entry = 0;
    if (browseSeason !== undefined) {
      // "Season 2 · [16]": the certificate in Netflix's outlined box.
      heading = <>{sec?.label}{meta?.certification && <><span className="tv-tp-dot">·</span><span className="tv-tp-age">{meta.certification}</span></>}</>;
      const aim = lastEp.current?.season === browseSeason ? lastEp.current
        : upNext?.season === browseSeason ? { season: upNext.season, ep: upNext.ep } : null;
      entry = deckOpensOn(browseEps, browseSeason, aim, (ep) => resumeOf(browseSeason, ep));
      cells = seasonQ.isLoading && !browseEps.length
        ? <div className="tv-tp-note">{t('modal.loading_synopsis')}</div>
        : browseEps.length
          ? browseEps.map((e) => (
            <EpisodeCell
              key={e.episode}
              ep={e}
              pct={resumeOf(browseSeason, e.episode).pct}
              busy={busyEp === `${browseSeason}:${e.episode}`}
              onPick={() => { void playEp(browseSeason, e.episode); }}
            />
          ))
          : <div className="tv-tp-note">{t('modal.episodes_unavailable')}</div>;
    } else if (sec?.key === 'trailers') {
      cols = 3;
      const wordmark = titleLogo ? rasterLogo(titleLogo, 'original') : undefined;
      cells = videos.length
        ? videos.map((v) => (
          <TvTrailerBox key={v.id} video={v} thumb={v.thumb || undefined} name={v.name} title={title} logo={wordmark} />
        ))
        : (
          <TvTrailerBox
            video={trailer}
            ytKey={meta?.trailerKey}
            still={meta?.backdrop ? imgW(meta.backdrop, 'w780') : undefined}
            title={title}
            logo={wordmark}
          />
        );
    } else if (sec?.key === 'more') {
      cols = 3;
      cells = recs.map((r) => (
        <MoreCell
          key={`${r.type}:${r.id}`}
          item={r}
          onOpen={() => openTitle({ id: r.id, type: r.type, title: r.title, year: r.year, rating: r.rating, poster: r.poster, seed: 0 })}
        />
      ));
    }
    browsePage = (
      <TvTitlePage
        head={pageHead()}
        sections={browseSections}
        current={sec?.key ?? ''}
        onSection={setBrowseSec}
        heading={heading}
        cols={cols}
        entry={entry}
        start="right"
      >
        {cells}
      </TvTitlePage>
    );
  }

  /* ---- SOURCES -----------------------------------------------------------------------------------
   * Streaming Services, then the add-ons — one row per language when they offer more than one, under
   * a caption, so choosing a language is resting on it rather than opening a menu. */
  const services = srcTab === 'services' ? pickWatchServices(meta?.providers, title) : [];
  let sourcesPage: ReactNode = null;
  if (view === 'sources') {
    const langs = signedIn && availableLangs.length > 1 ? availableLangs : [];
    const sections: PageSection[] = [
      { key: 'services', label: t('modal.tab_streaming') },
      ...(langs.length
        ? langs.map((l, i) => ({
          key: `lang:${l}`,
          label: <><i className={`flag flag-${l}`} />{langName(l)}</>,
          caption: i === 0 ? t('modal.tab_addons') : undefined,
          sub: true,
        }))
        : [{ key: 'addons', label: t('modal.tab_addons') }]),
    ];
    const current = srcTab === 'services' ? 'services' : langs.length ? `lang:${langs.includes(lang) ? lang : langs[0]}` : 'addons';
    const onSection = (key: string) => {
      if (key === 'services') { setSrcTab('services'); return; }
      setSrcTab('addons');
      if (key.startsWith('lang:')) setLang(key.slice(5));
    };
    let cells: ReactNode;
    if (srcTab === 'services') {
      cells = services.length ? services.map((s) => (
        <a className="tv-tp-src" key={s.key} href={s.link} target="_blank" rel="noopener noreferrer" data-cell=""
           aria-label={t('modal.watch_on', { name: s.name })}>
          <span className="tv-tp-src-logo" aria-hidden="true">{s.logo && <img src={s.logo} alt="" decoding="async" />}</span>
          <span className="tv-tp-src-title">{s.name}</span>
          <span className="tv-tp-src-chev" aria-hidden="true">›</span>
        </a>
      )) : <div className="tv-tp-note">{t('modal.no_providers')}</div>;
    } else if (!signedIn) {
      cells = (
        <div className="tv-tp-note">
          <span>{t('modal.signin_addon')}</span>
          <button type="button" className="tv-tp-signin" data-cell="" data-ring="pill" onClick={() => openAuth()}>{t('auth.signin')}</button>
        </div>
      );
    } else if (shownStreams.length) {
      /* Rows outrank the still-loading note: the remote has something to press the moment the first
       * add-on answers, and the note follows them while the rest are still coming. */
      cells = (
        <>
          {shownStreams.map((s, i) => (
            <button className="tv-tp-src" type="button" key={i} data-cell="" aria-label={streamTitle} onClick={() => playStream(s)}>
              <span className={`quality-badge ${qualClass(s.quality)}`}>{s.quality || 'SD'}</span>
              <span className="tv-tp-src-title">
                {s.label || streamTitle}
                <span className="tv-tp-src-sub">{[s.size, s.source, sourceNote(s) && t(`modal.source_${sourceNote(s)}`)].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="tv-tp-src-chev" aria-hidden="true">›</span>
            </button>
          ))}
          {streamsLoading && <div className="tv-tp-note" role="status">{t('modal.more_sources')}</div>}
        </>
      );
    } else {
      cells = <div className="tv-tp-note" role={streamsLoading ? 'status' : undefined}>{t(streamsLoading ? 'modal.searching_sources' : 'modal.no_streams')}</div>;
    }
    const epName = pickedEp ? episodesOf(meta, pickedEp.season, seasonQ.data?.episodes).find((e) => e.episode === pickedEp.ep)?.name : undefined;
    const currentLabel = sections.find((s) => s.key === current)?.label;
    sourcesPage = (
      <TvTitlePage
        head={pageHead(pickedEp ? [epLabel(pickedEp.season, pickedEp.ep), epName].filter(Boolean).join(' · ') : undefined)}
        sections={sections}
        current={current}
        onSection={onSection}
        heading={current.startsWith('lang:') ? <>{t('modal.tab_addons')} · {currentLabel}</> : currentLabel}
        start="right"
      >
        {cells}
      </TvTitlePage>
    );
  }

  return (
    <div
      className={`overlay open tv-det${noIn ? ' no-in' : ''}`}
      data-parked={parked ? '' : undefined}
      id="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mTitle"
      aria-hidden="false"
    >
      {/* Mounted invisible behind the veil and revealed with it, so its arrival is the screen's
          arrival rather than an event of its own. The box carries the picture's edge fade too (tv.css). */}
      <div className={`tv-det-art${artReady ? ' rdy' : ''}${pv ? ' is-pv' : ''}`} aria-hidden="true">
        {backdropUrl && <img src={backdropUrl} alt="" decoding="async" />}
      </div>
      <div className={`tv-det-scrim${view === 'main' ? '' : ' is-page'}`} aria-hidden="true" />

      {/* The spinner and nothing else while /api/meta and the backdrop are on their way. Back gets out
          (DetailModal's `handleBack`), so the veil needs no control of its own — a lone ✕ would be the
          only candidate on the layer, and TvSpatialNav would ring it. */}
      {!shown ? (
        <div className="m-load-veil" role="status" aria-busy="true" aria-label={t('modal.loading_synopsis')}>
          <span className="cat-loader" aria-hidden="true" />
        </div>
      ) : view === 'main' ? mainView : view === 'browse' ? browsePage : sourcesPage}
    </div>
  );
}
