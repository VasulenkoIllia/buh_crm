/**
 * Fills the admin's bell with one of every notification, for hands-on testing.
 *
 * DEV ONLY, and it goes through the REAL service functions — `createTask`, `updateTask`,
 * `addComment`, `createMeeting`, `updateMeeting`, and the actual nightly sweep — so what lands in
 * the tray is produced by exactly the code a real day would run. Nothing here inserts a
 * Notification row by hand; if the emitter is wrong, this script is wrong in the same way, which
 * is the point.
 *
 * Everything it creates is prefixed `[test]` so it can be found and removed:
 *     npx tsx --env-file=.env scripts/dev/seed-notifications.ts --clean
 */
import { config } from "../../server/core/config.js";
import { prisma } from "../../server/core/db.js";
import { recordSweepFailure } from "../../server/core/sweep-health.js";
import * as tasks from "../../server/modules/tasks/tasks.service.js";
import * as meetings from "../../server/modules/meetings/meetings.service.js";
import { runNotificationSweep } from "../../server/modules/notifications/notifications.sweep.js";
import { refuseOnProduction } from "./guard.js";

refuseOnProduction("scripts/dev/seed-notifications.ts");

const TAG = "[test]";
const clean = process.argv.includes("--clean");
/** Run only the nightly sweep — the 07:00 job, on demand, without waiting for 07:00. */
const sweepOnly = process.argv.includes("--sweep");
/** Raise ONE `task_assigned` for the admin — for checking a preference actually silences it. */
const assignOne = process.argv.includes("--assign");

/** A calendar day in the firm's zone, as the ISO day string the task form sends. */
function firmDay(offset: number): string {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

/** An instant today in the firm's zone, `hh:mm` wall clock. */
function firmToday(hhmm: string): Date {
  const guess = new Date(`${firmDay(0)}T${hhmm}:00.000Z`);
  const offset = (probe: Date) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: config.TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(probe);
    const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return (
      Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) -
      Math.floor(probe.getTime() / 60_000) * 60_000
    );
  };
  const first = new Date(guess.getTime() - offset(guess));
  return new Date(guess.getTime() - offset(first));
}

async function wipe() {
  const made = await prisma.task.findMany({
    where: { title: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = made.map((t) => t.id);
  await prisma.timeEntry.deleteMany({ where: { taskId: { in: ids } } });
  await prisma.taskComment.deleteMany({ where: { taskId: { in: ids } } });
  await prisma.taskAssignee.deleteMany({ where: { taskId: { in: ids } } });
  await prisma.meeting.updateMany({ where: { taskId: { in: ids } }, data: { taskId: null } });
  await prisma.meetingParticipant.deleteMany({
    where: { meeting: { title: { startsWith: TAG } } },
  });
  await prisma.meeting.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.task.deleteMany({ where: { id: { in: ids } } });
  await prisma.invoice.deleteMany({ where: { number: { startsWith: "TEST-" } } });
  await prisma.notification.deleteMany();
  await prisma.mailSenderAccount.updateMany({ data: { bounceError: null } });
  console.log(
    `cleaned: ${ids.length} tasks, their meetings, test invoices, and the whole tray`,
  );
}

async function main() {
  const [admin, olena, petro, iryna] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: "admin@buh-crm.local" } }),
    prisma.user.findUniqueOrThrow({ where: { email: "olena@buh-crm.local" } }),
    prisma.user.findUniqueOrThrow({ where: { email: "petro@buh-crm.local" } }),
    prisma.user.findUniqueOrThrow({ where: { email: "iryna@buh-crm.local" } }),
  ]);

  if (clean) return wipe();
  if (sweepOnly) {
    const r = await runNotificationSweep();
    console.log(`sweep raised ${r.raised}, skipped ${r.skipped}`);
    return;
  }
  if (assignOne) {
    const before = await prisma.notification.count({
      where: { userId: admin.id, trigger: "task_assigned" },
    });
    const t = await tasks.createTask(
      {
        title: `${TAG} One more thing ${new Date().toISOString().slice(11, 19)}`,
        internal: true,
        assignees: [admin.id],
      },
      olena,
    );
    const after = await prisma.notification.count({
      where: { userId: admin.id, trigger: "task_assigned" },
    });
    console.log(`task ${t.id} — task_assigned rows for the admin: ${before} -> ${after}`);
    return;
  }
  await wipe(); // start from a clean tray so the run is reproducible

  const mk = (title: string, actor: typeof olena, over: Record<string, unknown> = {}) =>
    tasks.createTask(
      { title: `${TAG} ${title}`, internal: true, assignees: [admin.id], ...over },
      actor,
    );

  // ── 1. task_assigned ────────────────────────────────────────────────────────
  const vat = await mk("Reconcile the Q3 VAT return", olena, { deadline: firmDay(4) });
  const payroll = await mk("Check the August payroll figures", petro);
  console.log("task_assigned      ×2");

  // ── 2. task_comment — Petro writes on a task the admin is on ───────────────
  await tasks.addComment(
    vat.id,
    { body: "The bank feed is missing two days — can you confirm before I file?" },
    petro,
  );
  console.log("task_comment       ×1");

  // ── 3. task_deadline_changed ───────────────────────────────────────────────
  await tasks.updateTask(vat.id, { deadline: firmDay(2) }, olena);
  console.log("task_deadline_changed ×1");

  // ── 4. task_done — somebody finishes work the ADMIN asked for ──────────────
  const mine = await tasks.createTask(
    {
      title: `${TAG} Send the client the signed engagement letter`,
      internal: true,
      assignees: [petro.id],
    },
    admin,
  );
  await tasks.updateTask(mine.id, { done: true }, petro);
  console.log("task_done          ×1");

  // ── 5. task_reopened ───────────────────────────────────────────────────────
  await tasks.updateTask(payroll.id, { done: true }, admin); // the admin's own action: silent
  await tasks.updateTask(payroll.id, { done: false }, olena);
  console.log("task_reopened      ×1");

  // ── 6. task_cancelled ──────────────────────────────────────────────────────
  const called_off = await mk("Prepare the quarterly board pack", iryna);
  await tasks.updateTask(called_off.id, { cancelled: true }, iryna);
  console.log("task_cancelled     ×1");

  // ── 7. meeting_invited + 8. meeting_moved ──────────────────────────────────
  const meeting = await meetings.createMeeting(
    {
      title: `${TAG} Year-end planning with Mykhailo`,
      startAt: new Date(`${firmDay(3)}T13:00:00.000Z`).toISOString(),
      durationMinutes: 60,
      participantIds: [admin.id],
    },
    iryna,
  );
  await meetings.updateMeeting(
    meeting.id,
    { startAt: new Date(`${firmDay(3)}T15:30:00.000Z`).toISOString() },
    iryna,
  );
  console.log("meeting_invited    ×1  ·  meeting_moved ×1");

  // ── what the SWEEP finds. Set the world up, then run the real 07:00 job. ────

  // task_deadline_near — due tomorrow
  await mk("File the VAT payment before the deadline", olena, { deadline: firmDay(1) });
  // task_overdue — the deadline has passed
  await mk("Chase Bohdan for last month's bank statements", olena, { deadline: firmDay(-4) });

  // meeting_today
  await meetings.createMeeting(
    {
      title: `${TAG} Standup`,
      startAt: firmToday("16:00").toISOString(),
      durationMinutes: 30,
      participantIds: [admin.id],
    },
    petro,
  );

  // timer_left_running — the admin's own timer, still going since yesterday
  const timed = await mk("Bookkeeping for Yaroslava", petro);
  await prisma.timeEntry.create({
    data: {
      taskId: timed.id,
      userId: admin.id,
      startedAt: firmToday("14:20"),
      stoppedAt: null,
    },
  });
  await prisma.timeEntry.updateMany({
    where: { taskId: timed.id },
    data: { startedAt: new Date(firmToday("14:20").getTime() - 24 * 60 * 60 * 1000) },
  });

  // invoice_overdue — an unpaid bill past its due day. `TEST-` numbers so it is findable.
  const client = await prisma.client.findFirstOrThrow({ where: { archivedAt: null } });
  await prisma.invoice.create({
    data: {
      number: `TEST-${Date.now().toString().slice(-6)}`,
      clientId: client.id,
      amount: 45_000,
      paidTotal: 0,
      issuedAt: new Date(`${firmDay(-30)}T00:00:00.000Z`),
      dueDate: new Date(`${firmDay(-9)}T00:00:00.000Z`),
    },
  });

  // ops_mailbox_broken — the state a failed IMAP read leaves behind
  await prisma.mailSenderAccount.updateMany({
    where: { isDefault: true },
    data: { bounceError: "Authentication failed: invalid username or password" },
  });

  // ops_sweep_failed — as the billing sweep would have reported it
  recordSweepFailure("period-invoice-generation", 2);

  const swept = await runNotificationSweep();
  console.log(`sweep              raised ${swept.raised}, skipped ${swept.skipped}`);

  /**
   * The mailbox is put back straight away. The NOTIFICATION stays — its dedup key is the error
   * text, not the mailbox's current state — so the tray shows a real one without leaving the
   * firm's mailbox looking broken on the Sender screen.
   */
  await prisma.mailSenderAccount.updateMany({ data: { bounceError: null } });

  const rows = await prisma.notification.groupBy({
    by: ["trigger"],
    where: { userId: admin.id },
    _count: true,
  });
  console.log("\nin the admin's tray:");
  for (const r of rows.sort((a, b) => a.trigger.localeCompare(b.trigger))) {
    console.log(`  ${r.trigger.padEnd(24)} ${r._count}`);
  }
  const total = rows.reduce((n, r) => n + r._count, 0);
  console.log(`  ${"".padEnd(24)} ${total} total`);
}

await main();
await prisma.$disconnect();
