/* THE LOCAL STREAMING SERVER — how a browser gets audio-track switching after all.
 *
 * Everything else in this app has taken as given that a web page cannot choose the audio
 * track of a downloaded file: Chrome, Edge and Firefox implement no `HTMLMediaElement.
 * audioTracks`, and they ship no Dolby or DTS decoder. Both facts are true and neither is
 * the whole picture, because the reference web client does it in the same Chrome — and it does it by
 * not asking the browser. It routes playback through a native transcoding server running
 * on localhost, which demuxes the container itself and re-serves it as HLS.
 *
 * Verified against the server installed on this machine (v4.20.17, `transcodeHardwareAccel:
 * true`, profile `nvenc-win`):
 *
 *   GET /hlsv2/probe?mediaURL=<url>
 *     {"format":{"name":"mov,mp4,m4a,…"},"streams":[
 *        {"track":"video","codec":"h264","width":1910,…},
 *        {"track":"audio","codec":"aac","channels":2,"language":"und","title":null}]}
 *
 *   GET /hlsv2/<id>/master.m3u8?mediaURL=<url>&videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2
 *     #EXTM3U
 *     #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="und",LANGUAGE="und",…,URI="audio0.m3u8?…"
 *     #EXT-X-STREAM-INF:BANDWIDTH=164000,VIDEO="video",AUDIO="audio"
 *
 * ONE `EXT-X-MEDIA:TYPE=AUDIO` PER AUDIO TRACK, each tagged with its language — which is
 * exactly what `hls.audioTracks` is, and the player already knows how to pick from that
 * (`applyAudioPref`) and how to offer it (the audio button). So routing through the server
 * turns three separate dead ends into working features at once: track switching, AC-3/DTS
 * that would otherwise play silently, and containers Chrome will not open at all.
 *
 * The URL shape is not guesswork — it is what Stremio's own client builds, in
 * `stremio-video/src/withStreamingServer/withStreamingServer.js`, down to `videoCodecs`
 * and `audioCodecs` being REPEATED keys rather than a comma-joined list.
 *
 * WHY LOCALHOST MATTERS BEYOND CONVENIENCE. The transcode happens on the machine that is
 * already watching, the way VLC or mpv would. Nothing is fetched, decoded or re-served by
 * groloo's own infrastructure, so this buys the feature without moving the app from
 * "player" to "the party serving the content" — the distinction that most intermediary
 * safe harbours turn on, and the reason a server-side transcode was the wrong answer. */

/* THE HELPER FIRST, and it is the only candidate that works in production.
 *
 * `groloo-helper` (../Groloo-helper) is our own process on the viewer's machine. It answers
 * the same API, and — the whole reason it exists — it sets CORS for groloo's origins, so a
 * page served from tv.groloo.com can reach it. The two fallbacks cannot both apply:
 *
 *   /streaming-server   the vite dev proxy. Same-origin, so CORS never applies — but it
 *                       proxies through the DEV SERVER, which only exists on localhost.
 *   :11470              the streaming server itself. Reachable only from its vendor's own
 *                       so this succeeds in almost no real setup; it is kept because it
 *                       costs one failed fetch and covers anyone who has allowlisted us. */
const ABSOLUTE_HTTP = /^https?:\/\//i;
const HELPER_URL = 'http://127.0.0.1:11471';
const PROXY_PATH = '/streaming-server';
const DIRECT_URL = 'http://127.0.0.1:11470';
const OVERRIDE_KEY = 'groloo.streamingServer';

let base: string | null = null;

/** Override from the console to point at a server elsewhere on the network:
 *  `localStorage['groloo.streamingServer'] = 'http://192.168.0.8:11470'`. */
function candidates(): string[] {
  let override: string | null = null;
  try { override = localStorage.getItem(OVERRIDE_KEY); } catch { /* private mode */ }
  return override ? [override] : [HELPER_URL, PROXY_PATH, DIRECT_URL];
}

/** The base that answered, once detection has run. */
export const serverBase = (): string => base || PROXY_PATH;

/* READING IS A DIFFERENT PERMISSION FROM PLAYING, and that is the whole problem with debrid
 * sources. `<video src="…">` is not subject to CORS; `fetch` is. So a TorBox link plays
 * perfectly and cannot be read at all, which disables in-page demuxing and Dolby decoding
 * together, since both have to see the bytes before they can do anything.
 *
 * The helper is not a browser and has no such restriction, so it reads on the page's behalf
 * and re-serves with the header that makes it readable. When one is running, reads go
 * through it and sources otherwise closed to the page open up; when it is not, this returns
 * the URL unchanged and the caller falls back. The helper is an upgrade, never a
 * requirement.
 *
 * IT LIVES HERE, not in browserDemux, because it is about the streaming server and nothing
 * else. It was briefly exported from the demuxer, which made `wasmAudio` import a
 * URL-rewriting helper from a module it otherwise has no business knowing about — and the
 * first symptom of that tangle was the whole app failing to boot with "does not provide an
 * export named 'readThrough'". */
export const readThrough = (url: string): string => {
  /* ONLY ABSOLUTE http(s) URLS GO THROUGH THE HELPER. It resolves whatever it is given with
   * `new URL()` and rejects anything relative, so wrapping a same-origin path would turn a
   * read that works into a 500. Real sources are absolute and test fixtures often are not,
   * and that difference should not change behaviour. */
  if (!streamingServerReady() || !ABSOLUTE_HTTP.test(url)) return url;
  return `${serverBase()}/fetch?url=${encodeURIComponent(url)}`;
};

/* Codecs the browser can decode with no help. `ac3`/`eac3`/`dts`/`truehd` are absent on
 * purpose and are the main reason to transcode at all — see lib/codecs.ts, where the same
 * fact is measured with canPlayType. */
const OK_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const OK_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const OK_FORMAT = /mp4|mov|m4a|webm|matroska/;

export interface ProbeStream { track: string; codec: string; channels?: number; language?: string | null; title?: string | null }
export interface Probe { format?: { name?: string; duration?: number }; streams?: ProbeStream[] }

/* One detection per session, shared by every call. A miss must be CHEAP and must not
 * stall playback: no server is the normal case for most users, and the whole point of the
 * timeout is that `fetch` to a closed localhost port can hang rather than refuse. */
let detected: Promise<boolean> | null = null;
let ready = false;

/** The cached answer, readable synchronously — for render paths that cannot await, like the
 *  source list deciding whether an audio-track switch is possible at all. `false` until the
 *  probe returns, so call `hasStreamingServer()` early to warm it. */
export const streamingServerReady = (): boolean => ready;

async function withTimeout(url: string, ms: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  signal?.addEventListener('abort', () => ctrl.abort());
  try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(to); }
}

/** Is a streaming server reachable? Cached for the session. */
export function hasStreamingServer(): Promise<boolean> {
  if (!detected) {
    detected = (async () => {
      for (const c of candidates()) {
        try {
          const r = await withTimeout(`${c}/settings`, 1500);
          if (r.ok) { base = c; ready = true; return true; }
        } catch { /* try the next candidate */ }
      }
      ready = false;
      return false;
    })();
  }
  return detected;
}

/** Ask the server what is actually inside `mediaURL`. Null when it cannot say. */
export async function probeMedia(mediaURL: string, signal?: AbortSignal): Promise<Probe | null> {
  try {
    const r = await withTimeout(`${serverBase()}/hlsv2/probe?mediaURL=${encodeURIComponent(mediaURL)}`, 20000, signal);
    if (!r.ok) return null;
    const j = await r.json() as Probe & { error?: unknown };
    return j && !j.error && Array.isArray(j.streams) ? j : null;
  } catch { return null; }
}

/** Should this file be routed through the server rather than handed to <video>?
 *
 *  MORE THAN ONE AUDIO TRACK IS ON ITS OWN A REASON, even when every codec is playable.
 *  A dual-audio file plays perfectly in Chrome — it just plays the wrong language with no
 *  way to change it, which is the entire complaint this module exists to answer. */
export function needsServer(probe: Probe): boolean {
  const streams = probe.streams || [];
  const audio = streams.filter((s) => s.track === 'audio');
  const video = streams.filter((s) => s.track === 'video');
  if (audio.length > 1) return true;
  if (audio.some((s) => !OK_AUDIO.includes((s.codec || '').toLowerCase()))) return true;
  if (video.some((s) => !OK_VIDEO.includes((s.codec || '').toLowerCase()))) return true;
  return !OK_FORMAT.test((probe.format?.name || '').toLowerCase());
}

/* `videoCodecs` and `audioCodecs` are REPEATED keys, not one comma-joined value. The reference client's
 * client appends them in a loop and the server reads them as a list; joining them yields a
 * playlist that transcodes when it did not need to. */
function hlsQuery(mediaURL: string, maxAudioChannels: number): string {
  const q = new URLSearchParams([['mediaURL', mediaURL]]);
  OK_VIDEO.forEach((c) => q.append('videoCodecs', c));
  OK_AUDIO.forEach((c) => q.append('audioCodecs', c));
  q.set('maxAudioChannels', String(maxAudioChannels));
  return q.toString();
}

/* The `<id>` segment is the server's handle for one transcode session. It only has to be
 * unique per playback; reusing one across sources makes the server serve the previous
 * file's playlist. */
const sessionId = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** The HLS master playlist for `mediaURL`, or null when no server is available.
 *
 *  Stereo by default: a 5.1 track downmixed to 2.0 is what a laptop plays anyway, and
 *  asking for 6 channels makes the server hand back surround the browser then discards. */
export async function hlsFor(mediaURL: string, maxAudioChannels = 2): Promise<string | null> {
  if (!(await hasStreamingServer())) return null;
  return `${serverBase()}/hlsv2/${sessionId()}/master.m3u8?${hlsQuery(mediaURL, maxAudioChannels)}`;
}

/* ── TORRENTS ────────────────────────────────────────────────────────────────────────
 *
 * The streaming server does more than transcode: it is a torrent client with an HTTP face,
 * and `GET /<infoHash>/<fileIdx>` is a plain progressive-download URL for one file inside
 * one torrent. That single endpoint is the whole of what an `infoHash` stream needs, and
 * it is why every torrent add-on works in other clients and listed nothing here.
 *
 * THE URL SHAPE IS STREMIO'S, not invented: `stremio-core`'s deep-link builder joins the
 * hex hash and the file index as two path segments and appends one `tr` query parameter per
 * entry of the stream's `sources` array, verbatim — including the `tracker:` / `dht:`
 * prefixes, which the server parses itself. `-1` for an absent `fileIdx` is also its
 * convention and means "pick the largest video in the torrent".
 *
 * THE POSTURE IS UNCHANGED, and that is the reason this is acceptable where a server-side
 * fetch would not be. The peer traffic, the disk and the seeding all happen on the machine
 * that is already watching, through a server the viewer installed and runs; groloo hands
 * over a URL and never touches a byte. That is the same line `hlsFor` above already draws
 * and the same one the module header argues from. */

/** Play URL for a torrent source, or null when no streaming server is reachable.
 *
 *  `<video>` is not subject to CORS, so this plays even against a server that sends no
 *  cross-origin headers — which is why it works against the streaming server's own :11470 and does not
 *  depend on the helper. The helper still matters for everything that must be READ rather
 *  than played (probing, demuxing, subtitle sync), which is why it proxies these paths too. */
export function torrentUrl(t: { infoHash?: string; fileIdx?: number; announce?: string[] }): string | null {
  if (!streamingServerReady() || !t.infoHash) return null;
  const idx = typeof t.fileIdx === 'number' ? t.fileIdx : -1;
  const q = new URLSearchParams();
  for (const a of t.announce ?? []) q.append('tr', a);
  const tail = q.toString();
  return `${serverBase()}/${encodeURIComponent(t.infoHash.toLowerCase())}/${idx}${tail ? `?${tail}` : ''}`;
}

/** Decide how to play `url`. Returns the URL to actually load and whether it is HLS.
 *
 *  Falls back to the original URL on every failure path — no server, probe refused,
 *  nothing worth transcoding — so this can only ever improve on direct playback. */
export async function resolvePlayback(
  url: string,
  kind: 'hls' | 'url' | undefined,
  signal?: AbortSignal,
  /** `behaviorHints.notWebReady` — the add-on stating outright that a browser cannot play
   *  this. Routed through the server without consulting the probe, because the probe answers
   *  what the CONTAINER holds and this is a claim about something else (a codec profile the
   *  panel refuses, a server that needs the referer, an MKV Chrome will not open at all).
   *  Other clients treat the flag the same way: it is the add-on's word, not a hint to weigh. */
  forceServer = false,
): Promise<{ url: string; kind: 'hls' | 'url'; via: boolean }> {
  const direct = { url, kind: (kind || 'url') as 'hls' | 'url', via: false };
  if (kind === 'hls') return direct;                       // already switchable
  if (!(await hasStreamingServer())) return direct;
  const probe = await probeMedia(url, signal);
  if (!forceServer && (!probe || !needsServer(probe))) return direct;
  const hls = await hlsFor(url);
  return hls ? { url: hls, kind: 'hls', via: true } : direct;
}
