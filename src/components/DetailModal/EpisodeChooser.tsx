import { useMemo, useState } from 'react';
import { useSeason } from '../../lib/queries';
import { useT } from '../../i18n/i18n';
import type { MetaDetail, Episode, SeasonInfo } from '../../lib/types';

/* Port of setupSeriesChooser / selectSeason / selectEpisode (assets/js/app.js).
 * Season tabs + a 16:9 still-card episode grid. Picking an episode raises
 * onEpisode(season, ep) so the modal can load that S:E's sources. */

function EpCard({ ep, season, active, onPick }: { ep: Episode; season: number; active: boolean; onPick: () => void }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  return (
    <button className={`ep-row${active ? ' on' : ''}`} type="button" data-season={season} data-ep={ep.episode} onClick={onPick}>
      {ep.still && !broken
        ? <span className="ep-still"><img src={ep.still} loading="lazy" decoding="async" alt="" onError={() => setBroken(true)} /></span>
        : <span className="ep-still no-still" data-n={`E${ep.episode}`} />}
      <span className="ep-num">E{ep.episode}</span>
      <span className="ep-body"><span className="ep-name">{name}</span></span>
    </button>
  );
}

export default function EpisodeChooser({ meta, initial, onEpisode }: { meta: MetaDetail; initial?: { season: number; episode: number }; onEpisode?: (season: number, ep: number) => void }) {
  const t = useT();

  const seasons: SeasonInfo[] = useMemo(() => {
    if (meta.seasonList?.length) return meta.seasonList;
    if (meta.seasons) return Array.from({ length: meta.seasons }, (_, i) => ({ season: i + 1, episodes: 0 }));
    return [];
  }, [meta.seasonList, meta.seasons]);

  // default to the resume season (from Continue Watching) if any, else the first real
  // season (skipping a season-0 "Specials" block)
  const firstSeason = useMemo(() => (seasons.find((s) => s.season >= 1) || seasons[0])?.season, [seasons]);
  const [activeSeason, setActiveSeason] = useState<number | undefined>(initial?.season ?? firstSeason);
  const [activeEp, setActiveEp] = useState<number | null>(initial?.episode ?? null);

  const season = activeSeason ?? firstSeason;
  const { data, isLoading } = useSeason(meta.id, season);

  if (!seasons.length || !meta.imdb) return null;

  const episodes: Episode[] = data?.episodes ?? [];

  return (
    <div className="ep-chooser" id="epChooser">
      <h4 className="m-rail-label">{t('modal.episodes')}</h4>
      <div className="season-tabs" id="seasonTabs">
        {seasons.map((s) => (
          <button
            key={s.season}
            className={`season-tab${s.season === season ? ' on' : ''}`}
            type="button"
            data-season={s.season}
            onClick={() => { setActiveSeason(s.season); setActiveEp(null); }}
          >
            {s.name || t('modal.season', { n: s.season })}
          </button>
        ))}
      </div>
      <div className="ep-list ep-grid" id="epList">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => <div className="ep-skel" key={i} />)
          : episodes.length
            ? episodes.map((e) => (
                <EpCard
                  key={e.episode}
                  ep={e}
                  season={season!}
                  active={activeEp === e.episode}
                  onPick={() => { setActiveEp(e.episode); onEpisode?.(season!, e.episode); }}
                />
              ))
            : <div className="ep-empty">{t('modal.episodes_unavailable')}</div>}
      </div>
    </div>
  );
}
