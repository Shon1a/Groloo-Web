import type { ElementType } from 'react';

/* The title screen's chunk, loaded once and REMEMBERED once it has evaluated — see the note in
 * DetailModalGate on why a first open that finds it here renders it directly instead of suspending.
 * Its own module so the gate stays a components-only file, and so lib/bootGate.ts can preload it
 * during the television's splash without importing the gate. */
let loaded: ElementType | null = null;

export function loadDetailModal() {
  return import('./DetailModal').then((m) => { loaded = m.default; return m; });
}

/** The modal component if its chunk has already been evaluated, else null. */
export function loadedDetailModal(): ElementType | null { return loaded; }
