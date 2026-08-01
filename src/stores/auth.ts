import { create } from 'zustand';
import { api, setSessionToken } from '../lib/api';

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

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,
  config: null,
  authOpen: false,
  intent: null,
  linkOpen: false,
  linkCode: '',

  refresh: async () => {
    try {
      const { user } = await api<{ user: User | null }>('/api/auth/me');
      set({ user: user || null });
    } catch {
      set({ user: null });
    } finally {
      set({ ready: true });
    }
  },
  loadConfig: async () => {
    try { set({ config: await api<AuthConfig>('/api/auth/config') }); } catch { /* dormant */ }
  },
  login: async (email, password) => {
    const { user, token } = await jsonPost('/api/auth/login', { email, password });
    setSessionToken(token); set({ user, authOpen: false });
  },
  signup: async (d) => {
    const { user, token } = await jsonPost('/api/auth/signup', d);
    setSessionToken(token); set({ user, authOpen: false });
  },
  googleLogin: async (credential) => {
    const { user, token } = await jsonPost('/api/auth/google', { credential });
    setSessionToken(token); set({ user, authOpen: false });
  },
  adoptSession: (token, user) => {
    setSessionToken(token); set({ user, authOpen: false });
  },
  logout: async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setSessionToken(null); set({ user: null });
  },
  openAuth: (intent) => set({ authOpen: true, intent: intent ?? null }),
  closeAuth: () => set({ authOpen: false, intent: null }),
  /* The code is kept when `code` is omitted rather than cleared, so reopening the popup
   * after a sign-in detour still has what the user typed. closeLink is what forgets it —
   * a pairing code is short-lived and there is no reason for one to outlive its popup. */
  openLink: (code) => set(code === undefined ? { linkOpen: true } : { linkOpen: true, linkCode: code }),
  closeLink: () => set({ linkOpen: false, linkCode: '' }),
}));
