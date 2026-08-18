import { create } from 'zustand';
import { api } from '../lib/api';
import { callCore, coreReady, loadCore, subscribeCoreStatus } from '../lib/heart';
import { useAuth } from './auth';

/* Installed add-on collection. Per the project's client-direct model, the browser
 * fetches an add-on's manifest DIRECTLY (never via our server) to validate + install.
 * localStorage is the instant, offline-safe source of truth; when signed in, the
 * account's LIST of add-ons also syncs to the server (/api/addons, requireAuth) so a
 * second device learns WHICH add-ons the user runs — not how to reach them, see below.
 * The server only stores that list; it never fetches an add-on. Guests stay purely
 * local.
 *
 * THE MANIFEST URL SYNCS TOO, AND THAT IS THE POINT. By add-on protocol convention a configured
 * community add-on packs its secrets into the path (`https://host/<provider>=<KEY>/
 * manifest.json`). The server used to store the ORIGIN and never the URL, so no debrid
 * key existed on that side — structurally safe, and structurally useless: a second
 * device pulled down a list of NAMES it could not call. Signing in on a TV handed the
 * user their collection as an inventory and a chore, one credentialed URL to be re-typed
 * per add-on on a remote control. "Your add-ons sync across your devices" has to mean the
 * add-ons, not their titles, so the URL is persisted per-account and comes back down on
 * the pull. See server.js's /api/addons header for what that obliges of the server side.
 *
 * `unlinked` SURVIVES THAT CHANGE AS A LEGACY PATH, not as the normal one. Rows written
 * while the server kept origins only have no URL to send, and there is no way to recover
 * one — so they still arrive URL-less and still need a paste, exactly as before. Hence
 * two lists. `installed` holds records this device can actually call, and is the only
 * thing addonClient/AddonRows consume. `unlinked` holds ids the account owns whose URL
 * nothing anywhere still has; they are inert until the user pastes it again, which
 * install() treats as a repair — and now also pushes up, so the OTHER devices stop
 * asking too. That last part is what closes the loop: without it a relink healed one
 * device and left the account exactly as unlinked as it was.
 *
 * Keeping the lists apart is still what stops a sync from overwriting a working record
 * with a URL-less one — the bug that would have wiped every user's credentialed add-on
 * off their own device — and `unlinked` must keep being RENDERED (Addons.tsx) for as
 * long as any legacy row can exist: a non-empty list that no view shows is
 * indistinguishable from data loss to the person whose add-ons they are. Consumers want
 * `manifest.name` and `origin` (which is why `origin` is carried through the pull) plus
 * the existing install() field to repair with. */

/* WHY THE KEY IS NAMESPACED BY ACCOUNT — AND WHY THE OLD KEY IS THE GUEST BUCKET.
 * The collection used to live at one un-namespaced `groloo.addons`, which meant signing
 * out left it sitting there for whoever signed in next: their first sync pushed the
 * previous account's add-ons up as their own, and their device fetched streams through
 * the previous account's debrid key. On a living-room TV that is precisely the
 * cross-account leak this phase exists to close, so the key now carries the email —
 * `groloo.addons:<email>` — the way `sf:history:<email>` and `sf:mylist:<email>` already
 * do. Namespacing rather than merely wiping on sign-out is the better fit here because
 * the manifest URL exists ONLY on this device (see the header above): destroying it at
 * sign-out would cost the owner their debrid keys every time they hand the TV over,
 * while filing it under their email hands it straight back when they return.
 *
 * The pre-namespace key is not migrated to a `:guest` name; it IS the guest bucket. That
 * settles the migration question without having to guess whose add-ons it holds. An
 * existing install keeps reading the same key while signed out, and the first account to
 * sign in on that device MOVES it into that account's namespace — copy, then removeItem.
 * A move and not a copy, because a copy would let the second account inherit it as well,
 * which is the same leak with an extra step. The account that inherits is whoever the
 * device's owner signs in as, which on a single-user device is the person who typed
 * those URLs; every account after finds the bucket gone and starts empty. Nothing is
 * orphaned by the rename, and the guest→account carry-over the un-namespaced store had
 * by accident survives as a deliberate one-shot.
 *
 * A namespace counts as "already lived in" by the PRESENCE OF ITS KEY, never by the list
 * being non-empty: an account that removed its last add-on has a stored `[]`, and must
 * not be handed the guest bucket as a consolation prize for emptying its own. */
const GUEST_KEY = 'groloo.addons';
const email = () => useAuth.getState().user?.email || '';
const storeKey = () => { const e = email(); return e ? GUEST_KEY + ':' + e : GUEST_KEY; };

/* WHY EVERY ASYNC WRITE CARRIES THE IDENTITY IT STARTED UNDER.
 * Namespacing the key above fixed WHERE a write lands, not WHEN. `storeKey()` is
 * evaluated at the moment save() runs, and every write in this store sits behind an
 * await — a manifest fetch, a GET /api/addons. Hand the TV over while one is in flight
 * and the promise resolves into a DIFFERENT namespace than the one it was started for:
 * account A's collection saved into B's bucket, set() into the lists B's screens render,
 * and then pushed up to B's /api/addons by the reconcile at the foot of the pull, where
 * no client-side reload can take it back. That is the cross-account leak this phase
 * exists to close, arriving by the back door — no code path picked the wrong key, the
 * key changed underneath a promise that had already read the world.
 *
 * So the identity is captured BEFORE the await and re-checked immediately before
 * anything is committed: to localStorage, to the store, or to the server. A mismatch
 * abandons the result in silence. There is nobody to tell — the person who started it
 * has signed out — and the only honest thing to do with data belonging to an account
 * that is no longer here is nothing at all; the next sign-in re-reads the bucket and
 * re-pulls from scratch anyway.
 *
 * The token is NOT the email alone, because clear() is a state change no email can see.
 * Account deletion calls clear() and only THEN logout (see the note on clear(), and both
 * delete screens) — for the seconds in between, the deleted account is still the
 * signed-in identity, so an in-flight pull would match on email and re-create the very
 * key clear() just removed, restoring manifest URLs that are the last copies in existence
 * of that user's debrid links. The counter makes "forgotten" its own generation, so
 * nothing started before a clear() can ever land after it.
 *
 * Signing out and back in as the SAME account keeps its token, deliberately: the bucket
 * the write was started for is the bucket it would land in, and dropping it would only
 * cost the owner their own work. The one write this does throw away needlessly is a
 * guest install caught mid-fetch by a sign-in — the hand-over rule above would have
 * carried that bucket across, but it is a rule about buckets, not a licence for a write
 * to follow a user it never belonged to, and re-pasting one URL is the cheap half of
 * that trade. */
let epoch = 0;
const identity = () => epoch + ':' + email();
const stillMine = (owner: string) => identity() === owner;

export interface Manifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  types?: string[];
  resources?: unknown[];
  catalogs?: unknown[];
}
export interface AddonRecord {
  id: string;
  url: string;
  manifest: Manifest;
  installedAt: number;
  /* Where the add-on came from. Carried for `unlinked` rows only, where it is the one
   * locator left after the URL is stripped and the only thing a repair prompt can name
   * the add-on's source by ("the one from torrentio.strem.fun") — a manifest name alone
   * doesn't tell the user which of their links to go and find. Installed rows leave it
   * undefined rather than storing a second copy of what `url` already answers. It is a
   * label, never an address: see the pull for why it must not be fetched. */
  origin?: string;
}

/* What GET /api/addons actually returns — deliberately NOT an AddonRecord. It stamps
 * `installedAt` as an ISO string, carries `origin` beside the URL, and — the field this
 * whole type exists for — its `url` is OPTIONAL, because rows written while the server
 * stored origins only have none and never will. Typing the response as AddonRecord was
 * a lie that let such a row be spliced straight into the collection with `url:
 * undefined` behind a required `url: string`, i.e. an add-on that looks installed and
 * answers nothing. Naming the wire shape separately is what forces the merge below to
 * convert rather than assume, and to branch on the one field that can be missing. */
interface ServerAddonRecord { id: string; url?: string; origin?: string; installedAt?: string; manifest?: Manifest }

/* WHY A REMOVAL IS A RECORD AND NOT A DELETION.
 * Removing an add-on used to be pure subtraction: drop the row here, fire a DELETE at the
 * server, done. That works for exactly as long as every device is looking. It is not what
 * the other devices see, and it is not what THIS device sees an hour later.
 *
 * Nothing in the old shape could tell the two meanings of an absence apart. A row this
 * device holds that the server's list does not is either an install the server has not
 * been told about yet — push it up, which the reconcile at the foot of the pull does — or
 * one the account removed somewhere else, which must be dropped. Symmetrically, a row the
 * SERVER holds that this device does not is either an install from another device to adopt
 * or one this device removed while its DELETE failed. Read one way when it meant the other
 * and the add-on comes back, and it came back the worst possible way: the pull ADOPTED
 * remote rows and never dropped local ones, so a device that had not synced since the
 * removal still held the add-on, found it missing from the server's list, and posted it
 * back up as if it were a new install. One stale television re-installed, for the whole
 * account, every add-on the user had just removed on their phone. That is the "it comes
 * back after a while, and it is still there on my other device" this file now answers.
 *
 * So a removal is stored, as `removed: { id: at }`, exactly as the library and block
 * documents already store theirs, and the same rule decides every case: for a given id the
 * later stamp wins — an install at `installedAt` against a removal at `at`. A tombstone
 * ties, for the block store's reason inverted: re-pasting a manifest URL is a chore on a
 * remote control, but silently resurrecting something the user deleted is the app refusing
 * to obey, and only one of those is a decision the user can see and redo.
 *
 * The stored shape is `{ rows, removed }` where it used to be a bare array; the array
 * still reads as "these rows, no removals on record", which is what it is. It is NOT
 * rewritten on read — this bucket is the only copy in existence of the user's credentialed
 * manifest URLs (see above), so it is rewritten when something actually changes it. */
const TOMB_TTL = 30 * 24 * 60 * 60 * 1000;   // forget a removal after 30 days, as the server does
type RemovalMap = Record<string, number>;

/* Drop removals older than the window. The clock is shared with the server's
 * pruneAddonRemovals so a round trip cannot revive what this side has just retired. What
 * the TTL costs is stated plainly: a device that has been offline LONGER than the window
 * comes back holding add-ons the account removed with no tombstone left to tell it, and
 * re-installs them. The alternative is a map that only ever grows. */
function prune(removed: RemovalMap): RemovalMap {
  const now = Date.now();
  const out: RemovalMap = {};
  for (const id of Object.keys(removed || {})) {
    const at = +removed[id] || 0;
    if (at > 0 && now - at <= TOMB_TTL) out[id] = at;
  }
  return out;
}

/* Both lists live in one localStorage array so the stored shape never forks — a record
 * that gets its URL back is the same row it always was, not a migration between keys.
 * The split happens on the way in, on the only thing that separates them: whether the
 * row carries a URL this device can call. */
function load(): { rows: AddonRecord[]; removed: RemovalMap } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (Array.isArray(raw)) return { rows: raw, removed: {} };   // pre-tombstone shape
    const doc = raw as { rows?: unknown; removed?: unknown } | null;
    const rows = Array.isArray(doc?.rows) ? (doc!.rows as AddonRecord[]) : [];
    const removed = (doc?.removed && typeof doc.removed === 'object' && !Array.isArray(doc.removed))
      ? (doc.removed as RemovalMap) : {};
    return { rows, removed: prune(removed) };
  } catch { return { rows: [], removed: {} }; }
}
function save(installed: AddonRecord[], unlinked: AddonRecord[], removed: RemovalMap) {
  try { localStorage.setItem(storeKey(), JSON.stringify({ rows: [...installed, ...unlinked], removed })); } catch { /* quota */ }
}

/* Read the bucket belonging to whoever is signed in right now, performing the one-shot
 * hand-over described above on the way. Done as a raw string copy rather than a
 * parse/re-serialize so a bucket this build cannot make sense of still reaches its owner
 * intact instead of being silently flattened to `[]` by the tolerant reader below. */
function loadForIdentity() {
  try {
    const key = storeKey();
    if (key !== GUEST_KEY && localStorage.getItem(key) === null) {
      const handover = localStorage.getItem(GUEST_KEY);
      if (handover !== null) { localStorage.setItem(key, handover); localStorage.removeItem(GUEST_KEY); }
    }
  } catch { /* private mode / quota — fall through and just read what we can */ }
  return load();
}

/* The bucket, arranged the way the store holds it. The removals carried across the
 * guest→account hand-over along with the rows, deliberately: they are the same person's
 * decisions, and an add-on the user threw away before making an account should not be
 * handed back to them by the act of signing up. */
function stateForIdentity() {
  const { rows, removed } = loadForIdentity();
  return { ...split(rows), removed };
}

/* Optional-chained because this also runs at module load: a single junk entry in the
 * stored array (a null from an interrupted write, anything a past build left behind)
 * would otherwise throw, and a throw at import time is a white screen with no route to
 * Settings to clear it. */
function split(rows: AddonRecord[]) {
  return { installed: rows.filter((a) => !!a?.url), unlinked: rows.filter((a) => a && !a.url) };
}

const authed = () => !!useAuth.getState().user;
const addonId = (a: { id?: string; manifest?: Manifest }) => a.manifest?.id || a.id || '';

/* Best-effort server writes — local stays the source of truth if these fail. The POST
 * carries the full install URL: the server stores it and hands it back on the next GET,
 * which is how the add-on reaches the user's other devices ready to use.
 *
 * `owner` is the identity its caller captured before ITS await, re-checked here at the
 * moment of dispatch rather than trusted from the call site. These two fire and forget,
 * so they are the one pair whose damage is unreachable afterwards: `api()` attaches
 * whichever session cookie/token is current when the request leaves, and a POST that
 * leaves after the hand-over files A's add-on under B's account server-side, where the
 * next device B signs in on will faithfully pull it down. authed() alone cannot see
 * that — B is authed too. */
function serverInstall(rec: AddonRecord, owner: string) {
  if (!authed() || !stillMine(owner)) return;
  api('/api/addons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: rec.url, manifest: rec.manifest }) }).catch(() => {});
}
function serverRemove(id: string, owner: string) {
  if (!authed() || !stillMine(owner)) return;
  api(`/api/addons/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

/** Accept a base URL, a full manifest URL, a `scheme://` deep link or a bare host; answer
 *  the manifest URL to fetch, or throw the sentence the add-ons screen should show.
 *
 *  THE TWIN THAT LIVED HERE IS GONE. `normalize_manifest_url` (core #10) is the unification
 *  of the three copies of this rule — this one, `server.js:1992` and `addon.rs` — and the
 *  parity corpus proved this copy and the core byte-identical across the whole URL ledger
 *  before a line was deleted (13 matched, 0 unplanned). The blocker was one row:
 *  ".../manifest.json/", where this copy stripped trailing slashes BEFORE the .json test
 *  and the core, having taken the server's rule, tested the pathname first and appended a
 *  second segment that 404s. That was unplanned divergence U-slash, and it is FIXED in pin
 *  0.2.0-e1acdff7 — the core now trims the PATH before testing it, so it takes the right
 *  TEST from the server (a query cannot defeat a pathname test) and the right ORDER from
 *  this copy, and that input is a fixpoint instead of growing a segment on every pass.
 *
 *  ROUTING AT THE CORE IS A BEHAVIOUR FIX, NOT MERELY A REFACTOR — and the fix is the whole
 *  reason this was worth doing. The deleted line tested /manifest\.json$/ against the WHOLE
 *  string INCLUDING THE QUERY, so it never matched a `?`-suffixed URL and appended a second
 *  segment: "https://a.co/addon?x=1" became ".../addon?x=1/manifest.json", which cannot
 *  resolve. The core tests the parsed pathname and inserts the segment BEFORE the query —
 *  "https://a.co/addon/manifest.json?x=1". By the add-on protocol's convention documented at the top
 *  of this file the URLs that carry a query are exactly the CREDENTIALED ones, so the copy
 *  removed here mangled precisely the debrid add-ons a user paid for; a `|`-packed config
 *  AND a query together was simply uninstallable. Those users can install now. (Declared
 *  divergences D6-query and D6-json — the latter is `foo.json`, already a manifest URL,
 *  which the old copy turned into "foo.json/manifest.json".)
 *
 *  IT CAN NOW REFUSE, WHICH THE DELETED COPY COULD NOT — hence the throw, where before this
 *  function could only ever answer a string. That copy prepended "https://" to anything at
 *  all, so a typo became a URL ("not-an-id" → "https://not-an-id/manifest.json") and failed
 *  later as an opaque network error with nothing anywhere to say it had never been a link.
 *  The core rejects a schemeless string unless its authority is host-shaped, which keeps
 *  every paste the old copy accepted for a reason ("v3-cinemeta.strem.io/manifest.json")
 *  and drops the ones it accepted by accident, and it hands back the server's own sentence
 *  for install()'s caller to render (D6-typo). A rejection the screen can surface beats a
 *  guess it cannot.
 *
 *  No core, no guess: refused for the same reason rejectManifest() refuses — with no core
 *  there is no second opinion, and admitting an unchecked add-on is how the "installs but
 *  answers nothing" state gets created in the first place.
 *
 *  THIS TOOK THE COUNT FROM THREE COPIES TO TWO, NOT TO ONE. The browser now has none of
 *  its own, but `server.js:1992` still tests before it trims and still rejects every
 *  schemeless paste — declared divergences D-slash and D6-host. So a trailing-slash URL,
 *  and a schemeless one, that this screen now installs will keep 404ing or bouncing
 *  server-side until that copy trims first and accepts a host-shaped authority. That is a
 *  server change, not a shell one; until it lands the server is the copy out of step, and
 *  the parity corpus keeps both rows red-flagged against it so nobody has to rediscover
 *  that from a bug report. */
function manifestUrl(raw: string): string {
  const env = callCore<string>('normalize_manifest_url', (c) => c.normalize_manifest_url(raw));
  if (!env) throw new Error('The add-on core did not load, so this link could not be checked. Reload and try again.');
  if (!env.ok) throw new Error(env.error?.detail || 'Not a usable add-on URL');
  return env.data;
}

/* Core #12 — is this document an add-on manifest at all? Returns null when it is, and the
 * reason when it is not, because that string goes straight onto the add-ons screen.
 *
 * WHAT THIS DELETED. The check used to be `!manifest || !manifest.id || !manifest.name`
 * under ONE message: two of the four rules, so a manifest with a malformed id and a
 * manifest with no `types` produced the same useless sentence — and a manifest with no
 * `resources` or no `types` was INSTALLED, became a row on this screen, was asked for
 * streams, and answered nothing. The core runs all four rules with `server.js:1947`'s four
 * distinct messages, so the browser and the server now agree about what an add-on is;
 * before this, an add-on the server refused could still be installed from the browser.
 *
 * A body that is not a JSON object at all USED to be the one case whose wording regressed:
 * serde rejected it before the core reached its own first rule, so the user saw a type
 * error where they had read a sentence. That was unplanned divergence U-notobject, and it
 * is FIXED in pin 0.2.0-e1acdff7 — the body is read as a JSON value before it is read as a
 * manifest, so such a document now answers `server.js:1947`'s own first sentence,
 * "Manifest is not a JSON object". The `error.detail` this function surfaces really is the
 * server's message verbatim, for all five rules rather than four.
 *
 * With no core there is no second opinion to fall back on (see the header of
 * lib/addonClient.ts for why that is the point), so the install is refused rather than
 * waved through: admitting an unvalidated add-on is how the "installs but answers nothing"
 * state gets created in the first place. */
function rejectManifest(manifestJson: string): string | null {
  const env = callCore<Manifest>('validate_manifest', (c) => c.validate_manifest(manifestJson));
  if (!env) return 'The add-on core did not load, so this manifest could not be checked. Reload and try again.';
  return env.ok ? null : (env.error?.detail || 'Not a valid add-on manifest');
}

interface AddonsState {
  /** add-ons this device can actually fetch — every consumer means this one */
  installed: AddonRecord[];
  /** add-ons the account owns whose manifest URL this device does not hold (see header) */
  unlinked: AddonRecord[];
  /** when each removed add-on was removed — what stops one from coming back (see header) */
  removed: RemovalMap;
  install: (rawUrl: string) => Promise<void>;
  remove: (id: string) => void;
  /** re-read the signed-in account's namespace (the storage key changes on sign-in/out) */
  reload: () => void;
  /** forget this account's add-ons on this device — sign-out / account deletion */
  clear: () => void;
  /** fold the server collection into local: metadata only, never over a local URL */
  pullFromServer: () => Promise<void>;
}

export const useAddons = create<AddonsState>((set, get) => ({
  ...stateForIdentity(),
  install: async (rawUrl) => {
    const owner = identity();
    /* The core comes up BEFORE the URL is normalised rather than after the fetch, because
     * normalising is now a core call and there is nothing to fetch until it has answered.
     * It is the same single load one step earlier, and it buys the user the better failure:
     * a link that was never a URL is refused here, instantly, instead of after a round-trip
     * to a host that does not exist. */
    await loadCore();
    const url = manifestUrl(rawUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
    /* The RAW TEXT goes to the core — it parses. Reading `res.json()` and re-serialising
     * would put a second parser in front of the validator, which is a place for a document
     * to change shape between being fetched and being judged. Parsed here only after it
     * has passed, where JSON.parse can no longer throw. */
    const body = await res.text();
    const rejected = rejectManifest(body);
    if (rejected) throw new Error(rejected);
    const manifest = JSON.parse(body) as Manifest;
    /* The manifest fetch is a third-party round-trip against a host we have never spoken
     * to before — seconds, on a TV, and it is precisely while it hangs that somebody hands
     * the remote over. Everything below reads and writes the CURRENT namespace, so past
     * this line the paste belongs to whoever pasted it or to nobody. */
    if (!stillMine(owner)) return;
    // addonId, not a.manifest.id: both dedupe checks in this function have to key on the
    // same thing as the pull below, and a row from an older build with no manifest block
    // would throw here rather than simply not matching.
    if (get().installed.some((a) => addonId(a) === manifest.id)) return; // already installed
    const rec: AddonRecord = { id: manifest.id, url, manifest, installedAt: Date.now() };
    /* Pasting the URL of an add-on that is only `unlinked` here is a REPAIR, not a new
     * install: the id leaves that list instead of the paste being swallowed as a
     * duplicate. Without this branch the user would have no way back — the duplicate
     * check above would return silently forever.
     *
     * IT IS STILL PUSHED UP, which it deliberately was not before. The old rule was
     * "the server already holds this id and would answer 409", true when the server kept
     * no URLs and so had nothing to learn from a relink. Now it does: this paste is the
     * only copy in existence of a link the account is missing, and swallowing it locally
     * would leave every OTHER device of this user asking for the same URL forever, one
     * repair at a time, for a row that has just been healed. POST treats same-id/
     * different-url as an update rather than a duplicate (server.js), so this is the
     * relink reaching the account, not a 409 waiting to happen. */
    const unlinked = get().unlinked.filter((a) => addonId(a) !== manifest.id);
    const next = [...get().installed, rec];
    /* AN INSTALL RETIRES THE REMOVAL, or the row will not stay installed. The tombstone
     * outranks nothing here — `rec.installedAt` is now and the removal is necessarily
     * older — but leaving it in the map means it goes up to the account on the next
     * reconcile and comes back down to every other device beside a row it is younger
     * than, which is a comparison this device has already settled by re-installing.
     * Dropping it is the same move block() makes on the tombstone for a key. */
    const removed = { ...get().removed };
    delete removed[manifest.id];
    save(next, unlinked, removed); set({ installed: next, unlinked, removed });
    serverInstall(rec, owner);
  },
  // The only write in here with nothing to outlive: no await stands between the click and
  // the save, so the identity read for serverRemove is the one the user clicked under.
  remove: (id) => {
    const owner = identity();
    const hit = (a: AddonRecord) => !!a && (a.id === id || addonId(a) === id);
    const at = Date.now();
    /* Record the removal BEFORE dropping the row, because the record is the part that has
     * to survive: the DELETE below is fire-and-forget, and on a television it is fired at
     * a network that is frequently not there. When it fails — offline, an expired session,
     * anything — the server keeps the add-on, and without this map the very next pull
     * reads it as an install this device had not heard about and puts it straight back.
     * The pull re-issues the DELETE for as long as the server still lists a tombstoned id,
     * so a removal made offline lands on its own rather than needing the user to remove
     * the same add-on a second time.
     *
     * BOTH NAMES OF WHATEVER ACTUALLY LEFT are tombstoned, not just the id the button
     * passed. A row written by an older build can carry an `id` its manifest disagrees
     * with, and the pull keys on the manifest's — tombstone one name and the merge below
     * matches on the other, finds no removal, and hands the row back. They are the same
     * add-on either way, so recording both costs a map entry and closes the gap. */
    const removed = { ...get().removed, [id]: at };
    for (const a of [...get().installed, ...get().unlinked]) {
      if (!hit(a)) continue;
      if (a.id) removed[a.id] = at;
      const mid = addonId(a);
      if (mid) removed[mid] = at;
    }
    const live = prune(removed);
    const installed = get().installed.filter((a) => !hit(a));
    const unlinked = get().unlinked.filter((a) => !hit(a));
    save(installed, unlinked, live); set({ installed, unlinked, removed: live });
    serverRemove(id, owner);
  },
  reload: () => set(stateForIdentity()),
  /* Local only, and deliberately so: this is what a device forgets, not what the account
   * owns. Sign-out must leave /api/addons untouched (the collection is meant to survive
   * onto the user's next device), and account deletion has already had the server drop
   * every record server-side — issuing DELETEs from here would be, at best, a burst of
   * 401s against a session that no longer exists.
   *
   * With the namespacing above, sign-out no longer NEEDS this: the identity subscription
   * at the foot of the file swaps the in-memory lists to the incoming account's bucket
   * on its own, so nothing of the previous account's is left for the next one to adopt
   * and re-upload. Callers use clear() for the stronger statement — "forget this account
   * on this device" — which is mandatory on account deletion, where the stored manifest
   * URLs are the last copy in existence of the user's credentialed add-on links and no
   * server-side purge can reach them. Call it BEFORE clearing the session: the key it
   * removes is derived from the currently signed-in email.
   *
   * Removing the key rather than storing an empty list is deliberate — an account that
   * has been deleted should leave nothing behind on the TV, not even its own name in a
   * key — and it does mean the account reads as new to this device again, so a later
   * sign-in would inherit the unsigned bucket under the hand-over rule above. That is
   * the same rule a guest-then-sign-in gets and it is bounded to one bucket, but it is
   * the reason clear() is specified as the DELETION path: routine sign-out is already
   * covered by the automatic namespace swap and does not need to give the key up. */
  clear: () => {
    /* Bump FIRST: "forget this account on this device" has to outrank anything already in
     * flight for it, or the pull that was started a moment ago writes the key back the
     * line below removes — with the email unchanged, since the session is still alive at
     * this point on the deletion path. See the identity note at the top. */
    epoch += 1;
    try { localStorage.removeItem(storeKey()); } catch { /* private mode */ }
    // The removals go with the rows. They are statements about a collection this device is
    // being told to forget entirely, and on the deletion path the account they describe is
    // about to stop existing — keeping them would leave one account's uninstall decisions
    // sitting in the bucket the next sign-in on this device may inherit.
    set({ installed: [], unlinked: [], removed: {} });
  },
  pullFromServer: async () => {
    if (!authed()) return;
    const owner = identity();
    try {
      const { addons: remote, removed: remoteRemoved } =
        await api<{ addons: ServerAddonRecord[]; removed?: RemovalMap }>('/api/addons');
      /* The list that just arrived describes the account that asked for it, which is not
       * necessarily the account signed in now. Nothing below awaits, so this single check
       * covers the save, the set and the reconcile push at the end. */
      if (!stillMine(owner)) return;

      /* THE REMOVALS MERGE FIRST, because every other decision in this function is taken
       * against them. Union of both sides, newest stamp per id: this device's own removals
       * matter as much as the account's, since one of them may be a DELETE that never
       * reached the server, and that is precisely the case the old code got wrong in the
       * direction of resurrection. */
      const union: RemovalMap = { ...get().removed };
      for (const id of Object.keys(remoteRemoved || {})) {
        const at = +(remoteRemoved || {})[id] || 0;
        if (at > (union[id] || 0)) union[id] = at;
      }
      const removed = prune(union);

      /* Removed, unless it has been installed again since. The stamp comparison is what
       * makes a re-install able to beat an older removal, and the tombstone takes the tie
       * (see the header). Both names are checked for the reason remove() records both. */
      const gone = (a: { id?: string; manifest?: Manifest; installedAt?: number }) => {
        const t = Math.max(removed[addonId(a)] || 0, (a.id && removed[a.id]) || 0);
        return t > 0 && t >= (a.installedAt || 0);
      };

      /* A REMOVAL ELSEWHERE NOW REACHES THIS DEVICE. The pull used to be add-only, so an
       * add-on removed on a phone stayed installed on the television for as long as that
       * television lived — and worse, the reconcile at the foot of this function then
       * posted it back up and undid the removal for every device the account has. Local
       * rows the account has since removed leave here first, so they are absent from both
       * the merged state and the push list. */
      const local = get().installed.filter((a) => !gone(a));
      // Working records go in LAST so that if an id somehow sits in both lists, the one
      // holding the URL is what the skip below tests — the whole point of this function
      // is that a URL-less copy can never shadow a usable one.
      const known = new Map<string, AddonRecord>();
      for (const a of [...get().unlinked.filter((u) => !gone(u)), ...local]) { const id = addonId(a); if (id) known.set(id, a); }
      /* A pull ADDS ids and never rewrites one this device already works with: an id we
       * hold a URL for is skipped outright, because our copy is at least as good as the
       * server's and may be better — a link re-pasted here a moment ago has not been
       * pushed up yet, and letting the older remote row land on top of it would undo a
       * repair in flight. Everything else is adopted: with a URL it joins `installed`
       * and is usable on this device immediately, which is the entire cross-device
       * story; without one (a legacy row, see the header) it lands in `unlinked` as
       * metadata awaiting a paste.
       *
       * `origin` RIDES ALONG BUT MUST NEVER BE FETCHED — it matters only for the rows
       * that still have no URL, and for those the temptation is to close the gap with no
       * UI at all: try `<origin>/manifest.json`, promote whatever answers, done; the
       * origin holds no secrets, so it reads as free. It is not. By the same protocol
       * convention that puts the key in the path, the UNCONFIGURED add-on sitting at the
       * bare origin serves a manifest with the SAME id as the user's configured one. The
       * promotion would "succeed", the row would leave this list, and the user would be
       * left with an add-on that quietly returns no debrid streams and no hint why — the
       * silent failure this split exists to prevent, reintroduced one layer down. A row
       * the user is asked to knowingly re-paste is the honest state. */
      const installed = [...local];
      const unlinked: AddonRecord[] = [];
      /* Ids the server still lists that this device knows the account removed — i.e. a
       * DELETE that never landed. Collected here and re-issued below rather than adopted,
       * which is what lets a removal made offline finish on its own. */
      const undelivered: string[] = [];
      for (const r of (remote || [])) {
        const id = addonId(r);
        if (!id) continue;
        const mine = known.get(id);
        const installedAt = mine?.installedAt ?? (Date.parse(r.installedAt || '') || Date.now());
        if (gone({ id, manifest: r.manifest, installedAt })) { undelivered.push(id); continue; }
        if (mine?.url) continue;
        const manifest = r.manifest || mine?.manifest;
        if (!manifest) continue;
        if (r.url) installed.push({ id, url: r.url, manifest, installedAt });
        else unlinked.push({ id, url: '', origin: r.origin || mine?.origin, manifest, installedAt });
      }
      save(installed, unlinked, removed); set({ installed, unlinked, removed });
      /* Push any local-only add-ons up so the server matches. Rows the pull just adopted
       * are by definition already there, so this walks the PRE-merge list — reconciling
       * `installed` after the splice would POST every row the server just handed us
       * straight back to it.
       *
       * `local` IS THE TOMBSTONE-FILTERED LIST, and that is the whole fix on this side.
       * This loop is what used to resurrect removed add-ons for the entire account: it
       * reads "mine, and not on the server" as "the server has not been told", which for a
       * row the user deleted on another device is the exact opposite of the truth. */
      const remoteIds = new Set((remote || []).map(addonId));
      for (const a of local) if (!remoteIds.has(addonId(a))) serverInstall(a, owner);
      // Retried every pull for as long as the server keeps listing them. DELETE is
      // idempotent server-side, so a duplicate costs a request and nothing else.
      for (const id of undelivered) serverRemove(id, owner);
    } catch { /* offline / not authed — keep local */ }
  },
}));

/* The store follows the signed-in identity itself instead of waiting to be told to.
 * history/library take their reload() from an effect in App.tsx, and that is fine for
 * them — the worst a missed reload does there is show a stale list. Here the missed
 * reload IS the vulnerability: a sign-out that forgets to swap namespaces leaves the
 * previous account's collection in memory, and the next install()/pull writes it into
 * the new account's bucket and up to the new account's /api/addons. A fix for a bug of
 * omission cannot itself be reintroduced by omission, so it hangs off the auth store,
 * where every sign-in, sign-out and session expiry has to pass through one set().
 *
 * Firing from a subscriber also gets the ordering right for free: zustand notifies
 * synchronously inside auth's set(), i.e. before React re-renders and App's effect calls
 * pullFromServer(), so the pull always merges into the bucket that just loaded rather
 * than the one being left behind.
 *
 * Only the email is compared — auth writes `ready`, `config` and the modal flags through
 * the same store, and none of those should cost a localStorage round-trip. The initial
 * value is '' rather than email() because at module load /api/auth/me is still in flight
 * and the answer is always "guest"; when it lands, this swaps to the account's bucket and
 * every consumer re-renders off the store. */
let lastEmail = '';
useAuth.subscribe((s) => {
  const next = s.user?.email || '';
  if (next === lastEmail) return;
  lastEmail = next;
  useAddons.getState().reload();
});

/* THE CORE ARRIVES AFTER THE FIRST RENDER, AND ONE VIEW IS NOW DERIVED THROUGH IT.
 *
 * `listAddonCatalogs()` is synchronous — AddonRows calls it from a `useMemo` keyed on this
 * store's `installed` array — and since the port it answers by asking the core, which
 * answers [] until the wasm module has instantiated. That is a race the shell used to be
 * immune to and now is not: App's boot effect starts the core AFTER the first render, so
 * the first answer is reliably the empty one.
 *
 * The empty one would also be the LAST one. On a guest device nothing else ever changes
 * `installed`'s identity — the auth subscription above fires only when the email moves, and
 * for a guest it never does — so the memo would hold [] for the life of the page and a user
 * with community catalog add-ons would simply never see their rows. Silent, total, and
 * invisible to anyone whose core happens to load quickly.
 *
 * So: republish the list once, the moment the core is up. Same records, new array identity,
 * which is the whole signal — every consumer that derives through the core recomputes and
 * every consumer that does not is unaffected (the Add-ons screen renders `installed`
 * directly and re-renders identically). It fires ONCE and then unsubscribes, because after
 * the core is up every later change to the collection already mints a new array.
 *
 * It lives here rather than in addonClient because this is where the state is: a module
 * that reads the store nudging the store back is a loop waiting to be closed by accident. */
let republished = false;
const stopWatchingCore = subscribeCoreStatus(() => {
  if (republished || !coreReady()) return;
  republished = true;
  stopWatchingCore();
  useAddons.setState({ installed: [...useAddons.getState().installed] });
});
