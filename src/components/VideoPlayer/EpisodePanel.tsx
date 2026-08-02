import { useEffect, useState } from 'react';
import { useSeason } from '../../lib/queries';
import { useT } from '../../i18n/i18n';
import type { Episode } from '../../lib/types';
import type { PlaySeries } from '../../stores/player';

/* In-player episodes panel (.vp-eppanel) — a slide-in on the right with season tabs
 * and 16:9 still cards, so you can jump between episodes without leaving the player.
 * Port of the vanilla openEpPanel / buildEpPanel. Picking an episode calls the
 * series.playEp() the modal wired in (switches episode, fetches its sources, plays). */

function EpRow({ ep, active, onPick }: { ep: Episode; active: boolean; onPick: () => void }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  return (
    <button className={`ep-row${active ? ' on' : ''}`} type="button" onClick={onPick}>
      {ep.still && !broken
        ? <span className="ep-still"><img src={ep.still} loading="lazy" decoding="async" alt="" onError={() => setBroken(true)} /></span>
        : <span className="ep-still no-still" data-n={`E${ep.episode}`} />}
      <span className="ep-num">E{ep.episode}</span>
      <span className="ep-body"><span className="ep-name">{name}</span></span>
    </button>
  );
}

export default function EpisodePanel({ open, series, onClose }: { open: boolean; series: PlaySeries; onClose: () => void }) {
  const t = useT();
  // Which season's episode list the panel is showing. Defaults to the one playing, but the
  // user can tab to another without changing playback, so it's state rather than the prop.
  const [panelSeason, setPanelSeason] = useState(series.season);
  // Re-sync when playback moves to a different season on its own. useState reads its
  // argument only on the first render, and auto-next swaps `series` in place without ever
  // unmounting this panel — so after S1E10 -> S2E1 panelSeason stayed at 1, leaving the
  // wrong season tab lit and `series.season === panelSeason` false for every row, i.e. no
  // episode highlighted at all. A manual tab choice is preserved: this only fires when the
  // PLAYING season actually changes.
  useEffect(() => { setPanelSeason(series.season); }, [series.season]);
  const { data, isLoading } = useSeason(series.metaId, panelSeason, series.imdb);
  const episodes: Episode[] = data?.episodes ?? [];

  return (
    <div className={`vp-eppanel${open ? ' open' : ''}`} id="vpEpPanel" onClick={(e) => e.stopPropagation()}>
      <div className="vp-eppanel-head">
        <div>
          <div className="lbl">{t('modal.episodes')}</div>
          {series.title && <div className="ttl">{series.title}</div>}
        </div>
        <button className="vp-icon" type="button" aria-label={t('player.close')} onClick={onClose}>✕</button>
      </div>
      <div className="vp-eppanel-seasons">
        {series.seasons.map((s) => (
          <button key={s.season} className={`vp-season-tab${s.season === panelSeason ? ' on' : ''}`} type="button" onClick={() => setPanelSeason(s.season)}>
            {s.name || t('modal.season', { n: s.season })}
          </button>
        ))}
      </div>
      <div className="vp-eppanel-list">
        {isLoading
          ? <div className="ep-empty" style={{ padding: '8px 4px', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
          : episodes.length
            ? episodes.map((e) => (
                <EpRow key={e.episode} ep={e} active={series.season === panelSeason && series.ep === e.episode} onPick={() => { onClose(); series.playEp(panelSeason, e.episode); }} />
              ))
            : <div className="ep-empty" style={{ padding: '8px 4px', color: 'var(--text-muted)' }}>{t('modal.episodes_unavailable')}</div>}
      </div>
    </div>
  );
}
