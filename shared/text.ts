/**
 * Small text helpers shared by the server and the browser. No imports — the browser loads this.
 */

/**
 * `plural(1, "task")` → "1 task", `plural(0, "task")` → "0 tasks".
 *
 * The `${n} thing${n === 1 ? "" : "s"}` shape appears about a dozen times in this repo, and the one
 * place it was NOT written is the one that shipped "1 letters were not delivered" for an afternoon
 * (shared/notifications.ts). New code uses this; the existing sites are left alone rather than
 * swept up in an unrelated change.
 *
 * English only, which is all the UI is. An irregular plural takes the second argument:
 * `plural(2, "entry", "entries")`.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
