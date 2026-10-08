import { create } from 'zustand';
import { api, ApiError, getToken, setSessionToken } from '../lib/api';

/* Auth — port of the vanilla auth flow (assets/js/app.js + server/auth.js). Talks
 * to /api/auth/*; the session token is mirrored to localStorage via the api client
 * (setSessionToken) so it survives browser restarts across the split deploy. Also
 * holds the auth-modal open state + the gated-route "intent" to resume after login. */

export interface User {
  id: string;
  email: string;
  name?: string;
  surname?: string;
  isAdmin?: boolean;
}

/* Everything but the credentials is optional, and the age gate can be satisfied EITHER
 * way — mirroring createUser/validateAge in Groloo-server/server/auth.js. The web form
 * sends a `dob`; the TV form sends `over18: true`, because typing an exact date on a
 * D-pad on-screen keyboard is a miserable job and the affirmation is the only fact the
 * gate actually needs. Sending neither is a rejection server-side, not a pass. */
export interface SignupData {
  email: string; password: string;
  name?: string; surname?: string; dob?: string; over18?: boolean;
}

interface AuthConfig { google: boolean; googleClientId?: string }

interface AuthState {
  user: User | null;
  ready: boolean;
  config: AuthConfig | null;
  authOpen: boolean;
  intent: string | null;
  /* The web account popup that claims a code shown on a TV (LinkTvModal). Its own flag
   * rather than a mode of `authOpen`, because the two can be open AT ONCE and stacked:
   * a signed-out user who opens it is shown sign-in over the top and comes back to the
   * code they already typed. Sharing one flag would close the popup to show the form. */
  linkOpen: boolean;
  /* A code the popup should start with — set when arriving from the #/link deep link so
   * the ?code= prefill survives the hand-off. Never auto-claimed; see LinkTvModal. */
  linkCode: string;
  refresh: () => Promise<void>;
  loadConfig: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (d: SignupData) => Promise<void>;
  googleLogin: (credential: string) => Promise<void>;
  /* Adopt a session minted somewhere other than a form on this device — today that is
   * exclusively the device-link poll, where the token is handed to the holder of the
   * pairing secret rather than to a password. Deliberately NOT called `linkLogin`: what
   * it does is install a session the caller has already been given, and every future
   * out-of-band sign-in (a native shell resuming a token, say) wants the same three
   * lines rather than its own copy of them. */
  adoptSession: (token: string, user: User) => void;
  logout: () => Promise<void>;
  openAuth: (intent?: string) => void;
  closeAuth: () => void;
  openLink: (code?: string) => void;
  closeLink: () => void;
}

const jsonPost = (path: string, body: unknown) =>
  api<{ user: User; token: string }>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* refresh() asks again this long after a /me that said nothing about the session. */
const REFRESH_RETRY_MS = 30_000;
let refreshRetry = 0;

/* The last account the server confirmed for the stored token. While /me cannot answer — the
 * API down, or up without its database — the app carries on as this account instead of as a
 * guest: every synced store keys its local data by the signed-in email, so a "guest" stretch
 * would file the progress watched meanwhile under 'guest', where it never reaches the account.
 * Kept beside the token and dropped with it; a real answer from /me always overrides it. */
const USER_KEY = 'groloo_user';
function rememberUser(u: User | null) {
  try { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); } catch { /* private mode */ }
}
function rememberedUser(): User | null {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null') as User | null;
    return u && typeof u.id === 'string' && typeof u.email === 'string' ? u : null;
  } catch { return null; }
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  config: null,
  authOpen: false,
  intent: null,
  linkOpen: false,
  linkCode: '',

  refresh: async () => {
    window.clearTimeout(refreshRetry);
    try {
      const { user } = await api<{ user: User | null }>('/api/auth/me');
      set({ user: user || null });
      rememberUser(user || null);
    } catch (e) {
      /* No answer about the session: the API was unreachable, or it answered 503 because it
       * could not read accounts (ACCOUNTS_UNAVAILABLE). Neither says the token is bad, so
       * keep it, carry on as the account last confirmed for it, and ask again — a device
       * left on, like the TV, then never drops to guest at all. A 4xx is a real answer and
       * still means signed out. */
      const noAnswer = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      if (!noAnswer) { set({ user: null }); rememberUser(null); }
      else if (getToken()) {
        if (!get().user) { const held = rememberedUser(); if (held) set({ user: held }); }
        refreshRetry = window.setTimeout(() => { void useAuth.getState().refresh(); }, REFRESH_RETRY_MS);
      }
    } finally {
      set({ ready: true });
    }
  },
  loadConfig: async () => {
    try { set({ config: await api<AuthConfig>('/api/auth/config') }); } catch { /* dormant */ }
  },
  login: async (email, password) => {
    const { user, token } = await jsonPost('/api/auth/login', { email, password });
    setSessionToken(token); rememberUser(user); set({ user, authOpen: false });
  },
  signup: async (d) => {
    const { user, token } = await jsonPost('/api/auth/signup', d);
    setSessionToken(token); rememberUser(user); set({ user, authOpen: false });
  },
  googleLogin: async (credential) => {
    const { user, token } = await jsonPost('/api/auth/google', { credential });
    setSessionToken(token); rememberUser(user); set({ user, authOpen: false });
  },
  adoptSession: (token, user) => {
    setSessionToken(token); rememberUser(user); set({ user, authOpen: false });
  },
  logout: async () => {
    window.clearTimeout(refreshRetry);
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setSessionToken(null); rememberUser(null); set({ user: null });
  },
  openAuth: (intent) => set({ authOpen: true, intent: intent ?? null }),
  closeAuth: () => set({ authOpen: false, intent: null }),
  /* The code is kept when `code` is omitted rather than cleared, so reopening the popup
   * after a sign-in detour still has what the user typed. closeLink is what forgets it —
   * a pairing code is short-lived and there is no reason for one to outlive its popup. */
  openLink: (code) => set(code === undefined ? { linkOpen: true } : { linkOpen: true, linkCode: code }),
  closeLink: () => set({ linkOpen: false, linkCode: '' }),
}));
