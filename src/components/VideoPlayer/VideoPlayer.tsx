import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayer } from '../../stores/player';
import { useHistory } from '../../stores/history';
import { useSettings } from '../../stores/settings';
import { useT } from '../../i18n/i18n';
import { loadHls, isHlsUrl, type HlsInstance } from '../../lib/hls';
import { toVttBlobUrl } from '../../lib/subtitles';
import { apiFetch } from '../../lib/api';
import { registerBackHandler, mediaAction } from '../../lib/tvKeys';
import EpisodePanel from './EpisodePanel';

/* THE TV BUILD IS A DIFFERENT PLAYER, and this constant is what splits them. `import.meta.env.MODE`
 * is a Vite compile-time string, so every `IS_TV` branch below is resolved at build time and the
 * losing side is dropped: the website never carries the remote-control code, and the TV never
 * carries the mouse-gesture code or the controls a set has no use for. See "TEN FEET AWAY" below. */
const IS_TV = import.meta.env.MODE === 'tv';

// skip-intro heuristic window (s) + credits-tail length when no IntroDB markers exist
const INTRO_FROM = 8, INTRO_TO = 92, CREDITS_TAIL = 35;
interface Segments { intro?: { start: number; end: number }; outro?: { start: number; end: number } }

const IcEpisodes = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 5h16v2H4zM4 11h16v2H4zM4 17h10v2H4z" /></svg>;

// friendly name for an HLS audio rendition + a snapped quality label (matches vanilla)
const AUDIO_NAMES: Record<string, string> = { eng: 'English', en: 'English', rus: 'Russian', ru: 'Russian', ka: 'ქართული', kat: 'ქართული', geo: 'ქართული', ukr: 'Ukrainian', uk: 'Ukrainian', tur: 'Turkish', fre: 'French', fr: 'French', ger: 'German', de: 'German', ita: 'Italian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', spa: 'Spanish', es: 'Spanish' };
function audioName(a: { name?: string; lang?: string }, i: number): string { return a.name || AUDIO_NAMES[(a.lang || '').toLowerCase()] || a.lang || `Track ${i + 1}`; }
function levelLabel(l: { height?: number; width?: number; bitrate?: number }): string {
  const eq = Math.max(l.height || 0, l.width ? Math.round((l.width * 9) / 16) : 0);
  if (eq >= 1900) return '2160p'; if (eq >= 1300) return '1440p'; if (eq >= 900) return '1080p';
  if (eq >= 650) return '720p'; if (eq >= 400) return '480p'; if (eq >= 300) return '360p';
  if (eq > 0) return '240p'; return l.bitrate ? Math.round(l.bitrate / 1000) + 'k' : '?';
}
function applyAudioPref(hls: HlsInstance, pref: string) {
  if (!pref || pref === 'original') return;
  const re = new RegExp(pref, 'i');
  const i = hls.audioTracks.findIndex((a) => re.test((a.name || '') + ' ' + (a.lang || '')));
  if (i >= 0 && hls.audioTrack !== i) { try { hls.audioTrack = i; } catch { /* ignore */ } }
}

/* Core video player — reproduces the #playerOverlay markup/classes (so app.css
 * styles it) with HLS.js + native playback and the essential controls: play/pause,
 * scrubber (buffered + played + tooltip), ±10s, volume/mute, time, speed, quality
 * (HLS levels), subtitles, PiP, fullscreen, keyboard, and auto-hide chrome.
 *
 * On touch devices a full-frame gesture surface adds phone controls: tap to
 * toggle chrome, double-tap the left/right third to seek ±10s (accumulating),
 * vertical drag for volume (right half) / brightness (left half), and a
 * horizontal drag to scrub — mirroring the native mobile players. */

const Worm = (
  <svg className="vp-pl" viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
    <defs><linearGradient id="vpPlGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f4f4f7" /><stop offset="100%" stopColor="#8d8d95" /></linearGradient></defs>
    <circle className="vp-pl__ring" r="56" cx="64" cy="64" fill="none" strokeWidth="16" strokeLinecap="round" />
    <path className="vp-pl__worm" d="M92,15.492S78.194,4.967,66.743,16.887c-17.231,17.938-28.26,96.974-28.26,96.974L119.85,59.892l-99-31.588,57.528,89.832L97.8,19.349,13.636,88.51l89.012,16.015S81.908,38.332,66.1,22.337C50.114,6.156,36,15.492,36,15.492a56,56,0,1,0,56,0Z" fill="none" stroke="url(#vpPlGrad)" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="44 1111" strokeDashoffset="10" />
  </svg>
);
const IcPlay = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
const IcPause = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>;
const IcBack = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12.5 7V4l-5 5 5 5V11a4.5 4.5 0 1 1-4.5 4.5H6A6 6 0 1 0 12.5 7z" /></svg>;
const IcFwd = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M11.5 7V4l5 5-5 5V11A4.5 4.5 0 1 0 16 15.5h1.5A6 6 0 1 1 11.5 7z" /></svg>;
const IcMute = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcGear = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-3.8l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h3.8l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.2A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4z" /></svg>;
const IcPip = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm6 4h7v5h-7v-5z" /></svg>;
const IcFs = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z" /></svg>;

// gesture-HUD glyphs: double-chevron seek ripples + volume/brightness meters
const IcRew = <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M11 6l-6 6 6 6V6zm8 0l-6 6 6 6V6z" /></svg>;
const IcFF = <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M13 6l6 6-6 6V6zM5 6l6 6-6 6V6z" /></svg>;
const IcVolHud = <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcVolMuteHud = <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcSun = <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/* A REMOTE HAS NO SLIDER. The two enhance controls are `<input type=range>` on the web, which is
 * the right control for a mouse and an unusable one for a D-pad: arrows nudge it by one step, and
 * nothing moves focus back OUT of it. On the TV they become four presets each — the same list
 * shape as every other menu section, so the same one press picks one. */
const TV_GRAIN = [0, 0.08, 0.18, 0.3];
const TV_CLARITY = [0, 0.25, 0.5, 0.85];
const TV_LEVEL_KEYS = ['menu.off', 'menu.low', 'menu.medium', 'menu.high'];

/* ---- TEN FEET AWAY: WHAT THE REMOTE DOES ---------------------------------------------------
 * The player has two modes on a TV and exactly one thing moves between them.
 *
 *   TRANSPORT (default). The chrome is down or merely showing, and nothing in it holds focus.
 *   Left/Right seek, OK plays and pauses, the remote's own ▶ ⏸ ⏪ ⏩ do what they say. This is
 *   what someone watching a film wants from a remote 95% of the time and it must cost zero
 *   presses to reach — so it is where the player starts and where it returns.
 *
 *   CONTROLS. Up or Down summons the bar and hands the D-pad to TvSpatialNav (via the `tv-nav`
 *   class it watches for), which walks the buttons, the gear menu, the subtitle and quality
 *   lists and the episode panel as ordinary focus targets. Back steps out again — one layer at
 *   a time, through the menu and the panel first, exactly like every other overlay in the app.
 *
 * SEEKING IS PREVIEWED, NOT APPLIED. A remote autorepeats, and setting `currentTime` on every
 * repeat asks the demuxer to re-seek ten times a second — on a TV that is a black screen and a
 * spinner for as long as the button is held. So presses accumulate into a PREVIEW position that
 * only the scrubber knows about, and the seek happens once, ~half a second after the last press.
 * Holding the button also lengthens the step (10s → 30s → 60s), because crossing forty minutes
 * of a film ten seconds at a time is not something anyone should have to sit through. */
const TV_SEEK_COMMIT_MS = 550;  // stillness that ends a scrub and applies it
const TV_SEEK_REPEAT_MS = 400;  // gap under which two presses count as "held"
const TV_HIDE_MS = 5000;        // chrome auto-hide — longer than the desktop's 3s; reading is slower from a sofa

// each menu section's collapsible gear-header icon + a single checkable option row
const AccIc = <svg className="vp-acc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;

function OptRow({ on, label, sub, onClick }: { on: boolean; label: string; sub?: string; onClick: () => void }) {
  return (
    <div className={`vp-opt${on ? ' on' : ''}`} role="menuitemradio" aria-checked={on} tabIndex={0}
      onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <span className="ck">{on ? '✓' : ''}</span>{label}{sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(ss).padStart(2, '0')}`;
}

interface Level { i: number; height?: number }

export default function VideoPlayer() {
  const t = useT();
  const source = usePlayer((s) => s.source);
  const close = usePlayer((s) => s.close);
  const record = useHistory((s) => s.record);
  const putProgress = useHistory((s) => s.putProgress);
  const getResume = useHistory((s) => s.getResume);
  const flush = useHistory((s) => s.flush);
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const kernelRef = useRef<SVGFEConvolveMatrixElement>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const recordedRef = useRef(false);   // record watch-history once per opened source
  const lastProgRef = useRef(0);       // throttle progress writes
  const resumedRef = useRef(false);    // seek-to-resume once per source

  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [levels, setLevels] = useState<Level[]>([]);
  const [curLevel, setCurLevel] = useState(-1);
  const [loading, setLoading] = useState(true);
  // null = no error; 'source' = stream host unreachable (network/manifest — try another
  // source); 'codec' = file loaded but the browser can't decode it (mkv/AC3…)
  const [errKind, setErrKind] = useState<null | 'source' | 'codec'>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentSub, setCurrentSub] = useState(-1); // -1 = subtitles off
  const [audioTracks, setAudioTracks] = useState<Array<{ i: number; name: string }>>([]);
  const [curAudio, setCurAudio] = useState(0);
  const [acc, setAcc] = useState<Record<string, boolean>>({}); // expanded accordion sections
  const [fs, setFs] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [vtt, setVtt] = useState<Array<{ lang: string; label: string; url: string }>>([]);
  const [epPanelOpen, setEpPanelOpen] = useState(false);
  const [segments, setSegments] = useState<Segments | null>(null);
  const ccOn = currentSub >= 0;

  // --- TV remote (see "TEN FEET AWAY" above; all of this is dropped from the web build) ---
  const [tvNav, setTvNav] = useState(false);              // the D-pad is driving the chrome
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const tvNavRef = useRef(false);                         // fresh read from bump()'s timer
  const seekPreviewRef = useRef<number | null>(null);     // fresh read from the key handler
  const seekCommitTimer = useRef<number | undefined>(undefined);
  const seekRepeats = useRef(0);
  const seekLastAt = useRef(0);
  const tvWantFocus = useRef<'bar' | 'gear' | 'episodes'>('bar'); // where the bar should re-seed focus
  useEffect(() => { tvNavRef.current = tvNav; }, [tvNav]);

  // --- mobile touch gestures ---
  // enabled only where the primary pointer is coarse (phones/tablets), so the
  // gesture surface never eats mouse clicks on hybrid laptops.
  const [isTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  const [webkitPip, setWebkitPip] = useState(false); // iPad/iOS per-video PiP
  const [bright, setBright] = useState(1);            // 1 = full; web can't set device brightness so we dim the frame
  const [seekHud, setSeekHud] = useState<{ side: 'left' | 'right'; secs: number } | null>(null);
  const [vHud, setVHud] = useState<{ kind: 'vol' | 'bright'; val: number } | null>(null);
  const hideUiRef = useRef(false);                    // fresh read for deferred single-tap
  const gestRef = useRef({ active: false, x0: 0, y0: 0, t0: 0, w: 1, h: 1, mode: '' as '' | 'seek' | 'vol' | 'bright', startVol: 1, startBright: 1, startTime: 0 });
  const lastTapRef = useRef({ t: 0, x: 0, side: '' as '' | 'left' | 'center' | 'right' });
  const seekAccumRef = useRef<{ side: '' | 'left' | 'right'; secs: number }>({ side: '', secs: 0 });
  const singleTapTimer = useRef<number | undefined>(undefined);
  const seekHudTimer = useRef<number | undefined>(undefined);
  const vHudTimer = useRef<number | undefined>(undefined);
  useEffect(() => { hideUiRef.current = hideUi; }, [hideUi]);

  // attach the source (HLS via hls.js, else native)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source) return;
    let cancelled = false;
    recordedRef.current = false; resumedRef.current = false; lastProgRef.current = 0;
    setLoading(true); setErrKind(null); setPlaying(false); setCur(0); setDur(0); setBuffered(0); setLevels([]); setCurLevel(-1); setMenuOpen(false); setHideUi(false); setAudioTracks([]); setCurAudio(0); setEpPanelOpen(false); setBright(1); setSeekHud(null); setVHud(null); seekAccumRef.current = { side: '', secs: 0 };
    setTvNav(false); setSeekPreview(null); seekPreviewRef.current = null; window.clearTimeout(seekCommitTimer.current);
    const url = source.url;
    // Prefer hls.js for any HLS source. DON'T gate on canPlayType('…mpegurl'):
    // modern Chrome returns "maybe" for that MIME type yet CANNOT actually play HLS
    // (no native demuxer) — trusting it sent every HLS stream down the native path and
    // stalled on a black screen. Native HLS is only a fallback for Safari/iOS, where
    // hls.js reports isSupported()===false.
    const isHls = source.kind === 'hls' || isHlsUrl(url);
    const canNativeHls = !!v.canPlayType('application/vnd.apple.mpegurl');

    if (isHls) {
      loadHls().then((Hls) => {
        if (cancelled || !v) return;
        if (Hls && Hls.isSupported()) {
          /* Buffer ahead (and keep a back-buffer) so rewinds / short forward-seeks land in
           * already-loaded video instead of stalling and snapping back; generous manifest/level
           * timeouts for slow add-on hosts.
           *
           * THE BUFFER NUMBERS ARE A TV BUDGET NOW, NOT A DESKTOP ONE. They were 600s forward and
           * 180s back, which on a set with a few hundred MB of headroom is not a buffer, it is an
           * out-of-memory report waiting to be filed: at a 6 Mbps stream 600s is ~450 MB of
           * demuxed fMP4 held live, and the pressure lands as decode stutter long before it lands
           * as a crash. 120/60 still covers every seek the remote can actually make — the bar
           * skips in tens of seconds — and is what the browser is asked to hold at once.
           *
           * capLevelToPlayerSize IS THE OTHER HALF, and the more important one. Without it ABR
           * climbs the ladder on bandwidth alone: a 4K rendition would be fetched, demuxed and
           * DECODED to be painted into a 1080p panel, which is the single most expensive thing
           * this player can be asked to do and buys nothing anyone can see. With it the ladder is
           * capped by the element's real painted size, so a 1080p set decodes 1080p. */
          const hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 120,
            backBufferLength: 60,
            capLevelToPlayerSize: true,
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
          });
          hlsRef.current = hls;
          // Recover from fatal-but-recoverable errors instead of stalling forever on
          // the loading spinner — the #1 reason some add-on streams never started.
          const fail = () => { try { hls.destroy(); } catch { /* ignore */ } setLoading(false); setErrKind('source'); };
          let fragTries = 0, mediaTries = 0;
          hls.on('hlsError', (...a: unknown[]) => {
            const data = a[1] as { fatal?: boolean; type?: string; details?: string } | undefined;
            if (!data || !data.fatal) return;
            const d = data.details || '';
            // A playlist that can't be fetched/parsed (upstream 403, expired token, dead
            // host) is terminal — startLoad() only resumes FRAGMENT loading, not the
            // manifest, so retrying here just hangs on a black screen. Surface it.
            if (/manifestLoad|manifestParsing|manifestIncompatible|levelLoad|levelEmpty|noLevelsAvailable/i.test(d)) { fail(); return; }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              if (fragTries++ >= 3) { fail(); return; }   // fragments keep failing → give up
              try { hls.startLoad(); } catch { fail(); }
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              if (mediaTries++ >= 2) { fail(); return; }
              try { hls.recoverMediaError(); } catch { fail(); }
            } else { fail(); }
          });
          hls.loadSource(url);
          hls.attachMedia(v);
          hls.on('hlsManifestParsed', () => {
            setLevels(hls.levels.map((l, i) => ({ i, height: l.height })));
            // apply the preferred-quality setting (else stay on auto)
            const pref = settings.autoQuality;
            if (pref !== 'best') {
              const want = pref === '4k' ? 2160 : 1080;
              let best = -1, bestH = -1;
              hls.levels.forEach((l, i) => { const h = l.height ?? 0; if (h <= want && h > bestH) { bestH = h; best = i; } });
              if (best >= 0) hls.currentLevel = best;
            }
            // audio renditions + preferred audio language
            if (hls.audioTracks && hls.audioTracks.length > 1) {
              applyAudioPref(hls, settings.audioLang);
              setAudioTracks(hls.audioTracks.map((a, i) => ({ i, name: audioName(a, i) })));
              setCurAudio(hls.audioTrack);
            }
            v.play().catch(() => {});
          });
          hls.on('hlsLevelSwitched', () => setCurLevel(hls.currentLevel));
          hls.on('hlsAudioTrackSwitched', () => setCurAudio(hls.audioTrack));
          hls.on('hlsAudioTracksUpdated', () => {
            if (hls.audioTracks && hls.audioTracks.length > 1) { setAudioTracks(hls.audioTracks.map((a, i) => ({ i, name: audioName(a, i) }))); setCurAudio(hls.audioTrack); }
          });
        } else if (canNativeHls) {
          // Safari / iOS: real native HLS playback.
          v.src = url; v.play().catch(() => {});
        } else {
          setLoading(false); setErrKind('source');
        }
      });
    } else {
      // progressive file (mp4/webm/…) — native playback
      v.src = url; v.play().catch(() => {});
    }

    return () => {
      cancelled = true;
      window.clearTimeout(hideTimer.current); // don't let a pending auto-hide fire into the next open
      flush(); // persist any pending resume-progress when the source changes / player closes
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch { /* ignore */ } hlsRef.current = null; }
      try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
    };
  }, [source, flush]);

  // convert add-on subtitle tracks (SRT / gzipped) to same-origin VTT blob URLs so
  // the browser can actually render them
  useEffect(() => {
    const subs = source?.subtitles;
    if (!subs?.length) { setVtt([]); return; }
    let alive = true;
    const created: string[] = [];
    Promise.all(subs.map(async (s) => {
      const url = await toVttBlobUrl(s.url);
      if (url) created.push(url);
      return url ? { lang: s.lang, label: s.label, url } : null;
    })).then((tracks) => { if (alive) setVtt(tracks.filter(Boolean) as Array<{ lang: string; label: string; url: string }>); });
    return () => { alive = false; created.forEach((u) => URL.revokeObjectURL(u)); };
  }, [source]);

  // honor the default-subtitles-language setting once tracks exist
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const want = settings.subLang;
    let shown = -1;
    for (let i = 0; i < v.textTracks.length; i++) {
      const match = want !== 'off' && !!vtt[i]?.lang?.toLowerCase().startsWith(want);
      v.textTracks[i].mode = match && shown < 0 ? 'showing' : 'hidden';
      if (match && shown < 0) shown = i;
    }
    setCurrentSub(shown);
  }, [vtt, settings.subLang]);

  // IntroDB intro/outro markers for the current episode (best-effort; the skip button
  // falls back to the heuristic window when there are none)
  useEffect(() => {
    setSegments(null);
    const s = source?.series;
    if (!s?.imdb) return;
    let alive = true;
    apiFetch(`/api/introdb/${encodeURIComponent(s.imdb)}/${s.season}/${s.ep}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && (d.intro || d.outro)) setSegments(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [source?.series]);

  const bump = useCallback(() => {
    setHideUi(false);
    window.clearTimeout(hideTimer.current);
    /* CHROME THE REMOTE IS STANDING ON MUST NOT FADE OUT FROM UNDER IT. On the web the pointer
     * leaves and the bar goes; on a TV "focus is on the mute button" is a position the viewer is
     * holding, and hiding it would leave an invisible selection and a bar that reappears
     * somewhere unexpected on the next press. It hides when they step OUT of it — see exitTvNav. */
    if (IS_TV && tvNavRef.current) return;
    hideTimer.current = window.setTimeout(() => { if (!videoRef.current?.paused) setHideUi(true); }, IS_TV ? TV_HIDE_MS : 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);
  const nudge = useCallback((d: number) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d)); }, []);

  /* Apply a pending scrub. Called by the idle timer, by OK, and by anything that ends the
   * gesture early (leaving the bar, a transport key, closing the player). */
  const commitSeek = useCallback(() => {
    window.clearTimeout(seekCommitTimer.current);
    const pos = seekPreviewRef.current;
    seekPreviewRef.current = null; seekRepeats.current = 0;
    setSeekPreview(null);
    const v = videoRef.current;
    if (v && pos != null) v.currentTime = pos;
    bump();
  }, [bump]);

  /** One press of Left/Right (or ⏪/⏩) in TV mode: extend the preview, defer the seek. */
  const tvSeek = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    const now = performance.now();
    seekRepeats.current = now - seekLastAt.current < TV_SEEK_REPEAT_MS ? seekRepeats.current + 1 : 0;
    seekLastAt.current = now;
    // Held-button acceleration — see the note above. Thresholds are presses, not seconds, so a
    // slow deliberate tap-tap-tap never accelerates however long it goes on.
    const step = seekRepeats.current >= 12 ? 60 : seekRepeats.current >= 5 ? 30 : 10;
    const base = seekPreviewRef.current ?? v.currentTime;
    const next = clamp(base + dir * step, 0, v.duration);
    seekPreviewRef.current = next;
    setSeekPreview(next);
    // Show the bar for the duration of the scrub without handing the D-pad over: the viewer is
    // seeking, not choosing, and the next Left press must still seek rather than move a selection.
    setHideUi(false);
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = window.setTimeout(commitSeek, TV_SEEK_COMMIT_MS);
  }, [commitSeek]);

  /** Summon the controls and give the D-pad to them. */
  const enterTvNav = useCallback(() => {
    if (seekPreviewRef.current != null) commitSeek();
    setHideUi(false);
    window.clearTimeout(hideTimer.current);
    setTvNav(true);
  }, [commitSeek]);

  /** Step back out to transport mode: nothing selected, chrome free to fade again. */
  const exitTvNav = useCallback(() => {
    setTvNav(false);
    tvNavRef.current = false;                 // bump() reads the ref, and state lands a tick late
    // Park focus on the overlay itself rather than leaving it on a button that is about to fade:
    // a stray OK would otherwise fire whatever the remote happened to be standing on.
    overlayRef.current?.focus({ preventScroll: true });
    bump();
  }, [bump]);

  /* WHERE THE REMOTE LANDS IN THE CONTROL BAR, and where it goes back to when a panel over the
   * bar closes. Both are the same problem — something has just appeared or disappeared and focus
   * has nowhere valid to be — so they share one effect keyed on all three states.
   *
   * The closing case is not optional. TvSpatialNav's own focus recovery deliberately skips this
   * overlay (the player manages itself), so with the gear menu unmounted the element the remote
   * was standing on is gone and focus falls to <body>; the next arrow press would restart from
   * the first candidate in the overlay, which is the ✕ in the far corner. Putting it back on the
   * button that opened the panel is what a viewer expects from closing one. */
  useEffect(() => {
    if (!IS_TV || !tvNav) return;
    const id = requestAnimationFrame(() => {
      const root = overlayRef.current;
      if (!root) return;
      if (menuOpen || epPanelOpen) return;            // the panel seeds its own first row
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && ae !== root && root.contains(ae)) return; // already somewhere real
      /* AN EXPLICIT HINT BEATS EVERYTHING, because it means the viewer has just closed a panel
         and there is a right answer: the button they opened it with. Only when there is no hint
         does SKIP INTRO take it — that button is on screen for perhaps ninety seconds and is the
         only reason most people touch the remote during them, so summoning the controls while it
         is up should land on it rather than make the viewer walk there from the scrubber.
         `.show` is load-bearing: the button is in the DOM the whole time and `display:none` when
         it has nothing to say. */
      const target = (tvWantFocus.current === 'gear' ? root.querySelector<HTMLElement>('#vpGear') : null)
        ?? (tvWantFocus.current === 'episodes' ? root.querySelector<HTMLElement>('#vpEpisodes') : null)
        ?? root.querySelector<HTMLElement>('.vp-skip.show')
        ?? barRef.current
        ?? root.querySelector<HTMLElement>('#vpPlay');
      tvWantFocus.current = 'bar';
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [tvNav, menuOpen, epPanelOpen]);
  const toggleMute = useCallback(() => { const v = videoRef.current; if (v) v.muted = !v.muted; }, []);
  const toggleFs = useCallback(() => {
    const el = overlayRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el?.requestFullscreen) { el.requestFullscreen(); return; }
    // iPhone Safari can't fullscreen an element — only the <video> itself
    if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen();
  }, []);
  const togglePip = useCallback(async () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string }) | null;
    if (!v) return;
    try {
      // iPad/iOS expose PiP via webkitSetPresentationMode, not the standard API
      if (typeof v.webkitSetPresentationMode === 'function') {
        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        return;
      }
      if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture();
    } catch { /* ignore */ }
  }, []);
  const setLevel = (i: number) => { const h = hlsRef.current; if (h) h.currentLevel = i; setCurLevel(i); };
  const setSpeed = (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; setRate(r); };
  const selectSub = (i: number) => {
    const v = videoRef.current; if (!v) return;
    for (let k = 0; k < v.textTracks.length; k++) v.textTracks[k].mode = k === i ? 'showing' : 'hidden';
    setCurrentSub(i);
  };
  const toggleCC = () => { if (!vtt.length) return; selectSub(ccOn ? -1 : Math.max(0, currentSub)); };
  const selectAudio = (i: number) => { const h = hlsRef.current; if (h) { try { h.audioTrack = i; } catch { /* ignore */ } } setCurAudio(i); };
  const toggleAcc = (sec: string) => setAcc((a) => ({ ...a, [sec]: !a[sec] }));

  // scrub
  const seekToClient = useCallback((clientX: number) => {
    const bar = barRef.current, v = videoRef.current; if (!bar || !v || !v.duration) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = ratio * v.duration;
  }, []);
  const onBarPointerDown = (e: React.PointerEvent) => {
    seekToClient(e.clientX);
    const move = (ev: PointerEvent) => seekToClient(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- touch gesture handlers (single tap toggles chrome; double-tap the left/right
  // third seeks ±10s and accumulates; a vertical drag adjusts volume on the right half
  // and brightness on the left; a horizontal drag scrubs) ---
  const showVHud = (kind: 'vol' | 'bright', val: number) => { window.clearTimeout(vHudTimer.current); setVHud({ kind, val }); };
  const hideVHudSoon = () => { window.clearTimeout(vHudTimer.current); vHudTimer.current = window.setTimeout(() => setVHud(null), 650); };

  const doDoubleTap = (region: 'left' | 'center' | 'right') => {
    const v = videoRef.current; if (!v) return;
    if (region === 'center') { togglePlay(); bump(); return; }
    const dir = region === 'left' ? -1 : 1;
    const acc = seekAccumRef.current;
    const secs = (acc.side === region ? acc.secs : 0) + 10;
    seekAccumRef.current = { side: region, secs };
    v.currentTime = clamp(v.currentTime + dir * 10, 0, v.duration || 0);
    setSeekHud({ side: region === 'left' ? 'left' : 'right', secs });
    window.clearTimeout(seekHudTimer.current);
    seekHudTimer.current = window.setTimeout(() => { setSeekHud(null); seekAccumRef.current = { side: '', secs: 0 }; }, 700);
  };

  const onGestureStart = (e: React.TouchEvent) => {
    const g = gestRef.current;
    if (e.touches.length !== 1) { g.active = false; return; }   // ignore pinch/multi-touch
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect(), tch = e.touches[0];
    g.active = true; g.mode = ''; g.t0 = performance.now();
    g.x0 = tch.clientX - r.left; g.y0 = tch.clientY - r.top; g.w = r.width; g.h = r.height;
    g.startVol = v?.muted ? 0 : (v?.volume ?? 1); g.startBright = bright; g.startTime = v?.currentTime ?? 0;
  };
  const onGestureMove = (e: React.TouchEvent) => {
    const g = gestRef.current;
    if (!g.active || e.touches.length !== 1) return;
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.touches[0].clientX - r.left) - g.x0, dy = (e.touches[0].clientY - r.top) - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;       // below intent threshold
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'seek' : (g.x0 < g.w / 2 ? 'bright' : 'vol');
      if (g.mode === 'seek') { setHideUi(false); window.clearTimeout(hideTimer.current); } // reveal scrubber
    }
    const span = g.h * 0.6;                                     // full-scale drag distance
    if (g.mode === 'vol' && v) {
      const nv = clamp(g.startVol - dy / span, 0, 1);
      v.volume = nv; v.muted = nv <= 0.001;
      showVHud('vol', nv);
    } else if (g.mode === 'bright') {
      const nb = clamp(g.startBright - dy / span, 0.15, 1);
      setBright(nb); showVHud('bright', (nb - 0.15) / 0.85);
    } else if (g.mode === 'seek' && v && v.duration) {
      const reach = Math.min(v.duration, 180);                  // full swipe = ±180s (or whole clip)
      v.currentTime = clamp(g.startTime + (dx / g.w) * reach, 0, v.duration);
    }
  };
  const onGestureEnd = () => {
    const g = gestRef.current;
    if (!g.active) return;
    g.active = false;
    if (g.mode) {                                               // a drag — settle HUDs
      if (g.mode === 'vol' || g.mode === 'bright') hideVHudSoon();
      else bump();                                              // scrub: restart auto-hide
      return;
    }
    const dt = performance.now() - g.t0;
    if (dt > 500) return;                                       // long-press: not a tap
    const region: 'left' | 'center' | 'right' = g.x0 < g.w * 0.35 ? 'left' : g.x0 > g.w * 0.65 ? 'right' : 'center';
    const now = performance.now(), last = lastTapRef.current;
    if (now - last.t < 320 && Math.abs(g.x0 - last.x) < 90 && last.side === region) {
      window.clearTimeout(singleTapTimer.current);             // upgrade to a double-tap
      lastTapRef.current = { t: now, x: g.x0, side: region };
      doDoubleTap(region);
    } else {
      lastTapRef.current = { t: now, x: g.x0, side: region };
      window.clearTimeout(singleTapTimer.current);
      singleTapTimer.current = window.setTimeout(() => {       // defer so a 2nd tap can upgrade
        if (hideUiRef.current) bump(); else { setHideUi(true); window.clearTimeout(hideTimer.current); }
      }, 280);
    }
  };

  // clear gesture timers on unmount
  useEffect(() => () => { window.clearTimeout(singleTapTimer.current); window.clearTimeout(seekHudTimer.current); window.clearTimeout(vHudTimer.current); }, []);

  // detect iPad/iOS per-video PiP once the media element exists
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSupportsPresentationMode?: (m: string) => boolean }) | null;
    if (v && typeof v.webkitSupportsPresentationMode === 'function') {
      try { setWebkitPip(!!v.webkitSupportsPresentationMode('picture-in-picture')); } catch { /* ignore */ }
    }
  }, [source]);

  // keyboard + fullscreen listener while open
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      /* Escape walks OUT one layer at a time. It used to close the whole player from anywhere,
       * so dismissing the gear menu tore down playback with it — two layers deep, wrong layer
       * closed. (On TV this handler never sees Escape at all: lib/tvKeys.ts resolves Back in the
       * capture phase and swallows it. The same order is repeated here because the website has
       * no such resolver and the bug was the website's too.) */
      if (e.key === 'Escape') {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (menuOpen) setMenuOpen(false);
        else if (epPanelOpen) setEpPanelOpen(false);
        else close();
        return;
      }
      /* Transport keys belong to the VIDEO, so they stand down while a panel is over it —
       * otherwise Left/Right seeks the film underneath the menu the user is reading. */
      if (menuOpen || epPanelOpen) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') nudge(-10);
      else if (e.key === 'ArrowRight') nudge(10);
      else if (e.key === 'm') toggleMute();
      else if (e.key === 'f') toggleFs();
      bump();
    };
    const onFs = () => setFs(!!document.fullscreenElement);
    /* NOT ON THE TV. The remote handler below replaces this one wholesale rather than layering
     * over it — these bindings assume a keyboard (space, k, m, f) and, worse, an unconsumed
     * ArrowLeft reaching here would seek the film a second time on top of the scrub the remote
     * handler had already started. The fullscreen listener stays either way; it costs nothing
     * and a TV shell can still be in and out of it. */
    if (!IS_TV) window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFs); };
  }, [source, close, togglePlay, nudge, toggleMute, toggleFs, bump, menuOpen, epPanelOpen]);

  /* ---- THE REMOTE ---------------------------------------------------------------------------
   * CAPTURE PHASE, and load-bearing for the same reason tvKeys' Back listener is: TvSpatialNav
   * binds `keydown` on the bubble phase, so a capture listener here runs first and can take
   * Left/Right back for the scrubber before spatial navigation treats them as movement.
   *
   * `stopImmediatePropagation` on everything consumed, so a press never does two jobs. */
  useEffect(() => {
    if (!IS_TV || !source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      const v = videoRef.current;

      /* 1. THE TRANSPORT ROW, which works from anywhere including inside the gear menu. These
       * buttons name their own action, so honouring them regardless of what has focus is what
       * the viewer expects — ⏸ means pause, not "pause unless a list is open". */
      const m = mediaAction(e);
      if (m) {
        consume();
        if (m === 'rew') { tvSeek(-1); return; }
        if (m === 'ff') { tvSeek(1); return; }
        if (seekPreviewRef.current != null) commitSeek();
        if (m === 'playpause') togglePlay();
        else if (m === 'play') v?.play().catch(() => { /* autoplay policy — the button stays */ });
        else if (m === 'pause') v?.pause();
        else if (m === 'stop') close();
        else if (m === 'next') source.next?.();
        // 'prev' has no meaning here: there is no previous-episode action in the player.
        bump();
        return;
      }

      // 2. A panel over the bar owns the D-pad completely — spatial nav walks it, and seeking
      // the film underneath a list the viewer is reading is the bug this exists to prevent.
      if (menuOpen || epPanelOpen) return;

      const k = e.key;
      const onBar = document.activeElement === barRef.current;

      // 3. THE SCRUBBER, whether it holds focus or nothing does. Same two keys, same job — which
      // is the point: Left is "back a bit" in both modes, so there is nothing to learn.
      if (!tvNav || onBar) {
        if (k === 'ArrowLeft') { consume(); tvSeek(-1); return; }
        if (k === 'ArrowRight') { consume(); tvSeek(1); return; }
        if (k === 'Enter' && seekPreviewRef.current != null) { consume(); commitSeek(); return; }
      }

      if (!tvNav) {
        /* 4. TRANSPORT MODE.
         *
         * OK IS PLAY/PAUSE AND NOTHING ELSE. It flashes the bar up (bump) as confirmation, and
         * that bar fades on its own once playback resumes — it deliberately does NOT hand the
         * D-pad over. Someone pausing to answer the door is not asking to be put into a control
         * bar they then have to press Back to escape; and if OK claimed the D-pad, the very next
         * Left press would move a selection instead of rewinding.
         *
         * Up or Down is the way in, which is what it is on every other television app. */
        if (k === 'Enter' || k === ' ') { consume(); togglePlay(); bump(); return; }
        if (k === 'ArrowUp' || k === 'ArrowDown') { consume(); enterTvNav(); return; }
        return;
      }

      // 5. CONTROLS MODE. Movement and OK belong to TvSpatialNav and to the buttons themselves;
      // all this does is keep the bar alive while the remote is working in it.
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter' || k === ' ') {
        setHideUi(false);
        window.clearTimeout(hideTimer.current);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [source, tvNav, menuOpen, epPanelOpen, tvSeek, commitSeek, enterTvNav, togglePlay, close, bump]);

  // A pending scrub must never outlive the player (or the source it was measured against).
  useEffect(() => () => window.clearTimeout(seekCommitTimer.current), []);

  /* The two layers the Back chain cannot see from outside: both are local state, not a store.
   * Registered while the player is open so a remote's Back closes the menu, then the episode
   * panel, then playback — one press each. Inert on the website, where nothing installs the
   * resolver that calls these. */
  useEffect(() => {
    if (!source) return;
    return registerBackHandler(() => {
      // The hint tells the focus effect which button to hand the remote back to — see there.
      if (menuOpen) { tvWantFocus.current = 'gear'; setMenuOpen(false); return true; }
      if (epPanelOpen) { tvWantFocus.current = 'episodes'; setEpPanelOpen(false); return true; }
      /* THE CONTROL BAR IS A LAYER TOO, and the last one before playback itself. Without this
       * step Back from the gear button closed the whole film — the viewer having opened the bar
       * only to check the subtitle track. Dismissing the controls is what Back means there;
       * a second press then closes the player, which is what it means everywhere else. */
      if (IS_TV && tvNav) { exitTvNav(); return true; }
      return false;
    });
  }, [source, menuOpen, epPanelOpen, tvNav, exitTvNav]);

  // picture-enhance: rewrite the unsharp-mask convolution kernel from the clarity
  // slider (identity at 0 → 3×3 Laplacian sharpen at 1; energy-preserving so it
  // doesn't shift brightness)
  useEffect(() => {
    const k = kernelRef.current; if (!k) return;
    const c = settings.clarity;
    k.setAttribute('kernelMatrix', `0 ${-c} 0 ${-c} ${1 + 4 * c} ${-c} 0 ${-c} 0`);
  }, [settings.clarity]);

  if (!source) return <div className="vp-overlay" id="playerOverlay" />;

  /* While a remote scrub is pending the bar shows where it WOULD land, not where the video still
   * is — that preview is the entire feedback for a seek that has not happened yet. */
  const shownTime = seekPreview ?? cur;
  const seekDelta = seekPreview == null ? 0 : Math.round(seekPreview - cur);
  const pct = dur ? (shownTime / dur) * 100 : 0;
  const bufPct = dur ? (buffered / dur) * 100 : 0;
  const hasSubs = vtt.length > 0;

  // ::cue styling from the subtitle settings (color / bg / size / outline)
  const ow = settings.subOutlineW, oc = settings.subOutline;
  const cueOutline = ow > 0 ? `text-shadow:${-ow}px ${-ow}px 0 ${oc},${ow}px ${-ow}px 0 ${oc},${-ow}px ${ow}px 0 ${oc},${ow}px ${ow}px 0 ${oc};` : '';
  const cueCss = `#playerVideo::cue{color:${settings.subColor};background-color:${settings.subBg};font-size:${settings.subSize}%;${cueOutline}}`;

  // contextual skip button: "Skip Intro" in the intro window, "Next Episode" in the
  // credits tail — IntroDB markers when available, else the heuristic (series, 5min+)
  let skipMode: 'intro' | 'next' | null = null;
  let skipTo = INTRO_TO;
  if (source.series && dur >= 300) {
    const intro = segments?.intro && segments.intro.end < dur ? segments.intro : null;
    const outroStart = segments?.outro && segments.outro.start > 0 && segments.outro.start < dur ? segments.outro.start : null;
    const nextAt = outroStart != null ? outroStart : dur - CREDITS_TAIL;
    if (source.next && cur >= nextAt && dur - cur > 0.5) skipMode = 'next';
    else {
      const inIntro = intro ? (cur >= intro.start && cur <= intro.end) : (cur >= INTRO_FROM && cur <= INTRO_TO);
      if (inIntro) { skipMode = 'intro'; skipTo = intro ? intro.end : INTRO_TO; }
    }
  }

  return (
    <div
      /* `tv-nav` is the flag TvSpatialNav watches: present means the D-pad drives the chrome,
         absent means the arrows are transport and it must stand down. `tv` is the styling hook
         for the 10-foot control bar. */
      className={`vp-overlay open${hideUi ? ' hide-ui' : ''}${settings.enhance ? ' enhance-on' : ''}${isTouch ? ' gestures-on' : ''}${webkitPip ? ' vp-has-webkit-pip' : ''}${IS_TV ? ' tv' : ''}${IS_TV && tvNav ? ' tv-nav' : ''}`}
      id="playerOverlay"
      ref={overlayRef}
      /* Focusable-but-not-tabbable so the remote has somewhere to rest when it steps out of the
         control bar. -1 keeps it out of TvSpatialNav's candidate pool (it filters tabIndex < 0). */
      tabIndex={IS_TV ? -1 : undefined}
      style={{ ['--grain' as string]: settings.enhance ? settings.grain : 0 }}
      onPointerMove={bump}
      onClick={(e) => { if (e.target === videoRef.current) togglePlay(); }}
    >
      {/* unsharp-mask filter for the Clarity control (kernel rewritten live above) */}
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <filter id="vpSharpen" colorInterpolationFilters="sRGB">
          <feConvolveMatrix ref={kernelRef} order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0" />
        </filter>
      </svg>
      <video
        id="playerVideo"
        ref={videoRef}
        playsInline
        style={{ filter: settings.enhance && settings.clarity > 0 ? 'url(#vpSharpen)' : undefined }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDur(v.duration || 0);
          // resume where we left off (once), if there's saved progress for this title
          if (!resumedRef.current && source.media?.key) {
            resumedRef.current = true;
            const r = getResume(source.media.key);
            if (r && r.pos > 0 && r.pos < (v.duration || Infinity)) v.currentTime = r.pos;
          }
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setCur(v.currentTime);
          // throttle resume-progress writes to ~once/5s
          const now = v.currentTime;
          if (source.media?.key && v.currentTime > 8 && Math.abs(now - lastProgRef.current) >= 5) {
            lastProgRef.current = now;
            putProgress(source.media.key, v.currentTime, v.duration || 0, source.media.lang);
          }
        }}
        onProgress={(e) => { const v = e.currentTarget; if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1)); }}
        onPlay={() => {
          setPlaying(true); bump();
          if (!recordedRef.current && source.media) {
            recordedRef.current = true;
            const m = source.media;
            record({ id: m.id, title: m.title, poster: m.poster, year: m.year, type: m.type, genre: m.genre, rating: m.rating, ep: m.ep, key: m.key, season: m.season, episode: m.episode });
          }
        }}
        onPause={() => { setPlaying(false); setHideUi(false); }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setLoading(false); setErrKind(null); }}
        onCanPlay={() => { setLoading(false); setErrKind(null); }}
        onError={() => { setLoading(false); setErrKind((k) => k ?? 'codec'); }}
        onVolumeChange={(e) => { setVol(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onEnded={() => { setPlaying(false); if (settings.autoplayNext && source.next) source.next(); }}
      >
        {vtt.map((s, i) => (
          <track key={i} kind="subtitles" src={s.url} srcLang={s.lang} label={s.label} />
        ))}
      </video>

      {/* subtitle appearance from Settings, applied to the cue text */}
      <style>{cueCss}</style>

      <div className="vp-grain" id="vpGrain" aria-hidden="true" />

      {/* mobile gesture surface: tap toggles chrome, double-tap sides seek ±10s,
          vertical drag = volume (right) / brightness (left), horizontal drag scrubs */}
      {isTouch && (
        <div className="vp-gestures" onTouchStart={onGestureStart} onTouchMove={onGestureMove} onTouchEnd={onGestureEnd} onTouchCancel={onGestureEnd}>
          <div className="vp-bright" style={{ opacity: clamp(1 - bright, 0, 0.85) }} />
          <div className={`vp-seekpulse left${seekHud?.side === 'left' ? ' show' : ''}`}>
            <span className="rip" />
            <span className="lbl">{IcRew}{(seekHud?.side === 'left' ? seekHud.secs : 10)}s</span>
          </div>
          <div className={`vp-seekpulse right${seekHud?.side === 'right' ? ' show' : ''}`}>
            <span className="rip" />
            <span className="lbl">{(seekHud?.side === 'right' ? seekHud.secs : 10)}s{IcFF}</span>
          </div>
          <div className={`vp-vhud${vHud ? ' show' : ''}`}>
            <span className="ic">{vHud?.kind === 'bright' ? IcSun : (vHud && vHud.val <= 0.001 ? IcVolMuteHud : IcVolHud)}</span>
            <span className="bar"><i style={{ width: `${Math.round((vHud?.val ?? 0) * 100)}%` }} /></span>
          </div>
        </div>
      )}

      {loading && !errKind && (
        <div className="vp-loading show" id="vpLoading" role="status" aria-live="polite">
          {Worm}
          <div className="lt">{t('player.preparing')}</div>
          <div className="ls" />
        </div>
      )}

      {errKind && (
        <div className="vp-loading show" id="vpError" role="alert" aria-live="assertive">
          <div className="lt">{t(errKind === 'source' ? 'player.source_unavailable' : 'player.cant_play')}</div>
          <div className="ls" style={{ opacity: 0.75, maxWidth: 420, textAlign: 'center' }}>{t(errKind === 'source' ? 'player.source_unavailable_sub' : 'player.cant_play_sub')}</div>
        </div>
      )}

      <div className="vp-ui">
        <div className="vp-top">
          <div>
            <div className="vp-title" id="playerTitle">{source.title || ''}</div>
            <div className="vp-subtitle" id="vpSubtitle">{source.subtitle || ''}</div>
          </div>
          <div className="vp-top-right">
            <div className="vp-status" id="playerStatus" role="status" aria-live="polite" />
            <button className="vp-icon" id="vpClose" title="Close (Esc)" aria-label={t('player.close')} onClick={close}>✕</button>
          </div>
        </div>

        {/* The centre disc is a BUTTON on the web and a plain badge on the TV. It has to stop
            being focusable there: it is a second, ambiguous play control sitting in the middle of
            the screen, and TvSpatialNav would offer it as a target above the bar's own ▶. OK
            already toggles playback from anywhere in transport mode, so on a TV this is only ever
            the "this is paused" sign it looks like. */}
        {IS_TV ? (
          <div className={`vp-center${playing ? ' hidden' : ''}`} aria-hidden="true">
            <span className="ic">{playing ? IcPause : IcPlay}</span>
          </div>
        ) : (
          <button className={`vp-center${playing ? ' hidden' : ''}`} aria-label="Play / Pause" onClick={togglePlay}>
            <span className="ic">{playing ? IcPause : IcPlay}</span>
          </button>
        )}

        <div className="vp-bottom">
          <div
            className={`vp-progress${seekPreview != null ? ' seeking' : ''}`}
            id="vpProgress"
            ref={barRef}
            onPointerDown={onBarPointerDown}
            /* On the TV the bar is a control in its own right — the remote lands on it and
               Left/Right move the preview, which is exactly a slider. On the web it stays a
               click target and nothing about it changes. */
            tabIndex={IS_TV ? 0 : undefined}
            role={IS_TV ? 'slider' : undefined}
            aria-label={IS_TV ? t('player.seek') : undefined}
            aria-valuemin={IS_TV ? 0 : undefined}
            aria-valuemax={IS_TV ? Math.round(dur) : undefined}
            aria-valuenow={IS_TV ? Math.round(shownTime) : undefined}
            aria-valuetext={IS_TV ? fmt(shownTime) : undefined}
          >
            <div className="vp-bar">
              <div className="vp-buffered" id="vpBuffered" style={{ width: `${bufPct}%` }} />
              <div className="vp-played" id="vpPlayed" style={{ width: `${pct}%` }} />
              <div className="vp-thumb" id="vpThumb" style={{ left: `${pct}%` }} />
            </div>
          </div>
          <div className="vp-controls">
            <button className="vp-icon" id="vpPlay" aria-label={t('ctl.play_a')} onClick={togglePlay}>{playing ? IcPause : IcPlay}</button>
            <button className="vp-icon" id="vpBack" aria-label={t('ctl.back_a')} onClick={() => nudge(-10)}>{IcBack}</button>
            <button className="vp-icon" id="vpFwd" aria-label={t('ctl.fwd_a')} onClick={() => nudge(10)}>{IcFwd}</button>
            {/* VOLUME IS THE TELEVISION'S, NOT OURS. The set has its own volume on the same
                remote, and on all three TV platforms it is handled below the browser — see the
                note in lib/tvKeys.ts. A second, app-local volume that the remote's volume keys
                do not drive is a control that looks broken; mute stays, since that IS ours. */}
            {IS_TV ? (
              <button className="vp-icon" id="vpMute" aria-label={t('ctl.mute_a')} aria-pressed={muted} onClick={toggleMute}>{IcMute}</button>
            ) : (
              <div className="vp-vol">
                <button className="vp-icon" id="vpMute" aria-label={t('ctl.mute_a')} aria-pressed={muted} onClick={toggleMute}>{IcMute}</button>
                <input type="range" className="vp-vol-slider" id="vpVol" min={0} max={1} step={0.02} value={muted ? 0 : vol} aria-label={t('ctl.vol_a')}
                  onChange={(e) => { const v = videoRef.current; if (v) { v.volume = +e.target.value; v.muted = +e.target.value === 0; } }} />
              </div>
            )}
            <div className="vp-time">
              <span id="vpCur">{fmt(shownTime)}</span> / <span id="vpDur">{fmt(dur)}</span>
              {/* How far the pending scrub has travelled. The absolute time above answers "where
                  will I land"; this answers "how far did I just skip", which is what a viewer
                  holding the button down is actually counting. */}
              {seekDelta !== 0 && <span className="vp-seekdelta">{seekDelta > 0 ? '+' : '−'}{fmt(Math.abs(seekDelta))}</span>}
            </div>
            <div className="vp-spacer" />
            {source.series && (
              <button className={`vp-icon${epPanelOpen ? ' on' : ''}`} id="vpEpisodes" aria-label={t('ctl.episodes_a')} aria-pressed={epPanelOpen} onClick={() => setEpPanelOpen((o) => !o)}>{IcEpisodes}</button>
            )}
            {hasSubs && (
              <button className={`vp-icon cc${ccOn ? ' on' : ''}`} id="vpCC" aria-label={t('ctl.subs_a')} aria-pressed={ccOn} onClick={toggleCC}>CC</button>
            )}
            <div className="vp-menu-wrap">
              <button className="vp-icon" id="vpGear" aria-label={t('ctl.settings_a')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>{IcGear}</button>
              {/* A CLOSED DROPDOWN IS STILL IN THE DOM, AND THAT IS A BUG FOR A REMOTE. `.vp-menu`
                  hides itself with opacity + pointer-events, which a pointer respects and
                  geometry does not: every row inside it keeps a real bounding box floating above
                  the gear button, so TvSpatialNav offered "Subtitles / Off / English…" as targets
                  while the menu was shut. Not rendering it is the fix — and it also spares the TV
                  the cost of a menu nobody opened. The web keeps the node so it can animate. */}
              {(!IS_TV || menuOpen) && (
              <div className={`vp-menu${menuOpen ? ' open' : ''}`} id="vpMenu" role="menu">
                {/* Subtitles */}
                <div className={`vp-acc${acc.subs ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.subs} onClick={() => toggleAcc('subs')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.subtitles')}</span>
                    <span className="vp-acc-val">{currentSub < 0 ? t('menu.off') : (vtt[currentSub]?.label || vtt[currentSub]?.lang || '')}</span>
                  </button>
                  <div className="vp-acc-body">
                    <OptRow on={currentSub < 0} label={t('menu.off')} onClick={() => selectSub(-1)} />
                    {vtt.length === 0 && <div className="vp-opt" style={{ opacity: 0.5 }}>{t('menu.no_subs_found')}</div>}
                    {vtt.map((s, i) => <OptRow key={i} on={i === currentSub} label={s.label || s.lang || `${t('menu.track')}${i + 1}`} onClick={() => selectSub(i)} />)}
                  </div>
                </div>
                {/* Audio language (HLS renditions) */}
                {audioTracks.length > 1 && (
                  <div className={`vp-acc${acc.audio ? ' open' : ''}`}>
                    <button className="vp-acc-head" aria-expanded={acc.audio} onClick={() => toggleAcc('audio')}>
                      {AccIc}<span className="vp-acc-label">{t('menu.audio_lang')}</span>
                      <span className="vp-acc-val">{audioTracks.find((a) => a.i === curAudio)?.name || ''}</span>
                    </button>
                    <div className="vp-acc-body">
                      {audioTracks.map((a) => <OptRow key={a.i} on={a.i === curAudio} label={a.name} onClick={() => selectAudio(a.i)} />)}
                    </div>
                  </div>
                )}
                {/* Playback speed */}
                <div className={`vp-acc${acc.speed ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.speed} onClick={() => toggleAcc('speed')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.speed')}</span><span className="vp-acc-val">{rate}×</span>
                  </button>
                  <div className="vp-acc-body">
                    <div className="vp-speeds">
                      {SPEEDS.map((r) => <button key={r} type="button" className={`vp-speed${r === rate ? ' on' : ''}`} onClick={() => setSpeed(r)}>{r}×</button>)}
                    </div>
                  </div>
                </div>
                {/* Quality (HLS levels) */}
                {levels.length > 1 && (
                  <div className={`vp-acc${acc.quality ? ' open' : ''}`}>
                    <button className="vp-acc-head" aria-expanded={acc.quality} onClick={() => toggleAcc('quality')}>
                      {AccIc}<span className="vp-acc-label">{t('menu.quality')}</span>
                      <span className="vp-acc-val">{curLevel < 0 ? t('menu.auto') : levelLabel(levels.find((l) => l.i === curLevel) || {})}</span>
                    </button>
                    <div className="vp-acc-body">
                      <OptRow on={curLevel < 0} label={t('menu.auto')} onClick={() => setLevel(-1)} />
                      {[...levels].sort((a, b) => (b.height || 0) - (a.height || 0)).map((l) => <OptRow key={l.i} on={l.i === curLevel} label={levelLabel(l)} onClick={() => setLevel(l.i)} />)}
                    </div>
                  </div>
                )}
                {/* Picture enhance */}
                <div className={`vp-acc${acc.enhance ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.enhance} onClick={() => toggleAcc('enhance')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.enhance')}</span>
                    <span className="vp-acc-val">{settings.enhance ? `${Math.round(settings.grain * 100)}%` : t('menu.off')}</span>
                  </button>
                  <div className="vp-acc-body">
                    <OptRow on={settings.enhance} label={t('menu.enhance_on')} onClick={() => updateSettings({ enhance: !settings.enhance })} />
                    {/* PRESETS ON THE TV, SLIDERS ON THE WEB — see TV_GRAIN above. A range input
                        is the one control a D-pad cannot get back out of: arrows move the value,
                        so nothing is left to move focus, and the remote is trapped on it. */}
                    {IS_TV ? (
                      <>
                        {TV_GRAIN.map((g, i) => (
                          <OptRow key={g} on={settings.enhance && settings.grain === g} label={`${t('ctl.grain')} · ${t(TV_LEVEL_KEYS[i])}`}
                            onClick={() => updateSettings({ enhance: g > 0, grain: g })} />
                        ))}
                      </>
                    ) : (
                      <div className={`vp-enh-slider${settings.enhance ? '' : ' off'}`}>
                        <input type="range" min={0} max={0.35} step={0.01} value={settings.grain} disabled={!settings.enhance} onChange={(e) => updateSettings({ grain: +e.target.value })} aria-label={t('ctl.grain')} />
                        <span className="vp-enh-val">{Math.round(settings.grain * 100)}%</span>
                      </div>
                    )}
                    {IS_TV ? (
                      <>
                        {TV_CLARITY.map((c, i) => (
                          <OptRow key={c} on={settings.clarity === c} label={`${t('menu.clarity')} · ${t(TV_LEVEL_KEYS[i])}`}
                            onClick={() => updateSettings({ clarity: c })} />
                        ))}
                      </>
                    ) : (
                      <>
                        <OptRow on={settings.clarity > 0} label={t('menu.clarity')} onClick={() => updateSettings({ clarity: settings.clarity > 0 ? 0 : 0.5 })} />
                        <div className={`vp-enh-slider${settings.clarity > 0 ? '' : ' off'}`}>
                          <input type="range" min={0} max={1} step={0.05} value={settings.clarity} disabled={settings.clarity <= 0} onChange={(e) => updateSettings({ clarity: +e.target.value })} aria-label={t('ctl.clarity')} />
                          <span className="vp-enh-val">{Math.round(settings.clarity * 100)}%</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
              )}
            </div>
            {/* NEITHER OF THESE MEANS ANYTHING ON A TELEVISION. The app is already the whole
                screen, so fullscreen has nothing to toggle, and picture-in-picture has no second
                window to go to. Left in, they are two dead stops the D-pad has to walk past to
                reach the gear — which on a remote is a real cost, unlike an unused button on a
                web page. */}
            {!IS_TV && (document.pictureInPictureEnabled || webkitPip) && (
              <button className="vp-icon" id="vpPip" aria-label={t('ctl.pip_a')} onClick={togglePip}>{IcPip}</button>
            )}
            {!IS_TV && <button className="vp-icon" id="vpFs" aria-label={t('ctl.fs_a')} aria-pressed={fs} onClick={toggleFs}>{IcFs}</button>}
          </div>
        </div>
      </div>

      {/* Contextual skip button — "Skip Intro" in the intro window, "Next Episode" in
          the credits tail (series only) */}
      {source.series && (
        <button
          className={`vp-skip${skipMode ? ' show' : ''}`}
          id="vpSkip"
          type="button"
          onClick={() => {
            if (skipMode === 'next') source.next?.();
            else if (skipMode === 'intro') { const v = videoRef.current; if (v) v.currentTime = Math.min((v.duration || 0) - 1, Math.max(v.currentTime, skipTo)); }
            bump();
          }}
        >
          {skipMode === 'next' ? `${t('player.next_episode')} ›` : skipMode === 'intro' ? t('player.skip_intro') : ''}
        </button>
      )}

      {/* In-player episodes panel (series). Mounted only when open on the TV, for the same reason
          the gear menu is: parked at translateX(100%) it is off-screen but still has real
          geometry, so every episode row was a live D-pad target while the panel was shut. It also
          saves the season fetch the panel fires on mount. */}
      {source.series && (!IS_TV || epPanelOpen) && <EpisodePanel open={epPanelOpen} series={source.series} onClose={() => setEpPanelOpen(false)} />}
    </div>
  );
}
