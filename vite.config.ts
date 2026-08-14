import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import postcss from 'postcss'
import { execSync } from 'node:child_process'

/* ---- THE TV STYLESHEET DIET ------------------------------------------------------------------
 *
 * WHAT THIS IS FOR. The TV build loads the whole desktop stylesheet (app.css, 136 KB compiled) and
 * then a TV sheet on top of it (74 KB) that spends much of its length overriding what the first one
 * just said. A large part of app.css cannot match on a television at all, and the engine still has
 * to parse it, build the rules and keep them in the cascade.
 *
 * DONE AS A BUILD TRANSFORM RATHER THAN BY EDITING THE STYLESHEETS, and that is the whole design:
 *   · THE DESKTOP BUILD IS BYTE-IDENTICAL. The plugin is only in the plugin list for `--mode tv`,
 *     so nothing about the website can change — which matters because there is no visual regression
 *     suite to prove otherwise, the same reason Lightning CSS is TV-only below.
 *   · NOTHING IS DELETED FROM SOURCE, so a rule that turns out to be needed comes back by changing
 *     one predicate here rather than by recovering it from git.
 *
 * WHAT IT REMOVES, and why each is safe:
 *   · `:hover` SELECTORS, from app.css only. A D-pad has no pointer, and TvSpotlight's header states
 *     the position outright — "NOTHING RESPONDS TO HOVER, deliberately... The remote — focus — is
 *     the only thing that drives this component." Only the hover selector is dropped from a list, so
 *     `a:hover, a:focus { }` keeps its focus half; the rule goes only when nothing is left.
 *   · MOBILE-ONLY MEDIA BLOCKS. A television reports 1920 CSS px wide, so a block gated on
 *     `max-width: 1024px` or narrower can never apply. Anything carrying a `min-width` is left
 *     alone, because a range query can still match.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: tv.css (every rule there was written FOR this screen),
 * `@media (hover: hover)` (an LG Magic Remote really does present a pointer), and keyframes (walked
 * by `walkRules` but their selectors are percentages, so the hover filter never matches them).
 *
 * HONEST ABOUT THE SIZE OF THE WIN: this is a startup-parse and memory saving, not a smoothness fix.
 * Stylesheet bulk was A/B'd on this hardware before and came back null for per-press cost — see the
 * dist-tv-BASE / -ALL / -NOFAST builds. It is included because it is free and measurable, not
 * because it is expected to move a frame time. */
const MOBILE_MAX_PX = 1024;

function tvCssDiet(): Plugin {
  let removedRules = 0;
  let removedMedia = 0;
  return {
    name: 'groloo-tv-css-diet',
    /* `pre`, so this sees the raw stylesheet before Vite's own CSS pipeline (and, in TV mode,
       Lightning CSS) gets it. */
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      /* app.css ONLY. tv.css is the sheet written for this screen; running a diet over it would be
         removing the thing being kept. */
      if (!id.includes('app.css')) return null;
      const root = postcss.parse(code, { from: id });
      root.walkAtRules('media', (at) => {
        const p = at.params;
        if (/min-width/i.test(p)) return;
        const m = p.match(/max-width:\s*(\d+)px/i);
        if (m && Number(m[1]) <= MOBILE_MAX_PX) { removedMedia++; at.remove(); }
      });
      root.walkRules((rule) => {
        if (!rule.selector.includes(':hover')) return;
        const kept = rule.selectors.filter((s) => !s.includes(':hover'));
        if (!kept.length) { removedRules++; rule.remove(); return; }
        rule.selectors = kept;
      });
      this.info?.(`tv css diet: dropped ${removedRules} hover-only rules, ${removedMedia} mobile media blocks`);
      return { code: root.toString(), map: null };
    },
  };
}

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
/* ---- WHAT BUILD IS THIS, EXACTLY ------------------------------------------------------------
 *
 * THE PROBLEM THIS SOLVES, and it is not hypothetical. The packaged webOS app loads
 * https://tv.groloo.com, which serves whatever was last DEPLOYED. A local build is served from this
 * PC's LAN address. Both render the same app, the same rows, the same artwork — and a measurement
 * taken against the wrong one is not merely useless, it is actively misleading, because it looks
 * exactly like a change that did nothing. There is no way to tell the two apart from the screen.
 *
 * So the build stamps itself: the commit it came from, whether the tree was dirty when it was
 * built, and when. `git describe`-style identity is deliberately NOT used — a dirty tree is the
 * normal state during this work, and the flag matters more than the tag.
 *
 * Resolved at CONFIG time, not import time, so it is a literal in the bundle and costs nothing at
 * runtime. Wrapped in try/catch because a build from a tarball with no .git must still succeed. */
function buildStamp(mode: string) {
  const run = (cmd: string) => {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return ''; }
  };
  const commit = run('git rev-parse --short HEAD') || 'nogit';
  /* `--quiet` exits non-zero when the tree differs, which `run` turns into ''. Both tracked-file
   * changes and staged ones count; untracked files deliberately do not, since new measurement
   * scripts appearing should not mark the APP as modified. */
  const dirty = run('git diff --quiet && git diff --cached --quiet && echo clean') !== 'clean';
  return {
    commit,
    dirty,
    at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    mode,
  };
}

export default defineConfig(({ mode }) => ({
  /* Injected as literals; see buildStamp above for why this exists at all. */
  define: {
    __GROLOO_BUILD__: JSON.stringify(buildStamp(mode)),
  },
  plugins: [
    react(),
    /* TV ONLY, so the website's stylesheet is provably untouched. See tvCssDiet above. */
    ...(mode === 'tv' ? [tvCssDiet()] : []),
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
        // `wasm` is here for the vendored Rust core under /assets/groloo-core/<build>/. It is
        // served from our own origin, so it matches no runtime route at all and the precache is
        // the only thing keeping it available offline. `**/*.js` already swept up the glue
        // script, and that half is the dangerous one: the glue loads happily from cache, then
        // mod.default() reaches for groloo_core_bg.wasm, misses, and the whole core drops to the
        // JS fallback with coreStatus.stage === 'instantiate' — a degradation that never
        // reproduces online. Both files must appear in: grep -o 'groloo-core[^"]*' dist/sw.js.
        // Size matters here as well: workbox drops anything above its 2 MiB
        // maximumFileSizeToCacheInBytes default from the manifest with only a build-log warning,
        // and a core that grows past it would fail exactly the same silent way. Today's is 435 KB.
        globPatterns: ['**/*.{js,css,html,woff2,svg,ico,webmanifest,wasm}'],
        // Big, rarely-touched, or not needed offline — fetched normally instead.
        //
        // /assets/heart/ IS THE OLD CORE AND NO APPLICATION CODE IMPORTS IT — but it is NOT dead,
        // and deleting it breaks a gate in another repository. It is the pre-groloo-core Heart
        // build, and `Groloo-Heart/tests/differential` loads it as the OLD side of the comparison
        // (see cores.mjs `OLD_DIR`); with the folder gone that suite refuses to run at all, which
        // is how this was found — `grep -rn "assets/heart" src/` is clean and says nothing about
        // it, because the consumer is a test harness in a sibling checkout. DO NOT DELETE.
        //
        // The precache is a different question and the ignore below is still the answer to it:
        // the js/wasm globPattern above matches this folder on name alone, so without the entry
        // every first visit downloads and stores 277 KB (a 244 KB .wasm plus its glue) for a
        // module the app can never instantiate. Kept out of the precache, kept on disk.
        /* THE LAST ENTRY IS THE DOLBY DECODER, AND THE BUILD FAILS WITHOUT IT.
         * It is 32 MB — sixteen times workbox's 2 MiB per-asset limit — and unlike the
         * silent drop described above, an asset that large makes `generateSW` throw and the
         * whole `vite build` fails. Precaching it would be wrong even if it were allowed:
         * it exists for AC-3/DTS files only, most visitors never open one, and forcing 32 MB
         * onto every first visit to serve a minority is the opposite of what lazy-loading
         * it in `lib/wasmAudio.ts` is for. Excluded here, fetched on demand. */
        /* ---- WHAT A TELEVISION DOWNLOADS BEFORE IT CAN SHOW ANYTHING ----------------------------
         *
         * The precache is the app shell, and on the TV build it had quietly become the whole app:
         * 50 entries, 1,903 KiB, fetched and stored before the first screen is usable. The largest
         * single entry is the VideoPlayer chunk at 573 KB — a bundle nobody needs until they press
         * OK on a stream, downloaded on every first launch and after every update, over whatever
         * connection the set has.
         *
         * The route chunks below are all `React.lazy`, so nothing imports them at launch. Kept OUT
         * of the precache and picked up by the hashed-asset runtime rule instead: the first time one
         * is actually opened it is fetched once and cached forever, because the filename carries a
         * content hash and therefore never changes meaning.
         *
         * DELIBERATELY STILL PRECACHED: `index`, `i18n` and `queries`. All three are on the launch
         * path — the home screen cannot render without them — so excluding them would trade a
         * smaller precache for a slower first paint, which is the opposite of the point.
         *
         * WEB IS UNCHANGED. A browser fetches these over a fast connection against a warm HTTP
         * cache, and the offline story there is a nicety rather than the difference between an app
         * that starts and one that does not. */
        globIgnores: [
          '**/demo.mp4', '**/og-image.jpg', '**/hls.min.js', '**/assets/heart/**', '**/ffmpeg/**',
          ...(mode === 'tv' ? [
            '**/build/VideoPlayer-*.js',
            '**/build/Settings-*.js',
            '**/build/Addons-*.js',
            '**/build/Terms-*.js',
            '**/build/Legal-*.js',
            '**/build/Attributions-*.js',
            '**/build/DeleteAccount-*.js',
            '**/build/Link-*.js',
            '**/build/Explore-*.js',
            /* THE PERFORMANCE PROBE. It is a development tool that a normal launch never even
             * fetches (main.tsx reads the flag before importing it), and precaching it would have
             * every television download the one chunk it is guaranteed not to run. Caught by
             * reading the generated manifest rather than by reasoning about it. */
            '**/build/tvPerf-*.js',
          ] : []),
        ],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            /* THE LAZY ROUTE CHUNKS THE PRECACHE NO LONGER CARRIES (see globIgnores above).
             *
             * CacheFirst is the correct handler and the filename is why: everything under /build/
             * carries a content hash, so a given URL's bytes can never change. There is nothing to
             * revalidate — a new build produces a new name, which is a cache miss and a fresh
             * download by construction. Checking the network first would spend a round trip on a
             * television to re-confirm bytes that are immutable by definition.
             *
             * The expiry is a floor on storage, not a freshness policy: old hashes stop being
             * requested the moment a new build ships, and this sweeps them up eventually. */
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/build\/.*\.(js|css)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'groloo-lazy-chunks',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
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
    /* THE TARGET IS SETTABLE, because the two things this proxy is for want different ones, and
     * THE DEPLOYED API IS THE DEFAULT because only one of them is the common case. Working on
     * the FRONTEND — a TV layout, say — means you want the real catalog and do not want to run a
     * backend or hold a TMDB key at all, and pointing this at the deployed API is the whole
     * reason it goes through a server-side proxy rather than being fetched directly: the
     * browser's request stays same-origin, so Render's CORS allowlist (which does not contain
     * localhost, and should not) never gets a say.
     *
     * The local Express used to be the default, and the failure was silent in the worst way:
     * with nothing listening on 8787 every catalog call 502s, and the home screen still RENDERS
     * — the Studios row is a hardcoded list, so the page comes up looking merely empty rather
     * than broken. Diagnosing that costs more than the flag it saves.
     *
     * Working ON the backend is the other case, and it is one variable away:
     *
     *   $env:API_PROXY = "http://127.0.0.1:8787"; npm run dev:tv     (PowerShell)
     *   API_PROXY=http://127.0.0.1:8787 npm run dev:tv               (bash)
     *
     * TWO THINGS TO EXPECT FROM THE DEFAULT. Render spins the instance down when it is idle, so
     * the first request after a quiet spell wakes it and can 502 once or twice before it
     * answers. And sign-in will not survive the trip — the session cookie is issued for the
     * backend's own domain — though everything the catalog serves does. */
    proxy: {
      '/api': {
        target: process.env.API_PROXY || 'https://groloo-server.onrender.com',
        changeOrigin: true,
        secure: true,
      },
      /* The LOCAL streaming server, proxied for one reason: its CORS allowlist.
       *
       * It re-serves a downloaded file as HLS with one audio rendition per track — which is
       * the only way a browser gets audio-track switching, and how the reference web client does it in the
       * same Chrome that has no `HTMLMediaElement.audioTracks`. But it answers
       * `Access-Control-Allow-Origin` only for its vendor's own origins:
       *
       *   Origin: https://web.stremio.com  ->  Access-Control-Allow-Origin: *
       *   Origin: http://localhost:5174    ->  (nothing)
       *
       * Measured against the server on this machine, v4.20.17. So the browser cannot talk to
       * it from this app directly, however local it is. Going through the dev server makes the
       * request same-origin and CORS never applies — the same trick, and the same reasoning,
       * as the /api proxy above.
       *
       * DEV ONLY, AND THAT IS A REAL LIMIT, not an oversight: in production the page is served
       * from groloo's host, which cannot reach the viewer's own 127.0.0.1. Shipping this
       * beyond dev needs a helper on the viewer's machine that sets permissive CORS itself —
       * see lib/streamingServer.ts. */
      '/streaming-server': {
        target: process.env.STREMIO_SERVER || 'http://127.0.0.1:11470',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/streaming-server/, ''),
      },
    },
  },
  /* `vite preview` GETS THE SAME PROXY, and that is what makes a PRODUCTION build testable on the
   * television at all.
   *
   * `server.proxy` applies to the dev server only, so `vite preview` served the built app with no
   * `/api` route — every catalog call 404'd and the home screen came up with no rows. The failure
   * looks like a broken build rather than a missing proxy, which is what made it worth writing
   * down: the page renders, it is just empty.
   *
   * It matters because the dev server is NOT a place to judge performance — React's dev build is
   * roughly 5x off on this hardware, and nearly all of the error is `jsxDEV` plus StrictMode
   * double-rendering. Measuring a change means serving the real build, and serving the real build
   * on the LAN means this. Point `APP_URL` in webos/index.html at this machine's `:4173`, run
   * `npx vite preview --mode tv --host`, and the set loads the same bytes a user would. */
  preview: {
    proxy: {
      '/api': {
        target: process.env.API_PROXY || 'https://groloo-server.onrender.com',
        changeOrigin: true,
        secure: true,
      },
      '/streaming-server': {
        target: process.env.STREMIO_SERVER || 'http://127.0.0.1:11470',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/streaming-server/, ''),
      },
    },
  },
}))
