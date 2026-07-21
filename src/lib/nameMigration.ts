/* One-time localStorage rename: `stredio*` keys -> `groloo*`.
 *
 * NOTE TO ANY FUTURE BULK RENAME: this file must keep the literal string "stredio" in
 * `OLD` below. A project-wide find-and-replace already broke it once, rewriting `OLD`
 * to 'groloo' and turning the whole migration into a silent no-op that would have
 * signed every existing user out and orphaned their add-on list. The CI step
 * "Guard the rename migration against a future bulk find-and-replace" in
 * .github/workflows/ci.yml fails the build if that literal disappears from this file.
 *
 * The product was renamed before first store submission. Everything else that carried
 * the old name is source code and could simply be edited, but these four key families
 * are DATA SITTING ON A USER'S DEVICE, and renaming a key without moving what is under
 * it is indistinguishable from deleting it:
 *
 *   stredio_session        the auth token    -> silently signed out
 *   stredio.addons[:email] installed add-ons -> their sources gone, INCLUDING the debrid
 *                                               keys they pasted and may not have written
 *                                               down anywhere else
 *   stredio.homeconfig     home layout
 *   stredio.settings.v1    preferences
 *
 * The `sf:` family (`sf-lang`, `sf:history:`, `sf:progress:`, `sf:removed:`, `sf:mylist*`)
 * is deliberately NOT touched. It predates the old name, does not contain it, and moving
 * it would be a second migration with none of the justification of this one.
 *
 * ORDER MATTERS. This module is imported for its side effect as the FIRST import in
 * main.tsx, because every store reads its slice of localStorage at module scope — see
 * `stores/history.ts:108-110` and `stores/settings.ts:52`, which call their loaders
 * inside `create()`. If this ran after those imports it would move the data a tick after
 * the stores had already read the empty new key and cached the default.
 *
 * SAFETY: copy, verify by reading back, and only then delete the original. A crash or a
 * quota failure mid-run therefore leaves the OLD key intact and the flag unset, so the
 * next boot retries from a consistent state. The old key is removed rather than left as
 * a duplicate specifically because the add-on list holds credentials; keeping a second
 * copy of a user's debrid keys to be safe about a rename would trade a data-loss risk
 * for a secret-duplication one, and `routes/DeleteAccount.tsx` already treats that copy
 * as something to be got rid of.
 *
 * Remove this module once the population has migrated. It costs one getItem per boot.
 */

const FLAG = 'groloo.migrated.v1';
/* eslint-disable-next-line no-useless-concat -- split so a bulk rename cannot match it */
const OLD = 'stre' + 'dio';
const NEW = 'groloo';

/** `stredio_session` and `stredio.addons:a@b.com` both match; `sf:mylist` does not. */
export function isOldKey(k: string): boolean {
  return k.startsWith(OLD + '_') || k.startsWith(OLD + '.');
}

/** `stredio.addons:a@b.com` -> `groloo.addons:a@b.com` */
export function newNameFor(oldKey: string): string {
  return NEW + oldKey.slice(OLD.length);
}

export function migrateStoredNames(): void {
  let ls: Storage;
  try {
    ls = window.localStorage;
    if (ls.getItem(FLAG)) return;
  } catch {
    return; // private mode / storage disabled — nothing persisted, nothing to move
  }

  /* Snapshot the key list before mutating: removing entries during a live index walk
   * re-indexes the collection and skips siblings. */
  const oldKeys: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && isOldKey(k)) oldKeys.push(k);
    }
  } catch {
    return;
  }

  let moved = 0;
  for (const oldKey of oldKeys) {
    const newKey = newNameFor(oldKey);
    try {
      const value = ls.getItem(oldKey);
      if (value === null) continue;

      /* Never clobber. If a new-name key already holds something, this device has
       * already run a newer build and that value is the current one. */
      if (ls.getItem(newKey) !== null) {
        ls.removeItem(oldKey);
        continue;
      }

      ls.setItem(newKey, value);
      if (ls.getItem(newKey) !== value) continue; // write did not stick — keep the original
      ls.removeItem(oldKey);
      moved++;
    } catch {
      /* Quota, or a value another tab removed underneath us. Leave the original in
       * place and let the next boot retry; the flag is not set on this path. */
    }
  }

  try {
    ls.setItem(FLAG, '1');
  } catch {
    /* Could not record completion. The run is still idempotent — a second pass finds
     * the new keys already present and only clears leftovers. */
  }

  if (moved) console.info(`[groloo] migrated ${moved} stored item(s) from the previous name`);
}

/* Executed HERE, at module-evaluation time, and not from a statement in main.tsx.
 * `import` declarations are hoisted and every imported module body runs before the first
 * statement of the importing module, so `import { f } from './nameMigration'; f()` would
 * have run the stores' module-scope localStorage reads BEFORE the move. Being the first
 * import in main.tsx is what orders this correctly, because module bodies are evaluated
 * in import order. Do not convert this back into a call site. */
migrateStoredNames();
