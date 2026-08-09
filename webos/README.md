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
var APP_URL = 'https://web.groloo.com/';
```

Point it at a LAN dev server (`http://192.168.x.x:5173/`) to test an unreleased build
on real hardware. `lib/api.ts` treats a private address as local, so the API calls go
back through the Vite proxy rather than at the production backend.

## Notes

- **`resolution` is `1280x720`.** That is what the TV build's CSS is written against
  (see the note at the top of `vite.config.ts`); the panel scales it.
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
