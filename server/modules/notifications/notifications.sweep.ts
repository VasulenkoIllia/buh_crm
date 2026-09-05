/**
 * The one daily pass over everything nothing else can tell you about.
 *
 * Five of the sixteen triggers are facts about the PASSAGE OF TIME rather than about somebody
 * doing something: a deadline arriving, a meeting being today, an invoice going past its due day,
 * a timer that was never stopped. Nobody performs those, so nothing can emit them at a call site.
 *
 * Per-item fault isolation throughout, following `payments.generation.ts` and
 * `tasks.generation.ts`: one bad row must not cost the firm the other fifteen notifications, and
 * the sweep is idempotent through `dedupKey`, so whatever failed is retried tomorrow.
 */
import { REMINDER_CHOICES } from "@shared/schema/calendar.js";
import { config } from "../../core/config.js";
import { addDays, isoDayInTz, todayInTz, toUtc, zonedDayStart } from "../../core/dates.js";
import { clientLabel } from "../../core/names.js";
import { notify } from "../../core/notify.js";
import { drainSweepFailures } from "../../core/sweep-health.js";
import * as repo from "./notifications.repository.js";

/** "tomorrow" / "in 3 days" — how far off one particular deadline is, in whole days. */
function dueIn(deadline: Date | null, todayUtc: Date): string {
  if (!deadline) return "soon";
  const days = Math.round((deadline.getTime() - todayUtc.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/**
 * How far ahead the firm wants to be warned. Read per sweep rather than cached: this runs once a
 * day, so a query costs nothing, and a cached value would go stale the moment somebody changed it.
 */
async function firmDeadlineLeadDays(): Promise<number> {
  return (await repo.findFirmNotificationSettings())?.notifyDeadlineDays ?? 1;
}

export interface SweepResult {
  raised: number;
  skipped: number;
}

/** One item's worth of work, isolated: a thrown error costs this row and nothing else. */
async function each<T>(
  items: T[],
  fn: (item: T) => Promise<number>,
  out: SweepResult,
): Promise<void> {
  for (const item of items) {
    try {
      out.raised += await fn(item);
    } catch (err) {
      out.skipped++;
      console.error("[notifications] sweep item failed:", err);
    }
  }
}

export async function runNotificationSweep(): Promise<SweepResult> {
  const out: SweepResult = { raised: 0, skipped: 0 };
  const today = todayInTz(config.TZ);
  const todayUtc = toUtc(today);
  const tomorrowUtc = toUtc(addDays(today, 1));

  // ── deadlines ──────────────────────────────────────────────────────────────
  //
  // A deadline is a calendar DAY pinned to UTC midnight (`dateToUtc`), so it is compared against
  // `toUtc(day)` and never against a real instant. Getting this backwards is the silent kind of
  // timezone bug the calendar cost two days to find.
  /**
   * A RANGE, never an exact day.
   *
   * With `equals: today + N` a task created INSIDE the window would never be warned at all: the
   * sweep only ever looks at that one day, and a deadline nearer than it is never equal to it. At
   * the default of one day the two are identical, which is why it read as `equals` until the lead
   * time became a setting (S9.2).
   *
   * Each task is still warned ONCE, because the dedup key is the task — so widening the window
   * warns about everything newly inside it, on the first morning it is, and never again.
   */
  const leadDays = Math.min(Math.max(await firmDeadlineLeadDays(), 1), 30);
  await each(
    await repo.tasksWithDeadlineIn({
      gte: tomorrowUtc,
      lte: toUtc(addDays(today, leadDays)),
    }),
    (task) =>
      notify("task_deadline_near", {
        // the TASK, not the day: one warning per task, ever. Keyed by the day, a task nobody
        // touched would be announced again every morning it stayed due.
        dedup: task.id,
        taskId: task.id,
        // the distance to THIS task's deadline, not the width of the window. "Due in 5 days" on a
        // task that is due in three is technically the setting and practically a lie.
        vars: { task: task.title, when: dueIn(task.deadline, todayUtc) },
        // the client, or nothing. "Due tomorrow" as the second line repeats the first one
        // word for word on every INTERNAL task, which have no client (spotted in testing).
        sub: task.client
          ? clientLabel(task.client)
          : task.deadline
            ? `Due ${task.deadline.toISOString().slice(0, 10)}`
            : null,
        link: { type: "task", id: task.id },
      }),
    out,
  );

  await each(
    await repo.tasksWithDeadlineIn({ lt: todayUtc }),
    (task) =>
      notify("task_overdue", {
        dedup: task.id,
        taskId: task.id,
        vars: { task: task.title },
        sub: task.deadline ? `Was due ${task.deadline.toISOString().slice(0, 10)}` : null,
        link: { type: "task", id: task.id },
      }),
    out,
  );

  // ── meetings ───────────────────────────────────────────────────────────────
  //
  // A meeting is a real INSTANT, so the day is sliced at the firm's midnight, not UTC's. At a
  // non-zero offset the wrong helper quietly drops every meeting before the offset and pulls in
  // the tail of the previous day.
  const dayStart = zonedDayStart(isoDayInTz(todayUtc, "UTC"), config.TZ);
  const dayEnd = zonedDayStart(isoDayInTz(toUtc(addDays(today, 1)), "UTC"), config.TZ);
  await each(
    await repo.meetingsStartingBetween(dayStart, dayEnd),
    (meeting) =>
      notify("meeting_today", {
        dedup: meeting.id,
        meetingId: meeting.id,
        vars: {
          meeting: meeting.title,
          time: new Intl.DateTimeFormat("en-GB", {
            timeZone: config.TZ,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(meeting.startAt),
        },
        link: { type: "meeting", id: meeting.id },
      }),
    out,
  );

  // ── billing ────────────────────────────────────────────────────────────────
  //
  // The balance is computed here rather than filtered in SQL because `paidTotal >= amount` is not
  // a column comparison Prisma can express — and the set is invoices past their due day, which is
  // small by construction in a firm that chases them.
  const overdue = (await repo.overdueInvoices(todayUtc)).filter((i) => i.paidTotal < i.amount);
  await each(
    overdue,
    (invoice) =>
      notify("invoice_overdue", {
        dedup: invoice.id,
        vars: { number: invoice.number, client: clientLabel(invoice.client) },
        sub: `${((invoice.amount - invoice.paidTotal) / 100).toFixed(2)} outstanding`,
        link: { type: "invoice", id: invoice.id },
      }),
    out,
  );

  // ── personal ───────────────────────────────────────────────────────────────
  //
  // The one trigger addressed to `self`: it is a consequence of INACTION, and the header timer bar
  // only shows it while the app is open — which it was not, all night.
  await each(
    await repo.timersRunningSince(dayStart),
    (entry) =>
      notify("timer_left_running", {
        // the TIMER, not the person: a second timer left running tomorrow is a second warning
        dedup: entry.id,
        selfUserId: entry.userId,
        vars: {
          since: new Intl.DateTimeFormat("en-GB", {
            timeZone: config.TZ,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(entry.startedAt),
        },
        sub: entry.task.title,
        link: { type: "task", id: entry.task.id },
      }),
    out,
  );

  // ── operations ─────────────────────────────────────────────────────────────
  //
  // A mailbox that stops being read stops catching bounces, silently and forever. `bounceError` is
  // already shown beside the mailbox in Settings; this is the half that reaches somebody who is
  // not looking at that screen.
  await each(
    await repo.brokenMailboxes(),
    (mailbox) =>
      notify("ops_mailbox_broken", {
        // the ERROR, not the mailbox: a mailbox fixed and later broken differently says so again,
        // while the same failure every fifteen minutes stays one notification
        dedup: `${mailbox.id}:${mailbox.bounceError}`,
        vars: { mailbox: mailbox.name },
        sub: mailbox.bounceError,
        link: { type: "mailbox", id: mailbox.id },
      }),
    out,
  );

  // Drained, not read: one bad night is reported once. The next report only happens if a sweep
  // fails again (core/sweep-health.ts).
  await each(
    drainSweepFailures(),
    (failure) =>
      notify("ops_sweep_failed", {
        // the day's run: unlike every other sweep key this one names an OCCASION rather than a
        // thing, because the thing being reported IS "the night the sweep could not finish"
        dedup: `${failure.sweep}:${isoDayInTz(failure.lastAt, config.TZ)}`,
        vars: { sweep: failure.sweep },
        sub: `${failure.count} item${failure.count === 1 ? "" : "s"} skipped — check the server log`,
        link: null,
      }),
    out,
  );

  return out;
}

/**
 * The widest window the query has to look at — DERIVED from the choices the form offers, never
 * typed beside them. Written as its own 60 it was a silent trap: adding a two-hour reminder to
 * `REMINDER_CHOICES` would have left the window at an hour, and that reminder would have fired
 * sixty minutes before instead of a hundred and twenty, with nothing to show for it.
 */
const WIDEST_REMINDER_MINUTES = Math.max(...REMINDER_CHOICES);

/**
 * The reminder pass — the module's second job, and the only frequent one.
 *
 * It runs every minute, because a five-minute reminder cannot be honoured by a job that wakes
 * every five: it would fire anywhere between five and ten minutes early, or not at all. The cost
 * is one indexed query a minute over a window an hour wide, which is a handful of rows in a
 * ten-person firm — far less than the IMAP connection the bounce reader opens every fifteen.
 *
 * Idempotent like everything else here: the dedup key carries the meeting's START TIME, so a
 * meeting that is moved reminds again for its new time, and one that is not reminds once. That
 * matters more than it looks — keyed on the meeting alone, a rescheduled meeting would have
 * reminded people about the hour it used to be at and never about the one it moved to.
 *
 * If the process is down through the reminder minute, the next run still fires as long as the
 * meeting has not started: a reminder eight minutes before a fifteen-minute setting is late but
 * useful, and silence is not.
 */
export async function runMeetingReminders(): Promise<SweepResult> {
  const out: SweepResult = { raised: 0, skipped: 0 };
  const now = new Date();
  const due = (await repo.meetingsToRemind(now, WIDEST_REMINDER_MINUTES)).filter(
    (m) => m.startAt.getTime() - (m.remindMinutesBefore ?? 0) * 60_000 <= now.getTime(),
  );

  await each(
    due,
    (meeting) =>
      notify("meeting_soon", {
        // the meeting AND its instant — see the note above
        dedup: `${meeting.id}:${meeting.startAt.toISOString()}`,
        meetingId: meeting.id,
        vars: {
          meeting: meeting.title,
          when: minutesAway(meeting.startAt, now),
        },
        sub: new Intl.DateTimeFormat("en-GB", {
          timeZone: config.TZ,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(meeting.startAt),
        link: { type: "meeting", id: meeting.id },
      }),
    out,
  );
  return out;
}

/** "in 15 minutes" / "in a minute" — rounded up, so it never says less time than there is. */
function minutesAway(startAt: Date, now: Date): string {
  const mins = Math.ceil((startAt.getTime() - now.getTime()) / 60_000);
  if (mins <= 1) return "in a minute";
  return `in ${mins} minutes`;
}

/**
 * Read notifications are purged after 90 days. Unread rows are NEVER purged, at any age — a
 * notification nobody has seen has not done its job yet.
 *
 * This is the FIRST retention rule in the product. `docs/modules/archive.md` still says "kept
 * forever, no purge, no hard delete, anywhere in the app", which was true when it was written and
 * is not a position 16 CFR §314.4(c)(6) permits indefinitely. Recorded so the next module has a
 * precedent to follow rather than a decision to re-take.
 */
export const RETENTION_DAYS = 90;

export async function purgeOldNotifications(): Promise<{ purged: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await repo.purgeReadBefore(cutoff);
  return { purged: count };
}
