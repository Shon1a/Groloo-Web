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
 * THE MANIFEST URL EXISTS ONLY ON THE DEVICE. By Stremio convention a configured
 * community add-on packs its secrets into the path (`https://host/<provider>=<KEY>/
 * manifest.json`), so the server deliberately persists the ORIGIN and never the URL —
 * there is no copy of the user's debrid key on that side to leak. The consequence for
 * this store is that a server record can NEVER be treated as a whole add-on: it is
 * metadata about one, missing the single field that makes it fetchable. Hence two
 * lists. `installed` holds records this device can actually call, and is the only
 * thing addonClient/AddonRows consume. `unlinked` holds ids the account owns
 * but this device has no URL for (a fresh device, or a record synced down after the
 * server stopped storing URLs); they are inert until the user pastes the URL again,
 * which install() treats as a repair rather than a duplicate. Keeping them apart is
 * what stops a sync from overwriting a working record with a URL-less one — the bug
 * that would have wiped every user's credentialed add-on off their own device.
 *
 * `unlinked` IS NOT AN INTERNAL DETAIL — THE ADD-ONS SCREEN HAS TO RENDER IT. Since the
 * server keeps `origin` and never `url`, EVERY row a second device pulls down arrives
 * URL-less, so on a freshly signed-in TV this list is the user's entire collection and
 * `installed` is empty. Re-pasting the URL is the only exit from it, and nobody pastes a
 * URL for an add-on they were never told is waiting. A non-empty `unlinked` that no view
 * shows is therefore indistinguishable from data loss to the person whose add-ons they
 * are — the storage half of this trade is only half the fix. Consumers want
 * `manifest.name` and `origin` (which is exactly why `origin` is carried through the
 * pull) plus the existing install() field to repair with. */

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

/* What GET /api/addons actually returns — deliberately NOT an AddonRecord. The server
 * keeps `origin` in place of `url` and stamps `installedAt` as an ISO string, so typing
 * the response as AddonRecord was a lie that let a URL-less row be spliced straight into
 * the collection with `url: undefined` behind a required `url: string`. Naming the wire
 * shape separately is what forces the merge below to convert rather than assume.
 *
 * Rows written before the server stopped storing URLs still carry one. It is left
 * undeclared, and so unread, on purpose: "the URL lives only on the device that typed
 * it" is worth having as a rule only if it holds without exception, and an exception
 * that depends on how old a row happens to be is the worst kind to reason about. */
interface ServerAddonRecord { id: string; origin?: string; installedAt?: string; manifest?: Manifest }

/* Both lists live in one localStorage array so the stored shape never forks — a record
 * that gets its URL back is the same row it always was, not a migration between keys.
 * The split happens on the way in, on the only thing that separates them: whether the
 * row carries a URL this device can call. */
function load(): AddonRecord[] {
  try { const l = JSON.parse(localStorage.getItem(storeKey()) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
function save(installed: AddonRecord[], unlinked: AddonRecord[]) {
  try { localStorage.setItem(storeKey(), JSON.stringify([...installed, ...unlinked])); } catch { /* quota */ }
}

/* Read the bucket belonging to whoever is signed in right now, performing the one-shot
 * hand-over described above on the way. Done as a raw string copy rather than a
 * parse/re-serialize so a bucket this build cannot make sense of still reaches its owner
 * intact instead of being silently flattened to `[]` by the tolerant reader below. */
function loadForIdentity(): AddonRecord[] {
  try {
    const key = storeKey();
    if (key !== GUEST_KEY && localStorage.getItem(key) === null) {
      const handover = localStorage.getItem(GUEST_KEY);
      if (handover !== null) { localStorage.setItem(key, handover); localStorage.removeItem(GUEST_KEY); }
    }
  } catch { /* private mode / quota — fall through and just read what we can */ }
  return load();
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

/* Best-effort server writes — local stays the source of truth if these fail. The URL
 * rides along on the POST because the server derives the origin from it; what it keeps,
 * and what comes back down on a GET, is that origin alone.
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
 *  "https://a.co/addon/manifest.json?x=1". By the Stremio convention documented at the top
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
  ...split(loadForIdentity()),
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
     * duplicate, and the server is left alone — it already holds this id (that is where
     * the URL-less row came from) and would answer 409. Without this branch the user
     * would have no way back: the duplicate check above would return silently forever. */
    const unlinked = get().unlinked.filter((a) => addonId(a) !== manifest.id);
    const repaired = unlinked.length !== get().unlinked.length;
    const next = [...get().installed, rec];
    save(next, unlinked); set({ installed: next, unlinked });
    if (!repaired) serverInstall(rec, owner);
  },
  // The only write in here with nothing to outlive: no await stands between the click and
  // the save, so the identity read for serverRemove is the one the user clicked under.
  remove: (id) => {
    const owner = identity();
    const installed = get().installed.filter((a) => a.id !== id);
    const unlinked = get().unlinked.filter((a) => a.id !== id);
    save(installed, unlinked); set({ installed, unlinked });
    serverRemove(id, owner);
  },
  reload: () => set(split(loadForIdentity())),
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
    set({ installed: [], unlinked: [] });
  },
  pullFromServer: async () => {
    if (!authed()) return;
    const owner = identity();
    try {
      const { addons: remote } = await api<{ addons: ServerAddonRecord[] }>('/api/addons');
      /* The list that just arrived describes the account that asked for it, which is not
       * necessarily the account signed in now. Nothing below awaits, so this single check
       * covers the save, the set and the reconcile push at the end. */
      if (!stillMine(owner)) return;
      const installed = get().installed;
      // Working records go in LAST so that if an id somehow sits in both lists, the one
      // holding the URL is what the skip below tests — the whole point of this function
      // is that a URL-less copy can never shadow a usable one.
      const known = new Map<string, AddonRecord>();
      for (const a of [...get().unlinked, ...installed]) { const id = addonId(a); if (id) known.set(id, a); }
      /* A pull can only ever ADD ids, never rewrite one this device already works with:
       * an id we hold a URL for is skipped outright, because the server copy carries
       * nothing we don't already have and dropping our record in favour of it would
       * destroy the only copy of the credentialed URL — and `save` would persist that
       * loss. Everything else lands in `unlinked` as metadata awaiting its URL.
       *
       * `origin` RIDES ALONG BUT MUST NEVER BE FETCHED. Dropping it, as this loop used
       * to, left a repair prompt with nothing to say beyond a manifest name. Keeping it
       * then makes it tempting to close the gap with no UI at all — try
       * `<origin>/manifest.json`, promote whatever answers into `installed`, done; the
       * origin holds no secrets, so it reads as free. It is not. By the same Stremio
       * convention that put the key in the path, the UNCONFIGURED add-on sitting at the
       * bare origin serves a manifest with the SAME id as the user's configured one. The
       * promotion would "succeed", the row would leave this list, and the user would be
       * left with an add-on that quietly returns no debrid streams and no hint why —
       * the silent failure this split exists to prevent, reintroduced one layer down. A
       * row the user is asked to knowingly re-paste is the honest state. */
      const unlinked: AddonRecord[] = [];
      for (const r of (remote || [])) {
        const id = addonId(r);
        const mine = id ? known.get(id) : undefined;
        if (!id || mine?.url) continue;
        const manifest = r.manifest || mine?.manifest;
        if (!manifest) continue;
        unlinked.push({ id, url: '', origin: r.origin || mine?.origin, manifest, installedAt: mine?.installedAt ?? (Date.parse(r.installedAt || '') || Date.now()) });
      }
      save(installed, unlinked); set({ unlinked });
      // push any local-only add-ons up so the server matches
      const remoteIds = new Set((remote || []).map(addonId));
      for (const a of installed) if (!remoteIds.has(addonId(a))) serverInstall(a, owner);
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
