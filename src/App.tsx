import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './stores/auth';
import { useAddons } from './stores/addons';
import { useHistory } from './stores/history';
import { useLibrary } from './stores/library';
import { useOfficial } from './stores/official';
import { initHeartLibrary } from './lib/heartLibrary';
import { initHeartCatalog } from './lib/heartCatalog';
import AppShell from './layout/AppShell';
import Home from './routes/Home';
import Explore from './routes/Explore';
import Categories from './routes/Categories';
import Browse from './routes/Browse';
import Library from './routes/Library';
import Addons from './routes/Addons';
import Settings from './routes/Settings';
/* Aliased on the way in. The route's own default export is named `Link`, which is also
 * the name of react-router-dom's link component — the one import this file is most
 * likely to grow next. Renaming here means that day is a one-line addition rather than
 * a rename under a shadowed identifier that still compiles and renders the wrong thing. */
import LinkRoute from './routes/Link';
import DeleteAccount from './routes/DeleteAccount';
import Legal from './routes/Legal';
import Terms from './routes/Terms';
import Attributions from './routes/Attributions';
import DetailModal from './components/DetailModal/DetailModal';
import VideoPlayer from './components/VideoPlayer/VideoPlayer';
import AuthModal from './components/AuthModal';

/* Hash routing (React Router in hash mode) — needs zero server config, so any static
 * host works with no catch-all rewrite. */
export default function App() {
  const refresh = useAuth((s) => s.refresh);
  const loadConfig = useAuth((s) => s.loadConfig);
  const user = useAuth((s) => s.user);
  const pullAddons = useAddons((s) => s.pullFromServer);
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
    if (user) { pullAddons(); pullHistory(); pullLibrary(); }
  }, [user, pullAddons, reloadHistory, pullHistory, reloadLibrary, pullLibrary]);

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          {/* discover surfaces */}
          <Route path="explore" element={<Explore />} />
          <Route path="categories" element={<Categories />} />
          <Route path="tv" element={<Browse cat="trending_tv" topLevel />} />
          <Route path="movies" element={<Browse cat="trending_movie" topLevel />} />
          <Route path="anime" element={<Browse cat="trending_anime" topLevel />} />
          <Route path="browse/:cat" element={<Browse />} />
          {/* library / add-ons / settings */}
          <Route path="library" element={<Library />} />
          <Route path="addons" element={<Addons />} />
          <Route path="settings" element={<Settings />} />
          {/* Device-link claim page. Deliberately NOT gated in AppShell's GATED list:
              the URL is typed off a TV screen by a user who may not be signed in yet,
              and the route itself has to hold the code they came to enter while the
              auth modal runs — a gate that bounced them home would lose it. */}
          <Route path="link" element={<LinkRoute />} />
          {/* Account deletion, publicly reachable and deliberately NOT gated. Play has
              required a deletion URL that works with the app uninstalled since 2024, so
              this one has to answer for a visitor who arrives cold from a store listing:
              it explains itself first and routes through sign-in on its own terms. The
              in-app control in Settings stays — this is the second door, not a move. */}
          <Route path="delete-account" element={<DeleteAccount />} />
          {/* public footer pages — /attributions is also its own route (not a Legal
              section) because TMDB and the stores both want a citable standalone URL,
              and the TV shells that drop the web footer link straight to it. */}
          <Route path="legal" element={<Legal />} />
          <Route path="terms" element={<Terms />} />
          <Route path="attributions" element={<Attributions />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <DetailModal />
      <VideoPlayer />
      <AuthModal />
    </HashRouter>
  );
}
