/* IS THIS BUILD THE ONE THAT LIVES INSIDE THE webOS PACKAGE, and where do its files live?
 *
 * `VITE_TV_PACKAGED` is set by scripts/build-tv-pack.mjs and inlined by Vite, so `IS_PACKAGED`
 * is a compile-time constant: the streamed TV build and the website fold every branch on it away.
 * See the note on `packagedTv` in vite.config.ts for what the packaged build changes.
 *
 * THE ONE THING THAT DIFFERS AT RUNTIME is where the app's own files are. On the web every
 * public asset is root-absolute (`/assets/…`), and Vite rewrites the references it can see in
 * index.html and the stylesheets to `./assets/…` for the package. It cannot see a path inside a
 * string in JavaScript — the WASM core, the hls.js loader, the Dolby decoder — and those used to
 * be the root-absolute string, which from a packaged document resolves to `file:///assets/…` and
 * does not exist. `asset()` is the one way to spell such a path: it prefixes Vite's `BASE_URL`
 * (`/` on the web, `./` in the package) and resolves against the DOCUMENT, not the calling
 * module — the chunks live one folder down in `build/`, so a module-relative `./assets` would be
 * wrong from every chunk. On the web the result is the same absolute URL the string always was. */
export const IS_PACKAGED = import.meta.env.VITE_TV_PACKAGED === '1';

/** An absolute URL for one of the app's own files, given its root-absolute path (`/assets/…`). */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const rel = base.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
  if (!IS_PACKAGED) return rel;
  return new URL(rel, document.baseURI).href;
}

/* THE ORIGIN THE STREAMED TV BUILD IS SERVED FROM, for the few things the package deliberately
 * does not carry: the 32 MB Dolby decoder (AC-3 / DTS audio only), which lib/wasmAudio.ts
 * fetches on demand. It is the same address webos/index.html points the shell at, and it must
 * answer with `Access-Control-Allow-Origin` for those paths, because a packaged document has an
 * opaque origin — see vercel.json. */
export const WEB_ORIGIN = 'https://tv.groloo.com';
