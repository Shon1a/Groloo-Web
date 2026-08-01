import { useEffect, lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './stores/auth';
import { useAddons } from './stores/addons';
import { useBlocks } from './stores/blocks';
import { useHistory } from './stores/history';
import { useLibrary } from './stores/library';
import { useOfficial } from './stores/official';
import { initHeartLibrary } from './lib/heartLibrary';
import { initHeartCatalog } from './lib/heartCatalog';
import AppShell from './layout/AppShell';
import Home from './routes/Home';
import Browse from './routes/Browse';

/* WHAT LOADS UP FRONT, AND WHAT WAITS. Home, Browse and the AppShell are eager: they are
 * the first paint on nearly every visit, and code-splitting them would only add a loading
 * flash to the path that matters most. Everything below is lazy — a separate file the
 * browser fetches the first time that screen is opened, and never on a visit that does not
 * open it. Settings, the legal pages and the account-deletion flow are the clearest wins:
 * heavy, and reached by a small fraction of sessions. On a TV, where the whole app competes
 * for a few hundred MB, not parsing a screen nobody opened is memory saved as well as bytes.
 *
 * The two heavy MODALS (DetailModal, VideoPlayer) are split the same way but gated below,
 * because they are always in the tree rather than reached by a route — see DetailModalGate. */
const Explore = lazy(() => import('./routes/Explore'));
const Categories = lazy(() => import('./routes/Categories'));
const Library = lazy(() => import('./routes/Library'));
const Addons = lazy(() => import('./routes/Addons'));
const Settings = lazy(() => import('./routes/Settings'));
const LinkRoute = lazy(() => import('./routes/Link'));
const DeleteAccount = lazy(() => import('./routes/DeleteAccount'));
const Legal = lazy(() => import('./routes/Legal'));
const Terms = lazy(() => import('./routes/Terms'));
const Attributions = lazy(() => import('./routes/Attributions'));

import DetailModalGate from './components/DetailModal/DetailModalGate';
import VideoPlayerGate from './components/VideoPlayer/VideoPlayerGate';
import AuthModal from './components/AuthModal';
import TvAuthModal from './components/TvAuthModal';
import LinkTvModal from './components/LinkTvModal';
import ReportModal from './components/ReportModal';

/* WHICH SIGN-IN SCREEN THIS BUILD SHIPS. `import.meta.env.MODE` is a Vite compile-time
 * constant, so exactly one of the two below survives the build and the other is dropped
 * with its imports — the TV never carries the web form-card, and the web never carries
 * the pairing screen. See TvAuthModal for why a TV cannot be asked to type a password.
 * LinkTvModal is the reverse of that pairing screen (the account popup that approves a
 * TV's code) and is therefore web-only for the same reason: a TV is the thing being
 * linked, never the thing doing the linking. */
const IS_TV = import.meta.env.MODE === 'tv';

/* Route fallback: nothing. A lazy route's chunk is a few KB over a connection already warm
 * from the app shell, so it resolves in well under a frame on anything but a cold cache —
 * and a spinner that flashes for 30ms is worse than a beat of the shell the user is already
 * looking at. The shell (rail + background) stays painted throughout because Suspense sits
 * INSIDE the AppShell layout route, not around it. */
const routeFallback = null;

/* Hash routing (React Router in hash mode) — needs zero server config, so any static
 * host works with no catch-all rewrite. */
export default function App() {
  const refresh = useAuth((s) => s.refresh);
  const loadConfig = useAuth((s) => s.loadConfig);
  const user = useAuth((s) => s.user);
  const pullAddons = useAddons((s) => s.pullFromServer);
  const pullBlocks = useBlocks((s) => s.pullFromServer);
  const reloadHistory = useHistory((s) => s.reload);
  const pullHistory = useHistory((s) => s.pull);
  const reloadLibrary = useLibrary((s) => s.reload);
  const pullLibrary = useLibrary((s) => s.pull);
  const loadOfficial = useOfficial((s) => s.load);
  useEffect(() => {
    refresh(); loadConfig(); loadOfficial();
    initHeartCatalog().catch(() => {});
    // once the Heart WASM library runtime is up, re-normalize the library through it
    initHeartLibrary().then(reloadHistory).catch(() => {});
  }, [refresh, loadConfig, loadOfficial, reloadHistory]);
  // on sign-in/out the localStorage namespace (per-email) changes → reload, then
  // merge the server-stored add-on collection + watch history when signed in
  useEffect(() => {
    reloadHistory(); reloadLibrary();
    if (user) { pullAddons(); pullBlocks(); pullHistory(); pullLibrary(); }
  }, [user, pullAddons, pullBlocks, reloadHistory, pullHistory, reloadLibrary, pullLibrary]);

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          {/* discover surfaces */}
          <Route path="explore" element={<Suspense fallback={routeFallback}><Explore /></Suspense>} />
          <Route path="categories" element={<Suspense fallback={routeFallback}><Categories /></Suspense>} />
          <Route path="tv" element={<Browse cat="trending_tv" topLevel />} />
          <Route path="movies" element={<Browse cat="trending_movie" topLevel />} />
          <Route path="anime" element={<Browse cat="trending_anime" topLevel />} />
          <Route path="browse/:cat" element={<Browse />} />
          {/* library / add-ons / settings */}
          <Route path="library" element={<Suspense fallback={routeFallback}><Library /></Suspense>} />
          <Route path="addons" element={<Suspense fallback={routeFallback}><Addons /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={routeFallback}><Settings /></Suspense>} />
          {/* Device-link claim page. Deliberately NOT gated in AppShell's GATED list:
              the URL is typed off a TV screen by a user who may not be signed in yet,
              and the route itself has to hold the code they came to enter while the
              auth modal runs — a gate that bounced them home would lose it. */}
          <Route path="link" element={<Suspense fallback={routeFallback}><LinkRoute /></Suspense>} />
          {/* Account deletion, publicly reachable and deliberately NOT gated. Play has
              required a deletion URL that works with the app uninstalled since 2024, so
              this one has to answer for a visitor who arrives cold from a store listing:
              it explains itself first and routes through sign-in on its own terms. The
              in-app control in Settings stays — this is the second door, not a move. */}
          <Route path="delete-account" element={<Suspense fallback={routeFallback}><DeleteAccount /></Suspense>} />
          {/* public footer pages — /attributions is also its own route (not a Legal
              section) because TMDB and the stores both want a citable standalone URL,
              and the TV shells that drop the web footer link straight to it. */}
          <Route path="legal" element={<Suspense fallback={routeFallback}><Legal /></Suspense>} />
          <Route path="terms" element={<Suspense fallback={routeFallback}><Terms /></Suspense>} />
          <Route path="attributions" element={<Suspense fallback={routeFallback}><Attributions /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <DetailModalGate />
      <VideoPlayerGate />
      {/* ORDER IS LOAD-BEARING, and it is a three-way constraint rather than a preference.
          ReportModal must sit ABOVE DetailModal (it opens from inside it) and BELOW
          AuthModal (an unauthenticated report opens sign-in on top of itself, and the
          report sheet stays mounted underneath so the user returns to it afterwards).
          ReportModal and AuthModal both render `.auth-overlay`, so they share a z-index
          and DOM order is the only thing deciding — mounted last, the report sheet
          swallowed every click meant for the sign-in form behind it. */}
      <ReportModal />
      {/* LinkTvModal sits BELOW the sign-in card for the same DOM-order reason the report
          sheet does: a signed-out visitor who opens it raises AuthModal on top and this
          popup stays mounted underneath, holding the code they already typed. Mounted
          last, it would swallow every click meant for the sign-in form in front of it. */}
      {!IS_TV && <LinkTvModal />}
      {IS_TV ? <TvAuthModal /> : <AuthModal />}
    </HashRouter>
  );
}
