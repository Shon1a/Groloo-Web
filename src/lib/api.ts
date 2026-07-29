/* ------------------------------------------------------------------ *
 *  API client — the typed React port of the fetch monkey-patch that
 *  lived in index.html (see the vanilla app's inline "Backend wiring").
 *
 *  Split deployment: the frontend is hosted on Vercel, the Express API
 *  on a DIFFERENT origin (Render). So every /api/* call must:
 *    1. target the backend origin explicitly (API_BASE),
 *    2. send the cross-site auth cookie (credentials: 'include'),
 *    3. replay the persisted session token as `Authorization: Bearer …`
 *       (cross-site cookies are purged on browser close; the mirrored
 *       token in localStorage survives restarts — auth.js accepts either).
 *
 *  On localhost the base stays empty so calls remain same-origin.
 *  Override via <meta name="api-base" content="…"> or VITE_API_BASE.
 * ------------------------------------------------------------------ */

const TOKEN_KEY = 'groloo_session';

function resolveApiBase(): string {
  // build-time override wins (Vite env), then a runtime <meta>, then host heuristic
  const envBase = (import.meta.env as Record<string, string | undefined>).VITE_API_BASE;
  if (envBase) return envBase.replace(/\/$/, '');
  const meta = document.querySelector<HTMLMetaElement>('meta[name="api-base"]');
  if (meta && meta.content.trim()) return meta.content.trim().replace(/\/$/, '');
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return isLocal ? '' : 'https://groloo-server.onrender.com';
}

export const API_BASE = resolveApiBase();

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

/** Mirror of the vanilla `window.setSessionToken` — persists the token across restarts. */
export function setSessionToken(token: string | null | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode / quota — non-fatal */ }
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `API ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Low-level fetch with the GROLOO contract applied. `path` is a /api/… path. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const tok = getToken();
  if (tok && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${tok}`);
  const url = path.startsWith('/api/') ? API_BASE + path : path;
  return fetch(url, {
    ...init,
    headers,
    // browsers only attach the cross-site auth cookie when asked to
    credentials: init.credentials ?? 'include',
  });
}

/** JSON helper — the workhorse used by query hooks. Throws ApiError on non-2xx. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** POST a JSON body and read JSON back — every mutating call needs the same three
 *  lines, and forgetting the Content-Type is silent: express.json() ignores the body
 *  and the route sees `{}`, which reads as a validation bug rather than a client one. */
export function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/* Every /api error answers with { error: "<human>", code: "<MACHINE_CODE>" }. Branch on
 * `code`, never on `error`: the human half is translated and reworded freely, so any UI
 * that matches on it breaks the moment someone improves the copy. */
export interface ApiErrorBody { error?: string; code?: string }

const errBody = (err: unknown): ApiErrorBody =>
  (err instanceof ApiError && err.body && typeof err.body === 'object' ? err.body as ApiErrorBody : {});

/** Machine code off a thrown error, or '' when the failure carried none — a dropped
 *  connection, or an HTML error page served by a proxy that never reached Express. */
export function errorCode(err: unknown): string {
  const c = errBody(err).code;
  return typeof c === 'string' ? c : '';
}

/** The server's own human message, or '' — callers supply a translated fallback, since
 *  these come back in English regardless of the UI language. */
export function errorMessage(err: unknown): string {
  const m = errBody(err).error;
  return typeof m === 'string' ? m : '';
}
