/* ------------------------------------------------------------------ *
 *  The pairing-code alphabet, shared by every screen that shows or accepts one.
 *
 *  Mirrors LINK_ALPHABET in Groloo-server/server/auth.js — 25 symbols with 0 O 1 I L
 *  (classic ambiguity) and B G S U Z Q (B/8, G/6, S/5, U/V, Z/2, Q/O across a living
 *  room) removed. The server remains the authority and re-normalizes everything it is
 *  sent; this exists so the field, the TV's display and the deep link all agree about
 *  what a code looks like instead of each carrying their own copy of the rule.
 * ------------------------------------------------------------------ */

export const LINK_ALPHABET = '23456789ACDEFHJKMNPRTVWXY';
export const LINK_CODE_LEN = 8;
const NOT_ALPHABET = new RegExp(`[^${LINK_ALPHABET}]`, 'g');

/* Uppercase, drop everything outside the alphabet, cap at 8. Dropping rather than
 * folding is deliberate and matches the server: a typed `O` could have been meant as
 * `0` or `Q`, neither of which is in the alphabet, so guessing would turn a wrong code
 * into a *different* wrong code — the short result and an honest "check the characters"
 * beats a confident lookup of something the user never saw. */
export const normalizeLinkCode = (raw: string) =>
  raw.toUpperCase().replace(NOT_ALPHABET, '').slice(0, LINK_CODE_LEN);

/* Rendered as XXXX-XXXX to match the TV, which shows the hyphen. Presentation only — the
 * hyphen is stripped straight back out on the next keystroke. */
export const formatLinkCode = (code: string) =>
  (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
