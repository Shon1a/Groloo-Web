import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useModal } from '../../stores/modal';
import { usePlayer } from '../../stores/player';
import { useLibrary } from '../../stores/library';
import { useAuth } from '../../stores/auth';
import { useHistory } from '../../stores/history';
import { useReport } from '../../stores/report';
import { useMeta, useAddonMeta } from '../../lib/queries';
import { useT, useGenre } from '../../i18n/i18n';
import { hueBg } from '../../lib/img';
import { epLabel } from '../../lib/utils';
import type { MetaDetail, MediaItem, CastMember } from '../../lib/types';
import { useTrailer } from './useTrailer';
import EpisodeChooser from './EpisodeChooser';
import StreamLangSelect from './StreamLangSelect';
import SourceSelect from './SourceSelect';
import { collectAddonStreams, orderLangs, qualityRank, isSingleAudioTrack, namedAudioLangs, primaryAudioLang, langName, canStartHere, sourceNote, UNDETERMINED, type AddonStream } from '../../lib/addonClient';
import { audioPlayability, silentCodecName } from '../../lib/codecs';
import { hasStreamingServer, streamingServerReady, torrentUrl } from '../../lib/streamingServer';
import { pickWatchServices } from '../../lib/watchProviders';
import { mediaUrl, syncAddressBar, type MediaAddress } from '../../lib/launchIntent';
import TvDetail from './TvDetail';

const qualClass = (q: string) => (q === '4K' ? 'q-4k' : q === '1080p' ? 'q-1080' : 'q-720');

/* EVERY LANGUAGE THE SOURCES CLAIM IS OFFERED. NOTHING IS HIDDEN.
 *
 * This filtered out languages no source could "deliver" — meaning the language was on a
 * non-default audio track and this browser cannot switch tracks. The reasoning was sound
 * and the result was worse than the bug: The Mentalist S04E16 has a `[TB+] Torrentio 720p`
 * release flagged 🇬🇧/🇷🇺 whose English track Stremio plays perfectly, and this dropped it
 * from the English tab entirely — leaving FEWER sources than Stremio lists and still no
 * English. Removing a real option is not an improvement over mislabelling it.
 *
 * So the list matches what the add-on actually offers, `forRender` puts the sources that
 * will genuinely play the chosen language first, and the ones that merely CONTAIN it are
 * labelled as such on the row. Rank and label, never hide. */
const langTabs = (list: AddonStream[]): string[] => {
  const all = orderLangs(list.flatMap((s) => s.langs));
  return [...all.filter((l) => l !== UNDETERMINED), ...all.filter((l) => l === UNDETERMINED)];
};

/* How likely this source is to ACTUALLY PLAY `want`, rather than merely contain it.
 *
 *   3 — `want` is the release's PRIMARY track, the one that plays by default.
 *   2 — one audio track and it is `want`.
 *   1 — the release name says it was dubbed into `want` ("[English Dub]").
 *   0 — `want` is in there among others, reachable only by switching audio tracks.
 *
 * Tier 3 exists because tier 2 was being fooled. `"Дом дракона … MVO (Syncmer) + Original
 * + Sub (Rus Eng)"` captions with the single flag 🇬🇧, which reads as one English audio
 * track — so it scored tier 2 and sorted to the TOP of the English list — and is a Russian
 * multi-voice-over that keeps the original beside it. `primaryAudioLang` reads the Cyrillic
 * release name and answers `ru`, which both demotes it out of English and correctly makes
 * it the best answer for Russian.
 *
 * The `und` bucket scores everything 0 because "Original" makes no claim about a language,
 * so there quality alone should decide. */
const deliverability = (s: AddonStream, want: string): number => {
  if (!want || want === UNDETERMINED) return 0;
  const primary = primaryAudioLang(s.label);
  if (primary === want) return 3;
  if (primary && primary !== want) return 0; // a known primary in ANOTHER language: not this one
  if (isSingleAudioTrack(s) && s.langs[0] === want) return 2;
  if (namedAudioLangs(s.label).includes(want)) return 1;
  return 0;
};

/* CAN THIS BROWSER SELECT AN AUDIO TRACK AT ALL?
 *
 * `HTMLMediaElement.audioTracks` is implemented by Safari, iOS and the WebKit-derived TV
 * browsers, and by NONE of Chrome, Edge or Firefox. Where it is missing, a progressive
 * file plays whatever the muxer marked default and there is no API — in any library, at
 * any price — to change it. hls.js is the exception: it demuxes the stream itself, so an
 * HLS source is always switchable regardless of browser. */
const CAN_SWITCH_TRACKS = typeof HTMLMediaElement !== 'undefined' && 'audioTracks' in HTMLMediaElement.prototype;

/* …OR a local streaming server can, on the browser's behalf. It re-serves the file as HLS
 * with one audio rendition per track, which hls.js switches between — so with one running,
 * every source becomes switchable and none of the warnings below apply. Read live rather
 * than captured in a const: detection is async and lands after first render. */
const canSwitchAudio = (): boolean => CAN_SWITCH_TRACKS || streamingServerReady();

/** Can this source actually be heard in `want` HERE — in this browser, for this file? */
const canDeliver = (s: AddonStream, want: string): boolean => {
  if (!want || want === UNDETERMINED) return true;
  if (deliverability(s, want) > 0) return true;
  return canSwitchAudio() || s.kind === 'hls'; // tier 0 is only reachable by switching
};

/* THE ROWS ARE A UI LAYER OVER `shownStreams`, NOT A REPLACEMENT FOR IT.
 *
 * `shownStreams` stays exactly the filter-then-quality-sort the parity corpus transcribes
 * as the twin of the core's `rank_streams`, and it stays the value that family compares.
 * This filters and re-sorts a COPY for rendering, which is the "UI change, not a
 * substitution" that fixture's own obligation note anticipates.
 *
 * IT RANKS, IT NO LONGER FILTERS. It briefly did both, and dropping the undeliverable
 * sources cost more than it saved — see the note on `langTabs`. Sources that will actually
 * play the chosen language come first; the rest stay listed and carry a label saying what
 * they will really play. The sort is stable, so quality still decides inside each tier. */
const forRender = (list: AddonStream[], want: string): AddonStream[] =>
  [...list].sort((a, b) => (startable(b) - startable(a)) || (audible(b) - audible(a)) || (deliverability(b, want) - deliverability(a, want)));

/** `canStartHere` as a sort key. Both builds' row lists and `bestFor` share it. */
const startable = (s: AddonStream): number => (canStartHere(s) ? 1 : 0);

/** For a row under the `want` tab: the language it will REALLY play, or null when `want`
 *  is what plays (or nothing can be said). Drives the per-row warning. */
const playsInstead = (s: AddonStream, want: string): string | null => {
  if (!want || want === UNDETERMINED || canDeliver(s, want)) return null;
  const primary = primaryAudioLang(s.label);
  return primary && primary !== want ? langName(primary) : '';
};

/* AUDIBILITY OUTRANKS LANGUAGE, because a source you cannot hear at all is not a worse
 * answer to "play this in Russian" — it is not an answer. Chrome ships no Dolby or DTS
 * decoder, so an AC-3 Russian dub plays perfect video in total silence, which is both the
 * commonest way these sources fail and the one that looks least like a bug. Sources whose
 * name claims a codec this browser cannot decode sink to the bottom; a name that claims
 * nothing ranks with the playable ones rather than being punished for being terse. */
const audible = (s: AddonStream): number => (audioPlayability(s.label) === false ? 0 : 1);

/** What the viewer was actually watching, so the next episode can be more of the same. */
export interface StreamPick { source: string; quality: string }

/** The one to start for `want`: deliverable only, audible first, then best quality. Falls
 *  back to the plain best if nothing can deliver, so ▶ is never a dead button.
 *
 *  `prefer` is the source the LAST episode played from, and it is a tie-break rather than a
 *  filter — see the note at `playEpisode`. It sits below deliverability on purpose: continuity
 *  is worth having only among sources that were already acceptable answers, and an add-on that
 *  cannot deliver the language, or cannot be started at all, does not become acceptable by
 *  virtue of having worked for episode four. */
const bestFor = (list: AddonStream[], want: string, prefer?: StreamPick | null): AddonStream | undefined => {
  const sameSource = (s: AddonStream): number => (prefer && s.source === prefer.source ? 1 : 0);
  /* Quality is matched EXACTLY here rather than by rank, and only after the add-on already
   * matches. The point is that a viewer who chose 1080p over the 4K in the same list gets 1080p
   * again — a rank comparison would quietly walk them back up to whatever is best, which is the
   * behaviour this preference exists to stop. */
  const sameQuality = (s: AddonStream): number => (prefer && s.quality === prefer.quality ? 1 : 0);
  // `startable` leads: ▶ must never land on a link that opens a browser tab, or on a torrent
  // with no server behind it, while an ordinary playable source is sitting in the same list.
  const rank = (a: AddonStream, b: AddonStream) => (startable(b) - startable(a))
    || (audible(b) - audible(a))
    || (deliverability(b, want) - deliverability(a, want))
    || (sameSource(b) - sameSource(a))
    || (sameQuality(b) - sameQuality(a))
    || (qualityRank(b.quality) - qualityRank(a.quality));
  const best = [...list.filter((s) => canDeliver(s, want))].sort(rank)[0] ?? [...list].sort(rank)[0];
  // Nothing startable at all is not an answer — better no auto-play than opening a tab the
  // user did not ask for. The rows are still listed and still clickable.
  return best && startable(best) ? best : undefined;
};

/* The TV build renders a different SHAPE for the same data — one screen, no page scroll, the
 * sources beside the synopsis rather than below it. See TvDetail.tsx for what that is and why.
 * Every hook, fetch and handler in this file is shared; only the markup below forks, so the two
 * builds can never drift on behaviour. Folds to `false` on the web bundle. */
const IS_TV = import.meta.env.MODE === 'tv';

/* Detail modal — faithful port of the #overlay markup + openInfoModal/enrichModalMeta/
 * renderCast/renderRecs (assets/js/app.js). Seeded from the clicked card for an instant
 * paint, then enriched from /api/meta. */

const SpeakerOff = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" /><line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" /></svg>
);
const LinkIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
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
  const openReport = useReport((s) => s.open);
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
  /* The add-on, quality and language of the last thing this modal STARTED, so the next episode
   * can be more of the same — see `playEpisode`. A ref rather than state: nothing renders from
   * it, and making it state would re-render the whole title screen on every play. */
  const lastPick = useRef<(StreamPick & { id: string; lang: string }) | null>(null);
  const [bdLoaded, setBdLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pickedEp, setPickedEp] = useState<{ season: number; ep: number } | null>(null);
  const [streams, setStreams] = useState<AddonStream[]>([]);
  const [streamsLoading, setStreamsLoading] = useState(false);
  const [lang, setLang] = useState<string>('');
  const [srcTab, setSrcTab] = useState<'services' | 'addons'>('services');

  const isTv = target?.type === 'tv' || target?.type === 'series';
  /* TWO SOURCES FOR ONE RECORD, asked in parallel, first usable answer rendered.
   *
   * `/api/meta` describes a TMDB or IMDb id. An add-on catalog card carries the add-on's own
   * id, and for those the endpoint is a guaranteed 404 — which used to be the end of the
   * story: no meta, therefore no `imdb`, therefore no stream fan-out, therefore an add-on
   * whose catalog row rendered perfectly and whose sources never appeared.
   *
   * `useAddonMeta` fires IMMEDIATELY for an id that is not ours (not after /api/meta has
   * failed), so the two run side by side and an add-on title costs one round trip rather than
   * two. For an id that IS ours it stays idle unless /api/meta actually fails, in which case
   * it is a free second chance at a title TMDB has never heard of. */
  const { data: apiMeta, isError: metaError } = useMeta(target?.id, target?.type);
  const { data: addonMeta, isFetching: addonMetaFetching } = useAddonMeta(target?.id, target?.type, metaError);
  const meta = apiMeta ?? addonMeta ?? undefined;
  // While the player is open on top, drop the trailer key so useTrailer tears the
  // autoplaying YouTube iframe down (it kept streaming a whole second video behind the
  // player). The modal's `target` stays set, so closing the player restores it — and
  // the trailer remounts — exactly where the user left off.
  const { muted, toggleMute } = useTrailer(slotRef, heroRef, playerOpen ? undefined : (meta?.trailerKey || undefined), meta?.title || target?.title || '');

  /* Reset backdrop fade + scroll on each new title; seed the picked episode from a
   * Continue-Watching resume so OPEN builds the exact-episode key (id:S#E#).
   *
   * EXCEPT ON TV, WHERE PRE-PICKING SKIPS THE SCREEN THE VIEWER CAME FOR. Picking an episode is
   * what swaps the episode deck out for that episode's sources, so seeding it from `resumeEp`
   * meant opening a Continue-Watching series went straight to a list of sources and the deck was
   * never seen at all. On a TV the deck IS the answer to "where am I in this show" — it opens on
   * the resume episode, lifted and showing how much is left (TvDetail hands `resumeEp` to it for
   * exactly that). One OK press from there reaches the same sources.
   *
   * The web modal keeps the old behaviour: it shows episodes and sources at once, so there is no
   * screen to skip and pre-picking only saves a click. */
  useEffect(() => {
    setBdLoaded(false);
    setCopied(false);
    setPickedEp(!IS_TV && target?.resumeEp ? { season: target.resumeEp.season, ep: target.resumeEp.episode } : null);
    setSrcTab('services');
    scrollRef.current?.scrollTo({ top: 0 });
  }, [target?.id, target?.resumeEp?.season, target?.resumeEp?.episode]);

  /* THE ID THE ADD-ONS ARE ASKED UNDER, PREFERRING THE SEED'S OVER THE DETAIL FETCH'S.
   *
   * This effect used to be keyed on `meta.imdb` alone, which made the two round trips
   * STRICTLY SEQUENTIAL: nothing was asked of any add-on until /api/meta had returned, and
   * /api/meta is the expensive one (TMDB with credits, videos, external_ids, images,
   * recommendations and watch/providers appended, plus a second English fetch whenever the
   * localized synopsis came back empty). The user waited for the sum of the two.
   *
   * A catalog card already knows the answer. The backend attaches `imdb` to every card it
   * lets through and DROPS the ones with no IMDb id, precisely because no stream add-on
   * could be asked about them — so for a film opened from a row the fan-out can start on
   * the click and overlap the detail fetch entirely.
   *
   * `meta.imdb` STILL WINS once it lands, and the fallback order is what makes that free:
   * when the two agree — the overwhelmingly common case — this expression does not change
   * identity, the effect does not re-run, and nothing is fetched twice. When they disagree
   * the add-ons are re-asked under the authoritative id, which is the old behaviour.
   *
   * A SERIES IS UNAFFECTED and deliberately so: `pickedEp` comes out of `meta.seasonList`,
   * so there is genuinely nothing to ask for until meta has landed. Deep links and Continue
   * Watching carry no seed id either and fall back to exactly what they did before.
   *
   * `addonVideoId` IS THE THIRD OPTION AND THE ONE THAT WAS MISSING. A title described by an
   * add-on rather than by TMDB has no IMDb id to convert to — `kitsu:44081` is the only name
   * it has — and asking add-ons under an id nobody published is how a working catalog ended
   * up with no sources. It sorts last because when a title HAS an IMDb id that is the id the
   * most add-ons will recognise. */
  const streamBaseId = meta?.imdb || target?.imdb || meta?.addonVideoId;

  /* THE ID FOR ONE EPISODE, which is not `${base}:${season}:${episode}` in general.
   *
   * That formula is Cinemeta's convention and it is right for every IMDb-numbered show, which
   * is why it worked for as long as those were the only shows reachable. An add-on that
   * publishes its own catalog publishes its own episode ids with it — `kitsu:44081:5` has one
   * colon-separated number, not two — and the add-on's `videos[]` is the only place that
   * mapping exists. So the add-on's own id wins when there is one, and the formula stays as
   * the fallback for everything else. */
  const videoIdFor = (ep: { season: number; ep: number } | null): string | undefined => {
    if (!isTv) return streamBaseId;
    if (!ep) return undefined;
    const own = meta?.addonEpisodes?.find((v) => v.season === ep.season && v.episode === ep.ep)?.id;
    return own ?? (streamBaseId ? `${streamBaseId}:${ep.season}:${ep.ep}` : undefined);
  };
  const streamVideoId = videoIdFor(pickedEp);

  // client-direct add-on streams: ask every installed stream add-on for this title's
  // sources (movie → tt…; series → the picked episode's own id, once one is picked)
  useEffect(() => {
    if (!streamVideoId) { setStreams([]); return; }
    const videoId = streamVideoId;
    const type = isTv ? 'series' : 'movie';
    let alive = true;
    setStreamsLoading(true); setStreams([]);
    /* Render each add-on's sources AS THEY LAND rather than at the end. The fan-out is only
     * as fast as its slowest member, and the slowest member is routinely an order of
     * magnitude behind the rest — a debrid-backed add-on checking cache per hash against
     * one that answers from a static index. Holding the fast answers back bought nothing;
     * the final list is identical either way, and `collectAddonStreams` fills add-on-order
     * slots so the rows do not reshuffle as it grows. */
    collectAddonStreams(videoId, type, (partial) => { if (alive) setStreams(partial); })
      .then((s) => { if (alive) setStreams(s); })
      .finally(() => { if (alive) setStreamsLoading(false); });
    return () => { alive = false; };
  }, [streamVideoId, isTv]);

  /* The last value THIS EFFECT chose, so a default can be told apart from a decision.
   *
   * It matters now that `streams` arrives in instalments. The rule below keeps `cur` when
   * it is still offered, which was unambiguous when the whole fan-out landed at once and is
   * not any more: whichever add-on answered FIRST would otherwise decide the default tab
   * for good, so a title whose Russian source came back in 200 ms and whose English one
   * took four seconds would open on Русский and stay there — the opposite of what
   * `langTabs`/`orderLangs` exist to express. Comparing against this ref makes the sticky
   * branch apply to a tab the USER picked (or one carried in from the title they were just
   * looking at) and not to one we filled in ourselves, so the default keeps converging as
   * the slower add-ons report and settles on exactly the value the single-shot version
   * would have computed. */
  const autoLang = useRef<string>('');

  // default the language bucket when the sources change: keep the current pick if it's
  // still offered, else prefer the language the user was last watching (so RESUME plays
  // the same one), else fall back to the first available.
  useEffect(() => {
    const langs = langTabs(streams);
    // Compute the resume key inline rather than via buildMediaFor(): that helper is a
    // const declared below the `if (!target) return` early-return, so it sits in the
    // temporal dead zone on the target=null render that fires when the modal closes
    // (which also resets `streams` → [], re-running this effect). Touching it there
    // threw "Cannot access 'buildMediaFor' before initialization" and crashed the app.
    const rkey = target ? (pickedEp ? `${target.id}:S${pickedEp.season}E${pickedEp.ep}` : String(target.id)) : '';
    const savedLang = signedIn && rkey ? getResume(rkey)?.lang : undefined;
    setLang((cur) => {
      if (cur && cur !== autoLang.current && langs.includes(cur)) return cur;
      const next = savedLang && langs.includes(savedLang) ? savedLang : (langs[0] || '');
      autoLang.current = next;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams]);

  // Warm the streaming-server probe early:  is read synchronously
  // while rendering the rows, and starts out false until this resolves.
  useEffect(() => { void hasStreamingServer(); }, []);

  // picking an episode brings its freshly-loaded sources into view (matches vanilla)
  useEffect(() => { if (pickedEp) streamsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [pickedEp]);

  /* Close the modal when the route changes (navigating away dismisses it).
   *
   * ONLY when the route ACTUALLY changed — this is load-bearing now that the modal is lazy-
   * mounted. React runs an effect once on mount, and this component now mounts AFTER the click
   * that opened it (DetailModalGate defers the chunk until first open), so a bare `close()`
   * here fires on mount and slams shut the modal that was just opened. The symptom is nasty
   * and intermittent: the FIRST title opened in a session flashes and closes, every one after
   * works, because the second time the component is already mounted and only a real pathname
   * change re-runs it. When the modal was always-mounted this effect ran once at app start
   * against an empty modal and the bug was invisible.
   *
   * COMPARE THE PATHNAME, DO NOT COUNT RUNS. A `hasMounted` boolean — the previous shape here
   * — is defeated by StrictMode, which double-invokes mount effects: the first run flips the
   * flag, the cleanup runs, and the second run finds the flag already down and closes the
   * modal anyway. That reduced the fix to "works in production, broken in `npm run dev`", and
   * it is why the very first title opened in a dev session still did nothing. A deep-linked
   * load makes it worse than cosmetic, because there the target is set BEFORE mount, so the
   * spurious close is the only thing that happens and the link looks broken outright.
   * Remembering the pathname makes "mounted" and "navigated" genuinely distinguishable, which
   * was always the intent, and it is idempotent however many times React chooses to run it. */
  const { pathname } = useLocation();
  const seenPath = useRef(pathname);
  useEffect(() => {
    if (seenPath.current === pathname) return;
    seenPath.current = pathname;
    close();
  }, [pathname, close]);

  /* The open title owns the address bar. An overlay with no address could not be copied,
   * bookmarked, refreshed back into, or handed to a TV launcher — see lib/launchIntent.ts. This
   * writes `/t/<type>/<id>[/s<n>/e<n>]` while a title is open and restores the page's own path
   * when it closes, via replaceState so no history entry appears and HashRouter (which reads the
   * hash, untouched here) carries on as before. Following the PICKED episode rather than the
   * opened one is what makes a copied series link point at the episode on screen. */
  const shareAddress: MediaAddress | null = target
    ? { id: String(target.id), type: target.type, season: pickedEp?.season, episode: pickedEp?.ep }
    : null;
  useEffect(() => {
    syncAddressBar(target ? { id: target.id, type: target.type, resumeEp: pickedEp ? { season: pickedEp.season, episode: pickedEp.ep } : undefined } : null);
  }, [target, pickedEp]);

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
  /* Hold the reveal until a description lands so the overlay opens already-populated
   * (backdrop, logo, all genres, synopsis, cast, sources) instead of flashing the
   * seeded/partial card data. Falls back to seeded content once BOTH sources are out —
   * `metaError` alone is no longer enough, because for an add-on id it goes true almost
   * at once and the add-on lookup that is going to answer is still in flight. Revealing on
   * it would show an empty modal and then repaint it a moment later. */
  const ready = !!meta || (metaError && !addonMetaFetching);

  const epTotal = (meta?.seasonList ?? []).reduce((a, s) => a + (s.episodes || 0), 0);
  const added = mylist.some((m) => String(m.id) === String(target.id));
  const onAdd = () => toggleList({ id: target.id, type: target.type, title, year, rating, poster: meta?.poster || target.poster });

  /* Hand out the title's address. Clipboard only, deliberately — `navigator.share` exists on
   * desktop Chrome too, where it opens the OS share sheet, so preferring it would make a button
   * labelled "Copy link" do something else entirely on the platform most people are reading this
   * on. One behaviour, one honest label, and a share is one paste away. The prompt is the last
   * resort: `navigator.clipboard` is undefined outside a secure context, which includes
   * plain-http LAN testing, and a selectable string still lets the user copy by hand. */
  const onShare = async () => {
    if (!shareAddress) return;
    const url = mediaUrl(shareAddress);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(t('modal.copy_link'), url);
    }
  };

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
  /* What the player will ask SUBTITLE add-ons for. THE SAME id the stream fan-out uses, via
   * the same `videoIdFor`, because they are the same question asked of a different resource
   * — and because the two rebuilding it separately is precisely how the subtitles path came
   * to be limited to IMDb titles while the streams path was not. Undefined when there is no
   * id at all: an add-on cannot answer `subtitles/movie/undefined.json`. */
  const subsQueryFor = (ep: Ep | null) => {
    const videoId = videoIdFor(ep);
    return videoId ? { videoId, type: (isTv ? 'series' : 'movie') as 'movie' | 'series' } : undefined;
  };
  // series context for the in-player episodes panel (only for a series episode)
  const seriesFor = (ep: Ep | null) => (ep && meta?.seasonList?.length
    ? { seasons: meta.seasonList, metaId: target.id, imdb: meta.imdb, season: ep.season, ep: ep.ep, title, playEp: (s: number, e: number) => { void playEpisode(s, e); } }
    : undefined);
  const playStreamFor = (s: AddonStream, ep: Ep | null, langTag?: string) => {
    /* A LINK IS NOT A STREAM. `externalUrl` sources exist to be opened elsewhere — a
     * broadcaster's own player, a shop page — and `ytId` ones are YouTube embeds this
     * player has no path for (its whole surface is a <video> element; the trailer hero is
     * an iframe and a separate thing entirely). Opening them out of the app is the honest
     * support: strictly better than the previous behaviour, which was to drop them before
     * anyone could see they existed. */
    if (s.kind === 'external' || s.kind === 'youtube') {
      if (s.url) window.open(s.url, '_blank', 'noopener,noreferrer');
      return;
    }
    /* A torrent has no address until a streaming server is known — `torrentUrl` builds
     * Stremio's `/<infoHash>/<fileIdx>?tr=…`, or answers null when none is reachable. The
     * row is already labelled in that case (see `needsServer` in the list), so this is the
     * belt to that braces rather than the place the user finds out. */
    const url = s.kind === 'torrent' ? torrentUrl(s) : s.url;
    if (!url) return;
    const nxt = nextEpOf(ep);
    // the language this playback represents, so resume can pick the same one later
    const chosen = langTag ?? (lang && s.langs.includes(lang) ? lang : s.langs[0]);
    /* WHAT IS PLAYING, KEPT FOR THE EPISODE AFTER THIS ONE. Written on every start — including a
     * start that came FROM the auto-next — so a viewer who switches add-on half way through a
     * season carries the new one forward rather than the one they abandoned.
     *
     * Stamped with the title id because this modal is not remounted between titles: without it,
     * finishing an episode of one show and opening another would offer the previous show's add-on
     * as a preference, which is meaningless — the same add-on name serves different releases. */
    lastPick.current = { id: String(target?.id ?? ''), source: s.source, quality: s.quality, lang: chosen || '' };
    playSource({
      url,
      // 'torrent' is not a player concept: what comes back from the server is an ordinary
      // range-supporting progressive file, which is exactly what 'url' means here.
      kind: s.kind === 'hls' ? 'hls' : 'url',
      notWebReady: s.notWebReady,
      title, lang: chosen, langs: s.langs,
      subtitle: ep ? epLabel(ep.season, ep.ep) : undefined,
      media: buildMediaFor(ep, chosen), subtitles: subsOf(s), subsQuery: subsQueryFor(ep),
      next: nxt ? () => { void playEpisode(nxt.season, nxt.ep); } : undefined,
      series: seriesFor(ep),
    });
  };
  const playStream = (s: AddonStream) => playStreamFor(s, pickedEp);
  /* SWITCH TO AN EPISODE AND START IT — the one path behind all three ways of getting there:
   * the player's auto-next when a file ends, its "Next episode" button, and picking a card in the
   * in-player episode shelf.
   *
   * IT CONTINUES WHAT WAS PLAYING RATHER THAN RE-DECIDING FROM SCRATCH. Episodes of a season are
   * one sitting, and every add-on is a different encode: switching between them mid-season means
   * the volume, the sharpness, the subtitle timing and whether the audio decodes at all can change
   * between episode four and episode five, for no reason the viewer did anything to cause. Before
   * this, each next episode ran the same "best available" contest from nothing and took whatever
   * won — usually but not reliably the same answer.
   *
   * THE LANGUAGE IS PART OF THE SAME PROMISE, and it is read from the last PLAYBACK rather than
   * from the modal's `lang` tab. The two come apart routinely: the tab is where the viewer was
   * browsing when they pressed play, and `playStreamFor` may have started something else if the
   * chosen source could not deliver that language.
   *
   * A PREFERENCE, NEVER A REQUIREMENT. Both fall through if the previous add-on has nothing for
   * this episode, or nothing in that language — a season with a gap in one add-on's coverage must
   * still play, and continuity is not worth a black screen. Everything below is a tie-break
   * inside the ranking `bestFor` already applied. */
  const playEpisode = async (season: number, ep: number) => {
    const videoId = videoIdFor({ season, ep }); if (!videoId) return;
    setPickedEp({ season, ep });
    const list = await collectAddonStreams(videoId, 'series');
    const langs = langTabs(list);
    const prev = lastPick.current && lastPick.current.id === String(target?.id ?? '') ? lastPick.current : null;
    /* The language that was actually playing wins, then the tab, then whatever the episode has.
     * `langs.includes` is the guard that keeps this a preference: a dub that stops after episode
     * three hands the choice back rather than filtering the list down to nothing. */
    const want = prev?.lang && langs.includes(prev.lang) ? prev.lang
      : langs.includes(lang) ? lang : langs[0];
    const best = bestFor(list.filter((s) => !want || s.langs.includes(want)), want, prev) ?? bestFor(list, '', prev);
    if (best) { playStreamFor(best, { season, ep }, want); return; }
    const nxt = nextEpOf({ season, ep });
    playSource({ url: '/assets/demo.mp4', title, subtitle: epLabel(season, ep), media: buildMediaFor({ season, ep }), subsQuery: subsQueryFor({ season, ep }), next: nxt ? () => { void playEpisode(nxt.season, nxt.ep); } : undefined, series: seriesFor({ season, ep }) });
  };
  // language buckets (from the sources) + the sources for the picked language, sorted
  // best-quality first
  const availableLangs = langTabs(streams);
  /* THE NEXT TWO LINES ARE PINNED BY THE PARITY CORPUS — `fixtures.mjs` transcribes them
   * character for character (SHELL_FILTER_SOURCE / SHELL_SORT_SOURCE) and re-reads them
   * by line number on every run, because they are the twin of the core's `rank_streams`
   * and cannot be imported out of JSX. Editing either text, or moving them without
   * re-pinning the line numbers in fixtures.mjs, closes the gate. The language preference
   * lives in `forRender` / `bestFor` below, neither of which is pinned. */
  const shownStreams = streams
    .filter((s) => !lang || s.langs.includes(lang))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  // what the rows actually render as: the same sources, deliverable-language-first
  const rowStreams = forRender(shownStreams, lang);
  // Each stream row is titled by the open CONTENT — the movie name, or for a series the
  // show name + chosen episode as `S# | E#`, character for character what the player's own
  // title line renders. Two spellings of one label is how they drift, and this is the string a
  // viewer reads immediately before the player shows them the other one.
  // The add-on's own caption (s.label) drops to the detail line so its release info survives.
  const streamTitle = isTv && pickedEp ? `${title} ${epLabel(pickedEp.season, pickedEp.ep)}` : title;

  // Play the best available source for the current language/episode. The player
  // seeks to any saved resume position itself (VideoPlayer reads getResume), so
  // "continue watching" needs no extra wiring here.
  const playBest = () => {
    // The second call widens from the chosen language bucket to everything; both go through
    // `bestFor`, so neither can hand back a link-out or a serverless torrent. The old
    // `streams[0]` fallback could, and would have opened a tab from the RESUME button.
    const pick = bestFor(shownStreams, lang) ?? bestFor(streams, '');
    if (pick) playStreamFor(pick, pickedEp);
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

  /* THE TV BUILD HAS NO WATCH BUTTON, so `onWatchTv` is gone with it.
   *
   * It used to start the best source in one press, which sounds like a loss and mostly is not:
   * on a series it could not play anything until an episode was chosen (the deck is that choice),
   * and on a film "best" was a guess made on the viewer's behalf between sources they were about
   * to be shown anyway. The panel beside it lists them, and picking one is the same press.
   * What it did cost is a quick resume, which is worth remembering if this is revisited. */

  if (IS_TV) {
    return (
      <TvDetail
        target={target} meta={meta} ready={ready} isSeries={isTv}
        title={title} titleLogo={titleLogo} rating={rating} year={year}
        genreChips={genreChips} plot={plot} epTotal={epTotal}
        close={close}
        added={added} onAdd={onAdd}
        onReport={() => openReport({ kind: 'title', targetKey: String(target.id), targetName: meta?.title || target.title || '' })}
        srcTab={srcTab} setSrcTab={setSrcTab}
        signedIn={signedIn} openAuth={openAuth}
        streamsLoading={streamsLoading} shownStreams={rowStreams}
        availableLangs={availableLangs} lang={lang} setLang={setLang}
        playStream={playStream} streamTitle={streamTitle}
        pickedEp={pickedEp} setPickedEp={setPickedEp}
      />
    );
  }

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
                {/* Reporting a title lives here, beside Add — always visible rather than
                  * behind a menu, because Play's UGC policy asks for reporting to be
                  * in-app and findable, and a reviewer with a D-pad has to reach it. It is
                  * a round m-disc to match the chrome and to stay out of Play's way. */}
                <button className="hero-add m-disc" id="mReport" type="button" aria-label={t('report.cta')} title={t('report.cta')}
                        onClick={() => openReport({ kind: 'title', targetKey: String(target.id), targetName: meta?.title || target.title || '' })}>⚑</button>
                {/* Copy this title's link. Web only: on TV the clipboard has nowhere to go and
                  * every extra button is one more D-pad stop between the user and Play. */}
                {import.meta.env.MODE !== 'tv' && (
                  <button className={`hero-add m-disc${copied ? ' on' : ''}`} id="mShare" type="button"
                          aria-label={t(copied ? 'modal.link_copied' : 'modal.copy_link')} title={t(copied ? 'modal.link_copied' : 'modal.copy_link')}
                          onClick={() => { void onShare(); }}>
                    {copied ? '✓' : <span className="m-share-ic" aria-hidden="true">{LinkIcon}</span>}
                  </button>
                )}
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
                  ) : rowStreams.length ? (
                    /* SOURCES BEFORE STILL-LOADING, which is the whole point of the
                     * instalments: this branch used to sit BELOW `streamsLoading`, so a
                     * list that already had rows in it rendered as a loading note until
                     * the last add-on answered. The note moves to the end and says what it
                     * now means — some sources are here, more may follow. */
                    <>
                    {rowStreams.map((s, i) => (
                      <button className={`addon-stream${silentCodecName(s.label) ? ' no-audio' : ''}`} type="button" key={i} aria-label={streamTitle} onClick={() => playStream(s)}>
                        <span className={`quality-badge ${qualClass(s.quality)}`}>{s.quality || 'SD'}</span>
                        <span className="stream-info">
                          <span className="stream-title">{streamTitle || s.label}</span>
                          <span className="stream-detail">{[s.label, s.size, s.source].filter(Boolean).join(' · ')}</span>
                          {/* Named, not hidden: the codec is evidence from the release name, and a
                              source the user can see and cannot start is worse than one that
                              might disappoint. Remuxes do get mislabelled. */}
                          {silentCodecName(s.label) && (
                            <span className="stream-warn">{t('modal.no_audio_codec', { codec: silentCodecName(s.label) as string })}</span>
                          )}
                          {/* The chosen language is IN this file but not on the track that
                              plays, and this browser cannot switch. Say which one it will
                              actually play instead of letting the tab imply otherwise. */}
                          {playsInstead(s, lang) !== null && (
                            <span className="stream-warn">
                              {playsInstead(s, lang)
                                ? t('modal.plays_instead', { want: langName(lang), primary: playsInstead(s, lang) as string })
                                : t('modal.secondary_track', { want: langName(lang) })}
                            </span>
                          )}
                          {/* What KIND of source this is, when that changes what pressing it
                              does. A torrent with no streaming server behind it, and a link
                              that leaves the app, both look exactly like an ordinary row
                              until they are pressed — which is the moment it is least
                              useful to find out. */}
                          {sourceNote(s) && (
                            <span className="stream-warn">{t(`modal.source_${sourceNote(s)}`)}</span>
                          )}
                        </span>
                        <span className="addon-stream-chevron" aria-hidden="true">›</span>
                      </button>
                    ))}
                    {streamsLoading && <div className="stream-source-label" role="status">{t('modal.more_sources')}</div>}
                    </>
                  ) : streamsLoading ? (
                    /* NOT `modal.loading_synopsis`, which is what this said for as long as
                     * the branch existed. The synopsis is a different fetch that finished
                     * before this list was ever mounted; the string was borrowed for its
                     * spinner-ish shape and then read, by everyone including us, as the
                     * synopsis being what the wait was for. */
                    <div className="stream-source-label" role="status">{t('modal.searching_sources')}</div>
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
