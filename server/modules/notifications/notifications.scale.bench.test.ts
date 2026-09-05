import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { notify } from "../../core/notify.js";
import { purgeOldNotifications, runMeetingReminders } from "./notifications.sweep.js";

/**
 * Scale check for the bell (opt-in), in the shape `server/scale.bench.test.ts` established.
 *
 * The question it answers is not "is it fast today" — a ten-person firm's tray is tiny — but
 * "which query stops being an index lookup FIRST". Three years of a busy firm is roughly what is
 * seeded here: 120 000 rows across ten people, with the retention purge deliberately not run, so
 * this is the worst state the table can legitimately reach.
 *
 * Skipped by default; run it deliberately:
 *   SCALE=1 npx vitest run server/modules/notifications/notifications.scale.bench.test.ts
 */
const RUN = process.env.SCALE === "1";
const USERS = 10;
const PER_USER = 12_000;

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let meId: string;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const out = await fn();
  console.log(
    `  ${label.padEnd(52)} ${String(Math.round(performance.now() - started)).padStart(5)} ms`,
  );
  return out;
}

/** Ask Postgres what it actually did, rather than inferring it from a stopwatch. */
async function plan(sql: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN ${sql}`);
  return rows.map((r) => Object.values(r)[0]).join("\n");
}

beforeAll(async () => {
  if (!RUN) return;
  app = await buildApp();
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@scale.local" } } });
  await ensureBaseData();

  const hash = await argon2.hash("password-123");
  const users: string[] = [];
  for (let i = 0; i < USERS; i++) {
    users.push(
      (
        await prisma.user.create({
          data: {
            firstName: `Scale${i}`,
            lastName: "Bell",
            email: `scale${i}@scale.local`,
            passwordHash: hash,
            role: i === 0 ? "admin" : "user",
            status: "active",
          },
        })
      ).id,
    );
  }
  meId = users[0];

  const now = Date.now();
  for (const userId of users) {
    // in batches, because one 12 000-row insert is a parameter limit away from failing
    for (let batch = 0; batch < PER_USER / 2_000; batch++) {
      await prisma.notification.createMany({
        data: Array.from({ length: 2_000 }, (_, k) => {
          const n = batch * 2_000 + k;
          const age = n * 3_600_000; // one an hour, going back
          return {
            userId,
            trigger: "task_assigned",
            reason: "assignee" as const,
            text: `Scale row ${n}`,
            dedupKey: `task_assigned:scale-${userId}-${n}`,
            createdAt: new Date(now - age),
            // most are read, as a real tray is: people clear them
            readAt: n % 40 === 0 ? null : new Date(now - age + 60_000),
          };
        }),
      });
    }
  }
  await prisma.$executeRawUnsafe(`ANALYZE "Notification"`);

  cookie = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "scale0@scale.local", password: "password-123" },
    })
  ).headers["set-cookie"]!.toString().split(";")[0];
  // seeding 120 000 rows does not fit vitest's 10-second default
}, 600_000);

afterAll(async () => {
  if (!RUN) return;
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@scale.local" } } });
  await app.close();
}, 300_000);

describe.runIf(RUN)("the bell at three years of a busy firm", () => {
  it("keeps every hot path on an index", { timeout: 300_000 }, async () => {
    const total = await prisma.notification.count();
    console.log(`\n  ${total.toLocaleString()} notifications across ${USERS} people\n`);

    const tray = await timed("GET /api/notifications (badge + 20 rows)", () =>
      app.inject({ method: "GET", url: "/api/notifications", headers: { cookie } }),
    );
    expect(tray.statusCode).toBe(200);
    expect(tray.json().items).toHaveLength(20);

    /**
     * The plan is the assertion, not the clock: a laptop under load can be slow for reasons that
     * have nothing to do with this query, and a sequential scan that is fast on 120 000 rows is
     * still the thing that will fall over on a million.
     */
    const trayPlan = await plan(
      `SELECT * FROM "Notification" WHERE "userId" = '${meId}'::uuid AND "readAt" IS NULL ORDER BY "createdAt" DESC LIMIT 20`,
    );
    console.log(`  tray plan: ${trayPlan.split("\n")[0]}`);
    expect(trayPlan, "the tray page must not seq-scan").not.toMatch(
      /Seq Scan on "?Notification/i,
    );

    const countPlan = await plan(
      `SELECT count(*) FROM "Notification" WHERE "userId" = '${meId}'::uuid AND "readAt" IS NULL`,
    );
    console.log(
      `  badge plan: ${countPlan
        .split("\n")
        .find((l) => /Scan/.test(l))
        ?.trim()}`,
    );
    expect(countPlan, "the badge count must not seq-scan").not.toMatch(
      /Seq Scan on "?Notification/i,
    );

    const dedupPlan = await plan(
      `SELECT "userId" FROM "Notification" WHERE "dedupKey" = 'task_assigned:scale-x' AND "userId" IN ('${meId}'::uuid)`,
    );
    console.log(`  dedup pre-filter plan: ${dedupPlan.split("\n")[0]}`);
    expect(dedupPlan, "the emitter's already-raised check must not seq-scan").not.toMatch(
      /Seq Scan on "?Notification/i,
    );

    await timed("emitter: one notification end to end", async () => {
      const priority = await prisma.priority.findFirstOrThrow({ where: { isDefault: true } });
      const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
      const task = await prisma.task.create({
        data: {
          title: "scale",
          kind: "free",
          priorityId: priority.id,
          statusColumnId: column.id,
        },
      });
      await prisma.taskAssignee.create({ data: { taskId: task.id, userId: meId } });
      await notify("task_assigned", {
        dedup: `scale-live-${Date.now()}`,
        taskId: task.id,
        vars: { actor: "Scale", task: "scale" },
      });
      await prisma.taskAssignee.deleteMany({ where: { taskId: task.id } });
      await prisma.task.delete({ where: { id: task.id } });
    });

    await timed("retention purge over the whole table", () => purgeOldNotifications());

    /**
     * The per-minute job's read, at a volume that makes the planner choose properly.
     *
     * On a nine-row table Postgres picks a sequential scan and is right to, which tells you
     * nothing — so this seeds a year of meetings first. `meeting-reminders` runs 1 440 times a
     * day; a scan here is the one query in this module that would be felt.
     */
    const base = Date.now();
    await prisma.meeting.createMany({
      data: Array.from({ length: 20_000 }, (_, i) => ({
        title: `Scale meeting ${i}`,
        startAt: new Date(base + (i - 10_000) * 60_000),
        durationMinutes: 30,
        remindMinutesBefore: i % 4 === 0 ? 15 : null,
      })),
    });
    await prisma.$executeRawUnsafe(`ANALYZE "Meeting"`);

    const reminderPlan = await plan(
      `SELECT id FROM "Meeting" WHERE "cancelledAt" IS NULL AND "remindMinutesBefore" IS NOT NULL
       AND "startAt" > now() AND "startAt" <= now() + interval '60 minutes'`,
    );
    console.log(`  reminder plan: ${reminderPlan.split("\n")[0]}`);
    expect(reminderPlan, "the per-minute reminder read must not seq-scan").not.toMatch(
      /Seq Scan on "?Meeting/i,
    );
    await timed("meeting reminder pass over 20 000 meetings", () => runMeetingReminders());
    await prisma.meeting.deleteMany({ where: { title: { startsWith: "Scale meeting" } } });
  });
});
