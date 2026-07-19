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
import Legal from './routes/Legal';
import Terms from './routes/Terms';
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
          {/* public footer pages */}
          <Route path="legal" element={<Legal />} />
          <Route path="terms" element={<Terms />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <DetailModal />
      <VideoPlayer />
      <AuthModal />
    </HashRouter>
  );
}
