import { create } from 'zustand';

/* Playback / interface settings, persisted to localStorage (groloo.settings.v1),
 * mirroring the vanilla SETTINGS object. A focused subset is wired now; the full
 * control set (external player, popup-ring, etc.) can extend this store. */

const KEY = 'groloo.settings.v1';

export interface Settings {
  // interface
  blurUnwatched: boolean;
  /* TV build only: play a muted trailer on the row billboard once the remote rests on a title.
   * A setting rather than a fixed behaviour because it is the one feature here whose cost lands
   * squarely on the weakest hardware the app runs on — an autoplaying embed is the heaviest thing
   * on the screen, and how well a given set copes is not something the app can measure. On by
   * default (the shelf preview is the expected behaviour on a TV); off is one switch away for a
   * set where browsing starts to feel sticky. Ignored entirely by the web build. */
  tvRowTrailers: boolean;
  // auto-play
  autoplayNext: boolean;
  nextPopup: number;          // seconds the next-video popup stays up
  // subtitles
  subLang: 'off' | 'en' | 'ka' | 'ru';
  subSize: number;            // % of base subtitle size
  subColor: string;
  subBg: string;
  subOutline: string;
  subOutlineW: number;
  // playback preferences
  autoQuality: 'best' | '4k' | '1080';
  audioLang: 'en' | 'original';
  // advanced
  externalPlayer: 'disabled' | 'vlc' | 'infuse' | 'outplayer' | 'nplayer';
  // picture-enhance (player)
  enhance: boolean;
  grain: number;              // 0–0.35 grain overlay opacity
  clarity: number;            // 0–1 unsharp-mask strength
}

const DEFAULTS: Settings = {
  blurUnwatched: false,
  tvRowTrailers: true,
  autoplayNext: true,
  nextPopup: 15,
  subLang: 'off',
  subSize: 100,
  subColor: '#ffffff',
  subBg: 'rgba(0,0,0,.6)',
  subOutline: '#000000',
  subOutlineW: 2,
  autoQuality: 'best',
  audioLang: 'en',
  externalPlayer: 'disabled',
  /* PICTURE ENHANCE IS OFF UNTIL ASKED FOR. It is a look, not a correction — grain and a sharpen
   * pass are things a viewer opts into, and a player that ships with them on is deciding how
   * somebody else's film should look.
   *
   * THE TWO LEVELS BELOW ARE THE "LOW" PRESETS, EXACTLY. They must stay equal to TV_GRAIN[1] and
   * TV_CLARITY[1] in VideoPlayer, and that is a real constraint rather than a tidy coincidence:
   * the TV menu offers four fixed levels and ticks the row whose value MATCHES, so a default that
   * merely sits near one ticks nothing at all. They were 0.10 and 0.40, which are between presets
   * — so on a television, switching the enhancement on used to light up "Film grain & color
   * boost" above four grain rows and four clarity rows with no mark against any of them, and the
   * header read 10%. Now turning it on lands on Low · Low, which is both the gentlest setting and
   * a visible one.
   *
   * The web keeps sliders and does not care where the value sits, so it simply starts gentler. */
  enhance: false,
  grain: 0.08,
  clarity: 0.25,
};

function load(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota */ }
}

interface SettingsState {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: load(),
  update: (patch) => { const next = { ...get().settings, ...patch }; save(next); set({ settings: next }); },
}));
