import { useCallback } from 'react';
import { useHistory } from '../stores/history';
import { useModal } from '../stores/modal';
import { useT } from '../i18n/i18n';
import Poster from './Poster';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';
import type { MediaItem } from '../lib/types';
import type { WatchEntry } from '../stores/history';
import { entryTarget, useContinueItems } from '../lib/continueItems';

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
  const progress = useHistory((s) => s.progress);
  const remove = useHistory((s) => s.remove);
  const open = useModal((s) => s.open);
  const openEntry = useCallback((e: WatchEntry) => open(entryTarget(e)), [open]);
  const { history, tvItems, byId, resumeOf } = useContinueItems();

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
