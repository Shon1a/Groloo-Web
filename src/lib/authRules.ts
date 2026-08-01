/* ------------------------------------------------------------------ *
 *  Client-side credential rules, shared by AuthModal (web) and TvAuthModal (TV).
 *
 *  The SERVER is the authority — validateEmail / validatePassword / validateAge in
 *  Groloo-server/server/auth.js — and everything here is a courtesy that saves a round
 *  trip. The only hard requirement is that these are never LOOSER than the server's: a
 *  stricter client can be surprised by nothing, while a looser one promises the user
 *  something the API will refuse.
 *
 *  They live in one file because two forms now enforce them, and two copies of a
 *  validation rule is one copy too many — the older one always drifts.
 * ------------------------------------------------------------------ */

export const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const passOk = (p: string) => p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);

/* 18, not 13. The Terms have always said 18+, and declaring a 13+ audience drags an app
 * whose add-on installer accepts arbitrary URLs into Play's Families policy. */
export const MIN_AGE = 18;

export const ageOk = (dob: string) => {
  if (!dob) return false;
  const d = new Date(dob);
  const age = (Date.now() - d.getTime()) / (365.25 * 864e5);
  return age >= MIN_AGE;
};

/* Latest birth date that still clears the gate. Fed to the date input's `max` so the
 * native picker refuses under-age dates outright — being stopped at entry beats a
 * rejection afterwards. */
export const maxDob = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MIN_AGE);
  return d.toISOString().slice(0, 10);
};
