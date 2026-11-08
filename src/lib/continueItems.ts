import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useCards } from './queries';
import { useHistory, type WatchEntry } from '../stores/history';
import { useLibrary, type WatchItem } from '../stores/library';
import type { ModalTarget } from '../stores/modal';
import type { MediaItem } from './types';
import { guessAddonType, collectAddonMeta } from './addonClient';

/* Continue Watching's items, shared by the TV row (components/ContinueRow.tsx) and the Prime-layout
 * home page (routes/PrimeTest.tsx). */

const IS_TV = import.meta.env.MODE === 'tv';

/* What reopening a watch entry opens; for a series it carries the resume episode so OPEN resumes
 * the exact episode (not the show's movie-level key). */
export function entryTarget(e: WatchEntry): ModalTarget {
  const isSeries = (e.type === 'tv' || e.type === 'series') && e.season != null && e.episode != null;
  return {
    id: e.id, type: e.type, title: e.title, year: e.year, rating: e.rating, poster: e.poster, genre: e.genre, seed: 0,
    /* An add-on title reopens under the add-on's own type, or its meta and streams are asked
     * for as a "movie" it never published and the overlay comes up empty. Entries saved
     * before the type was recorded get it inferred from the installed add-on that owns the id. */
    imdb: e.imdb, addonType: e.addonType || guessAddonType(String(e.id)),
    resumeEp: isSeries ? { season: e.season as number, episode: e.episode as number } : undefined,
  };
}

/* The TV row's items, built from the watch history (shared with the Prime-layout home page,
 * routes/PrimeTest.tsx). `ready` once the cards asked for (the art) have answered. */
export function useContinueItems() {
  const history = useHistory((s) => s.history);
  const progress = useHistory((s) => s.progress);

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
  const { data: cards, isFetched } = useCards(ids);
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
        titleLogo: c.titleLogo, overview: c.overview, tileArt: c.tileArt, bgArt: c.bgArt,
      }),
    };
  }), [history, artById, addonArt]);
  const resumeOf = useCallback((it: MediaItem) => {
    const e = byId.get(String(it.id));
    if (!e) return undefined;
    const p = progress[e.key || String(e.id)];
    return { pct: p && p.dur > 0 ? p.pos / p.dur : 0, note: e.ep || '' };
  }, [byId, progress]);
  return { history, tvItems, byId, resumeOf, ready: !ids.length || isFetched };
}

/* MY LIST's items for the TV's My Space (routes/PrimeTest.tsx, kind 'myspace'). A saved title knows
 * its id, type, name and poster; the featured row needs a catalog card's art too (the textless
 * backdrop, the wordmark, the facts), so the cards are asked for and laid over the saved entries —
 * the same lookup Continue Watching makes above. `ready` once they have answered. */
export function useMyListItems() {
  const mylist = useLibrary((s) => s.mylist);
  const ref = (m: WatchItem) => (/^(\d+|tt\d+)$/.test(String(m.id)) ? String(m.id) : undefined);
  const ids = useMemo(() => mylist.slice(0, 40)
    .filter((m) => !!ref(m))
    .map((m) => `${m.type === 'tv' || m.type === 'series' ? 'tv' : 'movie'}/${ref(m)}`), [mylist]);
  const { data: cards, isFetched } = useCards(ids);
  const items: MediaItem[] = useMemo(() => {
    const byRef = new Map<string, MediaItem>();
    for (const c of cards?.results || []) byRef.set(String(c.ref ?? c.id), c);
    return mylist.map((m) => {
      const c = byRef.get(String(m.id));
      return (c ? { ...c, id: m.id, type: m.type ?? c.type } : { ...m }) as MediaItem;
    });
  }, [mylist, cards]);
  return { items, ready: !ids.length || isFetched };
}
