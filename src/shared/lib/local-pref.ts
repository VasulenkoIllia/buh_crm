/**
 * **A preference of the screen, remembered in this browser.** How many client rows somebody reads,
 * whether their sidebar is folded: properties of the screen a person is looking at, not of their
 * account, so `localStorage` rather than the server.
 *
 * A private window or blocked site data makes `localStorage` throw, on reading as well as on
 * writing, and that must never take a screen down with it: a read then answers `null` and a write
 * is simply lost, which is what "the choice just will not stick" should mean. It was written out by
 * hand at each call site until the sidebar made it the second copy (audit, 2026-09-29).
 */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a private window or blocked site data: the choice just will not stick
  }
}
