import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useModal } from '../../stores/modal';
import { usePlayer } from '../../stores/player';
import { useLibrary } from '../../stores/library';
import { useAuth } from '../../stores/auth';
import { useHistory } from '../../stores/history';
import { useMeta } from '../../lib/queries';
import { useT, useGenre } from '../../i18n/i18n';
import { hueBg } from '../../lib/img';
import type { MetaDetail, MediaItem, CastMember } from '../../lib/types';
import { useTrailer } from './useTrailer';
import EpisodeChooser from './EpisodeChooser';
import StreamLangSelect from './StreamLangSelect';
import SourceSelect from './SourceSelect';
import { collectAddonStreams, orderLangs, qualityRank, type AddonStream } from '../../lib/addonClient';
import { pickWatchServices } from '../../lib/watchProviders';

const qualClass = (q: string) => (q === '4K' ? 'q-4k' : q === '1080p' ? 'q-1080' : 'q-720');

/* Detail modal — faithful port of the #overlay markup + openInfoModal/enrichModalMeta/
 * renderCast/renderRecs (assets/js/app.js). Seeded from the clicked card for an instant
 * paint, then enriched from /api/meta. */

const SpeakerOff = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" /><line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" /></svg>
);
const SpeakerOn = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);

function Avatar({ name, profile }: { name?: string; profile?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="m-avatar fallback" role="img" aria-label={name || ''}>
      <span className="m-avatar-ph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 12.6a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2ZM12 14.4c-5.2 0-9 3.1-9 7.4V24h18v-2.2c0-4.3-3.8-7.4-9-7.4Z" /></svg></span>
      {profile && !broken && <img src={profile} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
    </span>
  );
}

function Cast({ meta, isTv }: { meta?: MetaDetail; isTv: boolean }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const cast: CastMember[] = meta?.cast ?? [];
  const dirName = meta?.director || meta?.creators?.[0]?.name || '';
  const dirPhoto = meta?.creators?.find((c) => c.name === dirName)?.profile;
  const LIMIT = 5;
  if (!cast.length && !dirName) return null;

  return (
    <aside className={`m-cast${expanded ? ' expanded' : ''}`} id="mCast" aria-labelledby="mCastLabel">
      <h4 className="m-rail-label" id="mCastLabel">{t('modal.cast_credits')}</h4>
      {dirName && (
        <div className="m-cast-director">
          <Avatar name={dirName} profile={dirPhoto} />
          <div className="m-cast-body">
            <div className="m-cd-name">{dirName}</div>
            <div className="m-cd-role">{t(isTv ? 'modal.creator' : 'modal.director')}</div>
          </div>
        </div>
      )}
      <div className="m-cast-list">
        {cast.map((c, i) => (
          <div className={`m-cast-item${i >= LIMIT && !expanded ? ' m-hidden' : ''}`} key={i}>
            <Avatar name={c.name} profile={c.profile} />
            <div className="m-cast-body">
              <div className="m-cast-name">{c.name}</div>
              {c.character && <div className="m-cast-char">{t('modal.as', { name: c.character })}</div>}
            </div>
          </div>
        ))}
      </div>
      {cast.length > LIMIT && (
        <button className="m-showall" type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <span className="m-showall-txt">{t(expanded ? 'modal.show_less' : 'modal.show_all')}</span>
          <span className="m-showall-chev" aria-hidden="true">▾</span>
        </button>
      )}
    </aside>
  );
}

function Recs({ meta, onOpen }: { meta?: MetaDetail; onOpen: (r: MediaItem) => void }) {
  const t = useT();
  const recs = (meta?.recommendations ?? []).filter((r) => r && (r.backdrop || r.poster));
  if (!recs.length) return null;
  return (
    <div className="m-recs" id="mRecs">
      <h4 className="m-rail-label m-recs-label">{t('modal.you_may_like')}</h4>
      <div className="rec-grid">
        {recs.map((r) => {
          const img = r.backdrop || r.poster;
          const tp = r.type === 'tv' ? 'SERIES' : 'MOVIE';
          const metaLine = r.year ? `${r.year} • ${tp}` : tp;
          return (
            <button className="rec-card" type="button" key={String(r.id)} onClick={() => onOpen(r)}>
              <span className="rec-thumb">
                {img && <img src={img} loading="lazy" decoding="async" alt="" />}
                {r.rating ? <span className="rec-rate">★ {r.rating}</span> : null}
              </span>
              <span className="rec-cap">
                <span className="rec-title">{r.title}</span>
                <span className="rec-meta">{metaLine}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DetailModal() {
  const t = useT();
  const genre = useGenre();
  const target = useModal((s) => s.target);
  const open = useModal((s) => s.open);
  const close = useModal((s) => s.close);
  const playSource = usePlayer((s) => s.play);
  const playerOpen = usePlayer((s) => !!s.source);
  const mylist = useLibrary((s) => s.mylist);
  const toggleList = useLibrary((s) => s.toggle);
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  // Subscribe to the progress map so the hero button's resume bar re-renders the
  // moment a watch position is saved; getResume applies the <1% / >94% filter.
  useHistory((s) => s.progress);
  const getResume = useHistory((s) => s.getResume);
  const signedIn = !!user;

  const heroRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const episodesRef = useRef<HTMLDivElement>(null);
  const streamsRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [bdLoaded, setBdLoaded] = useState(false);
  const [pickedEp, setPickedEp] = useState<{ season: number; ep: number } | null>(null);
  const [streams, setStreams] = useState<AddonStream[]>([]);
  const [streamsLoading, setStreamsLoading] = useState(false);
  const [lang, setLang] = useState<string>('');
  const [srcTab, setSrcTab] = useState<'services' | 'addons'>('services');

  const isTv = target?.type === 'tv' || target?.type === 'series';
  const { data: meta, isError: metaError } = useMeta(target?.id, target?.type);
  // While the player is open on top, drop the trailer key so useTrailer tears the
  // autoplaying YouTube iframe down (it kept streaming a whole second video behind the
  // player). The modal's `target` stays set, so closing the player restores it — and
  // the trailer remounts — exactly where the user left off.
  const { muted, toggleMute } = useTrailer(slotRef, heroRef, playerOpen ? undefined : (meta?.trailerKey || undefined), meta?.title || target?.title || '');

  // reset backdrop fade + scroll on each new title; seed the picked episode from a
  // Continue-Watching resume so OPEN builds the exact-episode key (id:S#E#)
  useEffect(() => {
    setBdLoaded(false);
    setPickedEp(target?.resumeEp ? { season: target.resumeEp.season, ep: target.resumeEp.episode } : null);
    setSrcTab('services');
    scrollRef.current?.scrollTo({ top: 0 });
  }, [target?.id, target?.resumeEp?.season, target?.resumeEp?.episode]);

  // client-direct add-on streams: ask every installed stream add-on for this title's
  // sources (movie → tt…; series → tt…:season:episode, once an episode is picked)
  useEffect(() => {
    const imdb = meta?.imdb;
    if (!imdb) { setStreams([]); return; }
    if (isTv && !pickedEp) { setStreams([]); return; }
    const videoId = isTv && pickedEp ? `${imdb}:${pickedEp.season}:${pickedEp.ep}` : imdb;
    const type = isTv ? 'series' : 'movie';
    let alive = true;
    setStreamsLoading(true); setStreams([]);
    collectAddonStreams(videoId, type)
      .then((s) => { if (alive) setStreams(s); })
      .finally(() => { if (alive) setStreamsLoading(false); });
    return () => { alive = false; };
  }, [meta?.imdb, isTv, pickedEp]);

  // default the language bucket when the sources change: keep the current pick if it's
  // still offered, else prefer the language the user was last watching (so RESUME plays
  // the same one), else fall back to the first available.
  useEffect(() => {
    const langs = orderLangs(streams.flatMap((s) => s.langs));
    // Compute the resume key inline rather than via buildMediaFor(): that helper is a
    // const declared below the `if (!target) return` early-return, so it sits in the
    // temporal dead zone on the target=null render that fires when the modal closes
    // (which also resets `streams` → [], re-running this effect). Touching it there
    // threw "Cannot access 'buildMediaFor' before initialization" and crashed the app.
    const rkey = target ? (pickedEp ? `${target.id}:S${pickedEp.season}E${pickedEp.ep}` : String(target.id)) : '';
    const savedLang = signedIn && rkey ? getResume(rkey)?.lang : undefined;
    setLang((cur) => {
      if (cur && langs.includes(cur)) return cur;
      if (savedLang && langs.includes(savedLang)) return savedLang;
      return langs[0] || '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams]);

  // picking an episode brings its freshly-loaded sources into view (matches vanilla)
  useEffect(() => { if (pickedEp) streamsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [pickedEp]);

  // close the modal when the route changes (navigating away dismisses it)
  const { pathname } = useLocation();
  useEffect(() => { close(); }, [pathname, close]);

  // Escape to close + focus the close button on open
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const id = window.setTimeout(() => closeBtnRef.current?.focus(), 40);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(id); };
  }, [target, close]);

  if (!target) return <div className="overlay" id="overlay" aria-hidden="true" />;

  const titleLogo = meta?.titleLogo;
  const title = meta?.title || target.title || '';
  const rating = meta?.rating ?? target.rating;
  const year = meta?.year ?? target.year;
  const genreChips = meta?.genre ?? (target.genre ? [target.genre] : []);
  const plot = meta ? (meta.plot || meta.tagline || t('modal.no_synopsis')) : t('modal.loading_synopsis');
  // Hold the reveal until /api/meta lands so the overlay opens already-populated
  // (backdrop, logo, all genres, synopsis, cast, sources) instead of flashing the
  // seeded/partial card data. Fall back to seeded content if the fetch errors so it
  // can never spin forever.
  const ready = !!meta || metaError;

  const epTotal = (meta?.seasonList ?? []).reduce((a, s) => a + (s.episodes || 0), 0);
  const added = mylist.some((m) => String(m.id) === String(target.id));
  const onAdd = () => toggleList({ id: target.id, type: target.type, title, year, rating, poster: meta?.poster || target.poster });

  type Ep = { season: number; ep: number };
  const epsInSeason = (season: number) => meta?.seasonList?.find((s) => s.season === season)?.episodes ?? 0;
  // the next episode after `ep`: next in the same season, else episode 1 of the next season
  const nextEpOf = (ep: Ep | null): Ep | null => {
    if (!ep || !meta?.seasonList?.length) return null;
    if (ep.ep < epsInSeason(ep.season)) return { season: ep.season, ep: ep.ep + 1 };
    const seasons = meta.seasonList.filter((s) => s.season >= 1).map((s) => s.season).sort((a, b) => a - b);
    const ns = seasons[seasons.indexOf(ep.season) + 1];
    return ns != null && epsInSeason(ns) > 0 ? { season: ns, ep: 1 } : null;
  };
  const buildMediaFor = (ep: Ep | null, langTag?: string) => {
    const key = ep ? `${target.id}:S${ep.season}E${ep.ep}` : String(target.id);
    return { id: target.id, key, title, poster: meta?.poster || target.poster, year, type: target.type, genre: target.genre, rating, ep: ep ? `S${ep.season}E${ep.ep}` : undefined, season: ep?.season ?? null, episode: ep?.ep ?? null, lang: langTag || undefined };
  };
  const subsOf = (s: AddonStream) => s.subtitles?.map((x) => ({ lang: x.lang, label: x.lang || 'Subtitle', url: x.url }));
  // series context for the in-player episodes panel (only for a series episode)
  const seriesFor = (ep: Ep | null) => (ep && meta?.seasonList?.length
    ? { seasons: meta.seasonList, metaId: target.id, imdb: meta.imdb, season: ep.season, ep: ep.ep, title, playEp: (s: number, e: number) => { void playEpisode(s, e); } }
    : undefined);
  const playStreamFor = (s: AddonStream, ep: Ep | null, langTag?: string) => {
    const nxt = nextEpOf(ep);
    // the language this playback represents, so resume can pick the same one later
    const chosen = langTag ?? (lang && s.langs.includes(lang) ? lang : s.langs[0]);
    playSource({
      url: s.url, kind: s.kind, title,
      subtitle: ep ? `S${ep.season} · E${ep.ep}` : undefined,
      media: buildMediaFor(ep, chosen), subtitles: subsOf(s),
      next: nxt ? () => { void playEpisode(nxt.season, nxt.ep); } : undefined,
      series: seriesFor(ep),
    });
  };
  const playStream = (s: AddonStream) => playStreamFor(s, pickedEp);
  // switch to a specific episode, fetch its sources, and play the best one (auto-next)
  const playEpisode = async (season: number, ep: number) => {
    const imdb = meta?.imdb; if (!imdb) return;
    setPickedEp({ season, ep });
    const list = await collectAddonStreams(`${imdb}:${season}:${ep}`, 'series');
    const langs = orderLangs(list.flatMap((s) => s.langs));
    const want = langs.includes(lang) ? lang : langs[0];
    const shown = list.filter((s) => !want || s.langs.includes(want)).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    const best = shown[0] || list[0];
    if (best) { playStreamFor(best, { season, ep }, want); return; }
    const nxt = nextEpOf({ season, ep });
    playSource({ url: '/assets/demo.mp4', title, subtitle: `S${season} · E${ep}`, media: buildMediaFor({ season, ep }), next: nxt ? () => { void playEpisode(nxt.season, nxt.ep); } : undefined, series: seriesFor({ season, ep }) });
  };
  // language buckets (from the sources) + the sources for the picked language, sorted
  // best-quality first
  const availableLangs = orderLangs(streams.flatMap((s) => s.langs));
  const shownStreams = streams
    .filter((s) => !lang || s.langs.includes(lang))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  // Each stream row is titled by the open CONTENT — the movie name, or for a series the
  // show name + chosen episode as `S# · E#` (same format the player subtitle uses). The
  // add-on's own caption (s.label) drops to the detail line so its release info survives.
  const streamTitle = isTv && pickedEp ? `${title} · S${pickedEp.season} · E${pickedEp.ep}` : title;

  // Play the best available source for the current language/episode. The player
  // seeks to any saved resume position itself (VideoPlayer reads getResume), so
  // "continue watching" needs no extra wiring here.
  const playBest = () => {
    if (shownStreams.length) playStreamFor(shownStreams[0], pickedEp);
    else if (streams.length) playStreamFor(streams[0], pickedEp);
  };

  // Saved resume position for the current title (movie) or picked episode — only
  // meaningful for a signed-in user, since watch history is a signed-in feature.
  const resume = signedIn ? getResume(buildMediaFor(pickedEp).key) : null;
  const resumePct = resume && resume.dur > 0 ? Math.min(100, Math.max(0, (resume.pos / resume.dur) * 100)) : 0;
  // minutes into the title where playback will pick up — shown on the RESUME button
  const resumeMin = resume ? Math.max(1, Math.round(resume.pos / 60)) : 0;
  const hasSource = shownStreams.length > 0 || streams.length > 0;

  const hasEpisodes = isTv && !!meta?.seasonList?.length;

  // Hero CTA behaviour, by state:
  //  • signed in + resume → continue from the saved position (auto-seek in the player)
  //  • otherwise (incl. signed out) → scroll to the episode chooser if this is a series,
  //    else scroll the source list into view so a source is chosen
  const onWatch = () => {
    if (signedIn && resume && hasSource) { playBest(); return; }
    if (hasEpisodes) {
      episodesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setSrcTab('addons');
    streamsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const watchLabel = signedIn ? t(resume ? 'modal.resume' : 'modal.watch_authed') : t('modal.watch');

  return (
    <div
      className="overlay open"
      id="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mTitle"
      aria-hidden="false"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal">
        <div className="m-scroll" id="mScroll" ref={scrollRef}>
          {/* HERO */}
          <div className="m-hero" id="mHero" ref={heroRef}>
            <div className="poster m-hero-bg" id="mPoster" aria-hidden="true" style={{ background: hueBg(target.seed || 0) }}>
              {target.poster && (
                <div className="art" style={{ position: 'absolute', inset: 0 }}>
                  <img className="m-ambient" src={target.poster} loading="lazy" alt="" />
                </div>
              )}
              {meta?.backdrop && (
                <div className="art" style={{ position: 'absolute', inset: 0 }}>
                  <img className={bdLoaded ? 'm-backdrop rdy' : 'm-backdrop'} src={meta.backdrop} alt="" decoding="async" onLoad={() => setBdLoaded(true)} />
                </div>
              )}
            </div>
            <div className="m-hero-trailer-slot" id="mTrailerSlot" ref={slotRef} aria-hidden="true" />
            <div className="m-hero-scrim" aria-hidden="true" />
            <button className="close m-disc" id="closeModal" ref={closeBtnRef} type="button" aria-label={t('modal.close_aria')} onClick={close}>✕</button>
            <button className="m-mute m-disc" id="mMuteBtn" type="button" aria-pressed={muted} aria-label={t(muted ? 'modal.unmute' : 'modal.mute')} onClick={toggleMute}>
              <span className="m-mute-ic" aria-hidden="true">{muted ? SpeakerOff : SpeakerOn}</span>
            </button>
            {ready && (
            <div className="m-hero-inner">
              <h2 id="mTitle" className={titleLogo ? 'has-logo' : ''}>
                {titleLogo ? <img className="title-logo" src={titleLogo} alt={title} /> : title}
              </h2>
              <div className="meta m-meta" id="mMeta">
                {rating ? <><span className="star">★</span> {rating}</> : null}
                {year ? <span>{year}</span> : null}
                {meta?.runtime ? <span>{meta.runtime}</span> : null}
                {isTv && meta?.seasons ? (
                  <span>{[meta.seasons === 1 ? t('modal.season_one') : t('modal.seasons_count', { n: meta.seasons }), epTotal ? t('modal.episodes_count', { n: epTotal }) : ''].filter(Boolean).join(' · ')}</span>
                ) : null}
              </div>
              <div className="m-genres" id="mGenres">
                {genreChips.map((g) => <span className="chip" key={g}>{genre(g)}</span>)}
              </div>
              <div className="m-hero-actions">
                <button className={`hero-btn hero-play${resume ? ' has-resume' : ''}`} id="mWatch" type="button" onClick={onWatch}>
                  <span className="ic" aria-hidden="true">▶</span><span>{watchLabel}{resume ? <span className="hero-resume-at"> · {resumeMin} min</span> : null}</span>
                  {resume ? <span className="hero-progress" aria-hidden="true"><span className="hero-progress-fill" style={{ width: `${resumePct}%` }} /></span> : null}
                </button>
                <button className={`hero-add m-disc${added ? ' on' : ''}`} id="mAdd" type="button" aria-pressed={added} aria-label={t(added ? 'mylist.remove' : 'mylist.add')} onClick={onAdd}>{added ? '✓' : '+'}</button>
              </div>
            </div>
            )}
          </div>

          {ready && (<>
          {/* BODY */}
          <div className="m-body">
            <div className="m-main">
              {meta?.tagline && <div className="m-tagline" id="mTagline">{meta.tagline}</div>}
              <p className="plot m-plot" id="mPlot">{plot}</p>

              {isTv && meta && <div ref={episodesRef}><EpisodeChooser meta={meta} initial={target.resumeEp} onEpisode={(season, ep) => setPickedEp({ season, ep })} /></div>}

              <div className="m-streams" ref={streamsRef}>
                <div className="m-rail-head">
                  <h4 className="m-rail-label">{t('modal.streams')}</h4>
                  <SourceSelect value={srcTab} onChange={setSrcTab} />
                  {srcTab === 'addons' && availableLangs.length > 0 && <StreamLangSelect langs={availableLangs} value={lang} onChange={setLang} />}
                </div>
                <div id="streamList">
                  {srcTab === 'services' ? (
                    (() => {
                      // One full-width button per major streaming service, each linking
                      // straight into the platform (never TMDB) — see watchProviders.ts.
                      const services = pickWatchServices(meta?.providers, title);
                      if (!services.length) return <div className="demo-note">{t('modal.no_providers')}</div>;
                      return services.map((p) => (
                        <a className="addon-stream m-provider" key={p.key} href={p.link} target="_blank" rel="noopener noreferrer" aria-label={t('modal.watch_on', { name: p.name })}>
                          <span className="m-provider-logo" aria-hidden="true">{p.logo && <img src={p.logo} alt="" loading="lazy" decoding="async" />}</span>
                          <span className="stream-info">
                            <span className="stream-title">{p.name}</span>
                            <span className="stream-detail">{t('modal.watch_on', { name: p.name })}</span>
                          </span>
                          <span className="addon-stream-chevron" aria-hidden="true">›</span>
                        </a>
                      ));
                    })()
                  ) : !signedIn ? (
                    <div className="stream-signin">
                      <div className="demo-note">{t('modal.signin_addon')}</div>
                      <button className="addon-signin-btn" type="button" onClick={() => openAuth()}>
                        <span className="ic" aria-hidden="true">▶</span><span>{t('auth.signin')}</span>
                      </button>
                    </div>
                  ) : isTv && !pickedEp ? (
                    <div className="demo-note">{t('modal.pick_episode')}</div>
                  ) : streamsLoading ? (
                    <div className="stream-source-label">{t('modal.loading_synopsis')}</div>
                  ) : shownStreams.length ? (
                    shownStreams.map((s, i) => (
                      <button className="addon-stream" type="button" key={i} aria-label={streamTitle} onClick={() => playStream(s)}>
                        <span className={`quality-badge ${qualClass(s.quality)}`}>{s.quality || 'SD'}</span>
                        <span className="stream-info">
                          <span className="stream-title">{streamTitle || s.label}</span>
                          <span className="stream-detail">{[s.label, s.size, s.source].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="addon-stream-chevron" aria-hidden="true">›</span>
                      </button>
                    ))
                  ) : (
                    <div className="demo-note">{t('modal.no_streams')}</div>
                  )}
                </div>
              </div>
            </div>

            <Cast meta={meta} isTv={isTv} />
          </div>

          <Recs meta={meta} onOpen={(r) => { scrollRef.current?.scrollTo({ top: 0 }); open({ id: r.id, type: r.type, title: r.title, year: r.year, rating: r.rating, poster: r.poster, seed: 0 }); }} />
          </>)}
        </div>
        {!ready && (
          <div className="m-load-veil" role="status" aria-busy="true" aria-label={t('modal.loading_synopsis')}>
            <span className="cat-loader" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}
