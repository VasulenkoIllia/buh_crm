/**
 * What the background jobs are, in the firm's language.
 *
 * A zero-dependency constant, read by both the server and the browser — the same shape
 * `shared/notifications.ts` and `shared/system-tasks.ts` use, and for the same reason: a job
 * cannot appear on the System screen and not exist, or exist and not appear.
 *
 * The point of this file is the WORDS. The scheduler already knows every job's name and cron;
 * neither is any use to the person who has to decide whether the CRM is quietly broken.
 * `subscription-task-generation` at `5 3 * * *` says nothing. "Tasks from subscriptions, every
 * night at 3am — if this stops, work stops appearing on boards and nobody is told" says all of it.
 *
 * NO IMPORTS, ever. The browser loads this, and importing a value out of a schema module drags the
 * zod runtime into the bundle (+433 kB — docs/architecture.md §5).
 */

export type SystemJobKey =
  | "subscription-task-generation"
  | "period-invoice-generation"
  | "campaign-sends"
  | "read-bounces"
  | "stalled-send-sweep"
  | "notification-sweep"
  | "meeting-reminders"
  | "notifications:retention"
  | "sessions:cleanup";

/** The part of the app a job keeps running — the screen groups by this. */
export type SystemJobArea = "work" | "billing" | "mail" | "notifications" | "housekeeping";

export interface SystemJobSpec {
  area: SystemJobArea;
  /** what it is, as a person would name it. Never the job's own key. */
  label: string;
  /** how often, in words. Not a cron expression — nobody reads those. */
  cadence: string;
  /** what it does when it works, one sentence, present tense */
  whenOk: string;
  /** what goes wrong if it stops. The whole reason this screen exists. */
  whenBad: string;
  /**
   * Where to go and DO something about it, when there is such a place.
   *
   * The screen is read-only, and a read-only screen that tells somebody a job is broken and not
   * where to fix it has handed them half a job. Only set where a real screen configures the thing
   * that broke — a vague pointer at "Billing" is worse than none. Shown only while the job is
   * unhealthy: a door you need is help, a door you do not is clutter.
   */
  fixAt?: { label: string; to: string };
  /**
   * How long after its last successful run it should start worrying somebody.
   *
   * Generous on purpose — comfortably more than one missed run. A daily job that is four hours
   * late has probably just been restarted; one that is a day and a half late has not run.
   * A screen that cries wolf is a screen people stop opening.
   */
  staleAfterMinutes: number;
}

const HOUR = 60;
const DAY = 24 * HOUR;

export const SYSTEM_JOBS: Record<SystemJobKey, SystemJobSpec> = {
  "subscription-task-generation": {
    area: "work",
    label: "Tasks from subscriptions",
    cadence: "Every night, just after 3am",
    whenOk: "Creates the tasks each subscription and internal template owes for the day.",
    whenBad:
      "Work stops appearing on the boards. Nothing warns you — a subscription that has quietly " +
      "stopped producing tasks looks exactly like a subscription with nothing due.",
    staleAfterMinutes: DAY + 12 * HOUR,
  },
  "period-invoice-generation": {
    area: "billing",
    label: "Invoices for the period",
    cadence: "Every night, just after 3am",
    whenOk: "Issues one invoice per subscription period, on the service's billing day.",
    whenBad:
      "Clients stop being invoiced, and the money is not missed until somebody counts it.",
    staleAfterMinutes: DAY + 12 * HOUR,
  },
  "campaign-sends": {
    area: "mail",
    label: "Scheduled campaigns",
    cadence: "Every hour, on the hour",
    whenOk: "Sends the campaigns whose date and time have come.",
    whenBad: "A campaign scheduled for a date simply never goes out.",
    fixAt: { label: "Open campaigns", to: "/mailouts?tab=campaigns" },
    staleAfterMinutes: 4 * HOUR,
  },
  "read-bounces": {
    area: "mail",
    // NOT "delivery reports" — that was the protocol's word for it, and on a screen with a Reports
    // section in the sidebar it read as something the CRM produces and sends somebody (user,
    // 2026-09-06). Nothing here is sent anywhere: a letter that cannot be delivered comes BACK
    // into the firm's own mailbox, and this is the job that opens it.
    label: "Letters that came back",
    cadence: "Every fifteen minutes",
    whenOk:
      "Opens the mailbox letters bounce back into, ties each one to the letter it failed, and " +
      "marks the address as bad so nothing is sent to it again.",
    whenBad:
      "Mailouts keep reporting letters as delivered when they were not, and dead addresses stay " +
      "on the lists and keep being written to — which is what damages a sending domain's " +
      "reputation until real letters start landing in spam.",
    // almost always a mailbox that stopped answering, and that is where it is configured
    fixAt: { label: "Check the mailbox", to: "/mailouts?tab=sender" },
    staleAfterMinutes: 2 * HOUR,
  },
  "stalled-send-sweep": {
    area: "mail",
    label: "Mailouts that stopped halfway",
    cadence: "Every ten minutes, and on every restart",
    whenOk:
      "Finds mailouts that were interrupted mid-send — nearly always by a restart — and marks " +
      "what did not go out as failed, so it can be sent again.",
    whenBad:
      "An interrupted mailout reads as still sending, forever. Nobody re-sends it, because " +
      "nothing says it stopped.",
    fixAt: { label: "Open mailouts", to: "/mailouts" },
    staleAfterMinutes: 2 * HOUR,
  },
  "notification-sweep": {
    area: "notifications",
    label: "Daily notifications",
    cadence: "Once a day, at the hour set on the Notifications tab",
    whenOk:
      "Checks what the passing of time has changed — deadlines coming up, meetings today, " +
      "invoices past their due day, timers left running — and tells the right people.",
    whenBad: "Nobody is warned about anything until they happen to look at it themselves.",
    fixAt: { label: "Notification settings", to: "/settings?tab=notifications" },
    staleAfterMinutes: DAY + 12 * HOUR,
  },
  "meeting-reminders": {
    area: "notifications",
    label: "Meeting reminders",
    cadence: "Every minute",
    whenOk: "Rings shortly before a meeting that was booked with a reminder.",
    whenBad: "Reminders stop arriving, and the first anyone knows is a meeting they missed.",
    fixAt: { label: "Open the calendar", to: "/calendar" },
    staleAfterMinutes: 30,
  },
  "notifications:retention": {
    area: "housekeeping",
    label: "Clearing old records",
    cadence: "Every night, just after 4am",
    whenOk:
      "Removes notifications that were read more than 90 days ago — unread ones are kept — and " +
      "the entries older than that from the activity list below.",
    whenBad: "Nothing breaks; the two tables simply keep growing.",
    staleAfterMinutes: DAY + 12 * HOUR,
  },
  "sessions:cleanup": {
    area: "housekeeping",
    label: "Clearing expired sign-ins",
    cadence: "Every night, at 4am",
    whenOk: "Removes sign-in sessions that have expired.",
    whenBad: "Nothing breaks; expired sessions accumulate.",
    staleAfterMinutes: DAY + 12 * HOUR,
  },
};

export const SYSTEM_JOB_KEYS = Object.keys(SYSTEM_JOBS) as SystemJobKey[];

export const SYSTEM_JOB_AREAS: Array<{ key: SystemJobArea; label: string }> = [
  { key: "work", label: "Work" },
  { key: "billing", label: "Billing" },
  { key: "mail", label: "Mail" },
  { key: "notifications", label: "Notifications" },
  { key: "housekeeping", label: "Housekeeping" },
];

export function isSystemJobKey(value: string): value is SystemJobKey {
  // `in` walks the prototype chain, so `"toString" in SYSTEM_JOBS` is true. The names come from
  // the database, and a row called `constructor` would otherwise be reported as a known job.
  return Object.hasOwn(SYSTEM_JOBS, value);
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * Five states, and the fifth is the one that took the thinking.
 *
 * `waiting` exists because a nightly job on a container started twenty minutes ago has not run and
 * is not late — it is simply not 3am yet. Without it, every deploy would paint the screen red for
 * a day, and a screen that is red when everything is fine is worse than no screen: people learn
 * the colour means nothing.
 */
export type JobStatus = "working" | "waiting" | "skipping" | "failing" | "overdue";

export interface JobHealthRow {
  name: string;
  lastOkAt: string | null;
  lastFailedAt: string | null;
  /** consecutive runs that threw — one blip is not a broken job */
  failStreak: number;
  /** items the last run could not do, having finished. A partial failure, not a crash. */
  lastSkipped: number;
  lastDurationMs: number | null;
  /** the job's own summary of the last run, if it had one to give */
  lastNote: string | null;
  /** the last error, for whoever has to fix it. Never the headline. */
  lastError: string | null;
}

/** One line in the history: a run that failed, skipped work, or did something. */
export interface JobEventRow {
  id: string;
  job: string;
  at: string;
  ok: boolean;
  durationMs: number;
  note: string | null;
  skipped: number;
  error: string | null;
}

export function jobStatus(
  row: JobHealthRow | undefined,
  spec: SystemJobSpec,
  now: Date,
  bootedAt: Date,
): JobStatus {
  /**
   * The staleness clock starts at the LATER of "when it last ran" and "when this process booted".
   *
   * A job cannot run while the server is down, so counting downtime against it blames the wrong
   * thing. Without this, an hour of downtime made the per-minute reminder job red the instant the
   * server came back — before it had had a single chance to run — and the first thing anybody saw
   * on a fresh start was an error that was not one. The server being down is a real problem, but
   * it is a different problem, and it is not news to whoever just restarted it.
   *
   * It is also the rule the never-run branch below already used. Two clocks for the same question
   * was the inconsistency that let this through.
   */
  const since = (at: number) => (now.getTime() - Math.max(at, bootedAt.getTime())) / 60_000;

  if (!row?.lastOkAt && !row?.lastFailedAt) {
    return since(0) > spec.staleAfterMinutes ? "overdue" : "waiting";
  }
  if (row.failStreak > 0) return "failing";

  const lastOk = row.lastOkAt ? new Date(row.lastOkAt).getTime() : 0;
  if (!lastOk) return "failing";
  if (since(lastOk) > spec.staleAfterMinutes) return "overdue";
  return row.lastSkipped > 0 ? "skipping" : "working";
}

/** The headline, in the same words on every screen that shows one. */
export const JOB_STATUS_TEXT: Record<
  JobStatus,
  { label: string; tone: "ok" | "warn" | "bad" }
> = {
  working: { label: "Working", tone: "ok" },
  waiting: { label: "Waiting for its first run", tone: "ok" },
  skipping: { label: "Ran, but skipped some work", tone: "warn" },
  overdue: { label: "Has not run when it should have", tone: "bad" },
  failing: { label: "Last run failed", tone: "bad" },
};

/** "3 minutes ago" / "yesterday at 03:05" is the UI's job; this is the part both sides agree on. */
export function isHealthy(status: JobStatus): boolean {
  return status === "working" || status === "waiting";
}
