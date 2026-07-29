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
