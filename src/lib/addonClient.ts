import { loadCore, callData } from './heart';
import { useAddons, type AddonRecord } from '../stores/addons';
import { useBlocks, addonKey } from '../stores/blocks';
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
  /** AUDIO languages. See `classifyStreamLangs` — the flags in a release title are very
   *  often the SUBTITLE list, and counting those here is what put a 🇷🇺 tab on a file
   *  that has no Russian audio in it. */
  langs: string[];
  /** SUBTITLE languages the release advertises, when they could be told apart from the
   *  audio ones. Not playable on their own — these live inside the container — but they
   *  are the difference between "no Russian here" and "Russian, but as subtitles". */
  subLangs?: string[];
  subtitles?: Array<{ url: string; lang: string }>;
}

/* Display name for a stream/audio language code. Falls back to the uppercased code
 * so a language an add-on returns is never dropped. Deliberately shell-side: see the
 * header. */
const LANG_NAME: Record<string, string> = {
  en: 'English', ka: 'ქართული', uk: 'Українська', ru: 'Русский', es: 'Español',
  fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português', ja: '日本語',
  ko: '한국어', zh: '中文', ar: 'العربية', hi: 'हिन्दी', tr: 'Türkçe', pl: 'Polski', nl: 'Nederlands',
  id: 'Bahasa', ms: 'Melayu', th: 'ไทย', vi: 'Tiếng Việt', tl: 'Filipino', he: 'עברית',
  sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi', cs: 'Čeština', el: 'Ελληνικά',
  ro: 'Română', hu: 'Magyar', bg: 'Български', sr: 'Српски', hr: 'Hrvatski',
  // the file's own audio, where the release never said what it is — see classifyStreamLangs
  und: 'Original',
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

/* Every add-on the account has installed, MINUS the ones it has hidden.
 *
 * This is the one choke point both surfaces run through — listAddonCatalogs and
 * collectAddonStreams each start here — so the block list is applied once, in the place
 * that cannot be forgotten by a future consumer, rather than at each call site. That
 * matters more than the tidiness: Play's UGC policy asks for a blocking mechanism, and a
 * block that hides an add-on's row but still asks it for streams has not blocked
 * anything. Hiding is total by construction because there is nowhere else to look.
 *
 * BLOCKED BY ORIGIN, not by manifest id, matching the store and the server: the same
 * content reappearing under a new id from the same host stays hidden. A record whose URL
 * will not parse is treated as unblocked — it has no origin to match, and silently
 * hiding a row nothing can name would be a bug with no way for the user to undo it.
 *
 * Hidden add-ons are deliberately still INSTALLED: they keep their configuration and the
 * credentialed URL this device may hold the only copy of, and the Add-ons screen still
 * lists them so the user can unhide. Only what they surface goes away. */
const installed = (): AddonRecord[] => {
  const rows = useAddons.getState().installed;
  const { blocked } = useBlocks.getState();
  // Fast path: nothing hidden is the overwhelmingly common case, and it should not cost a
  // URL parse per add-on on every catalog enumeration (listAddonCatalogs is synchronous
  // and runs from a useMemo on the home screen).
  if (!Object.keys(blocked).length) return rows;
  return rows.filter((a) => {
    let origin = a.origin;
    if (!origin) { try { origin = new URL(a.url).origin; } catch { return true; } }
    return blocked[addonKey(origin)] === undefined;
  });
};

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

/* Flag → audio language. UNMAPPED CODES FALL THROUGH AS THEMSELVES (`cc.toLowerCase()`
 * below), which is deliberate — an add-on's language is never dropped — but it is also why
 * the gaps here are visible in the UI: a Torrentio multi-audio release lists 🇮🇩🇲🇾🇸🇦🇹🇭🇹🇼,
 * all of which miss this table and surface as raw "ID" / "MY" / "SA" / "TH" / "TW" buckets
 * beside the named ones (🇹🇼 is the costly one — it splits Chinese across two tabs instead
 * of folding into `zh`).
 *
 * FILLING THE GAPS IS NOT A ONE-LINE EDIT, which is why they are still here. This table is
 * a pinned twin: `tests/parity/twins.mjs` STILL_ON_DISK re-reads this declaration and
 * refuses to run the corpus unless it is character-identical to the copy at PRE_PORT_REV
 * (0dd5447c9ba2), because the `stream_parse` family is driven through the QUOTED revision
 * of `collectAddonStreams`. Adding a row here reds the gate with a message about the Rust.
 * To do it: add the same rows to `FLAG_LANG` in `Groloo-core/.../stream.rs` (whose doc
 * comment pins the count — "all 22 entries, same order"), then re-point PRE_PORT_REV in
 * the SAME commit. The buckets are cosmetic; the audio actually played is not, and that is
 * fixed in the player. */
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

/* ── flags are not always audio ────────────────────────────────────────────────────
 *
 * `parseStreamLangs` above scrapes every flag emoji out of a release title and hands
 * them all back as the stream's languages, and `mapAddonStream` puts them straight into
 * `AddonStream.langs`, which the UI presents as AUDIO tabs. For most add-ons that is
 * right. For the one everybody actually installs it is wrong, and wrong in the way that
 * wastes the most of a user's time: they pick Русский, the same file plays, and it plays
 * Japanese.
 *
 * Torrentio's caption has a tag line before the flags, and the tags say what the flags
 * ARE. Recorded from a real response (`/stream/series/tt21209876:2:1.json`, 50 streams):
 *
 *   "Multi Subs / 🇬🇧 / 🇨🇳 / 🇮🇩 / 🇲🇾 / 🇹🇭"                      ← 5 SUBTITLE tracks
 *   "Dubbed / 🇬🇧"                                                ← 1 AUDIO track
 *   "Dubbed / Multi Subs / Dual Audio / 🇬🇧 / 🇷🇺 / 🇮🇹 / …13 flags" ← 2 audio, 13 subs
 *   "Dubbed / Dual Audio / 🇬🇧 / 🇷🇺 / 🇮🇹 / …12 flags"             ← 2 audio, 12 subs
 *
 * Of those 50 streams, 23 carried a subs tag and NOT ONE mentioned Russian audio — every
 * 🇷🇺 in the whole response was a subtitle. The old reading turned that single response
 * into thirteen audio tabs (the "ID"/"MY"/"SA"/"TH"/"TW" ones in the screenshot are the
 * same list), of which twelve were fiction.
 *
 * The two clauses after the subs tag are the ones worth explaining, because both catch
 * releases whose tag line never says "Subs" and whose flags are subtitles anyway:
 *
 *   · "Dual Audio" is a claim about the file — TWO audio tracks — so a dozen flags beside
 *     it cannot be describing audio. Both DBMS rips above are real and neither says
 *     "Subs"; the count against the tag is the only thing that gives them away.
 *   · No audio tag AT ALL and more than three flags. Torrentio emits "Dubbed" / "Dual
 *     Audio" / "Multi Audio" whenever it believes a release has a non-original audio
 *     track, so a bare list of eight flags with none of those tags is a subtitle list:
 *     `"[jaaj] Solo Leveling S02 (BD 1080p AV1 AAC)" … 🇬🇧/🇷🇺/🇵🇹/🇪🇸/🇲🇽/🇨🇳/🇫🇷/🇩🇪`
 *     is a 348 MB BD rip, and eight dubs is not what that is.
 *
 * THREE IS THE THRESHOLD AND NOT TWO, because genuine untagged multi-audio releases do
 * exist and they are small: `"Solo Leveling S02e01-13 [1080p Ita Eng Spa Jap h265 SubS]
 * byMe7alh [MIRCrew]" … 🇬🇧/🇮🇹/🇪🇸` really does carry Italian, English and Spanish audio
 * beside the Japanese — it says so in the release name — and it must keep them. */
const SUBS_TAG = /multi[\s-]?subs?\b|\bm-?subs?\b|\bsubtitles?\b/i;
const DUAL_AUDIO_TAG = /dual[\s.-]?audio/i;
const MULTI_AUDIO_TAG = /(multi|tri|triple)[\s.-]?audio/i;
const DUB_TAG = /\bdubbed\b|\beng(lish)?[\s.-]?dub\b/i;

/** ISO 639-2 "undetermined": the file's own audio, whatever it is. A release that
 *  advertises only its subtitle languages has told us nothing about its audio, and this
 *  is how the UI says that out loud instead of guessing a flag off the subtitle list. */
export const UNDETERMINED = 'und';

/* Words a release name uses for the language it was DUBBED INTO, and the code each means.
 * `latino` and `castellano` are both Spanish here; `mandarin` and `cantonese` are both
 * `zh`, matching what LANG_NAME can render. */
const DUB_WORDS: Record<string, string> = {
  english: 'en', eng: 'en', russian: 'ru', rus: 'ru', ukrainian: 'uk', ukr: 'uk',
  georgian: 'ka', german: 'de', ger: 'de', deutsch: 'de', french: 'fr', fre: 'fr',
  spanish: 'es', spa: 'es', castellano: 'es', latino: 'es', italian: 'it', ita: 'it',
  portuguese: 'pt', por: 'pt', brazilian: 'pt', japanese: 'ja', jpn: 'ja',
  korean: 'ko', kor: 'ko', chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
  arabic: 'ar', ara: 'ar', hindi: 'hi', turkish: 'tr', thai: 'th', indonesian: 'id',
  polish: 'pl', dutch: 'nl', hebrew: 'he', vietnamese: 'vi',
};
/* Chinese releases mark the dub in the title rather than in words a Latin-alphabet regex
 * would find: 台配 (Taiwan dub), 國語/国语 (Mandarin), 中文配音/中配 (Chinese dubbing). */
const CJK_DUB = /台配|國語|国语|中文配音|中配|粵語|粤语/;

/** The language(s) a release NAME says it is dubbed into — not the flags beside it.
 *
 *  Read backwards from each "dub"/"dubbed"/"audio" for a language word within 32
 *  characters, which is what makes "(Mandarin Chinese Dub)" resolve while "Dual Audio"
 *  and "[Tri Audio]" — quantities, not languages — resolve to nothing. */
export function namedAudioLangs(label: string): string[] {
  const t = label || '';
  const out: string[] = [];
  if (CJK_DUB.test(t)) out.push('zh');
  const re = /\b(dub|dubs|dubbed|audio)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 32), m.index).toLowerCase();
    for (const w of Object.keys(DUB_WORDS)) {
      if (new RegExp(`\\b${w}\\b`).test(before) && out.indexOf(DUB_WORDS[w]) < 0) out.push(DUB_WORDS[w]);
    }
  }
  return out;
}

/* Markers that a Russian-scene release carries a Russian voice-over: the dub-crew
 * shorthand (MVO/DVO/AVO = multi-, two- and one-voice; P1/P2 = one- and two-voice), the
 * Russian words for it, and the big release groups. */
const RU_VO = /\b(mvo|dvo|avo|p1|p2)\b|дубляж|дублирован|озвуч|многоголос|одноголос|двухголос|лостфильм|кубик\s*в\s*кубе|hdrezka/i;
const UK_VO = /\bukr\b|українськ|укр\.|дубляж\s*укр/i;
const CYRILLIC = /[Ѐ-ӿ]/;

/** The language whose track is most likely to be the DEFAULT one — the one that plays if
 *  nobody selects anything.
 *
 *  This is the signal that was missing, and the flags are actively misleading without it.
 *  A Russian release captions as
 *
 *    "Дом Дракона / House of the Dragon [03х01-07 из 08] (2026) WEBRip 1080p | P2 | …"
 *    🇬🇧 / 🇷🇺
 *
 *  and the 🇬🇧 is real — the original English track IS in the file. It is simply not the
 *  track that plays. Worse, `"… MVO (Syncmer) + Original + Sub (Rus Eng)"` captions with
 *  🇬🇧 ALONE, which reads as a single English audio track and is a Russian multi-voice-over
 *  with the original kept beside it.
 *
 *  A release NAME written in Cyrillic is a Russian-scene release, and its default audio is
 *  Russian. That single fact is worth more than the whole flag list. Ukrainian is checked
 *  first because it is Cyrillic too and would otherwise be swallowed by the Russian rule. */
export function primaryAudioLang(label: string): string | null {
  const t = label || '';
  const named = namedAudioLangs(t);
  if (named.length === 1) return named[0];
  if (UK_VO.test(t)) return 'uk';
  if (RU_VO.test(t) || CYRILLIC.test(t)) return 'ru';
  return null;
}

/** Does this release carry exactly ONE audio track?
 *
 *  `langs.length === 1` alone is not enough and the difference is the whole point: a
 *  caption reading `Dubbed / Dual Audio / 🇬🇧` yields one language and TWO tracks, because
 *  the flag names the dub and the tag says the original is in there beside it. Only a
 *  release with one language AND no dual/multi tag is one where the language you asked for
 *  is necessarily the track that plays — which is the only thing a browser that cannot
 *  switch audio tracks can actually deliver. */
export function isSingleAudioTrack(s: AddonStream): boolean {
  return s.langs.length === 1 && !DUAL_AUDIO_TAG.test(s.label) && !MULTI_AUDIO_TAG.test(s.label);
}

/** Re-read one mapped stream, separating the audio languages from the subtitle ones.
 *
 *  Only called where `behaviorHints.lang` was absent — that field is the add-on stating
 *  the audio language on the wire, and a guess read out of a title never outranks it.
 *
 *  A stream whose audio cannot be determined comes back as `['und']` (plus `'en'` when
 *  the label claims a dub: "Dubbed", "Dual Audio" and "Eng Dub" all mean an English track
 *  alongside the original, which is the near-universal convention on these trackers).
 *  That is a smaller claim than the old code's and an honest one — the alternative is
 *  putting the file in thirteen language buckets and hoping. */
export function classifyStreamLangs(s: AddonStream): AddonStream {
  const t = s.label;
  const flags = parseStreamLangs(t);
  const named = namedAudioLangs(t);
  const dual = DUAL_AUDIO_TAG.test(t), multi = MULTI_AUDIO_TAG.test(t), dubbed = DUB_TAG.test(t);
  const flagsAreSubs = SUBS_TAG.test(t)
    || (dual && !multi && flags.length > 2)
    || (!dual && !multi && !dubbed && flags.length > 3);

  /* A RELEASE THAT NAMES ITS DUB OUTRANKS ITS OWN FLAG LIST, and this clause is the whole
   * reason `namedAudioLangs` exists. Torrentio captions
   *
   *   "[Furretar] 台配 - 我独自升级 (Solo Leveling) (Mandarin Chinese Dub) (Matching Soft Subs)"
   *
   * as `Dubbed / 🇬🇧 / 🇨🇳`, and reading those two flags as two audio tracks puts a Mandarin
   * dub in the ENGLISH bucket. Pick English, get Chinese — which is exactly what it did,
   * and the 🇬🇧 is the "Matching Soft Subs" the title mentions. The name is unambiguous
   * where the flags are not, so the named languages become the audio and every flag that
   * is not one of them drops to `subLangs`.
   *
   * The `und` is only added when something WAS dropped: a release whose flags say exactly
   * what its name says ("Eng Dub" + 🇬🇧) has one audio language and should stay a sole-
   * language source, because that is what `bestFor` looks for when the browser cannot
   * switch tracks. */
  if (named.length) {
    const extra = flagsAreSubs ? flags : flags.filter((f) => named.indexOf(f) < 0);
    return { ...s, langs: extra.length ? [...named, UNDETERMINED] : named, subLangs: extra };
  }
  if (flags.length && !flagsAreSubs) return { ...s, langs: flags, subLangs: [] };
  /* Nothing in the label speaks to language at all — no flags AND no tags. Leave the
   * mapper's own default alone rather than replacing one guess with another: that
   * fallback is `mapAddonStream`'s, it is the twin the parity corpus compares, and a
   * stream this silent is exactly the case it was written for. */
  /* NO EARLY RETURN FOR "the label says nothing". There used to be one here, keeping
   * `mapAddonStream`'s `['en']` fallback on the grounds that the mapper is the pinned twin
   * and its default was not mine to second-guess. That reasoning was backwards: the mapper
   * cannot know better, this function exists precisely to correct it, and overriding the
   * VALUE here never touches the pinned TEXT there. The cost of leaving it was that
   * `[SubsPlease] Solo Leveling - 13 (1080p)` and `[WAP] … (BD Remux)` — captions with no
   * tag line, no flags and no dub word anywhere, i.e. raw Japanese with English subs —
   * were filed as English audio and rendered in the English list.
   *
   * "Dubbed", "Dual Audio" and "Multi Audio" say a dub EXISTS. They do not say what it is,
   * and this is where guessing it was English did the most damage:
   *
   *   "Solo.Leveling.S02E01-E06.2160p.WEB-DL.MULTI.AAC2.0.x265.Multi.Subs.AniMeitantei"
   *   Dubbed / Multi Audio / Multi Subs        ← no flags, no language named anywhere
   *
   * is a MULTI-audio Chinese-platform WEB-DL. Assuming English put it in the English
   * bucket, quality-first ordering put it at the TOP of that bucket because it is 4K, and
   * clicking the first row played Mandarin. The genuine "Eng Dub - 2160p" release was the
   * row underneath it.
   *
   * So a dub whose language is not stated is `und` — the Original bucket — and the English
   * bucket holds only releases that actually say English (a 🇬🇧 audio flag, or "Eng Dub" /
   * "[English Dub]" via `namedAudioLangs`). This costs the genuinely dual-audio JP+EN rips
   * their English tab, and that is the right trade: their English is a non-default track
   * inside the container, and no browser this app runs in can switch to it. A bucket that
   * cannot deliver its language is worse than one row fewer. */
  return { ...s, langs: [UNDETERMINED], subLangs: flags };
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
      /* `classifyStreamLangs` runs OUTSIDE `mapAddonStream` and only where the wire did
       * not state the language, so the mapper stays the byte-for-byte twin the parity
       * corpus pins and the add-on's own `behaviorHints.lang` is never second-guessed. */
      return (data.streams || []).map((s) => {
        const m = mapAddonStream(s, a.manifest?.name || 'Add-on');
        return m && !s.behaviorHints?.lang ? classifyStreamLangs(m) : m;
      }).filter(Boolean) as AddonStream[];
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
