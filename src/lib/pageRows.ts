import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLang, useT } from '../i18n/i18n';
import { useHistory, type WatchEntry } from '../stores/history';
import { useAuth } from '../stores/auth';
import type { MediaItem } from './types';

/* THE PAGE ROWS — Home, Movies, TV Shows and Anime, as /api/rows curates them (server rows.js):
 * one title per page, every row checked against its own claim, Because You Watched cut from the
 * viewer's history.
 *
 * A STABLE QUEUE. The answer is kept for the session (sessionStorage) until the server's own
 * `refreshAt`, so a reload or a visit back shows the same rows in the same order; after that the
 * next visit takes the new set. Nothing is swapped under someone who is looking at the page. */

const IS_TV = import.meta.env.MODE === 'tv';

export type PageKind = 'home' | 'movie' | 'series' | 'anime';
export type PageRow = { key: string; title: string; items: MediaItem[]; style?: 'featured'; seed?: { id: string; type: string; title: string } };
type RowsPayload = { kind: PageKind; bucket: number; refreshAt: number; rows: PageRow[] };

/* A watch entry as the server knows a title — a TMDB or IMDb id; an add-on's own id has none. */
const refOf = (e: WatchEntry) => {
  const id = String(e.id);
  const r = /^(\d+|tt\d+)$/.test(id) ? id : e.imdb && /^tt\d+$/.test(e.imdb) ? e.imdb : '';
  return r ? `${e.type === 'tv' || e.type === 'series' ? 'tv' : 'movie'}/${r}` : '';
};

/* Kept per ACCOUNT: Because You Watched and Home's Continue Watching exclusions are the account's, so a
 * sign-in or sign-out must not reuse the other one's rows. */
const storeKey = (kind: PageKind, lang: string, who: string) => `groloo.rows:${IS_TV ? 'tv' : 'web'}:${kind}:${lang}:${who}`;
function readKept(kind: PageKind, lang: string, who: string): RowsPayload | undefined {
  try {
    const v = JSON.parse(sessionStorage.getItem(storeKey(kind, lang, who)) || 'null') as RowsPayload | null;
    return v && v.refreshAt > Date.now() && Array.isArray(v.rows) ? v : undefined;
  } catch { return undefined; }
}
function keep(kind: PageKind, lang: string, who: string, v: RowsPayload) {
  try { sessionStorage.setItem(storeKey(kind, lang, who), JSON.stringify(v)); } catch { /* quota / private mode */ }
}

/* Continue Watching's titles: the server keeps them out of Home's other rows. */
export function continueRefs(history: WatchEntry[]) {
  return history.slice(0, 40).map(refOf).filter(Boolean);
}

export function usePageRows(kind: PageKind, enabled = true) {
  const { lang } = useLang();
  const t = useT();
  const history = useHistory((s) => s.history);
  /* Because You Watched is the ACCOUNT's: signed out, no history is sent for it. Continue Watching's titles
   * (a signed-out TV still shows this device's own) are kept out of Home's other rows either way. */
  const who = useAuth((s) => s.user?.email) || '';
  const refs = useMemo(() => continueRefs(history), [history]);
  const query = useQuery({
    queryKey: ['page-rows', kind, lang, who],
    enabled,
    queryFn: async () => {
      const kept = readKept(kind, lang, who);
      if (kept) return kept;
      const q = new URLSearchParams({ page: kind, lang });
      if (IS_TV) q.set('logos', '1');
      if (who && refs.length) q.set('history', refs.slice(0, 12).join(','));
      if (kind === 'home' && refs.length) q.set('exclude', refs.join(','));
      const v = await api<RowsPayload>(`/api/rows?${q}`);
      keep(kind, lang, who, v);
      return v;
    },
    initialData: () => readKept(kind, lang, who),
    /* Fresh until the server says the set changes; never refetched behind a page on show. */
    staleTime: (q) => Math.max(0, (q.state.data?.refreshAt ?? 0) - Date.now()),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
  });
  /* Home only: a title started since the rows were fetched is in Continue Watching now — keep it
   * out of the rows below it (removed in place; nothing reorders). */
  const cw = useMemo(() => (kind === 'home' ? new Set(refs) : null), [kind, refs]);
  const rows = useMemo(() => (query.data?.rows ?? []).map((r) => ({
    ...r,
    title: r.key === 'because' && r.seed
      ? t('rows.because', { title: r.seed.title })
      : (t(`rows.${r.key}`) !== `rows.${r.key}` ? t(`rows.${r.key}`) : r.title),
    items: cw ? r.items.filter((m) => !cw.has(`${m.type === 'tv' || m.type === 'series' ? 'tv' : 'movie'}/${m.id}`)
      && !(m.imdb && cw.has(`${m.type === 'tv' || m.type === 'series' ? 'tv' : 'movie'}/${m.imdb}`))) : r.items,
  })).filter((r) => r.items.length > 0), [query.data, t, cw]);
  /* Answered (or given up on): the page can build. */
  const ready = query.data !== undefined || query.isError;
  return { rows, ready, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch };
}
