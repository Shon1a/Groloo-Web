import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useCards } from '../lib/queries';
import { useHistory } from '../stores/history';
import { useModal } from '../stores/modal';
import { useT } from '../i18n/i18n';
import Poster from './Poster';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';
import type { MediaItem } from '../lib/types';
import type { WatchEntry } from '../stores/history';
import { guessAddonType, collectAddonMeta } from '../lib/addonClient';

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
      /* An add-on title reopens under the add-on's own type, or its meta and streams are asked
       * for as a "movie" it never published and the overlay comes up empty. Entries saved
       * before the type was recorded get it inferred from the installed add-on that owns the id. */
      imdb: e.imdb, addonType: e.addonType || guessAddonType(String(e.id)),
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
  /* A watch entry knows a poster and a title. The row needs what a catalog card
   * carries — the textless backdrop, where its poster is cut from, the wordmark — so
   * ask for the real cards and lay them over the entries. Bounded because a long
   * history is still one row, and add-on entries (a `kitsu:` id) simply do not match
   * and keep rendering exactly as they do today. */
  /* An entry under an IMDb id — a Cinemeta-style add-on's own id, or one whose IMDb id was
   * recorded — is asked about by that id; /api/cards resolves `tt…` and answers with `ref`. */
  const artRef = (e: WatchEntry) => {
    const id = String(e.id);
    if (/^(\d+|tt\d+)$/.test(id)) return id;
    return e.imdb && /^tt\d+$/.test(e.imdb) ? e.imdb : undefined;
  };
  const ids = useMemo(() => history.slice(0, 24)
    .map((e) => [e, artRef(e)] as const)
    .filter(([, r]) => !!r)
    .map(([e, r]) => `${e.type === 'tv' || e.type === 'series' ? 'tv' : 'movie'}/${r}`), [history]);
  const { data: cards } = useCards(ids);
  const artById = useMemo(() => {
    const m = new Map<string, MediaItem>();
    for (const c of cards?.results || []) m.set(String(c.ref ?? c.id), c);
    return m;
  }, [cards]);

  /* AN ADD-ON'S OWN TITLE HAS NO CARD OF OURS TO BORROW FROM — no TMDB id, no IMDb id — so
   * an entry saved without a backdrop would sit on the billboard as a grey panel. Ask the add-on
   * that owns it for its meta (TV only, first dozen entries, cached like the detail view's own
   * add-on lookup) and take the background from there. */
  const bare = useMemo(() => (IS_TV ? history.slice(0, 12).filter((e) => !artRef(e) && !e.backdrop) : []), [history]);
  const bareMeta = useQueries({
    queries: bare.map((e) => {
      const kind: 'movie' | 'series' = e.type === 'tv' || e.type === 'series' ? 'series' : 'movie';
      const wire = e.addonType || guessAddonType(String(e.id)) || kind;
      return {
        queryKey: ['addon-meta-art', String(e.id), wire],
        queryFn: () => collectAddonMeta(String(e.id), kind, wire),
        staleTime: 10 * 60 * 1000,
        retry: false,
      };
    }),
  });
  const artKey = bareMeta.map((q) => q.dataUpdatedAt).join(',');
  const addonArt = useMemo(() => {
    const m = new Map<string, { backdrop?: string; overview?: string }>();
    bare.forEach((e, i) => { const d = bareMeta[i]?.data; if (d) m.set(String(e.id), { backdrop: d.backdrop, overview: d.plot }); });
    return m;
    // `artKey` stands in for the query results: a fixed-length dependency that changes when any lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bare, artKey]);

  const tvItems: MediaItem[] = useMemo(() => history.map((e) => {
    const r = artRef(e);
    const c = r ? artById.get(r) : undefined;
    const a = addonArt.get(String(e.id));
    return {
      id: e.id, type: e.type, title: e.title, year: e.year, rating: e.rating, poster: e.poster, genre: e.genre,
      // The backdrop recorded at play time, for a title TMDB has no card for (an add-on's own).
      backdrop: e.backdrop || a?.backdrop,
      ...(a?.overview && { overview: a.overview }),
      // Only the presentation comes from the card; the entry stays the spine, because it
      // is what knows the episode and the timecode.
      ...(c && {
        posterArt: c.posterArt, artFocusX: c.artFocusX, backdrop: c.backdrop || e.backdrop,
        titleLogo: c.titleLogo, overview: c.overview,
      }),
    };
  }), [history, artById, addonArt]);
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
