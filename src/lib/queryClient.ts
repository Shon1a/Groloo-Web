import { QueryClient, notifyManager } from '@tanstack/react-query';
import { quietFor, afterMotion, MOTION_MS } from './tvQuiet';

/* Server data cache. Defaults chosen to echo the vanilla app's behaviour:
 * the catalog endpoints already carry `max-age=600, stale-while-revalidate`,
 * so we keep data fresh for 10 min and avoid refetch-on-focus thrash. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10 * 60 * 1000, // 10 min — matches the API Cache-Control
      gcTime: 30 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/* ---- ON THE TV, AN ANSWER THAT ARRIVES MID-MOVEMENT IS HANDED OVER WHEN THE MOVEMENT ENDS ----------------
 * A walk asks for things as it goes (a resting card's /api/meta, a row's next page), and an answer lands
 * whenever the network delivers it — often inside the next press's slide, where it re-renders the row that
 * is moving. Every notification the cache would send is queued instead while the remote is moving and
 * delivered in one batch once it has been still for a press's movement (lib/tvQuiet `afterMotion`, capped
 * so a hold still sees its data). The requests themselves are not delayed, only what React does with them. */
if (import.meta.env.MODE === 'tv') {
  let held: Array<() => void> = [];
  /* One task for the batch, each callback kept apart as the default scheduler's own tasks keep them. */
  const deliver = () => {
    const q = held;
    held = [];
    for (const cb of q) { try { cb(); } catch (e) { console.error('[groloo] query notification failed', e); } }
  };
  notifyManager.setScheduler((cb) => {
    if (!held.length && quietFor() >= MOTION_MS) { window.setTimeout(cb, 0); return; }
    held.push(cb);
    if (held.length === 1) afterMotion(deliver);
  });
}
