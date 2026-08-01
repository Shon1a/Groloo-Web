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
 * Groloo-server/server/server.js — keep them in step. ONLY routes matched below may be
 * cached. Everything else — /api/auth/*, /api/addons, /api/addon-state, /api/library-state,
 * /api/config — is per-user and must always hit the network: a cached /api/auth/me would hand
 * one person's session to the next user of a shared device. It is an allowlist, so a route
 * added to the API later stays uncached until it is listed here. */

/* THE TV BUILD — `vite build --mode tv`.
 *
 * webOS runs a web engine and nothing else, so the LG app is this same React tree loaded
 * from a URL rather than a separate program. The only thing that makes it a *TV* build is
 * the browser floor it is compiled down to, and today's default is the reason the app does
 * not start on most LG sets at all.
 *
 * THE FLOOR IS webOS 22 = CHROMIUM 87, and it is a decision rather than a guess:
 *   webOS 22 → Chromium 87      ← the floor
 *   webOS 23 → 94, 24 → 108, 25 → 120, 26 → 132
 *   webOS 6.x → 79, and 4.x → 53, which predates WebAssembly entirely
 * 6.x and below are out of scope: they buy negligible installed base and cost
 * @vitejs/plugin-legacy plus core-js, and 4.x cannot run the core under any configuration.
 *
 * Vite 8 defaults `build.target` to `baseline-widely-available`, which is chrome111. That
 * is not a performance nicety — it is a hard SyntaxError before a single line executes on
 * webOS 22, 23 AND 24, because the parser meets syntax it does not know. Black screen, no
 * error surface, nothing in a log the user can reach. `Object.hasOwn` is Chromium 93 and
 * `toSorted` is 110, both of which the default happily emits.
 *
 * THE SAME FLOOR BINDS ANDROID TV, and that is deliberate. The Android app is a WebView
 * shell around this identical bundle, and Play-certified devices run a current Android
 * System WebView — roughly 60+ milestones ahead of Chromium 87. So the harder platform
 * solves the easier one for free: a bundle that satisfies webOS satisfies every Android TV
 * WebView by construction, and the reverse is not true. The cost is that the newer
 * WebView's capability goes deliberately unused on both. That is what "the two TV apps look
 * the same" actually costs, and it is the same fact as the guarantee.
 *
 * DESKTOP IS UNTOUCHED. The default build keeps Vite's modern target — there is no reason
 * to serve a browser from 2020 to a browser from this year, and lowering the web build
 * would pay the TV's cost on every visitor. Two modes, one source tree.
 */
const TV_TARGET = ['chrome87'];

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
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
        //
        // `wasm` is here for the vendored Heart core under /assets/heart/<ver>/. While the core
        // still came off jsDelivr it was kept offline by the CDN runtime-cache route below;
        // serving it from our own origin means it matches no runtime route at all, so the
        // precache is now the only thing keeping it available. `**/*.js` already swept up the
        // glue script, and that half is the dangerous one: the glue loads happily from cache,
        // then mod.default() reaches for groloo_heart_bg.wasm, misses, and the whole core drops
        // to the JS fallback with heartStatus.stage === 'instantiate' — a degradation that never
        // reproduces online. Both files must appear in: grep -o 'heart[^"]*' dist/sw.js.
        // Size matters here as well: workbox drops anything above its 2 MiB
        // maximumFileSizeToCacheInBytes default from the manifest with only a build-log warning,
        // and a core that grows past it would fail exactly the same silent way. Today's is 238 KB.
        globPatterns: ['**/*.{js,css,html,woff2,svg,ico,webmanifest,wasm}'],
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
              cacheName: 'groloo-api-curated',
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
              cacheName: 'groloo-api-catalog',
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
            // Translations + official add-ons only — the Heart core left this route when it was
            // vendored same-origin and is precached above instead. Both remaining consumers now
            // pin a full commit sha in the path (see src/i18n/i18n.tsx and src/stores/official.ts),
            // so every URL here is immutable: new content arrives as a new URL, never as new bytes
            // behind an old one. That makes the cached copy always correct — serve it instantly,
            // cold backend or no network — and reduces the background revalidation to a formality.
            // The expiry is not freshness control, it is housekeeping: it evicts the entries left
            // stranded by a sha bump, which nothing would otherwise ever ask for again.
            urlPattern: ({ url }) => url.origin === 'https://cdn.jsdelivr.net',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'groloo-cdn',
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
        name: 'GROLOO — Your Personal Media Library',
        short_name: 'GROLOO',
        description: 'Discover, organise and play your media library.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/assets/groloo-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/assets/groloo-icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/assets/groloo-icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    // Mirrors the "paths" entry in tsconfig.app.json — keep the two in step.
    alias: {
      /* ORDER IS LOAD-BEARING: Vite tries alias entries IN ORDER and takes the first match,
       * and '@' is a prefix of every path below it. With '@' first this entry never fired —
       * '@/layout/RailBar' resolved through the general rule to the real component and the
       * TV bundle was byte-identical (358.16 kB either way). Specific before general. */
      /* THE DESKTOP RAIL IS ALIASED AWAY IN THE TV BUILD, and this is the only thing that
       * actually keeps its animated glyphs out of dist-tv.
       *
       * AppShell already renders it behind `{!IS_TV && <RailBar …/>}`, and that gate does
       * remove the markup — `railbar`, `rail-item` and `rail-pill` are all absent from the TV
       * bundle without this line. What it does NOT remove is the seven glyph MODULES behind
       * it: each is a top-level `forwardRef(...)` call plus a `displayName` assignment, which
       * rollup will not treat as side-effect-free, so the module survives its last importer
       * being eliminated. Verified by grep: `ico-home-door` — a keyframe belonging to a glyph
       * that exists only on this rail — was still in dist-tv. `/*#__PURE__*​/` annotations on
       * the forwardRef calls were tried and changed nothing, hash-for-hash.
       *
       * Measured: 5.12 kB raw / ~1 kB gzip of animated icon code the TV never renders. The
       * bigger point is the runtime one — those glyphs animate on mouseenter, and a Magic
       * Remote IS a pointer, so on a TV they are a transform animation nobody asked for. See
       * TvTopNav (which now draws its two glyphs as inert SVG) and section 4 of tv.css.
       *
       * Web builds resolve the real component; only `--mode tv` gets the null stub. */
      ...(mode === 'tv'
        ? { '@/layout/RailBar': fileURLToPath(new URL('./src/layout/RailBar.tv.tsx', import.meta.url)) }
        : {}),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /* LIGHTNING CSS, TV MODE ONLY — because `build.cssTarget` alone does nothing here.
   *
   * Measured, not assumed: with `cssTarget: ['chrome87']` and esbuild's default CSS
   * pipeline, the TV stylesheet came out byte-identical to the web one. esbuild's CSS
   * downlevelling covers syntax like nesting; it does not rewrite `color-mix()`. Lightning
   * CSS does, against a real browser-support database.
   *
   * This closes the mechanical half of the gap. It cannot close the other half: `:has()`,
   * `@container` and `dvh` have no downlevelled equivalent in any tool, because there is
   * nothing to compile them TO — they are capabilities, not syntax. Those need hand edits
   * with fallbacks, tracked as their own task.
   *
   * Web mode is left on the default pipeline deliberately. Turning Lightning CSS on for
   * both would change the bytes served to every website visitor for the benefit of a
   * platform none of them are using, and this project has no visual regression suite yet
   * to prove that change was invisible. */
  ...(mode === 'tv' ? {
    css: {
      transformer: 'lightningcss' as const,
      lightningcss: { targets: { chrome: 87 << 16 } },
    },
  } : {}),
  build: {
    // Hashed build output lands in /build/*; public/ is copied verbatim to /assets/*.
    // They must stay in separate folders: /build/* filenames carry a content hash and
    // can be cached forever, /assets/* names never change and must not be. vercel.json
    // sets one rule per folder — merging them back into /assets would freeze the rail
    // icons at whatever version shipped first.
    assetsDir: 'build',
    // See the TV BUILD note at the top of this file. Both halves are required and they
    // fail differently: `target` misses are a SyntaxError at parse (nothing runs at all),
    // `cssTarget` misses are silent — the rule is simply dropped and the layout quietly
    // renders wrong, which is the harder of the two to notice on a TV nobody is holding.
    ...(mode === 'tv' ? { target: TV_TARGET, cssTarget: TV_TARGET } : {}),
    // A separate folder so a TV build can never overwrite the web build that is about to
    // be deployed to Vercel, and so both can exist at once during a comparison.
    ...(mode === 'tv' ? { outDir: 'dist-tv' } : {}),
  },
  server: {
    // Dev proxy: /api/* → the live backend, server-side, so the browser makes a
    // same-origin request and CORS never applies. Lets `npm run dev` show real
    // catalog data without running the Express server locally. In production the
    // app talks to the backend directly (see src/lib/api.ts API_BASE).
    /* THE TARGET IS SETTABLE, because the two things this proxy is for want different ones.
     * Working ON the backend means the local Express on 8787, which is the default and is
     * unchanged. Working on the FRONTEND — a TV layout, say — means you want the real catalog
     * and do not want to run a backend or hold a TMDB key at all, and pointing this at the
     * deployed API is the whole reason it goes through a server-side proxy rather than being
     * fetched directly: the browser's request stays same-origin, so Render's CORS allowlist
     * (which does not contain localhost, and should not) never gets a say.
     *
     *   API_PROXY=https://groloo-server.onrender.com npm run dev:tv
     *
     * Sign-in will not survive the trip — the session cookie is issued for the backend's own
     * domain — but everything the catalog serves does. */
    proxy: {
      '/api': {
        target: process.env.API_PROXY || 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: true,
      },
    },
  },
}))
