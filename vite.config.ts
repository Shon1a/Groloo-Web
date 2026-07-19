import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/* The urlPattern regexes below are written inline ON PURPOSE. workbox's generateSW mode
 * stringifies each urlPattern function straight into dist/sw.js, so the function body must be
 * self-contained: anything it closes over from this module — a `const PATTERN = /…/` up here —
 * is NOT emitted, and the pattern throws ReferenceError inside the worker. Workbox catches
 * that, the route silently never matches, and the response is never cached. It builds, it
 * typechecks, and it does nothing. Verify with: grep -c 'const.*API' dist/sw.js
 *
 * The two route groups mirror ADMIN_CURATED_GET and PUBLIC_CATALOG_GET in
 * Stredio-server/server/server.js — keep them in step. ONLY routes matched below may be
 * cached. Everything else — /api/auth/*, /api/addons, /api/addon-state, /api/library-state,
 * /api/config — is per-user and must always hit the network: a cached /api/auth/me would hand
 * one person's session to the next user of a shared device. It is an allowlist, so a route
 * added to the API later stays uncached until it is listed here. */

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A new build's service worker takes over on the next load rather than waiting for
      // every tab to close. That also means a bad deploy can be undone by shipping a good
      // one — with 'prompt', users who dismiss the toast stay stuck on the broken version.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // The app shell. Hashed /build/* is safe to precache outright; the unhashed
        // /assets/* names are revisioned by workbox's own content hash.
        // The rail's PNGs used to be listed here too; the rail is all inline SVG components now.
        globPatterns: ['**/*.{js,css,html,woff2,svg,ico,webmanifest}'],
        // Big, rarely-touched, or not needed offline — fetched normally instead.
        globIgnores: ['**/demo.mp4', '**/og-image.jpg', '**/hls.min.js'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Admin-curated. Try the network first so an admin edit still appears on the next
            // load exactly as the server's `no-cache` intends — but give up after 3s and serve
            // the last good copy. That 3s is the whole trick: a sleeping free-tier backend takes
            // 30-60s to wake, so without this the home page is blank for a minute. Live server →
            // fresh data, same as today. Sleeping server → instant page from cache.
            urlPattern: ({ url }) => url.hostname.endsWith('.onrender.com') && /^\/api\/(home|hero)\b/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'stredio-api-curated',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Catalog rows/search/meta. The server already declares these stale-while-revalidate
            // for 24h, so mirror that: serve instantly from cache, refresh in the background. If
            // the backend is cold or down the refresh just fails and the cached copy stands.
            urlPattern: ({ url }) => url.hostname.endsWith('.onrender.com') && /^\/api\/(catalog|search|genres|browse|meta\/|tv\/|introdb\/)/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'stredio-api-catalog',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // TMDB image paths are content hashes — the bytes behind a URL never change.
            urlPattern: ({ url }) => url.origin === 'https://image.tmdb.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'tmdb-images',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Heart WASM + translations + official add-ons. jsDelivr pins @master for ~12h
            // anyway, so revalidating in the background costs nothing and works offline.
            urlPattern: ({ url }) => url.origin === 'https://cdn.jsdelivr.net',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'stredio-cdn',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'STREDIO — Your Personal Media Library',
        short_name: 'STREDIO',
        description: 'Discover, organise and play your media library.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/assets/stredio-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/assets/stredio-icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/assets/stredio-icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    // Mirrors the "paths" entry in tsconfig.app.json — keep the two in step.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Hashed build output lands in /build/*; public/ is copied verbatim to /assets/*.
    // They must stay in separate folders: /build/* filenames carry a content hash and
    // can be cached forever, /assets/* names never change and must not be. vercel.json
    // sets one rule per folder — merging them back into /assets would freeze the rail
    // icons at whatever version shipped first.
    assetsDir: 'build',
  },
  server: {
    // Dev proxy: /api/* → the live backend, server-side, so the browser makes a
    // same-origin request and CORS never applies. Lets `npm run dev` show real
    // catalog data without running the Express server locally. In production the
    // app talks to the backend directly (see src/lib/api.ts API_BASE).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
