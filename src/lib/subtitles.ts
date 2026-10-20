/* Client-side subtitle prep — port of the vanilla subtitleBlobUrl/srtToVttC. Add-ons
 * hand back SRT (often gzipped); browsers only render VTT via <track>, so we fetch,
 * gunzip if needed, convert SRT→VTT, and hand the player a same-origin blob: URL (no
 * CORS on the track). A subtitle host without permissive CORS simply can't be read
 * and is skipped. */

/* LINES THAT ARE NOT THE FILM. Subtitle files carry their sources' notices as ordinary cues: the
 * OpenSubtitles add-on opens every file with its own name and the file's (">>OpenSubtitles v3+
 * v0.0.4<< =>Hope.2026.1080p….srt"), and the site and its uploaders add "Advertise your product or
 * brand here", "Support us and become VIP member…", "Subtitles by …", "Downloaded from YTS". A cue
 * whose text matches any of these is dropped whole. Web addresses are on the list because dialogue
 * almost never spells one out and these notices almost always do. */
const AD_CUE = /opensubtitles|osdb\.link|addic7ed|subscene|podnapisi|\byts\b|\byify\b|www\.[a-z0-9-]+\.[a-z]{2,}|https?:\/\/|\b[\w-]+(\.[\w-]+)+\.(srt|ass|ssa|vtt|sub)\b|^\s*>>.*<<\s*$|\b(subtitles?|subs|sync(ed)?|synchroni[sz]ed|corrections?|encoded|ripped|downloaded|captioned)\s+(by|from)\b|advertise your product|become vip member/im;

function dropAdCues(body: string): string {
  return body.split(/\n{2,}/).filter((block) => {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    return at < 0 || !AD_CUE.test(lines.slice(at + 1).join('\n'));
  }).join('\n\n');
}

function srtToVtt(srt: string): string {
  const body = dropAdCues(String(srt).replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
  return /^\s*WEBVTT/.test(body) ? body : 'WEBVTT\n\n' + body;
}

interface DecompressionStreamCtor { new (format: string): ReadableWritablePair<Uint8Array, Uint8Array> }

export async function toVttBlobUrl(srcUrl: string): Promise<string | null> {
  try {
    const r = await fetch(srcUrl);
    if (!r.ok) return null;
    let buf = new Uint8Array(await r.arrayBuffer());
    const gz = /\.gz($|\?)/i.test(srcUrl) || (buf[0] === 0x1f && buf[1] === 0x8b);
    const DS = (window as unknown as { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream;
    if (gz && DS) {
      try {
        const stream = new Blob([buf]).stream().pipeThrough(new DS('gzip'));
        buf = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch { /* not actually gzip — use as-is */ }
    }
    const vtt = srtToVtt(new TextDecoder('utf-8').decode(buf));
    return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  } catch { return null; }
}

/* ── THE LOOK: Netflix's subtitle, not a caption box ────────────────────────────────────────────
 *
 * Warm off-white rather than pure white, semibold, italic, and NO box behind the line — a soft
 * dark shadow is what keeps it legible over a bright frame, the way the big apps draw theirs. Inter
 * rather than the UI's Poppins: Poppins is a wide geometric face and reads as a website, Inter is
 * the closest open cousin of the grotesque the streaming apps set subtitles in, and it ships a
 * real italic (index.html asks Google for it). Georgian falls through to the UI's own faces.
 *
 * ONE SOURCE FOR BOTH READERS: the player writes it into its `::cue` rule, the Settings preview
 * into an inline style, so the preview cannot drift from what plays. */
export const CUE_FONT = '"Inter","BPG Nino Mtavruli","Noto Sans Georgian","Helvetica Neue",Helvetica,Arial,sans-serif';
const CUE_SHADOW = '0 0 2px rgba(0,0,0,.9),0 1px 3px rgba(0,0,0,.7),0 0 7px rgba(0,0,0,.6)';

export interface CueLookSettings { subColor: string; subBg: string; subOutline: string; subOutlineW: number; subItalic: boolean }

export function cueLook(s: CueLookSettings) {
  const ow = s.subOutlineW, oc = s.subOutline;
  // The outline setting is a hard 4-corner ring drawn UNDER the soft shadow, never instead of it.
  const ring = ow > 0 ? `${-ow}px ${-ow}px 0 ${oc},${ow}px ${-ow}px 0 ${oc},${-ow}px ${ow}px 0 ${oc},${ow}px ${ow}px 0 ${oc},` : '';
  return {
    color: s.subColor,
    background: s.subBg,
    fontFamily: CUE_FONT,
    fontWeight: 600,
    fontStyle: s.subItalic ? 'italic' : 'normal',
    textShadow: ring + CUE_SHADOW,
  };
}

/* ── WHICH TRACK SHOWS BY ITSELF ─────────────────────────────────────────────────────────────────
 *
 * The viewer's own pick for THIS title wins — the language AND the add-on it came from, so the next
 * episode of a series opens on the same subtitle source the last one was watched with, and switching
 * source mid-film (the Audio box) keeps it too. Kept per title in localStorage: a show watched over
 * a week keeps its choice, "Off" included. Without a pick, the Settings default language (English
 * unless changed) is turned on whenever a track in it exists. */
export interface SubPick { off?: boolean; lang?: string; source?: string; label?: string; url?: string }

/** The shape of a track the player could show: `source` is the subtitle add-on's name, absent for
 *  the stream's own embedded tracks. */
export interface SubChoice { lang: string; label: string; url: string; source?: string }

const PICKS_KEY = 'groloo.subpicks.v1';
const PICKS_MAX = 200;

/** One key per TITLE — a series' episodes share it. Null when there is nothing to key on. */
export function subPickKey(m?: { id?: string | number; type?: string } | null): string | null {
  if (!m || m.id == null || m.id === '') return null;
  return `${m.type === 'movie' ? 'm' : 's'}:${m.id}`;
}

function readPicks(): Record<string, SubPick> {
  try {
    const o = JSON.parse(localStorage.getItem(PICKS_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

export function loadSubPick(key: string | null): SubPick | null {
  return key ? readPicks()[key] ?? null : null;
}

export function saveSubPick(key: string | null, pick: SubPick) {
  if (!key) return;
  const all = readPicks();
  delete all[key];
  all[key] = pick; // re-inserted last, so the oldest title is first in line to be dropped
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - PICKS_MAX))) delete all[k];
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

/** "English #3" → "English": the number only tells apart files inside one answer. */
export const bareSubLabel = (label: string) => String(label || '').replace(/\s+#\d+$/, '');

/** The track to show by itself: an index into `subs`, -1 for none, or null for "not yet" — the
 *  remembered add-on has not answered, and settling on a different file now would mean swapping it
 *  out a second later. `bad` holds urls that would not load; they are passed over. */
export function autoSubIndex(subs: SubChoice[], pick: SubPick | null, defLang: string, bad: Set<string>, loading: boolean): number | null {
  if (pick?.off) return -1;
  const ofLang = (lang: string) => subs.map((s, i) => ({ s, i })).filter(({ s }) => s.lang === lang && !bad.has(s.url));
  /* A FORCED track only carries the lines spoken in another language — turned on by itself it looks
   * like subtitles that do not work. Any full track in the language comes first. */
  const best = (xs: Array<{ s: SubChoice; i: number }>) => (xs.find(({ s }) => !/forced/i.test(s.label)) ?? xs[0])?.i;

  if (pick?.lang) {
    const xs = ofLang(pick.lang);
    const src = pick.source ?? '';
    const hit = xs.find(({ s }) => s.url === pick.url)
      ?? xs.find(({ s }) => (s.source ?? '') === src && bareSubLabel(s.label) === pick.label)
      ?? xs.find(({ s }) => (s.source ?? '') === src);
    if (hit) return hit.i;
    if (loading && (src || !xs.length)) return null;
    const i = best(xs);
    if (i != null) return i;
  }
  if (!defLang || defLang === 'off') return -1;
  const i = best(ofLang(defLang));
  return i ?? (loading ? null : -1);
}
