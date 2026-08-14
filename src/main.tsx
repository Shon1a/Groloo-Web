/* FIRST, and a bare side-effect import on purpose — it runs during module evaluation.
 * Every store reads its slice of localStorage at module scope, and module bodies are
 * evaluated in import order, so this line is what guarantees the old-name -> `groloo*`
 * key move completes before those reads. A named import plus a call would NOT work:
 * import declarations are hoisted. See lib/nameMigration.ts. */
import './lib/nameMigration';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { I18nProvider } from './i18n/i18n';
import { bootLaunchIntent } from './lib/launchIntent';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
// Visual baseline: the vanilla app's stylesheet, imported verbatim so ported
// screens look identical. Migrates to per-component CSS Modules over later phases.
import './styles/app.css';

/* TV EFFECT BUDGET, `--mode tv` only. `import.meta.env.MODE` is the Vite build mode, and it
 * is a compile-time constant: in the web build it is the string "production", so this branch
 * is statically false and Vite dead-code-eliminates it — styles/tv.css is never bundled or
 * shipped to the website. In the TV build MODE is "tv", the branch is live, and the
 * subtractive overrides load. A dynamic import (not a top-level one) is what lets that
 * elimination happen; on a packaged TV app the file is local, so the load is immediate. */
if (import.meta.env.MODE === 'tv') {
  import('./styles/tv.css');
}

/* THE PERFORMANCE PROBE, TV BUILD ONLY AND OFF UNLESS ASKED FOR. Same compile-time gate as the
 * stylesheet above, so the website never contains the file at all. See lib/tvPerf.ts for what it
 * measures and how to read it; in short, localStorage['groloo.perf'] = '1' then relaunch.
 *
 * THE FLAG IS READ HERE RATHER THAN INSIDE THE MODULE, and that is the whole point of the shape:
 * asking `tvPerf.ts` whether it is wanted would mean FETCHING it on every launch to find out, which
 * is exactly the launch-time request this app is trying not to make. Three property reads decide it,
 * and the chunk stays on the server unless the answer is yes.
 *
 * NOT AWAITED. The import resolves within a few milliseconds of boot, long before a remote can reach
 * the first keypress, and the probe scores presses from `event.timeStamp` rather than from whenever
 * it happened to start listening — so nothing is lost by it arriving late. */
if (import.meta.env.MODE === 'tv') {
  /* Checked OUTSIDE the try, because it is the carrier the CDP driver uses: it arms a cold launch
   * through Page.addScriptToEvaluateOnNewDocument, and a set whose localStorage throws is exactly
   * the set worth measuring. Folding it in with the storage read would lose it on that set. */
  let perfMode: '1' | '2' | '' = window.__GROLOO_PERF__ === true ? '1' : '';
  if (!perfMode) {
    try {
      const q = new URLSearchParams(location.search).get('perf');
      const s = q === '1' || q === '2' ? q : localStorage.getItem('groloo.perf');
      if (s === '1' || s === '2') perfMode = s;
    } catch { /* no localStorage (private mode); the probe simply stays off */ }
  }
  if (perfMode) {
    void import('./lib/tvPerf').then((m) => m.startTvPerf(perfMode as '1' | '2'));
  }
}

/* Last-resort logging for the two failure classes a React boundary cannot see: throws
 * from outside the render cycle (event handlers, timers, media callbacks) and promise
 * rejections nobody awaited. Deliberately console-only — no telemetry dependency and no
 * network call, because a crash reporter is a separate decision with its own privacy and
 * store-review consequences. What this buys today is a single greppable prefix: on a TV
 * the only way in is a remote debugger session, and '[groloo]' turns a wall of vendor
 * noise into the three lines that matter. Wire a reporter into these two handlers later. */
window.addEventListener('error', (e) => {
  // e.error is absent for cross-origin script errors ("Script error.") and for resource
  // load failures, so fall back to the message rather than logging a bare `undefined`.
  console.error('[groloo] uncaught error:', e.error ?? e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[groloo] unhandled rejection:', e.reason);
});

/* Resolve an incoming title address BEFORE the first render, so a deep-linked visit paints the
 * detail overlay directly instead of flashing Home and then opening it. This is the web carrier
 * of the launch-intent resolver; webOS's launchParams/relaunch feeds and the Android bridge post
 * into the same `applyLaunchIntent`. It adds no route — see lib/launchIntent.ts. */
bootLaunchIntent();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside the providers, not inside: a throw from the query client or the i18n
        provider's own setup would otherwise escape the boundary meant to catch it. */}
    <ErrorBoundary label="app">
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <App />
        </I18nProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
