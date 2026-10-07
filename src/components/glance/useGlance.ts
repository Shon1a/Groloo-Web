import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLang, useT } from '../../i18n/i18n';
import { apiIdOf, useAwards, useHomeCached } from '../../lib/queries';
import { computeGlance, homeIndex, type GlanceCallout } from '../../lib/glance';
import { becauseIndex, becauseKey, homePool, useTaste } from '../../lib/picks';
import { loveCut } from '../../lib/taste';
import type { Awards, MediaItem, MetaDetail } from '../../lib/types';

export interface GlanceSource {
  item: Pick<MediaItem, 'id' | 'type' | 'year' | 'rating' | 'genre' | 'genres' | 'votes' | 'pop'> & { released?: string | null; imdb?: unknown };
  /** The detail record, when the surface has one: it carries the series' run and the full date. */
  meta?: Pick<MetaDetail, 'released' | 'airing' | 'imdb' | 'genre' | 'seasons'> | null;
  /** Ask IMDb for awards — one request per title, so only where ONE title is in focus. */
  awards?: boolean;
}

/** The callouts for one title, best first. Recomputed only when one of its sources moves. */
export function useGlance({ item, meta, awards = false }: GlanceSource): GlanceCallout[] {
  const t = useT();
  const { lang } = useLang();
  const home = useHomeCached();
  const taste = useTaste();
  const qc = useQueryClient();
  const imdb = (typeof item.imdb === 'string' ? item.imdb : undefined) || meta?.imdb || undefined;
  /* Asked only where one title is in focus — but kept once known: a billboard whose callouts came and
   * went with the focus re-played them on every press. */
  const { data: asked } = useAwards(awards ? imdb : undefined);
  const aw = asked ?? (imdb ? qc.getQueryData<Awards>(['awards', imdb]) : undefined);
  const released = item.released ?? meta?.released ?? null;
  const genres = item.genres?.length ? item.genres : (meta?.genre?.length ? meta.genre : undefined);
  return useMemo(() => computeGlance({
    item: { ...item, released, genres },
    airing: meta?.airing,
    awards: aw,
    home: homeIndex(home),
    taste,
    loveCut: home ? loveCut(taste, homePool(home), home) : undefined,
    because: becauseIndex(qc, lang).get(becauseKey(item)) || null,
    seasons: meta?.seasons ?? null,
    t,
    lang,
  }),
  // The item's identity changes on every refetch; what the callouts read from it does not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [item.id, item.type, item.year, item.rating, item.genre, item.votes, item.pop, released, genres, meta?.airing, meta?.seasons, aw, home, taste, t, lang, qc]);
}

/* WHETHER A TITLE'S CALLOUTS ARE WORTH SHOWING YET: its awards have come back (when they were asked
 * for), and its detail has (when the surface fetches one). Until then a callout can still change —
 * an award arriving outranks a "Trending Now" — and changing one under the viewer is a blink. */
export function useGlanceReady({ item, meta, awards = false }: GlanceSource, waitForMeta = false): boolean {
  const qc = useQueryClient();
  const imdb = (typeof item.imdb === 'string' ? item.imdb : undefined) || meta?.imdb || undefined;
  const q = useAwards(awards ? imdb : undefined);
  const known = imdb ? qc.getQueryData<Awards>(['awards', imdb]) !== undefined : true;
  const awardsReady = !awards || !imdb || !/^tt\d+$/.test(imdb) || known || q.isError;
  return awardsReady && (!waitForMeta || !!meta);
}

/* A TITLE'S CALLOUTS, SETTLED ONCE. They are held back until their sources are in (useGlanceReady)
 * or `maxWaitMs` has passed, then shown — and from then on they are FIXED for that title: whatever
 * arrives later waits for the next time the title is shown. One appearance, one entrance; never a
 * chip swapped or replayed while the viewer is looking at it. A new `key` (another title) starts over. */
export function useSettledGlance(
  source: GlanceSource,
  key: unknown,
  { waitForMeta = false, maxWaitMs = 900 }: { waitForMeta?: boolean; maxWaitMs?: number } = {},
): GlanceCallout[] {
  const live = useGlance(source);
  const ready = useGlanceReady(source, waitForMeta);
  const [st, setSt] = useState<{ key: unknown; list: GlanceCallout[] | null; late: boolean }>(() => ({ key, list: null, late: false }));
  if (st.key !== key) setSt({ key, list: null, late: false });
  const cur = st.key === key ? st : { key, list: null, late: false };
  useEffect(() => {
    const id = window.setTimeout(() => setSt((s) => (s.key === key ? { ...s, late: true } : s)), maxWaitMs);
    return () => window.clearTimeout(id);
  }, [key, maxWaitMs]);
  /* SETTLED IN THE RENDER THAT CAN SETTLE THEM, the same render-phase update as the key reset above. As
   * an effect this always cost one more commit: the surface was drawn once with no callouts and again
   * with them, so even callouts that were ready (their awards cached) arrived a frame after the words
   * they belong to — on post-play, visibly out of step with the wordmark they are meant to follow. */
  if (!(cur.list && cur.list.length) && (ready || cur.late) && live.length) setSt({ key, list: live, late: true });
  return cur.list || NONE;
}
const NONE: GlanceCallout[] = [];
/** How long a resolver reuses its "because you watched…" map before building it again. */
const BECAUSE_FRESH_MS = 2000;

/* THE SAME CALLOUTS FOR CODE THAT IS NOT A COMPONENT PER TITLE — the TV row billboard, which
 * describes a card inside its key handler (TvSpotlight `describeSlot`). Nothing here fetches: the
 * title's detail and awards are read from the cache if something already asked for them, so a
 * press costs a few map lookups and never a request. The row re-renders when a cached answer
 * lands (its own dwell asks for the awards), and the callout catches up then. */
export function useGlanceResolver(): (item: MediaItem) => GlanceCallout[] {
  const t = useT();
  const { lang } = useLang();
  const home = useHomeCached();
  const taste = useTaste();
  const qc = useQueryClient();
  return useMemo(() => {
    const index = homeIndex(home);
    const cut = home ? loveCut(taste, homePool(home), home) : undefined;
    /* "BECAUSE YOU WATCHED…" IS BUILT ONCE, NOT PER CARD. It is a map over the viewer's whole watch
     * history and every seed's recommendations, and this function runs every time a row describes a card
     * — each render, each press, each prefill — so for someone with a long history it was the same map
     * rebuilt several times per keypress. Kept for a couple of seconds, which still picks up a seed's
     * recommendations arriving in the cache without anything having to say so. */
    let because: ReturnType<typeof becauseIndex> | null = null;
    let becauseAt = 0;
    const becauseOf = () => {
      const now = Date.now();
      if (!because || now - becauseAt > BECAUSE_FRESH_MS) { because = becauseIndex(qc, lang); becauseAt = now; }
      return because;
    };
    return (item: MediaItem) => {
      const id = apiIdOf(item);
      const meta = id ? qc.getQueryData<MetaDetail>(['meta', id, item.type, lang]) : undefined;
      const imdb = (typeof item.imdb === 'string' ? item.imdb : undefined) || meta?.imdb || undefined;
      const awards = imdb ? qc.getQueryData<Awards>(['awards', imdb]) : undefined;
      return computeGlance({
        item: {
          ...item,
          released: item.released ?? meta?.released ?? null,
          genres: item.genres?.length ? item.genres : meta?.genre,
        },
        airing: meta?.airing,
        awards,
        home: index,
        taste,
        loveCut: cut,
        because: becauseOf().get(becauseKey(item)) || null,
        seasons: meta?.seasons ?? null,
        t,
        lang,
      });
    };
  }, [t, lang, home, taste, qc]);
}

/* THE OPENING MOMENTS OF A PAGE: true for INTRO_MS after a surface mounts, or after `key` (the title
 * it shows) changes; false after that. A surface hands it to its callouts (`rise`) and puts `gl-run`
 * on its buttons with it, so their icons play once as the page arrives — and a press, a focus, a
 * dropdown that rebuilds the button row, a billboard stepping to its next title, none of them plays
 * anything again. */
const INTRO_MS = 2600;
export function useIntro(key?: unknown): boolean {
  const [state, setState] = useState(() => ({ key, on: true }));
  if (state.key !== key) setState({ key, on: true });
  useEffect(() => {
    const id = window.setTimeout(() => setState((s) => (s.key === key ? { key, on: false } : s)), INTRO_MS);
    return () => window.clearTimeout(id);
  }, [key]);
  return state.key !== key ? true : state.on;
}
