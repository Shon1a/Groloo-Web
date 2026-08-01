/* ------------------------------------------------------------------ *
 *  WHO IS ASKING — the self-description a TV sends with /api/auth/link/new.
 *
 *  It is rendered on the phone's confirmation screen under a fixed, server-authored
 *  prefix ("The device asking is described as:"), and it is the ONLY thing a user has
 *  to go on when deciding whether the code on their screen belongs to the box in front
 *  of them. So it has to be honest and it has to be short: three fields, each clamped
 *  to 40 characters by sanitizeDeviceInfo in Groloo-server/server/auth.js, which is the
 *  authority — nothing produced here is trusted over there.
 *
 *  `platform` is a CLOSED enum on the server (webos / androidtv / tizen / browser /
 *  other) because it drives copy on the claim page; anything else is folded to 'other'.
 *  Detection is by user-agent, which is a weak signal everywhere else in this app and
 *  an acceptable one here: it is decoration on a screen whose real security comes from
 *  the two-secret split, not an authorization input. A TV that lies about being a TV
 *  gains nothing — the human still has to approve it.
 *
 *  webOS and Tizen both ship a UA that says so. Android TV does not reliably: the
 *  Android WebView shell is a WebView, and "Android" alone is a phone. The shell is
 *  expected to set `window.GROLOO_TV` (see the Kotlin bridge) and that is checked
 *  first — a positive claim from our own shell beats sniffing.
 * ------------------------------------------------------------------ */

export type LinkPlatform = 'webos' | 'androidtv' | 'tizen' | 'browser' | 'other';
export interface LinkDeviceInfo { platform: LinkPlatform; model: string; label: string }

/** What the native shell may declare about itself. Every field optional — a shell that
 *  sets nothing degrades to UA sniffing rather than to a wrong answer. */
interface TvBridge { platform?: string; model?: string; label?: string }
const bridge = (): TvBridge =>
  ((window as unknown as { GROLOO_TV?: TvBridge }).GROLOO_TV) || {};

const PLATFORMS: readonly LinkPlatform[] = ['webos', 'androidtv', 'tizen', 'browser', 'other'];
const isPlatform = (v: string): v is LinkPlatform => (PLATFORMS as readonly string[]).includes(v);

function detectPlatform(ua: string): LinkPlatform {
  const declared = String(bridge().platform || '').trim().toLowerCase();
  if (isPlatform(declared)) return declared;
  if (/web0?os|webappmanager/i.test(ua)) return 'webos';
  if (/tizen|smart-?tv/i.test(ua)) return 'tizen';
  /* "Android TV" is in the UA of a properly configured Android TV WebView; the bare
   * "Android" fallback deliberately is NOT treated as a TV, because a phone opening the
   * web build would then describe itself as one on somebody's confirmation screen. */
  if (/android\s*tv|googletv/i.test(ua)) return 'androidtv';
  // The TV BUILD running somewhere we could not name is still more useful as 'other'
  // than as 'browser': it is definitely not the web app someone opened on a laptop.
  return import.meta.env.MODE === 'tv' ? 'other' : 'browser';
}

/* A model string, best-effort. LG puts its model in the UA on webOS 5+; Samsung's Tizen
 * UA carries a year token rather than a model. Anything we cannot read stays EMPTY —
 * inventing "Smart TV" here would put a manufactured fact on a security screen, and an
 * absent line reads better than a confident wrong one. */
function detectModel(ua: string): string {
  const declared = String(bridge().model || '').trim();
  if (declared) return declared.slice(0, 40);
  const lg = /\bwebOS\.TV-([A-Z0-9-]+)/i.exec(ua);
  if (lg) return lg[1].slice(0, 40);
  const tizen = /\bTizen[/ ]?([\d.]+)/i.exec(ua);
  if (tizen) return `Tizen ${tizen[1]}`.slice(0, 40);
  return '';
}

/** The device descriptor to POST to /api/auth/link/new. Cheap and synchronous; call it
 *  at request time rather than caching, so a shell that sets the bridge late still wins. */
export function linkDeviceInfo(label = ''): LinkDeviceInfo {
  const ua = navigator.userAgent || '';
  return {
    platform: detectPlatform(ua),
    model: detectModel(ua),
    // A user-chosen room name ("Living room") would go here. Nothing sets one yet, and
    // the bridge may; the parameter exists so a settings field can feed it later.
    label: (label || String(bridge().label || '')).trim().slice(0, 40),
  };
}
