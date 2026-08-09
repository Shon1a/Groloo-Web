/* AUDIO-TRACK SWITCHING WITH NOTHING INSTALLED.
 *
 * Every other route to this feature needs something on the viewer's machine — a local
 * streaming server, or our own helper. This one needs nothing: the page opens the container
 * itself, keeps the video plus the ONE audio track the viewer asked for, and hands
 * MediaSource a stream with no choice left to make. The browser is not being asked to switch
 * tracks (it cannot; `HTMLMediaElement.audioTracks` does not exist in Chrome, Edge or
 * Firefox) — it is given a stream with a single track, which it has always been able to play.
 *
 * THE VIDEO IS NEVER RE-ENCODED. Its compressed packets are copied across untouched, so the
 * expensive half stays on the graphics hardware and only the container is rewritten. That is
 * what makes this affordable on a laptop, let alone a phone.
 *
 * MEASURED, against a 443 MB / 10-minute dual-audio file (see ../../../Groloo-poc):
 *
 *     time to playable            72 ms      playback starts before conversion finishes
 *     memory held                 78-115 MB  flat, whatever the film's length
 *     the same file, buffered     ~1.8 GB    the ceiling this design removes
 *     switch language             ~1.1 s
 *     seek outside the buffer     ~1.1 s
 *
 * WHAT IT CANNOT DO: Dolby and DTS. Pulling an AC-3 track out of the container does not
 * help — no browser will decode it, and there is no WASM decoder on npm to ship instead.
 * `canDemuxAudio` reports that honestly rather than producing a silent stream. */

import {
  ALL_FORMATS, Input, UrlSource,
  Output, Mp4OutputFormat, AppendOnlyStreamTarget, Conversion, ConversionCanceledError,
  type InputAudioTrack,
} from 'mediabunny';
import { readThrough } from './streamingServer';

/** Codecs a browser can play once they are alone in a stream. AC-3/E-AC-3/DTS are absent
 *  deliberately: measured with `AudioDecoder.isConfigSupported`, Chrome refuses all three. */
const DEMUXABLE = ['aac', 'opus', 'mp3', 'flac', 'vorbis'];
export const canDemuxAudio = (codec: string | null | undefined): boolean =>
  DEMUXABLE.includes(String(codec || '').toLowerCase());

/* How far ahead of the playhead to convert. THIS IS THE MEMORY BUDGET: at ~6 Mbps, 30
 * seconds is about 22 MB held at once regardless of the film's length. */
const AHEAD_MAX = 30;

export interface DemuxTrack { index: number; codec: string; language: string; channels: number; playable: boolean }
export interface DemuxHandle {
  tracks: DemuxTrack[];
  current: () => number;
  switchAudio: (i: number) => Promise<void>;
  destroy: () => Promise<void>;
}

/* MediaSource rejects an append while another is in flight, so every append goes through one
 * queue. Getting this wrong throws InvalidStateError only under load. */
function makeAppender(sb: SourceBuffer) {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(bytes: Uint8Array) {
      chain = chain.then(() => new Promise<void>((resolve, reject) => {
        const done = () => resolve();
        const fail = (e: unknown) => reject(e);
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error', fail, { once: true });
        try { sb.appendBuffer(bytes as BufferSource); } catch (e) { fail(e); }
      })).catch(() => {}); // a failed append must not wedge the queue
      return chain;
    },
    idle: () => chain,
  };
}

/* Throw everything away and WAIT for it to be gone. `remove()` is asynchronous, and not
 * waiting is why switching language first appeared to take ten seconds: the already-converted
 * audio stayed in the buffer and kept playing while the new track was appended behind it —
 * the original complaint, reintroduced one layer down. */
function clearBuffer(sb: SourceBuffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (sb.updating) sb.abort();
      sb.addEventListener('updateend', () => resolve(), { once: true });
      sb.remove(0, Infinity);
    } catch { resolve(); }
  });
}

const aheadOf = (el: HTMLVideoElement, t: number): number => {
  const b = el.buffered;
  for (let i = 0; i < b.length; i += 1) if (t >= b.start(i) - 0.25 && t <= b.end(i)) return b.end(i) - t;
  return 0;
};
const inBuffer = (el: HTMLVideoElement, t: number): boolean => {
  const b = el.buffered;
  for (let i = 0; i < b.length; i += 1) if (t >= b.start(i) && t <= b.end(i) - 0.1) return true;
  return false;
};

/** Why in-page demuxing is not being used for a source. `null` = it is. */
export type DemuxBlocker = 'unreadable' | 'single-track' | 'undecodable-audio' | 'no-mse';

/** What is inside `url`, without committing to playing it.
 *
 *  REPORTS WHY IT CANNOT HELP, rather than just failing. The difference matters because the
 *  three reasons need three different answers from the viewer, and a player that silently
 *  falls back to direct playback teaches them nothing: "this file is Dolby" is a dead end in
 *  any browser, while "we could not read the file" usually means the host serves no CORS
 *  headers and is a problem with the SOURCE, not the format. */
export async function probeUrl(url: string): Promise<
  { ok: true; tracks: DemuxTrack[]; duration: number }
  | { ok: false; reason: DemuxBlocker; detail?: string; tracks?: DemuxTrack[] }
> {
  if (typeof MediaSource === 'undefined') return { ok: false, reason: 'no-mse' };
  let audio: InputAudioTrack[];
  let duration: number;
  try {
    const input = new Input({ source: new UrlSource(readThrough(url)), formats: ALL_FORMATS });
    audio = await input.getAudioTracks();
    const [video] = await input.getVideoTracks();
    if (!video) return { ok: false, reason: 'unreadable', detail: 'no video track' };
    duration = await input.computeDuration();
  } catch (e) {
    /* Almost always CORS: `UrlSource` reads with ranged `fetch`, which a debrid CDN may
     * refuse even though <video src> on the same URL is fine — the element is not subject
     * to CORS and `fetch` is. Worth naming, because it is not a codec problem and no
     * amount of picking another release will fix it.
     *
     * "ALMOST ALWAYS" IS NOT GOOD ENOUGH TO ACT ON, so the real reason is separated from
     * the guess. A CORS rejection and a 404 both surface as an opaque `TypeError: Failed to
     * fetch` with no detail, so a bare probe cannot tell them apart — but a plain HEAD does:
     * if it succeeds, the host is reachable and the failure was the ranged read; if it
     * fails the same way, the URL itself is the problem. */
    const detail = (e as Error).message;
    let corsProbe = 'unknown';
    try {
      const r = await fetch(url, { method: 'HEAD' });
      corsProbe = r.ok ? 'HEAD ok — the host allows reading; the ranged read is what failed' : `HEAD ${r.status}`;
    } catch (h) {
      corsProbe = `HEAD also blocked (${(h as Error).message}) — CORS, or the URL is dead`;
    }
    if (import.meta.env.DEV) console.warn('[demux] cannot read source:', { url, detail, corsProbe });
    return { ok: false, reason: 'unreadable', detail: `${detail} · ${corsProbe}` };
  }
  const tracks: DemuxTrack[] = audio.map((t, i) => ({
    index: i, codec: t.codec ?? '', language: t.languageCode || 'und',
    channels: t.numberOfChannels, playable: canDemuxAudio(t.codec),
  }));
  if (tracks.length < 2) return { ok: false, reason: 'single-track', tracks };
  if (!tracks.some((t) => t.playable)) return { ok: false, reason: 'undecodable-audio', tracks };
  return { ok: true, tracks, duration };
}

/**
 * Play `url` through the element with only one audio track at a time.
 *
 * Returns a handle whose `switchAudio` rebuilds the stream around a different track from
 * wherever the viewer currently is.
 */
export async function playDemuxed(
  videoEl: HTMLVideoElement,
  url: string,
  audioIndex: number,
  onLog: (m: string) => void = () => {},
): Promise<DemuxHandle> {
  const input = new Input({ source: new UrlSource(readThrough(url)), formats: ALL_FORMATS });
  const [videoTrack] = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const duration = await input.computeDuration();
  if (!videoTrack) throw new Error('no video track');
  if (!audioTracks[audioIndex]) throw new Error('no such audio track');

  /* The SourceBuffer needs the exact codec string before any bytes exist, and guessing it
   * fails on any profile but the guessed one. The tracks can state it, so ask. */
  const vCodec = await videoTrack.getCodecParameterString();
  const aCodec = await audioTracks[audioIndex].getCodecParameterString();
  let currentMime = `video/mp4; codecs="${[vCodec, aCodec].filter(Boolean).join(',')}"`;
  const mime = currentMime;
  if (!MediaSource.isTypeSupported(mime)) throw new Error(`browser cannot play ${mime}`);

  let current = audioIndex;
  let generation = 0;
  let destroyed = false;
  let conversion: Conversion | null = null;

  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  ms.duration = duration;
  const sb = ms.addSourceBuffer(mime);
  sb.mode = 'segments';
  const appender = makeAppender(sb);

  /** Convert from `from` onwards, with backpressure.
   *
   *  RESOLVES WHEN PLAYBACK CAN START, NOT WHEN CONVERSION FINISHES. Under backpressure the
   *  conversion only completes once the viewer reaches the end of the film, so awaiting it
   *  here waits for playback to finish before letting it begin — a silent, permanent hang. */
  async function pump(from: number): Promise<void> {
    const mine = ++generation;
    if (conversion) { try { await conversion.cancel(); } catch { /* done */ } conversion = null; }
    await appender.idle();
    if (sb.timestampOffset !== from) sb.timestampOffset = from;

    let ready!: (() => void) | null;
    let failed!: ((e: unknown) => void) | null;
    const playable = new Promise<void>((res, rej) => { ready = res as () => void; failed = rej; });

    const writable = new WritableStream<Uint8Array>({
      async write(bytes) {
        if (destroyed || mine !== generation) throw new Error('superseded');
        await appender.append(bytes);
        if (ready) { ready(); ready = null; }
        /* THE PAUSE. Not resolving keeps `write` from being called again, which stalls the
         * conversion and, upstream of it, the range requests reading the source. */
        while (!destroyed && mine === generation && aheadOf(videoEl, videoEl.currentTime) >= AHEAD_MAX) {
          await new Promise((r) => setTimeout(r, 250));
        }
      },
    });

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new AppendOnlyStreamTarget(writable),
    });
    conversion = await Conversion.init({
      input,
      output,
      // 1-BASED. `getAudioTracks()` is 0-based; the mismatch silently keeps the wrong
      // language — a perfectly playable file in the language you did not ask for.
      audio: (_t, n) => ({ discard: n !== current + 1 }),
      trim: from > 0 ? { start: from } : undefined,
      showWarnings: false,
    });

    void (async () => {
      try {
        await conversion.execute();
        if (mine === generation && !destroyed) {
          await appender.idle();
          if (ms.readyState === 'open') ms.endOfStream();
        }
      } catch (e) {
        if (e instanceof ConversionCanceledError || destroyed || mine !== generation) return;
        onLog(`demux stopped: ${(e as Error).message}`);
        failed?.(e);
      }
    })();

    return playable;
  }

  /* Seeking back lands in fragments still held. Seeking forward past them has nowhere to
   * land, so the conversion restarts there — `timestampOffset` keeps the new fragments on
   * the original timeline instead of restarting at zero. */
  const onSeeking = () => {
    const t = videoEl.currentTime;
    if (destroyed || inBuffer(videoEl, t)) return;
    generation += 1;
    void clearBuffer(sb).then(() => pump(t));
  };
  videoEl.addEventListener('seeking', onSeeking);

  await pump(0);
  onLog(`demuxing in the browser · ${audioTracks.length} audio tracks · ${mime}`);

  return {
    tracks: audioTracks.map((t, i) => ({
      index: i, codec: t.codec ?? '', language: t.languageCode || 'und',
      channels: t.numberOfChannels, playable: canDemuxAudio(t.codec),
    })),
    current: () => current,
    /* THE NEW TRACK MAY NOT BE THE SAME CODEC AS THE OLD ONE, and assuming it was is what
     * broke this. A real source — Apex, five tracks: Russian ×3, Ukrainian, English — mixes
     * codecs across its tracks, so a SourceBuffer created for the first track's mime cannot
     * accept the second. The append fails, and because the failure lands mid-playback the
     * player shows "this file can't play in the browser", which blames the file for a
     * mistake made here.
     *
     * Two cases, and they need different answers:
     *   · A codec the browser can still play once alone — `changeType()` re-declares the
     *     buffer, which is exactly what that API is for.
     *   · A codec no browser decodes (AC-3/DTS). Nothing this module does will help; it
     *     throws `NEEDS_WASM_DECODER` so the caller can hand over to `wasmAudio`, which can.
     */
    async switchAudio(i) {
      if (i === current || destroyed) return;
      const next = audioTracks[i];
      if (!next) return;
      if (!canDemuxAudio(next.codec)) {
        const e = new Error('NEEDS_WASM_DECODER');
        (e as Error & { trackIndex?: number }).trackIndex = i;
        throw e;
      }

      const aNext = await next.getCodecParameterString();
      const nextMime = `video/mp4; codecs="${[vCodec, aNext].filter(Boolean).join(',')}"`;
      if (nextMime !== currentMime) {
        if (!MediaSource.isTypeSupported(nextMime)) throw new Error(`browser cannot play ${nextMime}`);
        try { sb.changeType(nextMime); currentMime = nextMime; } catch (e) {
          throw new Error(`could not switch to ${next.codec}: ${(e as Error).message}`);
        }
      }

      current = i;
      const at = videoEl.currentTime;
      generation += 1;              // stop the running conversion before touching the buffer
      await clearBuffer(sb);        // and make sure the old language is really gone
      await pump(at);
      videoEl.currentTime = at;
    },
    async destroy() {
      destroyed = true;
      videoEl.removeEventListener('seeking', onSeeking);
      if (conversion) { try { await conversion.cancel(); } catch { /* done */ } }
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* fine */ }
    },
  };
}
