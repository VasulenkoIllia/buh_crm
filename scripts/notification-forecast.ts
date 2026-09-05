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
import * as repo from "../server/modules/notifications/notifications.repository.js";

const today = todayInTz(config.TZ);
const todayUtc = toUtc(today);
const dayStart = zonedDayStart(isoDayInTz(todayUtc, "UTC"), config.TZ);
const dayEnd = zonedDayStart(isoDayInTz(toUtc(addDays(today, 1)), "UTC"), config.TZ);

const policies = new Map((await repo.listPolicies()).map((p) => [p.trigger, p]));
const admins = await prisma.user.count({ where: { role: "admin", status: "active" } });

/** How many PEOPLE one raised notification reaches, and how many of them get a letter. */
async function reach(trigger: string, subjects: Array<{ assignees?: number; self?: boolean }>) {
  const policy = policies.get(trigger);
  if (!policy || !policy.enabled) return { rows: 0, mails: 0, note: "switched off" };
  const perItem = policy.roles.includes("admin")
    ? admins
    : policy.roles.includes("custom") && policy.roles.length === 1
      ? policy.customUserIds.length
      : 1; // assignee / participant / self — counted per subject below
  const rows = subjects.reduce((n, s) => n + (s.assignees ?? perItem), 0);
  return { rows, mails: policy.defaultEmail ? rows : 0, note: "" };
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
const near = await repo.tasksWithDeadlineIn({ equals: toUtc(addDays(today, 1)) });
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
  `\nThe next sweep runs at 07:00 ${config.TZ}. Already-raised rows are excluded ` +
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
