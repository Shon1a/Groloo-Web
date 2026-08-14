# GROLOO on webOS (LG TV)

A **shell app**: an icon on the TV's home row that opens `https://web.groloo.com`.
It contains no application code — see the note at the top of `index.html` for why
it navigates rather than bundling or framing the app.

## One-time setup

**1. LG developer account** — register at <https://webostv.developer.lge.com>. Free.

**2. Developer Mode on the TV**
   - LG Content Store → search **Developer Mode** → install → sign in
   - Turn **Dev Mode Status** on. The TV restarts.
   - Reopen it and note the **IP address** and **passphrase** shown on screen.

   > Dev Mode expires after ~50 hours. Reopen the app and press **Extend** before it
   > lapses, or the app is removed from the TV.

**3. LG's CLI on this machine**

```
npm install -g @webos-tools/cli
```

**4. Pair with the TV** (once, or whenever its IP changes)

```
ares-setup-device
```

Add a device, give it a name (e.g. `tv`), the IP from step 2, port `9922`,
user `prisoner`. Then:

```
ares-novacom --device tv --getkey     # asks for the passphrase from the TV screen
```

## Build and install

From the repository root:

```
npm run tv:package      # writes webos/out/com.groloo.web_1.0.0_all.ipk
npm run tv:install      # sends it to the device named `tv`
npm run tv:launch       # opens it
```

Or by hand, if the device is named something else:

```
ares-package webos --outdir webos/out
ares-install --device <name> webos/out/com.groloo.web_1.0.0_all.ipk
ares-launch  --device <name> com.groloo.web
```

To see what the app logs while it runs:

```
ares-inspect --device <name> --app com.groloo.web
```

## Changing what it opens

One line, at the top of the script in `index.html`:

```js
var APP_URL = 'https://tv.groloo.com/';
```

**`tv.`, not `web.`** — `IS_TV` is `import.meta.env.MODE === 'tv'`, a compile-time constant, so
the URL alone decides whether the television gets the TV interface or the desktop site with its
icon rail. `web.groloo.com` serves the desktop build.

Point it at a LAN dev server (`http://192.168.x.x:5173/`) to test an unreleased build on real
hardware, and **put it back before packaging for anyone else.** `lib/api.ts` treats a private
address as local, so the API calls go back through the Vite proxy rather than at the production
backend.

To test a **production** build on the TV instead — which is the only kind worth measuring, the
dev build being roughly 5x slower here — point `APP_URL` at `http://192.168.x.x:4173/` and run
`npx vite preview --mode tv --host`. `vite.config.ts` gives `preview` the same `/api` proxy the
dev server has; without it the built app serves fine and comes up with no rows at all, which
looks like a broken build rather than a missing proxy.

## Notes

- **`resolution` is `1920x1080`, AND THAT IS A DECISION, NOT AN OVERSIGHT. 720p is measurably
  smoother and was chosen against, deliberately, for sharpness.** This entry used to say the
  opposite; if you are about to "fix" the setting back to `1280x720`, read this first.

  Measured on a 65UT81006LA (webOS 24, SDK 10.3.1, Chromium 120, 4 cores, PowerVR B-Series
  BXE-4-32) over the CDP bridge `ares-inspect` opens, walking a poster row:

  | | `1920x1080` | `1280x720` |
  |---|---|---|
  | frames over 33ms | 24–28% | **3.2%** |
  | median frame | 16.7ms | 16.7ms |

  720p wins and nothing here disputes that. **What changed is knowing how little of the gap is
  ours to close.** Three numbers, same set, same session, timestamps taken from rAF's own
  vsync-aligned argument:

  | scene | frames over 33ms |
  |---|---|
  | idle, nothing moving | **0%** (240 of 240 frames at 16.7ms) |
  | ONE grey `<div>` moving on a promoted layer — no React, no images | **18%** |
  | the actual app, walking a row | 24–28% |

  **A single moving rectangle already drops one frame in five at 1080p.** The app adds about six
  to ten points on top of that floor, and the floor is the browser's compositor on this panel —
  not anything in this repo. So the choice is 1080p at ~28% or 720p at ~3%, and there is no third
  option that keeps the sharpness.

  SEVEN APP-SIDE FIXES WERE BUILT AND MEASURED AT 1080p AND NONE OF THEM MOVED IT: eliminating
  forced style recalc, collapsing the billboard fade cascade under a held key, stacking the
  artwork layers instead of cross-fading, throttling the scroller's per-frame `scrollTo`,
  pre-promoting the next row's compositor layers, `content-visibility` on the rows, and releasing
  tile bitmaps when a row scrolls away. Two made things worse. Do not spend a day rediscovering
  them — the working notes are on a git stash labelled "perf investigation: 7 measured dead ends".

  BEWARE TWO MEASUREMENT TRAPS, both of which produced wrong conclusions here. Take frame times
  from the timestamp `requestAnimationFrame` passes its callback, never `performance.now()` read
  inside it — the latter smears vsync-quantised 16.7/33.3ms deltas into a meaningless ~20ms
  median. And restart the app before any A/B, discarding the first run: dropped frames drifted
  from 28% to ~50% over an hour of continuous testing and a relaunch put it straight back, which
  is larger than any effect worth measuring.

  THE OLD `devicePixelRatio` NOTE HERE WAS WRONG. It argued that dpr 2 at 1080p and dpr 3 at 720p
  give the same backing store, so the speedup was unexplained. LG's own spec says the UI plane IS
  the `appinfo.json` resolution and the panel scales it, so 720p really does rasterise 0.92M
  pixels against 1080p's 2.07M. The arithmetic predicts the result fine; the old reading of dpr
  did not.

  THE LAYOUT IS IDENTICAL AT BOTH, so nothing moves if this is ever changed: every dimension on
  the home screen is a proportion of `--spot-h`, itself `26.5vw` (ratio table at the top of
  `tv.css`). `--spot-h` resolves to 339.2px at 720p and 508.8px at 1080p, the section heading to
  20.352px and 30.528px — exactly 1.5x, the same picture at two sizes.

  WHAT 720p COSTS is sharpness: webOS draws on a 720p canvas and the panel scales it, so glyphs
  are slightly softer than if drawn at full size. That is the whole of the trade, and it is the
  reason this app is at 1080p.
- **`disableBackHistoryAPI: true`** hands the Back key to the app instead of letting
  webOS walk history itself. `lib/tvKeys.ts` answers keyCode 461 and steps one layer
  per press; without this, the platform would also navigate and one press would close
  two things.
- **The icons are the app's existing PNGs**, not the 80×80 / 130×130 webOS asks for —
  the launcher scales them. Swap in exact sizes if they look soft on the home row.

## If you want a fully packaged app instead

Copy `dist-tv/*` in beside `appinfo.json` and drop `index.html`. Two things then need
solving, and they are the reason this is a shell:

1. **CORS.** A packaged app's origin is `file://` or `null`, which is not on the API's
   `CORS_ORIGINS` allowlist, so every catalog call fails preflight. The allowlist would
   have to accept it.
2. **The service worker will not run** from packaged files, so the offline cache — the
   thing that keeps the home screen up while a free-tier backend wakes — is off.

What you gain is an app that starts without the network.
