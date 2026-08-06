/**
 * When two meetings collide — the one rule both sides count overlap by.
 *
 * A meeting occupies the **half-open** interval `[start, start + duration)`. That single choice is
 * what makes back-to-back scheduling work: 10:00–11:00 and 11:00–12:00 do NOT collide, because the
 * first has already ended at the instant the second begins. Closed intervals would flag every
 * consecutive pair in a normal day, and a warning that fires constantly is a warning nobody reads.
 *
 * Zod-free on purpose, like `dates.ts`: the meeting form warns about a clash as you type, and
 * importing a value out of a schema module pulls the whole zod runtime into the browser bundle
 * (measured: +433 kB).
 */

/** Anything with a start instant and a length — a stored meeting or a half-filled form. */
export interface TimeSpan {
  startAt: string | Date;
  durationMinutes: number;
}

const startMs = (s: TimeSpan): number =>
  (s.startAt instanceof Date ? s.startAt : new Date(s.startAt)).getTime();

/** Exclusive end: the first instant the slot is free again. */
export const spanEndMs = (s: TimeSpan): number => startMs(s) + s.durationMinutes * 60_000;

/**
 * Do these two spans share any instant? Half-open on both sides, so touching is not overlapping.
 *
 * A span of no length overlaps nothing, stated explicitly rather than left to the inequality —
 * which would have said "no" at the boundary and "yes" one minute in. The schema forbids a
 * non-positive duration, but the meeting form holds one every time the field is cleared, and the
 * live warning must stay quiet until there is an actual meeting to clash with.
 */
export function spansOverlap(a: TimeSpan, b: TimeSpan): boolean {
  if (a.durationMinutes <= 0 || b.durationMinutes <= 0) return false;
  return startMs(a) < spanEndMs(b) && startMs(b) < spanEndMs(a);
}

/** The spans in `others` that collide with `span`, in the order given. */
export function overlapping<T extends TimeSpan>(span: TimeSpan, others: T[]): T[] {
  return others.filter((o) => spansOverlap(span, o));
}
