import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/i18n';
import { usePicks } from '../lib/picks';
import type { MediaItem } from '../lib/types';
import PosterCard from './PosterCard';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';

const IS_TV = import.meta.env.MODE === 'tv';

/* TOP PICKS FOR YOU — the reference's personal row, built by lib/picks.ts from what this viewer
 * has loved, liked and finished ("because you watched…"), ranked against their taste.
 *
 * NOT SHOWN UNTIL THERE IS SOMETHING PERSONAL TO SAY. A guest, or an account with no history and no
 * thumbs, has no picks — and a "for you" row filled with the week's trending titles would be a lie
 * the row beneath it (Trending) already tells honestly. It appears once there are seeds.
 *
 * ON A TELEVISION IT ARRIVES A BEAT AFTER THE FIRST SCREEN. The home screen mounts its first rows
 * in one task and the rest one per commit (see Home's StagedStrips) because a long first task is a
 * remote that does not answer. This row's own work — a handful of detail reads to find the seeds'
 * recommendations, then their artwork — waits for the screen to settle rather than adding to it. */
const TV_SETTLE_MS = 1500;

export default function PicksRow({ onSelect }: { onSelect: (m: MediaItem) => void }) {
  const t = useT();
  const [live, setLive] = useState(!IS_TV);
  useEffect(() => {
    if (live) return;
    const id = window.setTimeout(() => setLive(true), TV_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [live]);
  if (!live) return null;
  return <PicksRowLive onSelect={onSelect} title={t('sec.top_picks')} />;
}

function PicksRowLive({ onSelect, title }: { onSelect: (m: MediaItem) => void; title: string }) {
  const { picks, personal } = usePicks(20);
  const items = useMemo(() => picks.map((p) => p.item).filter((m) => m.poster || m.backdrop), [picks]);
  if (!personal || items.length < 4) return null;

  if (IS_TV) return <TvSpotlight items={items} title={title} onSelect={onSelect} />;

  return (
    <div className="strip reveal in" data-row="top_picks">
      <div className="strip-head">
        <span className="strip-title static mono">{title}</span>
      </div>
      <Rail>{items.map((m, i) => <PosterCard key={`${m.type}-${m.id}`} item={m} seed={i} onSelect={onSelect} />)}</Rail>
    </div>
  );
}
