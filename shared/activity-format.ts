import { fmtMoney } from "./money.js";

/**
 * **How a diff VALUE is read out loud.**
 *
 * The log stores what the database stores, which is right — `amount` is minor units because money
 * is never a float, `paidAt` is a timestamp because that is what a `DateTime` column holds. What
 * was wrong was showing them that way. On production, 2026-09-09, a payment of one hundred dollars
 * read `amount 10000` and the date beside it read `paidAt 2026-09-08T00:00:00.000Z`: two true
 * values, neither of them an answer, on the screen whose whole purpose is that a person can read
 * the record without opening the database.
 *
 * **Keyed by FIELD NAME, once, rather than per event.** `amount` means minor units in all nine
 * events that carry it, and a per-event declaration would have repeated that nine times and let
 * two of them disagree. The names are already a shared vocabulary across the registry — this file
 * writes down what each one means.
 *
 * Separate from `activity.ts` because that file may not import anything (the browser loads it and
 * a stray schema import drags zod in). This one may: `money.ts` is three lines and importing it is
 * the point — a second money formatter is how "$1,250.00" here and "1250.00" there happen.
 */
export type ChangeKind = "money" | "date" | "minutes" | "seconds" | "bytes" | "plain";

/** Field name → what its number or string actually means. Anything absent renders as it is. */
export const CHANGE_KIND: Record<string, ChangeKind> = {
  // minor units, every one of them
  amount: "money",
  defaultAmount: "money",
  balance: "money",
  // stored as timestamps, read as days
  paidAt: "date",
  dueDate: "date",
  deadline: "date",
  startsOn: "date",
  endsOn: "date",
  lastDay: "date",
  startAt: "date",
  sendAt: "date",
  startedAt: "date",
  // durations
  durationMinutes: "minutes",
  plannedMinutes: "minutes",
  minutes: "minutes",
  remindMinutesBefore: "minutes",
  meetingRemindMinutes: "minutes",
  seconds: "seconds",
  // file sizes
  bytes: "bytes",
  size: "bytes",
  /**
   * Considered and deliberately plain. `notifySweepAt` looks like a timestamp by name and is a
   * clock reading — "07:00", the hour the nightly sweep runs. Listed rather than left out so the
   * test below, which flags any unit-shaped name with no kind, records that this one was decided.
   */
  notifySweepAt: "plain",
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;

/** 90 → "1 h 30 m"; 45 → "45 m"; 120 → "2 h". Zero is a real answer and stays "0 m". */
function duration(totalMinutes: number): string {
  const hours = Math.floor(Math.abs(totalMinutes) / 60);
  const minutes = Math.abs(totalMinutes) % 60;
  const sign = totalMinutes < 0 ? "−" : "";
  if (hours === 0) return `${sign}${minutes} m`;
  return minutes === 0 ? `${sign}${hours} h` : `${sign}${hours} h ${minutes} m`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One value of one field, as a person reads it.
 *
 * Deliberately total: an unknown field, a null, a boolean and an object all have an answer, because
 * this runs on two years of stored rows and a value written before a field had a kind must still
 * render. A number that arrives as a string is formatted too — `diff()` stores what it was given.
 */
export function formatChangeValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  /**
   * A list is joined for a reader, not stringified. `String(["Olena","Serhii"])` gives
   * "Olena,Serhii" with no space — which nobody noticed while these fields held uuids, and which
   * is the first thing you see now that `assignees`, `added` and `removed` hold names.
   */
  if (Array.isArray(value)) {
    return value.length === 0 ? "—" : value.map((v) => formatChangeValue(field, v)).join(", ");
  }

  const kind = CHANGE_KIND[field] ?? "plain";
  if (kind === "date" && typeof value === "string" && ISO_DATETIME.test(value)) {
    return value.slice(0, 10);
  }

  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && typeof value !== "object") {
    if (kind === "money") return fmtMoney(n);
    if (kind === "minutes") return duration(n);
    if (kind === "seconds") return duration(Math.round(n / 60));
    if (kind === "bytes") return bytes(n);
  }
  return String(value);
}

/** `companyName` → "company name", `paid_at` → "paid at". The column beside the value. */
export function fieldLabel(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}
