/* EVERY DEPENDENCY EDGE IN package-lock.json POINTS AT SOMETHING THAT IS IN IT.
 *
 * This exists because a lockfile written on Windows is quietly incomplete, and the way it
 * announces that is a wall of npm usage text on a Linux runner:
 *
 *     npm error code EUSAGE
 *     npm error `npm ci` can only install packages when your package.json and
 *     npm error package-lock.json … are in sync.
 *     npm error Missing: @emnapi/runtime@1.11.3 from lock file
 *     npm error Usage:  … forty more lines of --flag documentation …
 *
 * npm records an optional dependency only for the platforms it actually resolved on, so a
 * package Linux resolves and Windows does not is simply absent from a Windows-authored
 * lockfile. The tree still LOOKS complete: the package that needs the missing one is
 * present, its `dependencies` still names it, and nothing on Windows ever tries to follow
 * that edge. It is caught on the runner, after a checkout and a node setup, by the only
 * process that walks the whole graph — which is why the error arrives so far from the
 * mistake, and why "check `git diff package-lock.json` before committing" has now failed
 * twice as a control. This turns it into one line, at the top, naming the package.
 *
 * THE CHECK IS DERIVED, NOT A LIST. It would be shorter to assert that the three @emnapi
 * packages are present, and that guard would be worthless the first time npm's tree grows a
 * different platform-only edge. Instead every `dependencies` / `optionalDependencies` entry
 * of every package is resolved the way node resolves it — nearest `node_modules`, then
 * outward to the root — and anything that resolves to nothing is the failure. The @emnapi
 * case falls out of that rather than being spelled out in it.
 *
 * PEER EDGES ARE CHECKED, AND THAT IS THE WHOLE GUARD. The first draft of this file skipped
 * them — an unmet peer being a warning in npm's older model — and it passed cleanly on the
 * exact lockfile that had just broken CI. The missing package was `@emnapi/runtime`, and
 * nothing DEPENDS on it: it is a peer of `@napi-rs/wasm-runtime`. npm 7+ installs
 * non-optional peers into the tree like anything else, marks them `"peer": true`, and `npm
 * ci` then requires them to be in the lockfile — so a stripped peer is a hard failure that
 * looks, in the file, like an edge nobody follows. A guard that passes when it should fail is
 * worse than no guard, so this one is proved against that lockfile in CI below.
 *
 * Peers marked optional in `peerDependenciesMeta` are skipped: those are genuinely allowed to
 * be absent, and npm does not put them in the tree.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: version SATISFACTION. That is npm's job and it does it
 * properly at `npm ci`. The question here is only whether the entry exists at all, because
 * that is the failure Windows actually causes.
 *
 * Run it yourself after any `npm install`:  node scripts/check-lockfile.mjs
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'package-lock.json';

let lock;
try {
  lock = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`lockfile: ${path} is missing or unreadable (${err.message})`);
  process.exit(1);
}

/* `packages` is the lockfileVersion 2/3 map, keyed by path — "" for the root project,
 * "node_modules/x", "node_modules/x/node_modules/y". A v1 lockfile has no such map, and
 * this guard cannot check one; say so rather than passing vacuously. */
if (!lock.packages || typeof lock.packages !== 'object') {
  console.error(
    `lockfile: ${path} has no "packages" map (lockfileVersion ${lock.lockfileVersion ?? '?'}). ` +
    'This guard walks that map to resolve dependency edges; teach it the new shape rather ' +
    'than deleting it.',
  );
  process.exit(1);
}

const entries = lock.packages;
const has = (p) => Object.prototype.hasOwnProperty.call(entries, p);

/* Node's resolution, in the one form the lockfile needs: from the package at `from`, look in
 * its own node_modules, then in each ancestor's, out to the root. Returns the path of the
 * entry that satisfies `name`, or null.
 *
 * The ancestor walk is textual because the keys already encode the nesting — dropping the
 * last `node_modules/<pkg>` segment IS moving one package outwards, and `<pkg>` may itself
 * contain a slash when it is scoped, which is why this trims by the separator rather than
 * by counting path components. */
function resolveFrom(from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (has(candidate)) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    if (cut < 0) {
      base = ''; // one level below the root: the next look is the root's own node_modules
      continue;
    }
    base = base.slice(0, cut);
  }
}

const broken = [];
for (const [where, pkg] of Object.entries(entries)) {
  if (!pkg || typeof pkg !== 'object') continue;
  // The root's devDependencies are real edges too, and `npm ci` installs them by default.
  const edges = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(where === '' ? pkg.devDependencies || {} : {}),
  };
  // Non-optional peers only — see the note at the top; this is the case that actually bites.
  const meta = pkg.peerDependenciesMeta || {};
  for (const name of Object.keys(pkg.peerDependencies || {})) {
    if (!meta[name]?.optional) edges[name] = true;
  }
  for (const name of Object.keys(edges)) {
    if (!resolveFrom(where, name)) broken.push({ name, from: where || '(the root project)' });
  }
}

if (broken.length === 0) {
  console.log(`lockfile: ${Object.keys(entries).length} packages, every dependency edge resolves`);
  process.exit(0);
}

/* One line per missing package, then the remedy — because the remedy is the part that is not
 * guessable, and getting it wrong is expensive: three plausible repairs from Windows all
 * produce a lockfile that is differently wrong (see the note in .github/workflows/ci.yml). */
console.error(`lockfile: ${broken.length} dependency edge(s) in ${path} point at a package that is not in it:\n`);
const byName = new Map();
for (const b of broken) {
  if (!byName.has(b.name)) byName.set(b.name, []);
  byName.get(b.name).push(b.from);
}
for (const [name, froms] of byName) {
  console.error(`  ${name}  <- required by ${froms.join(', ')}`);
}
console.error(
  '\nThis is almost certainly a lockfile written on Windows. npm records an optional\n' +
  'dependency only for the platforms it resolved on, so a package Linux resolves and\n' +
  'Windows does not is omitted by construction — and `npm ci` on the runner refuses.\n' +
  '\n' +
  'It cannot be repaired from Windows. Regenerate on Linux: a full `npm install` under\n' +
  'node 24 (WSL, a container, or a throwaway ubuntu-latest workflow), starting from the\n' +
  'last lockfile CI accepted plus the current package.json. Then check the diff adds only\n' +
  'the packages you meant to add.\n',
);
process.exit(1);
