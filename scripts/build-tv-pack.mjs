/* BUILD THE PACKAGED TV APP — the whole application inside the IPK, not a redirect to it.
 *
 *   node scripts/build-tv-pack.mjs             build dist-tv-pack/ and stage webos-pack/app/
 *   node scripts/build-tv-pack.mjs --ipk       … and run ares-package on it
 *
 * WHAT IT PRODUCES. `dist-tv-pack/` is `vite build --mode tv` with `VITE_TV_PACKAGED=1` (see
 * vite.config.ts for the three things that changes), and `webos-pack/app/` is that output beside a
 * copy of `webos/appinfo.json` and the icons — the directory `ares-package` turns into an IPK. The
 * appinfo is copied, not shared: the shell package in `webos/` keeps its own file, and the two must
 * be free to differ (the packaged app's `main` is the real index.html; a future field one needs and
 * the other does not goes here).
 *
 * WHY A SCRIPT AND NOT A `--mode`. `import.meta.env.MODE === 'tv'` is the compile-time switch the
 * entire TV build hangs off, so the packaged variant has to be the same mode with one extra
 * variable — and that variable has to be set the same way on Windows, in Git Bash and in CI, which
 * is what `process.env` from Node gives and `VAR=1 npm run …` does not.
 *
 * WHAT IT DOES NOT DO: install. `npm run tv:install:pack` / `tv:launch` are the same ares commands
 * the shell uses, and the shared television is never touched from here. */
import { build } from 'vite';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist-tv-pack');
const STAGE = join(ROOT, 'webos-pack');
const APP = join(STAGE, 'app');

process.env.VITE_TV_PACKAGED = '1';

/* The same pre-step `npm run build:tv` runs (the Dolby decoder is copied into public/ffmpeg). */
execSync('node scripts/copy-ffmpeg.mjs', { cwd: ROOT, stdio: 'inherit' });

await build({ configFile: join(ROOT, 'vite.config.ts'), mode: 'tv' });

if (!existsSync(join(DIST, 'index.html'))) throw new Error('vite build produced no dist-tv-pack/index.html');

/* ---- STAGE THE PACKAGE ------------------------------------------------------------------------
 * ares-package wants one directory holding appinfo.json, the icons it names and the app. The
 * 32 MB Dolby decoder under ffmpeg/ is left OUT: it exists for AC-3/DTS files, is fetched lazily
 * from the web origin by lib/wasmAudio.ts when it is ever needed, and would quadruple the IPK for
 * something most sets never open. Same for the old Heart core — nothing in the app imports it. */
await rm(STAGE, { recursive: true, force: true });
await mkdir(APP, { recursive: true });
await cp(DIST, APP, {
  recursive: true,
  filter: (src) => !/[\\/](ffmpeg|assets[\\/]heart)([\\/]|$)/.test(src) && !/[\\/]demo\.mp4$/.test(src),
});
const appinfo = JSON.parse(await readFile(join(ROOT, 'webos', 'appinfo.json'), 'utf8'));
/* `main` is the built index, and the package must not carry the shell's offline card. Everything
 * else — id, title, icons, resolution, back-key and relaunch behaviour — is the shell's, verbatim,
 * so the two packages are the same app to the launcher. */
appinfo.main = 'index.html';
await writeFile(join(APP, 'appinfo.json'), JSON.stringify(appinfo, null, 2) + '\n');
for (const icon of [appinfo.icon, appinfo.largeIcon].filter(Boolean)) {
  await cp(join(ROOT, 'webos', icon), join(APP, icon));
}
console.log(`staged ${APP}`);

if (process.argv.includes('--ipk')) {
  const out = join(STAGE, 'out');
  await mkdir(out, { recursive: true });
  /* --no-minify: ares-package runs its own, older minifier over every script by default, and it
   * cannot parse the syntax Vite has already minified (it fails on the codecs chunk). The bundle
   * is minified; the CLI has nothing to add. */
  execSync(`ares-package --no-minify "${APP}" --outdir "${out}"`, { stdio: 'inherit' });
}
