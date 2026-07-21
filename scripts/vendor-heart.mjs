// Re-vendor the groloo-core WASM artifact into public/assets/groloo-core/<build>/.
//
// Usage:
//   node scripts/vendor-heart.mjs                  # from github.com/Shon1a/groloo-core@main
//   node scripts/vendor-heart.mjs <ref>            # …at a branch/tag/sha
//   node scripts/vendor-heart.mjs --from <dir>     # from a local build output
//
// The filename still says "heart" because a dozen call sites import from './heart' and
// renaming files is not what this change is about; the core it vendors is the successor
// crate, github.com/Shon1a/groloo-core.
//
// The core is EXECUTABLE code loaded into the origin that holds the session, so it is
// never fetched from a CDN at runtime — see the header of src/lib/heart.ts. This script
// exists so that keeping it current stays a one-command chore instead of a reason to
// quietly go back to a mutable @master ref: it resolves the ref to a concrete commit,
// downloads the artifact from that exact commit, proves the bytes, and prints the three
// lines to paste into heart.ts. Nothing is written to src/ — bumping the version stays a
// deliberate, reviewable edit by a human.
//
// --from exists because a local build is currently the ONLY way to get an artifact: the
// groloo-core repo has no published commit yet. It is not a lax path — every check below
// runs on local bytes too, minus the two (HTTP status, content type) that only mean
// something over the wire. Produce the input with the repo's own sanctioned build:
//
//     bash .github/scripts/build-wasm.sh <dir>
//
// Node built-ins only, on purpose: this must run in CI or on a clean checkout with no
// install step. Requires Node 18+ for global fetch.
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'Shon1a/groloo-core';
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(WEB_ROOT, 'public', 'assets', 'groloo-core');

// The .js glue resolves the .wasm relative to its own import.meta.url, so the pair must
// land in one folder together AND KEEP THEIR NAMES — renaming the .wasm breaks a
// reference baked into the glue. Both basenames are accepted because `--out-name` is a
// build-time choice: the repo's CI commits `groloo_core_wasm*`, its differential harness
// builds `groloo_core*`, and either is a legitimate thing to ship.
//
// minBytes is the smallest size that file could plausibly have — the real core is ~350 KB
// and the glue ~24 KB, so these are floors, not estimates: anything under them is a
// truncated transfer or an error body, never a working build.
const NAMES = ['groloo_core', 'groloo_core_wasm'];
const MIN_JS = 8 * 1024;
const MIN_WASM = 100 * 1024;

const die = (msg) => { console.error(`vendor-heart: ${msg}`); process.exit(1); };

async function http(url, as) {
  const r = await fetch(url);
  if (!r.ok) die(`${r.status} ${r.statusText} for ${url}`);
  // The content type comes back with the body because the caller has to see it: a CDN that
  // answers a bad path with a 200 + HTML error page is the one failure mode that survives
  // every other check by looking like a successful download.
  const type = r.headers.get('content-type') ?? '';
  const body = as === 'buffer' ? Buffer.from(await r.arrayBuffer()) : await r.text();
  return { body, type };
}

/* ── where the bytes come from ─────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const localDir = fromIdx >= 0 ? args[fromIdx + 1] : null;
if (fromIdx >= 0 && !localDir) die('--from needs a directory');

/** @returns {{ name: string, js: Buffer, wasm: Buffer, provenance: string }} */
async function collect() {
  if (localDir) {
    const present = new Set(await readdir(localDir).catch(() => die(`cannot read ${localDir}`)));
    const name = NAMES.find((n) => present.has(`${n}.js`) && present.has(`${n}_bg.wasm`));
    if (!name) die(`${localDir} holds no <${NAMES.join('|')}>.js + _bg.wasm pair (found: ${[...present].join(', ') || 'nothing'})`);
    return {
      name,
      js: await readFile(join(localDir, `${name}.js`)),
      wasm: await readFile(join(localDir, `${name}_bg.wasm`)),
      provenance: `local build ${localDir}`,
    };
  }

  // Resolve whatever was asked for to a full sha FIRST. Passing a branch straight through
  // to jsDelivr would defeat the whole point: the folder has to name one immutable set of
  // bytes, otherwise `git status` looks clean while the vendored artifact drifts.
  const ref = args.find((a) => !a.startsWith('--') && a !== localDir) || 'main';
  const commit = JSON.parse((await http(`https://api.github.com/repos/${REPO}/commits/${ref}`)).body);
  const sha = commit?.sha;
  if (typeof sha !== 'string' || sha.length !== 40) die(`could not resolve ref '${ref}' to a commit`);
  const base = `https://cdn.jsdelivr.net/gh/${REPO}@${sha}/pkg`;

  for (const name of NAMES) {
    const probe = await fetch(`${base}/${name}.js`);
    if (!probe.ok) continue;
    const js = await http(`${base}/${name}.js`, 'buffer');
    const wasm = await http(`${base}/${name}_bg.wasm`, 'buffer');
    for (const [file, got] of [[`${name}.js`, js], [`${name}_bg.wasm`, wasm]]) {
      if (/html|xml/i.test(got.type)) {
        die(`${file} came back as '${got.type}', not a build artifact — the path is probably wrong (body starts "${got.body.subarray(0, 120).toString('utf8')}")`);
      }
    }
    return { name, js: js.body, wasm: wasm.body, provenance: `${REPO}@${sha}` };
  }
  die(`no pkg/<${NAMES.join('|')}>.js at ${REPO}@${sha} — has the artifact been committed?`);
}

/* ── prove the bytes ───────────────────────────────────────────────────────────── */

const { name, js, wasm, provenance } = await collect();

// Four cheap checks before the expensive one, because each catches a different lie: the
// byte floors catch a truncated or empty transfer, and the magic number / glue marker
// catch a body that is the wrong artifact entirely.
if (js.length < MIN_JS) die(`${name}.js is only ${js.length} bytes (expected at least ${MIN_JS}) — truncated or an error body`);
if (wasm.length < MIN_WASM) die(`${name}_bg.wasm is only ${wasm.length} bytes (expected at least ${MIN_WASM}) — truncated or an error body`);
if (wasm.subarray(0, 4).toString('binary') !== '\0asm') {
  die(`${name}_bg.wasm is not a WebAssembly module (got ${wasm.length} bytes starting "${wasm.subarray(0, 16).toString('utf8')}")`);
}
if (!js.includes('wasm_bindgen') && !js.includes('__wbg_init')) {
  die(`${name}.js does not look like wasm-bindgen glue (got ${js.length} bytes)`);
}

/* The check the old script could not make, and the one that actually matters: INSTANTIATE
 * the artifact and ask it what it is. Everything above proves the bytes are shaped like a
 * core; only this proves they ARE one. It also removes the last hand-typed constant —
 * CORE_VERSION is read out of the module rather than transcribed from a Cargo.toml that
 * may not be the tree these bytes were built from.
 *
 * The glue is a `--target web` ESM module, so it cannot fetch() under node — but it also
 * exports initSync(), which compiles raw bytes synchronously. Handing them over directly
 * means nothing here is testing its own scaffolding. Staged inside public/assets so the
 * import resolves against Stredio-Web's own `"type": "module"`. */
const staging = join(ASSETS, `.staging-${process.pid}`);
await mkdir(staging, { recursive: true });
await writeFile(join(staging, `${name}.js`), js);
await writeFile(join(staging, `${name}_bg.wasm`), wasm);

let version;
try {
  const mod = await import(pathToFileURL(join(staging, `${name}.js`)).href);
  mod.initSync({ module: wasm });
  version = mod.core_version();
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`core_version() answered ${JSON.stringify(version)}, which is not a semver`);
  }
  for (const fn of ['merge_official', 'merge_library', 'visible_rows', 'core_constants']) {
    if (typeof mod[fn] !== 'function') throw new Error(`the module exports no ${fn}() — wrong artifact?`);
  }
} catch (err) {
  await rm(staging, { recursive: true, force: true });
  die(`the artifact would not instantiate: ${err?.message || err}`);
}

/* The folder is named by the CONTENT, not by a git sha. The path is the cache key, so it
 * has to be unique per bytes — and a git-derived name cannot promise that: build.rs
 * degrades to `unknown` on a source export or a repo with no commit yet, so two different
 * trees would claim the same immutable path and one would be served out of a stale cache
 * forever. The semver prefix keeps it readable; the digest makes it true. */
const semver = version.split('+')[0];
const digest = createHash('sha256').update(wasm).digest('hex').slice(0, 8);
const build = `${semver}-${digest}`;
const outDir = join(ASSETS, build);

await rm(outDir, { recursive: true, force: true });
await rename(staging, outDir).catch(async (e) => {
  // Cross-device or a locked staging dir: fall back to a copy so the run still lands.
  if (e?.code !== 'EXDEV' && e?.code !== 'EPERM') throw e;
  await mkdir(outDir, { recursive: true });
  for (const f of [`${name}.js`, `${name}_bg.wasm`]) await copyFile(join(staging, f), join(outDir, f));
  await rm(staging, { recursive: true, force: true });
});

console.log(`  ${`${name}.js`.padEnd(26)} ${js.length} bytes`);
console.log(`  ${`${name}_bg.wasm`.padEnd(26)} ${wasm.length} bytes`);
console.log(`\nvendored ${provenance} -> public/assets/groloo-core/${build}`);
console.log(`core_version() answers "${version}"\n`);
console.log('Paste into src/lib/heart.ts, then keep the previous folder until this one has shipped:\n');
console.log(`const CORE_BUILD = '${build}';`);
console.log(`const CORE_VERSION = '${version}';`);
console.log(`const CORE_JS = \`/assets/groloo-core/\${CORE_BUILD}/${basename(name)}.js\`;`);
