/**
 * What the FIRST nightly sweep will raise — asked before it happens, not discovered afterwards.
 *
 * The event triggers are quiet on a deploy: they fire when somebody does something, so they
 * accumulate at the pace people work. The SWEEP is the one to look at. It has no `catchUp`, so it
 * does not run when the container starts — it runs at the next 07:00 firm time, and on that first
 * morning it meets a database that has been accumulating overdue work since long before the module
 * existed. Every one of those raises a notification, once, and mails whoever the policy says.
 *
 * READ-ONLY, and safe on production: it uses the sweep's own repository reads and writes nothing.
 * That is deliberate — a forecast that had its own copy of the queries would eventually forecast
 * something the sweep does not do.
 *
 *   npx tsx scripts/notification-forecast.ts
 */
import { config } from "../server/core/config.js";
import { addDays, isoDayInTz, todayInTz, toUtc, zonedDayStart } from "../server/core/dates.js";
import { prisma } from "../server/core/db.js";
import { NOTIFICATION_TRIGGERS } from "../shared/notifications.js";
import { decide } from "../server/core/notify.js";
import * as repo from "../server/modules/notifications/notifications.repository.js";

const today = todayInTz(config.TZ);
const todayUtc = toUtc(today);
const dayStart = zonedDayStart(isoDayInTz(todayUtc, "UTC"), config.TZ);
const dayEnd = zonedDayStart(isoDayInTz(toUtc(addDays(today, 1)), "UTC"), config.TZ);

const policies = new Map((await repo.listPolicies()).map((p) => [p.trigger, p]));

/**
 * Every active person's own preferences, so the letter count is the one the emitter would produce
 * rather than the one the firm's default suggests.
 *
 * This asked `policy.defaultEmail` and nothing else, which over-reported for anybody who had
 * turned email off and under-reported for anybody who had turned it on (audit, 2026-09-06).
 */
const people = await prisma.user.findMany({
  where: { status: "active" },
  select: { id: true, role: true },
});
const prefRows = await prisma.notificationPreference.findMany();
const prefsFor = (userId: string) => {
  const own = new Map<string, boolean>();
  for (const r of prefRows)
    if (r.userId === userId) own.set(`${r.trigger}:${r.channel}`, r.enabled);
  return own;
};

/** How many PEOPLE one raised notification reaches, and how many of them get a letter. */
async function reach(trigger: string, subjects: Array<{ assignees?: number; self?: boolean }>) {
  const policy = policies.get(trigger);
  if (!policy || !policy.enabled) return { rows: 0, mails: 0, note: "switched off" };

  /**
   * Who a row reaches. `admin` and a `custom`-only list are known names, so their preferences can
   * be consulted exactly. Assignee / participant / self are per-subject and unknowable from here —
   * counted as one person on the FIRM's default, which is the honest approximation and is stated
   * as such in the output.
   */
  const named = policy.roles.includes("admin")
    ? people.filter((u) => u.role === "admin").map((u) => u.id)
    : policy.roles.includes("custom") && policy.roles.length === 1
      ? policy.customUserIds
      : null;

  if (named) {
    const rows = subjects.length * named.length;
    // the SAME precedence the emitter applies — imported, not re-implemented
    const mails =
      subjects.length *
      named.filter((id) => decide(policy, "custom", prefsFor(id), trigger).email).length;
    return { rows, mails, note: "" };
  }

  const rows = subjects.reduce((n, s) => n + (s.assignees ?? 1), 0);
  return { rows, mails: policy.defaultEmail ? rows : 0, note: "per-person defaults assumed" };
}

/**
 * Already raised, and therefore not raised again.
 *
 * On the first run after a deploy this changes nothing — the table is empty. It matters every time
 * afterwards: `dedupKey` makes each of these once-per-thing, so a forecast that ignored it would
 * keep predicting a burst that has already happened and cannot happen twice.
 */
const raised = new Set(
  (await prisma.notification.findMany({ select: { dedupKey: true } })).map((n) => n.dedupKey),
);
const pending = <T extends { id: string }>(trigger: string, items: T[]) =>
  items.filter((i) => !raised.has(`${trigger}:${i.id}`));

const overdue = await repo.tasksWithDeadlineIn({ lt: todayUtc });
/**
 * The FIRM's window, not a hardcoded tomorrow.
 *
 * This asked `{ equals: today + 1 }` while the sweep asks a range from `notifyDeadlineDays`
 * (S9.2), so on any firm that widened the window the forecast under-reported the first morning —
 * at exactly the moment somebody reads it to decide whether to silence a channel.
 */
const firm = await prisma.firmProfile.findUnique({
  where: { id: 1 },
  select: { notifyDeadlineDays: true, notifySweepAt: true },
});
const leadDays = firm?.notifyDeadlineDays ?? 1;
// the hour the firm actually set, not the one this script was written against
const sweepAt = firm?.notifySweepAt ?? "07:00";
const near = await repo.tasksWithDeadlineIn({
  gte: toUtc(addDays(today, 1)),
  lte: toUtc(addDays(today, leadDays)),
});
const meetingsToday = await repo.meetingsStartingBetween(dayStart, dayEnd);
const invoices = (await repo.overdueInvoices(todayUtc)).filter((i) => i.paidTotal < i.amount);
const timers = await repo.timersRunningSince(dayStart);
const mailboxes = await repo.brokenMailboxes();

const assigneeCount = async (taskIds: string[]) =>
  taskIds.length === 0
    ? []
    : (
        await prisma.taskAssignee.groupBy({
          by: ["taskId"],
          where: { taskId: { in: taskIds } },
          _count: true,
        })
      ).map((g) => ({ assignees: g._count }));

const rowsFor = [
  ["task_overdue", await assigneeCount(pending("task_overdue", overdue).map((t) => t.id))],
  [
    "task_deadline_near",
    await assigneeCount(pending("task_deadline_near", near).map((t) => t.id)),
  ],
  ["meeting_today", pending("meeting_today", meetingsToday).map(() => ({}))],
  ["invoice_overdue", pending("invoice_overdue", invoices).map(() => ({}))],
  ["timer_left_running", pending("timer_left_running", timers).map(() => ({ assignees: 1 }))],
  // keyed by the ERROR text, not the mailbox id — the one key that is not just an id
  [
    "ops_mailbox_broken",
    mailboxes
      .filter((m) => !raised.has(`ops_mailbox_broken:${m.id}:${m.bounceError}`))
      .map(() => ({})),
  ],
] as const;

console.log(
  `\nThe next sweep runs at ${sweepAt} ${config.TZ}. Already-raised rows are excluded ` +
    `(${raised.size} in the table). It would raise:\n`,
);
let totalRows = 0;
let totalMails = 0;
for (const [trigger, subjects] of rowsFor) {
  const { rows, mails, note } = await reach(trigger, subjects as Array<{ assignees?: number }>);
  totalRows += rows;
  totalMails += mails;
  const label = `${subjects.length} × ${trigger}`;
  console.log(
    `  ${label.padEnd(34)} ${String(rows).padStart(4)} tray row(s)` +
      `${mails ? `, ${mails} email(s)` : ", no email"}${note ? `  — ${note}` : ""}`,
  );
}
console.log(
  `  ${"".padEnd(34)} ${String(totalRows).padStart(4)} rows, ${totalMails} emails in total\n`,
);

const eventTriggers = Object.entries(NOTIFICATION_TRIGGERS)
  .filter(([, s]) => s.source === "event")
  .map(([k]) => k);
console.log(
  `The other ${eventTriggers.length} triggers are event-driven and raise NOTHING on a deploy —\n` +
    `they fire the first time somebody assigns, comments, invites or moves something.\n`,
);
if (totalMails > 30) {
  console.log(
    `⚠ ${totalMails} letters in one morning is a lot for a first day. Turning the EMAIL channel\n` +
      `  off for task_overdue in Settings → Notifications before the first 07:00 leaves the tray\n` +
      `  rows intact and sends none of them.\n`,
  );
}
await prisma.$disconnect();
