import { loadCore, callData } from './heart';
import { useAddons, type AddonRecord } from '../stores/addons';
import type { MediaItem } from './types';

/* Client-direct add-on transport. The BROWSER fetches an installed add-on's streams and
 * catalogs DIRECTLY (the server is never involved) — that is what makes an installed
 * community add-on actually do something.
 *
 * WHAT THIS FILE IS NOW. The I/O is here; the PROTOCOL is in groloo-core. Most of what
 * used to parse, map, rank or build a path below has been deleted and routed at the Rust
 * core, per INCREMENT 2 of the roadmap. NOT all of it, and the exceptions are the point:
 * a twin is deleted only once a differential corpus proves the Rust answer is byte-identical
 * on that corpus, so anything the corpus has not cleared is still here, in TypeScript, doing
 * the work. What stays, stays for a stated reason:
 *
 *   fetchAddonText        an AbortController and a 20-second budget. The core is pure and
 *                         never gains a network call — it is handed the bytes and answers.
 *   collectAddonStreams   a Promise.all fan-out with a per-add-on catch. Scheduling, not
 *   fetchAddonCatalog     protocol.
 *   langName              i18n. A rendered string is never an FFI crossing (plan 06 §3):
 *                         'Add-on' and 'English' are translatable words and the core has
 *                         no locale to translate them in.
 *   qualityRank           still the only ordering the two DetailModal sort sites have.
 *                         `rank_streams` replaces them, but it answers {ranked, summary}
 *                         with indices and blocked reasons rather than a filtered array,
 *                         so adopting it is a UI rewrite and not a substitution.
 *   mapAddonStream        AND its three detectors — see the block above it. Parity is NOT
 *   + detectQuality       proven for this family: one unplanned divergence (U-coerce)
 *   + extractSize         blocks it, and the twin rule is absolute.
 *   + parseStreamLangs
 *   orderLangs            UN-DELETED. It was ported and then restored: the divergence that
 *   + LANG_ORDER          licensed the deletion (D-collate) is real, but the argument that
 *                         it is unreachable is false — see the long note at the function.
 *                         Same rule as mapAddonStream: no parity proof, no deletion.
 *
 * WHY THE DELETED HALVES HAVE NO JS FALLBACK. They used to be the fallback. Keeping a
 * second implementation alive "just in case the core is down" is exactly the drift this
 * increment exists to end: `addonBaseUrl` was `addon.rs:15` re-derived character for
 * character in another language, and nobody noticed for a year because both copies worked.
 * So the core is now LOAD-BEARING for the add-on protocol: no core, no community catalogs
 * and no community streams. That is a visible, bounded degradation — the official rows and
 * everything served by our own API are untouched — and heart.ts already makes it loud
 * (retry backoff, the corner badge, the Settings row). A silent second answer would not.
 *
 * The async entry points therefore `await loadCore()` and give up honestly; the one
 * synchronous entry point (listAddonCatalogs, called from a useMemo) answers [] until the
 * core is up, which is why stores/addons.ts republishes its list the moment it arrives. */

export interface AddonStream {
  source: string;
  label: string;
  quality: string;
  size: string | null;
  kind: 'hls' | 'url';
  url: string;
  langs: string[];
  subtitles?: Array<{ url: string; lang: string }>;
}

/* Display name for a stream/audio language code. Falls back to the uppercased code
 * so a language an add-on returns is never dropped. Deliberately shell-side: see the
 * header. */
const LANG_NAME: Record<string, string> = {
  en: 'English', ka: 'ქართული', uk: 'Українська', ru: 'Русский', es: 'Español',
  fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português', ja: '日本語',
  ko: '한국어', zh: '中文', ar: 'العربية', hi: 'हिन्दी', tr: 'Türkçe', pl: 'Polski', nl: 'Nederlands',
};
export const langName = (c: string): string => LANG_NAME[c] || c.toUpperCase();

/** UN-DELETED PENDING PARITY PROOF — do not re-delete without re-signing D-collate.
 *
 *  This is the original TypeScript, restored verbatim from `git show HEAD:` after review.
 *  It was deleted in favour of core #21 `order_langs` on the strength of a declared
 *  divergence, D-collate, whose JUSTIFICATION IS FALSE. The twin tie-breaks with
 *  `localeCompare` (ICU collation) and the core tie-breaks on byte order; the deletion was
 *  signed off on the claim that the two can never be handed an input that distinguishes
 *  them — "on inputs no code path can produce", because everything reaching this function
 *  is `[a-z]{2}`. That claim does not survive contact with the wire:
 *
 *    `behaviorHints.lang` is passed through VERBATIM AND UNNORMALIZED by both sides — by
 *    `mapAddonStream` below (`const langs = bh.lang ? [bh.lang] : …`) and by the core
 *    (`stream.rs:624`). An add-on shipping `behaviorHints:{lang:"PT-BR"}` therefore puts a
 *    non-`[a-z]{2}` token straight into `AddonStream.langs`, which the three `orderLangs`
 *    call sites in DetailModal.tsx hand to this function. Confirmed in a real browser
 *    against a manifest that does exactly that: the stream arrives with `langs:["PT-BR"]`,
 *    this code orders `['pt','PT-BR','en']` as `["en","pt","PT-BR"]` and the vendored wasm
 *    orders it `["en","PT-BR","pt"]`. The distinguishing input is not hypothetical — it is
 *    one third-party manifest away.
 *
 *  WHAT IS UNPROVEN, precisely: not that the core is wrong. Byte order is very probably the
 *  RIGHT answer for a core that has no locale and must agree on LG, Android and Chrome —
 *  `localeCompare` is not even stable across those three. What is unproven is that the two
 *  are INTERCHANGEABLE, which is the only thing that licenses a deletion. The corpus proves
 *  they differ; the sign-off said the difference was unreachable; it is reachable. Nobody
 *  has yet decided this on true facts, so the twin stays. Impact is cosmetic either way
 *  (language-tab order — no data loss, nothing unreachable), which is why this is a
 *  restoration and not an incident.
 *
 *  TO CLOSE IT, either: (a) lowercase/normalize `bh.lang` at the wire boundary in the core,
 *  which makes the `[a-z]{2}` premise TRUE instead of merely asserted, and then D-collate
 *  is a real no-op; or (b) re-sign D-collate on honest grounds — "byte order is chosen and
 *  the tab order for exotic tags may differ" — and correct the same false sentence in the
 *  three other places that repeat it: tests/parity/fixtures.mjs (WHY_COLLATE), rank.rs:92-96,
 *  and the core test `order_langs_pins_the_locale_compare_assumption`. Until one of those
 *  lands, this function is the implementation and `order_langs` has no call site here. */
const LANG_ORDER = ['en', 'ka', 'ru', 'uk'];
export function orderLangs(langs: string[]): string[] {
  return [...new Set(langs)].sort((a, b) => {
    const ia = LANG_ORDER.indexOf(a), ib = LANG_ORDER.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
}

const QRANK: Record<string, number> = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1 };
export const qualityRank = (q: string): number => QRANK[q] ?? 0;

const installed = (): AddonRecord[] => useAddons.getState().installed;

/* ── the core, three thin call sites ─────────────────────────────────────────── */

/** Core #11. The directory a resource path resolves against — everything up to and
 *  including the final '/'. Was `String(manifestUrl||'').replace(/[^/]*$/,'')`, which is
 *  `addon.rs:15` written out again in another language: the single duplication plan 06
 *  §2.5 cites as proof that "write it once" erodes without a gate. */
const addonBaseUrl = (manifestUrl: string): string =>
  callData<string>('addon_base_url', (c) => c.addon_base_url(manifestUrl)) ?? '';

/** Core #13. Does this add-on advertise `resource`, optionally for `type`? Short
 *  ('stream') and long ({name:'stream',…}) resource forms are handled identically, which
 *  is what the deleted `typeof r === 'string' ? r : r?.name` map was for. `''` is "any
 *  type" — an empty string rather than null so the wasm-bindgen signature stays `&str`. */
const hasResource = (a: AddonRecord, resource: string, type?: string): boolean =>
  callData<boolean>(
    'manifest_has_resource',
    (c) => c.manifest_has_resource(JSON.stringify(a?.manifest ?? {}), resource, type ?? ''),
  ) ?? false;

/** Core #20. `stream/series/tt0903747%3A1%3A4.json`. Replaces the two hand-built path
 *  expressions that used to sit at the two fetch sites below — the same expression written
 *  twice, which is how the stream one and the catalog one get to drift.
 *
 *  `mediaType` is the WIRE vocabulary (movie | series), never the /api/ one (movie | tv).
 *  For a catalog it is whatever token the add-on declared, passed through untouched: a
 *  catalog type is an add-on's own label, not a media kind. */
const resourcePath = (resource: string, mediaType: string, id: string): string =>
  callData<string>('addon_resource_path', (c) => c.addon_resource_path(resource, mediaType, id)) ?? '';

/* ── I/O ─────────────────────────────────────────────────────────────────────── */

/* The RAW TEXT, not the parsed body. The core parses — handing it `JSON.stringify(await
 * r.json())` would round-trip every response through JS's number formatting before the
 * core ever saw it, which is a second parser in the path and a place for bytes to change.
 * The 20s budget is unchanged and stays here: the core never gains a network call. */
async function fetchAddonText(base: string, path: string): Promise<string> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(base + path, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('addon ' + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}

/* ── streams: NOT PORTED, and this is the reason ─────────────────────────────────
 *
 * `stream_parse` (core #18) is the replacement for everything from here to
 * `mapAddonStream`, and the parity corpus will not authorise the swap: 35 fixtures match
 * byte for byte and one does not. A stream whose `name` is a NUMBER gets the label "5" and
 * plays under this code, and is dropped entirely by the core, which cannot deserialise the
 * record at all. That is one lost source per malformed add-on — unplanned, arguable in
 * either direction (the wire type could coerce, as LibraryItem.id already does), and not
 * something to decide inside a port. The twin rule is absolute: no parity proof, no
 * deletion. So this stays, verbatim, until the core takes a decision on U-coerce.
 *
 * Two behaviours the core would ALSO change, recorded here so the eventual swap is not a
 * surprise: a stream whose `url` is a number is passed straight through today (`s.url ||
 * ''` is truthy for a non-zero number) and becomes a <video src> that 404s; and a response
 * that is not JSON is indistinguishable from an add-on that genuinely has no sources. */

function detectQuality(t: string): string {
  t = (t || '').toLowerCase();
  if (/(2160|\b4k\b|uhd)/.test(t)) return '4K';
  if (/1080/.test(t)) return '1080p';
  if (/720/.test(t)) return '720p';
  if (/480/.test(t)) return '480p';
  return '';
}
function extractSize(t: string): string | null {
  const m = (t || '').match(/(\d+(?:\.\d+)?)\s?(gb|mb)/i);
  return m ? m[1] + ' ' + m[2].toUpperCase() : null;
}

const FLAG_LANG: Record<string, string> = { GB: 'en', US: 'en', AU: 'en', CA: 'en', IE: 'en', NZ: 'en', RU: 'ru', UA: 'uk', GE: 'ka', FR: 'fr', DE: 'de', IT: 'it', ES: 'es', MX: 'es', PT: 'pt', BR: 'pt', JP: 'ja', KR: 'ko', CN: 'zh', TR: 'tr', PL: 'pl', NL: 'nl' };
function parseStreamLangs(text: string): string[] {
  const out: string[] = [];
  const re = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ''))) {
    const cc = String.fromCharCode(m[1].codePointAt(0)! - 0x1F1E6 + 65) + String.fromCharCode(m[2].codePointAt(0)! - 0x1F1E6 + 65);
    const l = FLAG_LANG[cc] || cc.toLowerCase();
    if (l && out.indexOf(l) < 0) out.push(l);
  }
  return out;
}

interface RawStream { name?: string; title?: string; description?: string; url?: string; behaviorHints?: { streamType?: string; lang?: string }; subtitles?: Array<{ url?: string; lang?: string }> }

function mapAddonStream(s: RawStream, addonName: string): AddonStream | null {
  const label = [s.name, s.title, s.description].filter(Boolean).join('\n');
  const url = s.url || '';
  if (!url) return null;
  const bh = s.behaviorHints || {};
  const isHls = bh.streamType === 'hls' || /\.(m3u8|txt)(\?|$)/i.test(url) || /\/hls\//i.test(url);
  const flagLangs = parseStreamLangs(label);
  const langs = bh.lang ? [bh.lang] : (flagLangs.length ? flagLangs : ['en']);
  return {
    source: addonName,
    label: label || 'Source',
    quality: detectQuality(label),
    size: extractSize(label),
    kind: isHls ? 'hls' : 'url',
    url,
    langs,
    subtitles: Array.isArray(s.subtitles) ? s.subtitles.map((x) => ({ url: x.url || '', lang: x.lang || '' })).filter((x) => x.url) : undefined,
  };
}

/** Ask every installed stream add-on for its streams for one video id, in parallel,
 *  entirely in the browser. `videoId` is the IMDb id (or `tt…:season:episode`).
 *
 *  The fan-out, the timeout and the per-add-on catch are the shell's; which add-ons are
 *  asked (`manifest_has_resource`), where they are asked (`addon_base_url` +
 *  `addon_resource_path`) and — one decision away — what comes back are the core's. */
export async function collectAddonStreams(videoId: string, type: 'movie' | 'series'): Promise<AddonStream[]> {
  if (!(await loadCore())) return [];
  const addons = installed().filter((a) => hasResource(a, 'stream', type));
  if (!addons.length) return [];
  const path = resourcePath('stream', type, videoId);
  const per = await Promise.all(addons.map(async (a) => {
    try {
      const data = JSON.parse(await fetchAddonText(addonBaseUrl(a.url), path)) as { streams?: RawStream[] };
      return (data.streams || []).map((s) => mapAddonStream(s, a.manifest?.name || 'Add-on')).filter(Boolean) as AddonStream[];
    } catch { return []; }
  }));
  return per.flat();
}

/* ── catalogs: ported ────────────────────────────────────────────────────────── */

/** One catalog an installed add-on declares. Mirrors the core's `CatalogEntry`.
 *
 *  `name` IS OPTIONAL NOW, and that is a contract change worth reading twice. The deleted
 *  twin invented a display string — `c.name || a.manifest?.name || 'Add-on'` — and the core
 *  will not: an absent catalog name is an ABSENT FIELD and an absent add-on name is `''`,
 *  because 'Add-on' is a translatable word and the core has no locale (plan 06 §3, the same
 *  rule that keeps `langName` in this file). The obligation lands on the call site, and
 *  AddonRows.tsx:32 already discharges it — `str(c.name) || str(c.addonName) || 'Add-on'`,
 *  written for a different reason (a third party can ship `name: {}`) and correct for this
 *  one too. Any NEW consumer has to do the same or render a blank label. */
export interface AddonCatalog { addonId: string; addonName: string; type: string; id: string; name?: string; base: string }

/** Core #14. Enumerate the catalogs declared by installed community add-ons (add-ons with
 *  no catalog resource are skipped). Each becomes a home row.
 *
 *  SYNCHRONOUS, and therefore [] until the core is up — AddonRows calls it from a useMemo
 *  keyed on the installed list, which on a guest device never changes identity again after
 *  boot. That is why stores/addons.ts republishes the list once the core arrives; without
 *  it, an empty first answer would be the last answer and the add-on rows would simply
 *  never appear. */
export function listAddonCatalogs(): AddonCatalog[] {
  // Exactly the three fields the core is allowed to see. Sending whole AddonRecords would
  // hand it `installedAt` and `origin`, which are the shell's bookkeeping and not protocol.
  const records = installed().map((a) => ({ id: a.id, url: a.url, manifest: a.manifest }));
  return callData<AddonCatalog[]>('addon_catalogs', (c) => c.addon_catalogs(JSON.stringify(records))) ?? [];
}

/** Core #19. Fetch one catalog's items (poster-card shape) directly from the add-on.
 *
 *  The mapping is the core's now, and it fixes two things the deleted `mapCatalogMeta` got
 *  wrong. An add-on that labels a show `"tv"` used to fail a strict equality against
 *  `'series'` and come back typed `movie` — a film's chrome on a series card, and its
 *  streams then requested from `stream/movie/…`, which answers nothing; the core routes
 *  every token through one `movie | series` vocabulary in which `tv`, `series` and `show`
 *  are all series. And a single `null` in the `metas` array used to throw out of the map,
 *  land in the catch below and cost the user THE WHOLE ROW; the core reads the array
 *  leniently, so one bad record costs itself.
 *
 *  The `catch` stays and now means only what it says — the fetch failed. A body that is not
 *  JSON no longer looks like an add-on with nothing to offer: it comes back ok:false and
 *  heart.ts logs it once. */
export async function fetchAddonCatalog(c: AddonCatalog): Promise<MediaItem[]> {
  if (!(await loadCore())) return [];
  try {
    const body = await fetchAddonText(c.base, resourcePath('catalog', c.type, c.id));
    return callData<MediaItem[]>('catalog_metas', (k) => k.catalog_metas(body)) ?? [];
  } catch { return []; }
}
