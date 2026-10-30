import { lazy, type ComponentType } from 'react';

/* React.lazy that does not suspend once its chunk is in hand. React calls a lazy page's loader on its
 * first render and suspends on the promise it gets, even when the chunk was fetched long before — and
 * then holds the page back up to 300ms (its fallback throttle): on the TV, black between one page and
 * the next (measured on the Prime test page's switch, Oct 30). `preload` fetches the chunk and keeps
 * the module; the loader then hands the kept module over at once, through a thenable that answers
 * synchronously, so the first render has the page. */
export function lazyNow<T extends ComponentType>(load: () => Promise<{ default: T }>) {
  let kept: { default: T } | null = null;
  const preload = () => load().then((m) => { kept = m; return m; });
  const Page = lazy(() => {
    const m = kept;
    return m ? ({ then: (ok: (mod: { default: T }) => void) => ok(m) } as unknown as Promise<{ default: T }>) : preload();
  });
  return Object.assign(Page, { preload });
}
