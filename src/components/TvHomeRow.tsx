import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { gridUrl, type GridDesc } from '../lib/grid';
import { useLang } from '../i18n/i18n';
import type { MediaItem } from '../lib/types';
import TvSpotlight, { SPOT_MAX } from './TvSpotlight';

/* A TV HOME ROW THAT GETS LONGER INSTEAD OF LEAVING.
 *
 * Every category row on the TV home used to end in a "SEE ALL" card that navigated to
 * /browse/<cat> — a whole page transition, a new screen to orient to, and a Back press to undo.
 * The TV / Movies / Anime pages had already answered this better (TvCatalogRow): the card at the
 * end says "+" and pressing it LENGTHENS THE ROW, so walking right is the pagination and the
 * viewer never leaves the shelf they were reading. This makes the home rows behave the same way,
 * which is the whole reason those pages were built as rows in the first place — one grammar.
 *
 * WHERE THE EXTRA TITLES COME FROM, AND WHY THERE ARE TWO SOURCES. /api/home answers with ~20
 * titles per row and the home screen caps that further, so the first press can often be served
 * from what is already in hand. Past that the row asks the same paginated endpoint the drill-down
 * page it replaces would have loaded (`gridUrl` on the same descriptor Browse builds), under the
 * same React Query key — so a row extended here and a category opened from anywhere else share
 * one cache entry rather than each fetching page 1.
 *
 * NOTHING IS FETCHED UNTIL THE ROW IS REACHED. A home screen mounts a dozen of these, and arming
 * a catalogue query per row on load would put a dozen requests on the network at exactly the
 * moment the artwork is loading — for rows nobody has walked to. `started` is one-way, and two
 * things set it: pressing the end card, and the remote settling on the row (`onOpen`).
 *
 * THE SECOND OF THOSE IS NEW, AND IT IS WHAT MAKES A FORTY-TITLE ROW POSSIBLE AT ALL. /api/home
 * answers with one TMDB page — about twenty titles after the IMDb gate and the poster filter — so
 * a row that opens at SPOT_MAX (40) is short by half from the moment it mounts, and no press of
 * anything is going to fix that: the end card sits at position 40, past titles that do not exist
 * yet. Waking the query when the row is focused fills the gap from underneath while the viewer is
 * still looking at the first card, and costs one request for a row somebody is reading rather than
 * thirteen for a screen nobody has touched.
 *
 * THE TWO SOURCES DO OVERLAP, so the merge is deduped by id: page 1 of `trending_movie` is
 * largely the row that is already on screen, and a strip that repeats its own first six titles
 * halfway along reads as a bug. The seeded titles keep their positions — the walk must not
 * reorder under the remote — and only titles it has not already shown are appended. */

interface GridResponse { totalPages?: number; results?: MediaItem[] }

/** Titles added per press of the end card. Matches TvCatalogRow, so the two rows lengthen by the
 *  same amount and a home row that has been extended is indistinguishable from a catalogue one. */
const STEP = 15;

export interface TvHomeRowProps {
  cat: string;
  title: string;
  /** What /api/home already gave us for this row — the strip as it stands before any press. */
  items: MediaItem[];
  onSelect?: (m: MediaItem) => void;
}

export default function TvHomeRow({ cat, title, items, onSelect }: TvHomeRowProps) {
  const { lang } = useLang();
  /* OPENS AT SPOT_MAX OUTRIGHT, NOT AT WHAT THE PAYLOAD HAPPENED TO CARRY. This used to be
   * `min(items.length, SPOT_MAX)` — the row asked for no more than it already had, so it never
   * needed a request to fill itself and the whole of the catalogue query was reserved for presses
   * of the end card. At SPOT_MAX 10 against a ~14-title seed that was always the same number.
   *
   * At 40 it is not: the seed is half the row, and clamping to it would mean a row that says it
   * walks forty titles quietly walking twenty. `shown` is the WINDOW the row wants, `all` is what
   * has arrived, and the effect below is what closes the distance — so asking for the full forty
   * up front is what tells it there is a distance to close. */
  const [shown, setShown] = useState(SPOT_MAX);
  const [started, setStarted] = useState(false);

  /* The SAME descriptor Browse builds for this category (see its `desc`), so the query key matches
   * and the drill-down grid, the TV catalogue row and this row all read one cache. */
  const desc: GridDesc = useMemo(() => ({ kind: 'category', cat, title }), [cat, title]);

  const q = useInfiniteQuery({
    queryKey: ['grid', desc, lang],
    enabled: started,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<GridResponse>(gridUrl(desc, pageParam as number, lang)),
    getNextPageParam: (last, _pages, lastPageParam) => {
      const tp = Math.max(1, Math.min(500, last.totalPages || 1));
      const next = (lastPageParam as number) + 1;
      return next <= tp ? next : undefined;
    },
  });

  /* Seed first and in its original order, then whatever the catalogue adds that is not already on
   * the strip. Posterless cards are dropped for the reason the home rows drop them: the strip is
   * nothing but artwork, and a card with none is a hole in the middle of it. */
  const all = useMemo(() => {
    const out: MediaItem[] = [];
    const seen = new Set<string>();
    for (const m of [...items, ...(q.data?.pages ?? []).flatMap((p) => p.results ?? [])]) {
      if (!m?.poster) continue;
      const k = `${m.type || ''}:${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
    return out;
  }, [items, q.data]);

  /* Keep the pages coming until the window is covered — a press that lands mid-page fetches, and a
   * page that arrives still short (the dedupe and the poster filter can both shorten one) fetches
   * again. */
  const short = all.length < shown;
  useEffect(() => {
    if (!started || !short) return;
    if (q.isFetching || !q.hasNextPage) return;
    void q.fetchNextPage();
  }, [started, short, q.isFetching, q.hasNextPage, q.fetchNextPage, q]);

  const list = all.slice(0, shown);
  /* Offered until the catalogue is demonstrably out of titles: anything already fetched and
   * outside the window, a page still to ask for, or a request in flight all mean there is more
   * coming. Tested as "not exhausted" rather than as "has more" so the card cannot BLINK OUT for
   * the moment between a press and the page it triggered — a focus stop that disappears under the
   * remote is worse than one that turns out to be the last. */
  const exhausted = started && !q.isFetching && !q.hasNextPage && all.length <= shown;

  /* The catalogue is only woken when the window would actually outrun what is already here — a
   * press that the seeded titles can serve costs no request at all, which on a row that arrived
   * with twenty titles is the common case. `started` is one-way from there. */
  const more = () => {
    const next = shown + STEP;
    if (next > all.length) setStarted(true);
    setShown(next);
  };

  return (
    <TvSpotlight
      items={list}
      title={title}
      max={shown}
      /* ONLY ONCE THE ROW HAS BEEN REACHED. /api/home resolves a wordmark per title (the `logos=1`
       * flag) and /api/browse does not, so the seeded titles arrive complete and the appended ones
       * do not. `enrich` fills the gap with a detail lookup for the rested title — worth one
       * request on a row someone is walking through, and thirteen requests on a home screen nobody
       * has touched, which is why it is not simply always on.
       *
       * TIED TO `started` RATHER THAN TO THE LENGTH, which is both simpler and more correct than
       * the `shown > items.length` it replaces. That test now reads true on every row from mount
       * (see `shown` above) and would have turned this on everywhere. `started` is the same fact it
       * was always trying to express — this row has titles on it that did not come from /api/home —
       * and it covers a case the length test never did: the server caps its wordmark resolution at
       * TV_LOGO_CAP (12) per row, so even the SEEDED titles past the twelfth arrive without one. */
      enrich={started}
      onSelect={onSelect}
      /* Wake the catalogue the first time the remote settles here, so the row has fetched its way
       * to `shown` by the time anyone walks far enough to notice it was short. Idempotent: this
       * fires on every settle and `setStarted(true)` on an already-started row is a no-op. */
      onOpen={() => setStarted(true)}
      onMore={exhausted ? undefined : more}
      /* Gated on `started` so an untouched row — permanently `short`, because it wants 40 and holds
       * 20 — does not render its end card as "Loading…" for a fetch that has not been asked for. */
      moreBusy={started && (short || q.isFetching)}
    />
  );
}
