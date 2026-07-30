import { useCallback, useMemo } from 'react';
import { useHistory } from '../stores/history';
import { useModal } from '../stores/modal';
import { useT } from '../i18n/i18n';
import Poster from './Poster';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';
import type { MediaItem } from '../lib/types';
import type { WatchEntry } from '../stores/history';

/* Continue Watching rail — signed-in only, drawn from the watch-history store.
 * Each card carries a resume progress bar + a corner ✕ (remove), and reopens the
 * detail modal to resume. Port of renderContinueWatching. Hidden when empty.
 *
 * ON TV IT IS A BILLBOARD ROW LIKE EVERY OTHER ROW, and the branch is here for the same
 * reason Row's is: the TV home is ONE repeated component, and a rail sitting among twelve
 * spotlights does not read as a smaller version of them, it reads as a different screen.
 * This was the last rail left on that page — see the props it hands TvSpotlight for how its
 * two rail-only affordances (the resume bar, the remove ✕) were resolved. */

const IS_TV = import.meta.env.MODE === 'tv';

export default function ContinueRow({ onSelect: _onSelect }: { onSelect?: (m: MediaItem) => void }) {
  const t = useT();
  const history = useHistory((s) => s.history);
  const progress = useHistory((s) => s.progress);
  const remove = useHistory((s) => s.remove);
  const open = useModal((s) => s.open);

  // reopen the detail modal; for a series, carry the resume episode so OPEN resumes
  // the exact episode (not the show's movie-level key)
  const openEntry = useCallback((e: WatchEntry) => {
    const isSeries = (e.type === 'tv' || e.type === 'series') && e.season != null && e.episode != null;
    open({
      id: e.id, type: e.type, title: e.title, year: e.year, rating: e.rating, poster: e.poster, genre: e.genre, seed: 0,
      resumeEp: isSeries ? { season: e.season as number, episode: e.episode as number } : undefined,
    });
  }, [open]);

  /* ---- THE TV ROW'S THREE INPUTS ------------------------------------------------------------
   * Built here rather than inside the spotlight because a watch ENTRY is not a catalog card: it
   * knows an episode and a timecode, and the spotlight only ever needs to be told the fraction
   * and the label. Memoised as one unit, keyed by id — the strip is rebuilt whenever `resumeOf`
   * changes identity, and that must be when the history changes, not on every render of Home. */
  const byId = useMemo(() => {
    const m = new Map<string, WatchEntry>();
    for (const e of history) m.set(String(e.id), e);
    return m;
  }, [history]);
  const tvItems: MediaItem[] = useMemo(() => history.map((e) => ({
    id: e.id, type: e.type, title: e.title, year: e.year, rating: e.rating, poster: e.poster, genre: e.genre,
  })), [history]);
  const resumeOf = useCallback((it: MediaItem) => {
    const e = byId.get(String(it.id));
    if (!e) return undefined;
    const p = progress[e.key || String(e.id)];
    return { pct: p && p.dur > 0 ? p.pos / p.dur : 0, note: e.ep || '' };
  }, [byId, progress]);

  if (!history.length) return null;

  if (IS_TV) {
    // No `cat`/`onSeeAll`: unlike a catalog row this one has no page of its own to walk onto, so
    // the strip simply ends with the oldest thing you were watching.
    return (
      <TvSpotlight
        items={tvItems}
        title={t('sec.continue')}
        onSelect={(m) => { const e = byId.get(String(m.id)); if (e) openEntry(e); }}
        resumeOf={resumeOf}
        enrich
      />
    );
  }

  return (
    <div className="strip reveal in" data-row="continue">
      <div className="strip-head"><span className="strip-title static mono">{t('sec.continue')}</span></div>
      <Rail>
        {history.map((e, i) => {
          const key = e.key || String(e.id);
          const p = progress[key];
          const frac = p && p.dur > 0 ? p.pos / p.dur : 0;
          const item: MediaItem = { id: e.id, type: e.type, title: e.title, year: e.year, rating: e.rating, poster: e.poster, genre: e.genre };
          return (
            <div className="pcard" key={`${e.id}-${i}`}>
              <Poster item={item} seed={i} progress={frac} onRemove={() => remove(e.id)} onSelect={() => openEntry(e)} />
              <div className="cap">
                <div className="t">{e.title}</div>
                <div className="meta mono">{e.ep || e.year || ''}</div>
              </div>
            </div>
          );
        })}
      </Rail>
    </div>
  );
}
