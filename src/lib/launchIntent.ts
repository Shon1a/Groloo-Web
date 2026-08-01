import { useModal, type ModalTarget } from '../stores/modal';
import type { MediaItem } from './types';

/* ONE ADDRESS SHAPE FOR A TITLE, AND ONE RESOLVER.
 *
 * Until now nothing in the catalog had an address. A title opens because a card called
 * `useModal.open()` (stores/modal.ts) — pure overlay state, no route, nothing in the URL. That
 * is invisible on a desktop, where you always arrive at a title by clicking one, and fatal on a
 * TV: both platforms' re-engagement paths hand the app a payload naming a title and expect it to
 * resolve. Android TV fires an ACTION_VIEW intent; webOS delivers a JSON `params` object on the
 * launch event. Neither carries a URL into the SPA, and today there is no function for either to
 * call. `ares-launch --params` and `adb am start` are also the only executable proofs a deep link
 * works, so without an address there is nothing to test against either.
 *
 * THE OVERLAY STAYS AN OVERLAY. This deliberately does NOT add a route. HashRouter is untouched,
 * `disableBackHistoryAPI: true` still stands, and Back keeps resolving through the store order
 * (vp-menu -> EpisodePanel -> player.close -> modal.close -> ...). A launch intent is an *input*
 * that produces exactly the state a click produces. A route-backed modal would contradict TV-DB
 * — see tv-plan/05-tv-readiness.md A.6, which specifies this file.
 *
 * THE HOST HAS TO ANSWER `/t/…`. Routing is otherwise hash-based precisely so no server config
 * is needed, and `/t/…` is the only real path the app owns — hence the single narrow rewrite in
 * vercel.json (`/t/(.*)` -> /index.html) rather than a catch-all, which would turn every typo
 * into a shell that silently redirects home instead of a 404. JSON takes no comments, so the
 * reason for that rule lives here.
 *
 * TYPE IS IN THE PATH, and that is the one deviation from the shape A.6 sketched (`/t/<id>`).
 * Ids are not self-describing: /api/meta/:id takes either an IMDb id (`tt0111161`, which the
 * server resolves for both films and shows) or a bare TMDB number — and a TMDB number means a
 * different title depending on `?type=`. `/t/1399` alone would fall through to /movie/1399 and
 * 404. So the type rides in the path where it survives copy/paste, and the parser stays lenient:
 * a typeless `/t/<id>` still resolves, exactly as a card with no `type` does today. */

// NonNullable: MediaItem['type'] is optional, and a type-guard's predicate cannot widen to
// include undefined. Optionality belongs on the fields below, not in the union itself.
export type MediaKind = NonNullable<MediaItem['type']>; // 'movie' | 'tv' | 'series'

export interface MediaAddress {
  id: string;
  type?: MediaKind;
  season?: number;
  episode?: number;
}

/** The wire contract the TV shells post in. `mediaId` is the media KEY, not a path — that is
 *  what webOS launch params and an Android intent extra carry, and it matches the key format
 *  history.ts already stores positions against. */
export interface LaunchIntent {
  mediaId: string;
  type?: MediaKind;
  /** `play`/`resume` are accepted so the TV carriers have a stable contract to target; both
   *  currently land on the same place `open` does — the detail overlay, whose primary button
   *  already reads "Resume · N min" and seeks on its own (VideoPlayer reads getResume). Auto-
   *  starting playback from a cold launch belongs with the webOS/Android shells, not here. */
  action?: 'open' | 'play' | 'resume';
}

const KINDS = ['movie', 'tv', 'series'] as const;
const isKind = (s: string): s is MediaKind => (KINDS as readonly string[]).includes(s);

/* ---- media key <-> address --------------------------------------------------------------
 * The key format is the app's own, already in use at DetailModal.tsx (`buildMediaFor`) and
 * history.ts: `<id>` for a film, `<id>:S<season>E<episode>` for an episode. Reusing it means no
 * new identifier space appears anywhere in the stack. */

const KEY_RE = /^(.+?):S(\d+)E(\d+)$/;

export function parseMediaKey(key: string): MediaAddress | null {
  const raw = key.trim();
  if (!raw) return null;
  const m = KEY_RE.exec(raw);
  if (!m) return { id: raw };
  return { id: m[1], season: Number(m[2]), episode: Number(m[3]) };
}

export function mediaKey(a: MediaAddress): string {
  return a.season != null && a.episode != null ? `${a.id}:S${a.season}E${a.episode}` : String(a.id);
}

/* ---- address <-> path ------------------------------------------------------------------- */

/** `/t/movie/tt0111161`, `/t/series/1399/s2/e4`, or `/t/<id>` when the type is unknown. */
export function mediaPath(a: MediaAddress): string {
  const head = a.type ? `/t/${a.type}/${encodeURIComponent(String(a.id))}` : `/t/${encodeURIComponent(String(a.id))}`;
  return a.season != null && a.episode != null ? `${head}/s${a.season}/e${a.episode}` : head;
}

/** Absolute, hash-free — what a share button hands to the clipboard. */
export function mediaUrl(a: MediaAddress): string {
  const origin = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : '';
  return origin + mediaPath(a);
}

/**
 * Accepts every carrier that can name a title: a bare path (`/t/...`), a full https URL, the
 * hash form (`#/t/...`) so a link survives a host with no rewrite, and the custom scheme
 * (`groloo://t/...`) that the Android intent-filter and Tizen app-control will mirror.
 * Returns null for anything that is not a title address — this is the only gate, so it must
 * never guess.
 */
export function parseMediaPath(input: string): MediaAddress | null {
  if (!input) return null;
  let s = input.trim();
  // strip a scheme + host: groloo://t/… , https://web.groloo.com/t/…
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) {
    const rest = s.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    // `groloo://t/tt123` puts `t` in the HOST position, not the path — accept both spellings
    s = slash === -1 ? `/${rest}` : (rest.slice(0, slash) === 't' ? `/${rest}` : rest.slice(slash));
  }
  s = s.split('?')[0];
  if (s.startsWith('#')) s = s.slice(1);
  const parts = s.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] !== 't') return null;

  let i = 1;
  let type: MediaKind | undefined;
  if (parts[i] && isKind(parts[i])) { type = parts[i] as MediaKind; i += 1; }
  const id = parts[i];
  if (!id) return null;
  i += 1;

  // optional /s<n>/e<n>. Both or neither — a season with no episode is not an address.
  const sm = parts[i] ? /^s(\d+)$/i.exec(parts[i]) : null;
  const em = parts[i + 1] ? /^e(\d+)$/i.exec(parts[i + 1]) : null;
  if (sm && em) return { id, type, season: Number(sm[1]), episode: Number(em[1]) };
  return { id, type };
}

/* ---- applying an address ----------------------------------------------------------------- */

function targetFor(a: MediaAddress): ModalTarget {
  return {
    id: a.id,
    type: a.type,
    // A deep link carries no card data, so the modal opens on its loading veil and fills in
    // from /api/meta — the same path a card takes once its seeded fields are exhausted.
    seed: 0,
    resumeEp: a.season != null && a.episode != null ? { season: a.season, episode: a.episode } : undefined,
  };
}

/**
 * THE one entry point every carrier calls: the web bootstrap below, webOS's `launchParams()` /
 * `webOSRelaunch`, and the Android bridge message. Ignores a repeat of the title already open —
 * LG documents that `launch` may be called repeatedly with different params, so a relaunch can
 * arrive for a title the user is already looking at, and re-opening would reset their episode.
 */
export function applyLaunchIntent(intent: LaunchIntent): boolean {
  const parsed = parseMediaKey(intent.mediaId);
  if (!parsed) return false;
  const address: MediaAddress = { ...parsed, type: intent.type ?? parsed.type };
  const cur = useModal.getState().target;
  if (cur && String(cur.id) === String(address.id) && cur.resumeEp?.season === address.season && cur.resumeEp?.episode === address.episode) return true;
  useModal.getState().open(targetFor(address));
  return true;
}

/** Same, from an address rather than a key — what the URL path produces. */
export function applyMediaAddress(a: MediaAddress): boolean {
  return applyLaunchIntent({ mediaId: mediaKey(a), type: a.type });
}

/* ---- the web carrier: read the incoming URL once, then own the address bar --------------- */

/* Where the URL returns to when the overlay closes. Fixed at boot because HashRouter never
 * touches `location.pathname` — in-app navigation moves the hash only — so the path the page
 * loaded at IS the app's base for the whole session. A deep-linked load resets it to the site
 * root so closing the title lands on Home rather than back on the title's own address. */
let basePath = '/';

const canWriteUrl = () =>
  typeof history !== 'undefined' && typeof history.replaceState === 'function'
  // A packaged TV app runs from file:// (webOS IPK, Android asset load) where replaceState to an
  // absolute path throws SecurityError, and where the address bar does not exist to read anyway.
  && typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/**
 * One-shot, at load, BEFORE React mounts — so the store already holds the target on first
 * render and DetailModalGate's `everOpened` latches true without a flash of the empty overlay.
 */
export function bootLaunchIntent(): void {
  if (typeof location === 'undefined') return;
  const root = (import.meta.env.BASE_URL || '/');
  const fromPath = parseMediaPath(location.pathname);
  const fromHash = fromPath ? null : parseMediaPath(location.hash);
  const addr = fromPath ?? fromHash;

  if (!addr) {
    /* A path under the title namespace that does not parse — `/t/movie` with no id, a truncated
     * paste — is still rewritten to the app by the host, so it arrives here. Treat it as the
     * root rather than adopting it: keeping it would leave the address bar on a dead URL and,
     * worse, make it the place closing a title later returns to. */
    basePath = parseMediaPath(location.pathname) === null && /^\/t(\/|$)/.test(location.pathname) ? root : (location.pathname || root);
    return;
  }

  basePath = root;
  applyMediaAddress(addr);
  /* A deep-linked cold start has no back-stack, so the first Back would leave the site. Seed
     the app's own home entry: the hash goes to `#/` (the address lives in the PATH, so the
     hash form must be cleared or HashRouter would route to a title path and bounce off the
     `*` redirect), and syncAddressBar re-states the title path a beat later. */
  if (fromHash && canWriteUrl()) {
    try { history.replaceState(null, '', `${basePath}${location.search}#/`); } catch { /* non-fatal */ }
  }
}

/**
 * Keeps the address bar honest while the overlay is open: a title showing means its address is
 * in the URL, so it can be copied, bookmarked and refreshed back into. `replaceState` rather
 * than `pushState` deliberately — a pushed entry would make the browser Back button close the
 * modal, which is the route-backed behaviour A.6 rules out, and would desynchronise from the
 * TV back chain where the same close has to happen without any history at all.
 *
 * HashRouter is unaffected: it reads `location.hash`, which this never touches, and
 * replaceState fires no popstate.
 */
export function syncAddressBar(target: ModalTarget | null): void {
  if (!canWriteUrl()) return;
  const path = target
    ? mediaPath({ id: String(target.id), type: target.type, season: target.resumeEp?.season, episode: target.resumeEp?.episode })
    : basePath;
  if (location.pathname !== path) {
    try { history.replaceState(null, '', `${path}${location.search}${location.hash}`); } catch { /* non-fatal */ }
  }
  mirrored = location.href;
}

/* THE URL THIS FILE LAST MIRRORED, for the browser-Back trap in tvKeys.
 *
 * Because nothing here pushes a history entry, a browser Back pressed while a title is open pops
 * straight past it to whatever page preceded the modal. tvKeys catches that and re-states this
 * address instead, so the press reaches the app's own back chain rather than leaving the screen.
 * It has to be recorded rather than recomputed: by the time popstate fires, `location` is already
 * the previous entry and both the path AND the hash have moved. */
let mirrored = '';
export const mirroredHref = (): string => mirrored;
