/* DOLBY AND DTS IN THE BROWSER — the codecs no browser will decode.
 *
 * `browserDemux.ts` handles files whose audio the browser can already decode: keep one
 * track, remux, play. It cannot help with AC-3, E-AC-3 or DTS, because those decode to
 * nothing — perfect picture, total silence, no error, no clue. Chrome ships no decoder for
 * them and neither does Edge or Firefox.
 *
 * So the decoder is shipped with the page. Measured in Chrome on a real AC-3 file:
 *
 *     crossOriginIsolated   false        <- NO COOP/COEP headers, so it does not break
 *     sharedArrayBuffer     false           embeds, fonts or anything else on the page
 *     transcode speed       103x realtime
 *     heap while playing    23 MB
 *     result                the English AC-3 track, audible, at the right pitch
 *
 * WHY NOT SIMPLY RUN FFMPEG ON THE FILE. ffmpeg.wasm's API is file-based — `writeFile()`
 * then `exec()` — so handing it the source would hold the whole 1.4 GB episode in memory,
 * which is the exact ceiling `browserDemux.ts` exists to remove. Instead:
 *
 *   · The VIDEO never goes near ffmpeg. It streams through mediabunny remuxed and
 *     untouched, so the graphics hardware still does the expensive half.
 *   · Only the AUDIO PACKETS are pulled out, a window at a time. AC-3 at 192 kbps is about
 *     60 MB for a whole episode against 1.4 GB for the file; a 20-second window is under
 *     half a megabyte.
 *   · AC-3 is self-framing, so a window of packets concatenated is a valid stream on its
 *     own and transcodes independently — no state carried between windows.
 *
 * TWO SOURCEBUFFERS, NOT ONE. Video and audio arrive from different pipelines at different
 * speeds; muxing them together would mean holding one back for the other. MediaSource is
 * built for this — the arrangement DASH and HLS use for separate tracks — and reports
 * `buffered` as the INTERSECTION of the two, so playback advances only where both exist.
 * That is exactly the wanted behaviour and it needs no coordination from us. */

import {
  ALL_FORMATS, Input, UrlSource, EncodedPacketSink,
  Output, Mp4OutputFormat, AppendOnlyStreamTarget, Conversion, ConversionCanceledError,
} from 'mediabunny';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { readThrough } from './streamingServer';

/** Codecs no browser decodes — the ones worth loading 32 MB to handle. */
const NEEDS_WASM = ['ac3', 'eac3', 'dts', 'truehd'];
export const needsWasmDecoder = (codec: string | null | undefined): boolean =>
  NEEDS_WASM.includes(String(codec || '').toLowerCase());

/* ffmpeg's demuxer name for a raw elementary stream of each. Feeding packets back as the
 * format they already are avoids a container round-trip. */
const RAW_FORMAT: Record<string, string> = { ac3: 'ac3', eac3: 'eac3', dts: 'dts', truehd: 'truehd' };

const AUDIO_WINDOW = 20;   // seconds transcoded per pass
const AHEAD_MAX = 30;      // seconds to stay ahead of the playhead

/* LOADED ONCE, LAZILY, AND ONLY FOR FILES THAT NEED IT. Most sources never touch this path,
 * and 32 MB on every page load would tax the majority to serve the minority. */
let ffmpegPromise: Promise<FFmpeg> | null = null;
export const decoderLoaded = (): boolean => ffmpegPromise !== null;

export function loadDecoder(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ff = new FFmpeg();
      /* Blob URLs, not paths: ffmpeg.wasm loads its core with a dynamic `import()`, and a
       * dev server that rewrites module requests (Vite appends `?import`) 404s on a file
       * served from /public. The app's CSP already allows this — `worker-src 'self' blob:`
       * and `script-src … 'wasm-unsafe-eval'` are both set in vercel.json. */
      await ff.load({
        coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
      });
      return ff;
    })().catch((e) => { ffmpegPromise = null; throw e; }); // let a failed load be retried
  }
  return ffmpegPromise;
}

/* One ffmpeg run at a time: it is a single WASM instance with one virtual filesystem, so
 * overlapping `exec()` calls would fight over the same file names. */
let ffChain: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = ffChain.then(fn, fn) as Promise<T>;
  ffChain = next.catch(() => {});
  return next;
}

/**
 * Transcode one window of undecodable audio into a fragmented MP4 MediaSource will accept.
 *
 * `-movflags cmaf` is what makes the output appendable, and finding that took two wrong
 * turns worth recording, because both fail in ways that point at the wrong thing:
 *
 *   · The usual MSE recipe is `frag_keyframe+empty_moov+default_base_is_moof`, and this
 *     build REJECTS the last flag ("Undefined constant or missing '(' …"). The run dies
 *     while writing the header, AFTER the decoder is set up, so the log shows a healthy
 *     `ac3 (native) -> aac (native)` line immediately above the error and it reads like a
 *     decoding failure when it is a muxer-option failure.
 *   · Dropping the flag makes ffmpeg exit 0 and produce a VALID file MediaSource still
 *     refuses — `mp4a.40.2`, 48 kHz stereo, mime accepted by `isTypeSupported`, and
 *     `appendBuffer` fires an error event. Without it the fragments carry absolute
 *     `base_data_offset` values, which Chrome will not take. The file is fine; the layout
 *     is not; nothing in ffmpeg's output says so.
 *
 * `cmaf` implies the same offset rule and this build supports it. A verified fallback, if a
 * future build lacks `cmaf` too: emit raw ADTS and let mediabunny do the muxing.
 */
async function transcodeWindow(ff: FFmpeg, codec: string, bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const inName = `w${index}.${RAW_FORMAT[codec] || 'ac3'}`;
  const outName = `w${index}.mp4`;
  return serialise(async () => {
    await ff.writeFile(inName, bytes);
    const code = await ff.exec([
      '-f', RAW_FORMAT[codec] || 'ac3', '-i', inName,
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', 'cmaf',
      '-f', 'mp4', outName,
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    const data = await ff.readFile(outName) as Uint8Array;
    // The virtual filesystem is not swept for us, and a film is a lot of windows.
    try { await ff.deleteFile(inName); await ff.deleteFile(outName); } catch { /* fine */ }
    return data;
  });
}

/* MediaSource rejects an append while another is in flight on the SAME buffer. Video and
 * audio get separate queues because they are separate buffers. */
function makeAppender(sb: SourceBuffer) {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(bytes: Uint8Array) {
      chain = chain.then(() => new Promise<void>((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
        sb.addEventListener('error', reject, { once: true });
        try { sb.appendBuffer(bytes as BufferSource); } catch (e) { reject(e); }
      })).catch(() => {});
      return chain;
    },
    idle: () => chain,
  };
}

const aheadOf = (el: HTMLVideoElement, t: number): number => {
  const b = el.buffered;
  for (let i = 0; i < b.length; i += 1) if (t >= b.start(i) - 0.25 && t <= b.end(i)) return b.end(i) - t;
  return 0;
};

export interface WasmAudioHandle {
  codec: string;
  tracks: Array<{ index: number; codec: string; language: string; channels: number }>;
  switchAudio: (i: number) => Promise<void>;
  destroy: () => Promise<void>;
}

/**
 * Play a file whose chosen audio track is AC-3 / E-AC-3 / DTS.
 *
 * Video streams untouched; only the audio is decoded and re-encoded, in the page.
 */
export async function playWithWasmAudio(
  videoEl: HTMLVideoElement,
  url: string,
  audioIndex: number,
  onLog: (m: string) => void = () => {},
): Promise<WasmAudioHandle> {
  const input = new Input({ source: new UrlSource(readThrough(url)), formats: ALL_FORMATS });
  const [videoTrack] = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const duration = await input.computeDuration();
  if (!videoTrack || !audioTracks[audioIndex]) throw new Error('need one video and one audio track');

  const vCodec = await videoTrack.getCodecParameterString();
  const videoMime = `video/mp4; codecs="${vCodec}"`;
  const audioMime = 'audio/mp4; codecs="mp4a.40.2"';   // what we transcode TO
  if (!MediaSource.isTypeSupported(videoMime)) throw new Error(`cannot play ${videoMime}`);
  if (!MediaSource.isTypeSupported(audioMime)) throw new Error(`cannot play ${audioMime}`);

  const ff = await loadDecoder();
  let current = audioIndex;
  let generation = 0;
  let destroyed = false;
  let conversion: Conversion | null = null;

  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  ms.duration = duration;
  const videoSB = ms.addSourceBuffer(videoMime);
  const audioSB = ms.addSourceBuffer(audioMime);
  videoSB.mode = 'segments';
  audioSB.mode = 'segments';
  const vAppend = makeAppender(videoSB);
  const aAppend = makeAppender(audioSB);

  /** Video: the streaming path from browserDemux.ts, with the audio discarded. */
  async function pumpVideo(from: number): Promise<void> {
    const mine = generation;
    let ready: (() => void) | null = null;
    const playable = new Promise<void>((res) => { ready = res as () => void; });
    const writable = new WritableStream<Uint8Array>({
      async write(bytes) {
        if (destroyed || mine !== generation) throw new Error('superseded');
        await vAppend.append(bytes);
        if (ready) { ready(); ready = null; }
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
      input, output,
      audio: { discard: true },                    // audio comes from the other pipeline
      trim: from > 0 ? { start: from } : undefined,
      showWarnings: false,
    });
    void (async () => {
      try { await conversion.execute(); } catch (e) {
        if (!(e instanceof ConversionCanceledError) && !destroyed && mine === generation) {
          onLog(`video stopped: ${(e as Error).message}`);
        }
      }
    })();
    return playable;
  }

  /** Audio: pull packets, transcode a window at a time, append at the right timestamp. */
  async function pumpAudio(from: number): Promise<void> {
    const mine = generation;
    const sink = new EncodedPacketSink(audioTracks[current]);
    let windowIndex = 0;
    let cursor = from;

    while (!destroyed && mine === generation && cursor < duration) {
      // The same backpressure rule as the video, so the decoder idles when nobody is watching.
      while (!destroyed && mine === generation && aheadOf(videoEl, videoEl.currentTime) >= AHEAD_MAX) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (destroyed || mine !== generation) return;

      const end = Math.min(cursor + AUDIO_WINDOW, duration);

      /* `getPacket(t)` FINDS A PACKET AT t, AND A TRACK NEED NOT HAVE ONE AT ZERO.
       *
       * A track whose first packet starts a few milliseconds in — normal when a file's
       * streams are not aligned, and true of the AC-3 track in a mixed-codec release —
       * answers `null` here. The loop then broke on its first pass, no audio was ever
       * appended, and the element sat at `readyState 0` for ever with only video buffered:
       * a permanent silent stall that looks exactly like a decoder failure and is not one.
       * The decoder was never asked to do anything.
       *
       * `getFirstPacket()` is the right question for the opening window — "wherever this
       * track begins" rather than "at this exact timestamp". */
      let startPacket = await sink.getPacket(cursor);
      if (!startPacket && windowIndex === 0) startPacket = await sink.getFirstPacket();
      if (!startPacket) break;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let first: number | null = null;
      for await (const p of sink.packets(startPacket)) {
        if (first === null) first = p.timestamp;
        chunks.push(p.data);
        bytes += p.data.byteLength;
        if (p.timestamp >= end) break;
      }
      if (!chunks.length) break;
      const raw = new Uint8Array(bytes);
      let o = 0;
      for (const c of chunks) { raw.set(c, o); o += c.byteLength; }

      try {
        const mp4 = await transcodeWindow(ff, audioTracks[current].codec ?? 'ac3', raw, windowIndex++);
        if (destroyed || mine !== generation) return;
        /* Each window is transcoded alone and therefore timestamped from zero; the offset
         * is what places it on the film's timeline. */
        audioSB.timestampOffset = first ?? cursor;
        await aAppend.append(mp4);
      } catch (e) {
        onLog(`audio window at ${cursor.toFixed(0)}s failed: ${(e as Error).message}`);
        return;
      }
      cursor = end;
    }
  }

  async function startAt(from: number): Promise<void> {
    generation += 1;
    if (conversion) { try { await conversion.cancel(); } catch { /* done */ } conversion = null; }
    await Promise.all([vAppend.idle(), aAppend.idle()]);
    if (videoSB.timestampOffset !== from) videoSB.timestampOffset = from;
    const playable = pumpVideo(from);
    void pumpAudio(from);
    await playable;
  }

  await startAt(0);
  onLog(`${audioTracks[current].codec} decoded in the page · video untouched`);

  return {
    codec: audioTracks[current].codec ?? '',
    tracks: audioTracks.map((t, i) => ({
      index: i, codec: t.codec ?? '', language: t.languageCode || 'und', channels: t.numberOfChannels,
    })),
    async switchAudio(i) {
      if (i === current || destroyed) return;
      current = i;
      const at = videoEl.currentTime;
      generation += 1;
      try { audioSB.abort(); videoSB.abort(); } catch { /* not updating */ }
      await startAt(at);
      videoEl.currentTime = at;
    },
    async destroy() {
      destroyed = true;
      if (conversion) { try { await conversion.cancel(); } catch { /* done */ } }
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* fine */ }
    },
  };
}
