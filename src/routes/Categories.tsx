import { useNavigate } from 'react-router-dom';
/* This page's stylesheet, imported HERE and not from main.tsx. The route is a lazy chunk, so Vite
 * emits these rules as that chunk's own CSS: fetched when the page is, and absent from any build
 * the page is absent from — which on the TV build is the whole of it. */
import '../styles/Categories.css';
import { useT, useGenre } from '../i18n/i18n';
import { catArt } from '../lib/categoryArt';
import type { ReactNode } from 'react';

/* Categories — the "browse by category" surface. Instead of dumping a movie grid,
 * this page shows the categories THEMSELVES as cards: big collection tiles, a
 * genre wall, and the streaming networks. Each card is a signed duotone glass
 * tile (per-category hue + a large line-art watermark glyph) that lazily blends
 * a few real backdrops from that category behind the label, then drills into the
 * matching grid: collections/networks → /browse, genres → /explore pre-filtered.
 * The gradient tiles paint instantly; the artwork fades in on top once fetched. */

interface Cat {
  key: string;              // stable react key — also keys the curated backdrop (see catArt)
  label: string;            // display label (already localized)
  to: string;               // router destination
  h1: string; h2: string;   // duotone gradient stops (light → deep)
  icon: ReactNode;          // line-art watermark glyph
}

// tiny line-art icon set — monochrome; the tint comes from the card's gradient
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const ICONS: Record<string, ReactNode> = {
  movies: <svg viewBox="0 0 24 24" {...S}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></svg>,
  tv: <svg viewBox="0 0 24 24" {...S}><rect x="2.5" y="7" width="19" height="12.5" rx="2" /><path d="M8 3.5 12 7l4-3.5" /></svg>,
  anime: <svg viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="9" /><path d="M12 12V3M12 12l7.8 4.5" /></svg>,
  trending: <svg viewBox="0 0 24 24" {...S}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>,
  top: <svg viewBox="0 0 24 24" {...S}><path d="M12 3l2.6 5.6 6 .7-4.5 4.2 1.2 6L12 16.9 6.7 19.5l1.2-6L3.4 9.3l6-.7L12 3z" /></svg>,
  upcoming: <svg viewBox="0 0 24 24" {...S}><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v3M16 3v3M12 12v4M10 14h4" /></svg>,
  action: <svg viewBox="0 0 24 24" {...S}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" /></svg>,
  adventure: <svg viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2z" /></svg>,
  comedy: <svg viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" /></svg>,
  drama: <svg viewBox="0 0 24 24" {...S}><path d="M4 4c0 8 2 12 8 12s8-4 8-12c-5 1.5-11 1.5-16 0z" /><path d="M9 9h.01M15 9h.01M9.5 13s1 1.5 2.5 1.5S14.5 13 14.5 13" /></svg>,
  horror: <svg viewBox="0 0 24 24" {...S}><path d="M12 2a8 8 0 0 0-8 8c0 3 1.5 4.5 2 6 .3 1 0 3 0 3h12s-.3-2 0-3c.5-1.5 2-3 2-6a8 8 0 0 0-8-8z" /><path d="M9 10h.01M15 10h.01M10 16v2M14 16v2" /></svg>,
  thriller: <svg viewBox="0 0 24 24" {...S}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>,
  scifi: <svg viewBox="0 0 24 24" {...S}><path d="M5 19c-1-1 0-4 2.5-6.5C11 9 15 6.5 19 5c-1.5 4-4 8-7.5 11.5C9 19 6 20 5 19z" /><circle cx="14.5" cy="9.5" r="1.6" /><path d="M5 19l2.5-2.5" /></svg>,
  fantasy: <svg viewBox="0 0 24 24" {...S}><path d="m5 19 9-9M14 6l1.5 1.5" /><path d="m17 3 .8 2.2L20 6l-2.2.8L17 9l-.8-2.2L14 6l2.2-.8L17 3z" /><path d="M6 13l.6 1.6L8 15l-1.4.4L6 17l-.6-1.6L4 15l1.4-.4L6 13z" /></svg>,
  romance: <svg viewBox="0 0 24 24" {...S}><path d="M12 20s-7-4.5-9-9C1.5 7 4 4 7 4c2 0 3.5 1.5 5 3.5C13.5 5.5 15 4 17 4c3 0 5.5 3 4 7-2 4.5-9 9-9 9z" /></svg>,
  animation: <svg viewBox="0 0 24 24" {...S}><path d="m12 3 2.2 4.8L19 9l-4.8 1.2L12 15l-2.2-4.8L5 9l4.8-1.2L12 3z" /><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" /></svg>,
  mystery: <svg viewBox="0 0 24 24" {...S}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /><path d="M10.5 7.5a3 3 0 0 1 3 3" /></svg>,
  crime: <svg viewBox="0 0 24 24" {...S}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="m9 12 2 2 4-4" /></svg>,
  documentary: <svg viewBox="0 0 24 24" {...S}><path d="M4 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4V5z" /><path d="M20 5h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7V5z" /></svg>,
  family: <svg viewBox="0 0 24 24" {...S}><circle cx="8" cy="8" r="2.6" /><circle cx="16" cy="8" r="2.6" /><path d="M3 20c0-3 2.2-5 5-5s5 2 5 5M13.5 20c.4-2.4 2.3-4 4.5-4s4 1.6 4.5 4" /></svg>,
  war: <svg viewBox="0 0 24 24" {...S}><path d="M6 4l12 12M18 4L6 16" /><path d="M4 14l2 2-2 2 2 2M20 14l-2 2 2 2-2 2" /></svg>,
  western: <svg viewBox="0 0 24 24" {...S}><path d="M4 14c1-5 3-7 8-7s7 2 8 7" /><path d="M2 14c2 2 5 3 10 3s8-1 10-3" /></svg>,
  history: <svg viewBox="0 0 24 24" {...S}><path d="M5 4h14M5 20h14M7 4c0 4 2 6 5 8-3 2-5 4-5 8M17 4c0 4-2 6-5 8 3 2 5 4 5 8" /></svg>,
  music: <svg viewBox="0 0 24 24" {...S}><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>,
  network: <svg viewBox="0 0 24 24" {...S}><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg>,
};

/* Big collection tiles — the primary browse destinations. */
const COLLECTIONS: Cat[] = [
  { key: 'movies',   label: 'nav.movies',           to: '/movies',                h1: '#8fb2ff', h2: '#2b357e', icon: ICONS.movies },
  { key: 'tv',       label: 'nav.tv_shows',          to: '/tv',                    h1: '#7be0d2', h2: '#0e6f7f', icon: ICONS.tv },
  { key: 'anime',    label: 'nav.anime',             to: '/anime',                 h1: '#ff9ff3', h2: '#7b3fb0', icon: ICONS.anime },
  { key: 'trending', label: 'explore.trending',      to: '/browse/trending_movie', h1: '#ff8a5c', h2: '#b21f3a', icon: ICONS.trending },
  { key: 'top',      label: 'sec.top_movies',        to: '/browse/top_movie',      h1: '#ffd66b', h2: '#b07d1e', icon: ICONS.top },
  { key: 'upcoming', label: 'sec.upcoming_movies',   to: '/browse/upcoming_movie', h1: '#b18cff', h2: '#4b2bb0', icon: ICONS.upcoming },
];

/* Genre wall — each drills into the Explore page pre-filtered to that genre. The
 * `g` name is the raw label the catalog API resolves (aliases handled server-side). */
const GENRES: Array<{ key: string; g: string; h1: string; h2: string; icon: ReactNode }> = [
  { key: 'action',      g: 'Action',      h1: '#ff6a3d', h2: '#a81f2a', icon: ICONS.action },
  { key: 'adventure',   g: 'Adventure',   h1: '#f5b14c', h2: '#a5611c', icon: ICONS.adventure },
  { key: 'comedy',      g: 'Comedy',      h1: '#ffd24d', h2: '#d1841c', icon: ICONS.comedy },
  { key: 'drama',       g: 'Drama',       h1: '#8a9cff', h2: '#333a86', icon: ICONS.drama },
  { key: 'horror',      g: 'Horror',      h1: '#c23347', h2: '#2a060b', icon: ICONS.horror },
  { key: 'thriller',    g: 'Thriller',    h1: '#9fb0c2', h2: '#2b3542', icon: ICONS.thriller },
  { key: 'scifi',       g: 'Sci-Fi',      h1: '#47e0d0', h2: '#0d6a86', icon: ICONS.scifi },
  { key: 'fantasy',     g: 'Fantasy',     h1: '#bb84ff', h2: '#5626a8', icon: ICONS.fantasy },
  { key: 'romance',     g: 'Romance',     h1: '#ff85b4', h2: '#a82b5e', icon: ICONS.romance },
  { key: 'animation',   g: 'Animation',   h1: '#ffa1ee', h2: '#7b3fc0', icon: ICONS.animation },
  { key: 'mystery',     g: 'Mystery',     h1: '#7b88ff', h2: '#282e78', icon: ICONS.mystery },
  { key: 'crime',       g: 'Crime',       h1: '#b6bec8', h2: '#333c47', icon: ICONS.crime },
  { key: 'documentary', g: 'Documentary', h1: '#57d495', h2: '#1c6a4f', icon: ICONS.documentary },
  { key: 'family',      g: 'Family',      h1: '#ffb877', h2: '#c95f26', icon: ICONS.family },
  { key: 'war',         g: 'War',         h1: '#c2ac5e', h2: '#544319', icon: ICONS.war },
  { key: 'western',     g: 'Western',     h1: '#e0a25c', h2: '#82441c', icon: ICONS.western },
  { key: 'history',     g: 'History',     h1: '#dcc290', h2: '#836637', icon: ICONS.history },
  { key: 'music',       g: 'Music',       h1: '#ff6ecb', h2: '#831f88', icon: ICONS.music },
];

/* Streaming networks — reuse the provider browse cats behind the home rails. */
const NETWORKS: Cat[] = [
  { key: 'netflix',    label: 'sec.netflix',    to: '/browse/prov_netflix',    h1: '#ff5a5a', h2: '#7a0d12', icon: ICONS.network },
  { key: 'disney',     label: 'sec.disney',     to: '/browse/prov_disney',     h1: '#4fa5ff', h2: '#0b2b6b', icon: ICONS.network },
  { key: 'prime',      label: 'sec.prime',      to: '/browse/prov_prime',      h1: '#5cc6ff', h2: '#0a5a8f', icon: ICONS.network },
  { key: 'apple',      label: 'sec.apple',      to: '/browse/prov_apple',      h1: '#cfd4dc', h2: '#2a2e35', icon: ICONS.network },
  { key: 'max',        label: 'sec.max',        to: '/browse/prov_max',        h1: '#8a6cff', h2: '#2a1f7a', icon: ICONS.network },
  { key: 'paramount',  label: 'sec.paramount',  to: '/browse/prov_paramount',  h1: '#5c94ff', h2: '#12357a', icon: ICONS.network },
  { key: 'crunchyroll',label: 'sec.crunchyroll',to: '/browse/prov_crunchyroll',h1: '#ff8a3d', h2: '#b2461f', icon: ICONS.network },
];

/* One category tile. Renders the gradient + label immediately; its curated
 * backdrop is a static URL (see catArt) so it paints straight from TMDB's CDN
 * with no backend round-trip, fading in on mount via the .catcard-art keyframe. */
function Tile({ c, cls, label }: { c: Cat; cls: string; label: string }) {
  const nav = useNavigate();
  const art = catArt(c.key);
  const hasArt = !!art;

  return (
    <button
      type="button"
      className={hasArt ? `${cls} has-art` : cls}
      style={{ ['--h1' as string]: c.h1, ['--h2' as string]: c.h2 }}
      onClick={() => nav(c.to)}
      aria-label={label}
    >
      {hasArt && (
        <span className="catcard-art" aria-hidden="true">
          <span className="catcard-shot" style={{ backgroundImage: `url("${art}")` }} />
        </span>
      )}
      {hasArt && <span className="catcard-scrim" aria-hidden="true" />}
      <span className="catcard-ico" aria-hidden="true">{c.icon}</span>
      <span className="catcard-body">
        <span className="catcard-name">{label}</span>
        <span className="catcard-go" aria-hidden="true">→</span>
      </span>
      <span className="catcard-sheen" aria-hidden="true" />
    </button>
  );
}

export default function Categories() {
  const t = useT();
  const genreT = useGenre();

  return (
    <section className="page active" id="explore" aria-label={t('page.categories')}>
      <div className="cat-hub">
        <div className="cathub-head">
          <span className="cathub-eyebrow mono">{t('nav.categories')}</span>
          <h1 className="cathub-title display">{t('cathub.title')}</h1>
          <p className="cathub-sub">{t('cathub.sub')}</p>
        </div>

        <div className="cathub-sec">
          <h2 className="cathub-sectitle">{t('cathub.collections')}</h2>
          <div className="cathero-grid">
            {COLLECTIONS.map((c) => (
              <Tile key={c.key} c={c} cls="catcard catcard-lg" label={t(c.label)} />
            ))}
          </div>
        </div>

        <div className="cathub-sec">
          <h2 className="cathub-sectitle">{t('cathub.genres')}</h2>
          <div className="catcard-grid">
            {GENRES.map((c) => (
              <Tile
                key={c.key}
                c={{
                  key: c.key,
                  label: c.g,
                  to: `/explore?genre=${encodeURIComponent(c.g)}`,
                  h1: c.h1,
                  h2: c.h2,
                  icon: c.icon,
                }}
                cls="catcard"
                label={genreT(c.g)}
              />
            ))}
          </div>
        </div>

        <div className="cathub-sec">
          <h2 className="cathub-sectitle">{t('cathub.networks')}</h2>
          <div className="catcard-grid catcard-grid-net">
            {NETWORKS.map((c) => (
              <Tile key={c.key} c={c} cls="catcard catcard-net" label={t(c.label)} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
