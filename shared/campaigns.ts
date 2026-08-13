/**
 * When a campaign fires next.
 *
 * Its own zero-dependency module, next to `shared/dates.ts` and for the same reason: the browser
 * must be able to say "next run: 1 Oct" without importing the zod runtime, and the server must
 * compute the identical answer. One function, one rule, both sides.
 *
 * Everything here works in **business dates** — the UTC-midnight instant of a calendar day, the
 * scale the rest of the app compares days on. A campaign fires on a DAY, not at an instant; the
 * time of day only decides which side of the daily sweep it lands on.
 */

export type CampaignRhythm = "once" | "monthly" | "quarterly" | "yearly";

/** `YYYY-MM-DD` of a business date — the key that says which occurrence a run was for. */
export function periodKeyOf(dateMs: number): string {
  return new Date(dateMs).toISOString().slice(0, 10);
}

const MONTHS: Record<Exclude<CampaignRhythm, "once">, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * The occurrence after `fromMs`, counted from the campaign's anchor.
 *
 * **Counted from the anchor, never from the last run** — that is the whole point of taking
 * `anchorMs`. Adding a month to each result in turn walks the date backwards forever: the 31st
 * becomes the 28th in February, and every month after that is the 28th. Anchoring means a
 * campaign set for the 31st fires on the 28th of February and on the 31st of March, which is what
 * "monthly on the 31st" means to the person who typed it.
 *
 * Returns null when the rhythm has run out — `once` always has, and a rhythm past `endsOn` has.
 */
export function nextRunAfter(
  anchorMs: number,
  rhythm: CampaignRhythm,
  fromMs: number,
  endsOnMs: number | null = null,
): number | null {
  if (rhythm === "once") return null;

  const anchor = new Date(anchorMs);
  const anchorDay = anchor.getUTCDate();
  const step = MONTHS[rhythm];

  // How many whole steps from the anchor to `from`, then walk forward until strictly past it.
  const monthsApart =
    (new Date(fromMs).getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (new Date(fromMs).getUTCMonth() - anchor.getUTCMonth());
  let n = Math.max(0, Math.floor(monthsApart / step));

  // Bounded: each turn advances by at least one step, so this cannot spin. Two turns is the most
  // it ever takes — one to land on or before `from`, one to pass it.
  for (let guard = 0; guard < 4; guard++) {
    const candidate = occurrence(anchor, anchorDay, n * step);
    if (candidate > fromMs) {
      return endsOnMs !== null && candidate > endsOnMs ? null : candidate;
    }
    n += 1;
  }
  return null;
}

/**
 * The first date a campaign is due.
 *
 * A start date already in the past does NOT quietly slide to next month — the sweep fires it
 * late, once, the same promise the task and invoice sweeps make about downtime.
 *
 * **But only once.** After a late run the next date is counted from TODAY, not from the date that
 * was missed (see the caller). Tasks and invoices catch up every missed period, because a missing
 * invoice is a missing fact; a campaign that caught up the same way would empty six months of
 * newsletters into a client's inbox in one morning. Late is recoverable, a backlog blast is not.
 */
export function firstRunOn(startsOnMs: number, endsOnMs: number | null = null): number | null {
  if (endsOnMs !== null && startsOnMs > endsOnMs) return null;
  return startsOnMs;
}

/**
 * The anchor day, clamped into the month it lands in.
 *
 * February has no 31st. Clamping to the 28th (or 29th) is the only answer that keeps "monthly on
 * the 31st" meaning end-of-month rather than silently becoming the 3rd of March.
 */
function occurrence(anchor: Date, anchorDay: number, monthsForward: number): number {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + monthsForward;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(anchorDay, lastDay));
}

/** How the rhythm reads on screen. */
export const RHYTHM_LABELS: Record<CampaignRhythm, string> = {
  once: "Once",
  monthly: "Every month",
  quarterly: "Every quarter",
  yearly: "Every year",
};
