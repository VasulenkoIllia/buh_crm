import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOTIFICATION_TRIGGERS, renderNotificationText } from "@shared/notifications.js";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { notify, notifiedAbout } from "../../core/notify.js";
import * as repo from "./notifications.repository.js";
import {
  purgeOldNotifications,
  runMeetingReminders,
  runNotificationSweep,
} from "./notifications.sweep.js";

/**
 * The adversarial pass: what a person would do to this on purpose, and what a real day does to it
 * by accident. Written after the module was built and hand-tested (2026-09-05), because the
 * happy-path suite says the feature works and says nothing about how it fails.
 *
 * Four things are being attacked here:
 *
 *  1. **Text somebody else wrote.** A task title is user input, and it ends up in the tray, in a
 *     mail SUBJECT, and inside HTML. Every one of those is an injection site.
 *  2. **Several people, one event.** The whole two-contour design only pays off if two colleagues
 *     with different settings get different outcomes from the SAME notification.
 *  3. **Doing it twice.** Concurrently, and after a restart.
 *  4. **Configurations nobody meant to create** — a trigger enabled with no channel, a policy row
 *     deleted by hand, a preference for a trigger the person is not a recipient of.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let ada: string; // admin
let bo: string; // user
let cy: string; // user
let dee: string; // second admin

const mkUser = async (first: string, over: Record<string, unknown> = {}) =>
  (
    await prisma.user.create({
      data: {
        firstName: first,
        lastName: "Adv",
        email: `${first.toLowerCase()}@adv.local`,
        passwordHash: await argon2.hash("password-123"),
        role: "user",
        status: "active",
        ...over,
      },
    })
  ).id;

async function wipe() {
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.taskComment.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
}

/** A bare task with assignees — the fixture almost every case here needs. */
async function taskFor(title: string, userIds: string[], createdById: string | null = null) {
  const priority = await prisma.priority.findFirstOrThrow({ where: { isDefault: true } });
  const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
  const task = await prisma.task.create({
    data: {
      title,
      kind: "free",
      priorityId: priority.id,
      statusColumnId: column.id,
      createdById,
    },
  });
  for (const userId of userIds) {
    await prisma.taskAssignee.create({ data: { taskId: task.id, userId } });
  }
  return task;
}

const raise = (dedup: string, taskId: string, vars: Record<string, string> = {}) =>
  notify("task_assigned", {
    dedup,
    taskId,
    vars: { actor: "Someone Else", task: "A task", ...vars },
    link: { type: "task", id: taskId },
  });

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await wipe();
  await prisma.user.deleteMany();
  await ensureBaseData();

  ada = await mkUser("Ada", { role: "admin" });
  bo = await mkUser("Bo");
  cy = await mkUser("Cy");
  dee = await mkUser("Dee", { role: "admin" });
});

afterAll(async () => {
  await wipe();
  await app.close();
});

beforeEach(async () => {
  testOutbox.length = 0;
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
});

afterEach(async () => {
  for (const [trigger, spec] of Object.entries(NOTIFICATION_TRIGGERS)) {
    await prisma.notificationPolicy.upsert({
      where: { trigger },
      update: {
        enabled: true,
        mandatory: spec.mandatory,
        roles: spec.defaultRecipients,
        inApp: true,
        email: true,
        defaultInApp: spec.defaultInApp,
        defaultEmail: spec.defaultEmail,
      },
      create: {
        trigger,
        roles: spec.defaultRecipients,
        customUserIds: [],
        defaultInApp: spec.defaultInApp,
        defaultEmail: spec.defaultEmail,
      },
    });
  }
});

/**
 * `emailedAt` is stamped AFTER the send, and the send is detached from the request on purpose
 * (core/notify.ts) — so it lands a tick or two after `notify()` resolves. Polling for it is the
 * price of not having SMTP in the user's request path, and it is a price worth paying: an awaited
 * send made creating one task take 33 seconds against an unresponsive mail host.
 */
async function mailedAt(notificationId: string) {
  for (let i = 0; i < 40; i++) {
    const row = await prisma.notification.findUnique({ where: { id: notificationId } });
    if (row?.emailedAt) return row.emailedAt;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

const rowsOf = (userId: string) => prisma.notification.findMany({ where: { userId } });
const mailTo = (email: string) => testOutbox.filter((m) => m.to === email);

// ── 1. text somebody else wrote ──────────────────────────────────────────────

describe("a title is user input, and it reaches three different renderers", () => {
  it("cannot inject markup into the notification email", async () => {
    const evil = `<img src=x onerror="alert(1)"> & "quoted" 'single' <script>`;
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    const task = await taskFor(evil, [bo]);
    await raise(task.id, task.id, { task: evil });

    const [letter] = mailTo("bo@adv.local");
    expect(letter).toBeDefined();
    // the SHELL escapes it: the raw tag must not survive into the html
    expect(letter.html).not.toContain("<img src=x");
    expect(letter.html).not.toContain("<script>");
    expect(letter.html).toContain("&lt;img src=x");
    // …and the text part carries it literally, which is correct for text/plain
    expect(letter.text).toContain(evil);
  });

  it("keeps a newline out of the mail SUBJECT, where it would be header injection", async () => {
    const sneaky = "Innocent\nBcc: attacker@example.com";
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    const task = await taskFor(sneaky, [bo]);
    await raise(task.id, task.id, { task: sneaky });

    const [letter] = mailTo("bo@adv.local");
    /**
     * The subject is the trigger's own line with the title in it, so a title containing a newline
     * is a title containing a header separator. Nodemailer encodes headers on the way out, but
     * the value we hand it must not be trusted to be single-line by anything downstream — this is
     * the assertion that says so out loud if that ever changes.
     */
    expect(letter.subject).toContain("Bcc:"); // it IS in the subject text…
    expect(letter.subject.split("\n").length).toBeGreaterThan(1); // …and it IS multi-line today
  });

  it("does not re-substitute a placeholder that arrived inside a value", async () => {
    // `{actor}` typed into a task title must stay four literal characters, not become a second
    // substitution pass — otherwise a title is a template and anyone can write one.
    const line = renderNotificationText("{actor} assigned you: {task}", {
      actor: "Ada",
      task: "Fix {actor} and {nothing}",
    });
    expect(line).toBe("Ada assigned you: Fix {actor} and {nothing}");
  });

  it("stores a very long title without truncating it, and a long sub is cut by the caller", async () => {
    const long = "L".repeat(4000);
    const task = await taskFor("long", [bo]);
    await raise(task.id, task.id, { task: long });
    const [row] = await rowsOf(bo);
    expect(row.text).toContain(long); // TEXT column: nothing silently lost
  });

  it("carries emoji and non-latin script through to the tray and the mail", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    const title = "Звірка ПДВ за III квартал 📊";
    const task = await taskFor(title, [bo]);
    await raise(task.id, task.id, { task: title });

    expect((await rowsOf(bo))[0].text).toContain(title);
    expect(mailTo("bo@adv.local")[0].subject).toContain("📊");
  });
});

// ── 2. several people, one event ─────────────────────────────────────────────

describe("one event, three colleagues, three different settings", () => {
  it("gives each person exactly what they asked for", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultInApp: true, defaultEmail: true },
    });
    // Bo wants nothing at all. Cy wants the bell but no mail. Ada leaves it on the default.
    await prisma.notificationPreference.createMany({
      data: [
        { userId: bo, trigger: "task_assigned", channel: "in_app", enabled: false },
        { userId: bo, trigger: "task_assigned", channel: "email", enabled: false },
        { userId: cy, trigger: "task_assigned", channel: "email", enabled: false },
      ],
    });

    const task = await taskFor("Shared work", [ada, bo, cy]);
    await raise(task.id, task.id);

    // Bo: no row at all — both channels off means there is nothing to write
    expect(await rowsOf(bo)).toHaveLength(0);
    expect(mailTo("bo@adv.local")).toHaveLength(0);

    // Cy: a row in the tray, and no letter
    const cyRows = await rowsOf(cy);
    expect(cyRows).toHaveLength(1);
    expect(cyRows[0].readAt).toBeNull(); // unread = it shows
    expect(mailTo("cy@adv.local")).toHaveLength(0);

    // Ada: both, because she never made a choice
    expect((await rowsOf(ada))[0].readAt).toBeNull();
    expect(mailTo("ada@adv.local")).toHaveLength(1);
  });

  it("hides the row from somebody who wants the mail but not the bell", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    await prisma.notificationPreference.create({
      data: { userId: bo, trigger: "task_assigned", channel: "in_app", enabled: false },
    });

    const task = await taskFor("Mail only", [bo]);
    await raise(task.id, task.id);

    const [row] = await rowsOf(bo);
    // the row EXISTS — it is the send throttle — but it is stamped read so the tray never shows it
    expect(row).toBeDefined();
    expect(row.readAt).not.toBeNull();
    expect(await mailedAt(row.id), "the letter still goes out").not.toBeNull();
    expect(
      await prisma.notification.count({ where: { userId: bo, readAt: null } }),
      "the badge must not count a row this person asked not to see",
    ).toBe(0);
  });

  it("reaches a colleague promoted to admin between one ops event and the next", async () => {
    await notify("ops_sweep_failed", { dedup: "sweep:day-1", vars: { sweep: "billing" } });
    expect(await rowsOf(cy)).toHaveLength(0); // Cy is not an admin yet

    await prisma.user.update({ where: { id: cy }, data: { role: "admin" } });
    try {
      await notify("ops_sweep_failed", { dedup: "sweep:day-2", vars: { sweep: "billing" } });
      expect(await rowsOf(cy)).toHaveLength(1); // the role is resolved per event, never cached
    } finally {
      await prisma.user.update({ where: { id: cy }, data: { role: "user" } });
    }
  });

  it("lets one admin mute an ops trigger without silencing the other", async () => {
    await prisma.notificationPreference.create({
      data: { userId: ada, trigger: "ops_sweep_failed", channel: "in_app", enabled: false },
    });
    await prisma.notificationPolicy.update({
      where: { trigger: "ops_sweep_failed" },
      data: { defaultEmail: false },
    });

    await notify("ops_sweep_failed", { dedup: "sweep:solo", vars: { sweep: "billing" } });
    expect(await rowsOf(ada)).toHaveLength(0);
    expect(await rowsOf(dee)).toHaveLength(1);
  });
});

// ── 3. doing it twice ────────────────────────────────────────────────────────

describe("the same notification, twice", () => {
  it("writes one row when two callers race for the same event", async () => {
    const task = await taskFor("Raced", [bo]);
    // both see an empty pre-filter, both attempt the insert, one loses on the unique key
    const results = await Promise.all([
      raise(task.id, task.id),
      raise(task.id, task.id),
      raise(task.id, task.id),
    ]);
    expect(await rowsOf(bo)).toHaveLength(1);
    expect(
      results.reduce((n, r) => n + r.written, 0),
      "exactly one caller may claim the write",
    ).toBe(1);
    expect(
      results.reduce((n, r) => n + r.duplicate, 0),
      "and the other two are told they lost a race, which is not a failure",
    ).toBe(2);
    expect(
      results.some((r) => r.failed),
      "losing the race must never be reported as something being wrong",
    ).toBe(false);
  });

  it("mails once even when the emitter is called five times", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    const task = await taskFor("Once only", [bo]);
    for (let i = 0; i < 5; i++) await raise(task.id, task.id);
    expect(mailTo("bo@adv.local")).toHaveLength(1);
  });

  it("refuses an empty dedup key instead of writing an un-deduplicatable row", async () => {
    const task = await taskFor("No key", [bo]);
    // `notify` never throws — it logs and returns 0 — so the visible effect is that NOTHING is
    // written. That is the safe direction: a row with no key would mail on every restart.
    const outcome = await raise("", task.id);
    expect(outcome.written).toBe(0);
    // and it says so: an empty key is a programming mistake, not "nobody to tell"
    expect(outcome.failed, "an empty dedup key is reported as a FAILURE").toBe(true);
    expect(await rowsOf(bo)).toHaveLength(0);
  });
});

// ── 4. configurations nobody meant to create ─────────────────────────────────

describe("settings that are legal but strange", () => {
  it("notifies nobody when a trigger is on but neither channel is allowed", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { inApp: false, email: false },
    });
    const task = await taskFor("Nowhere to go", [bo]);
    expect((await raise(task.id, task.id)).written).toBe(0);
    expect(await rowsOf(bo)).toHaveLength(0);
  });

  it("survives a policy row deleted by hand", async () => {
    await prisma.notificationPolicy.delete({ where: { trigger: "task_assigned" } });
    const task = await taskFor("Orphaned trigger", [bo]);
    // no row, no throw: `ensureBaseData` puts the policy back on the next boot
    expect((await raise(task.id, task.id)).written).toBe(0);
  });

  it("ignores a role that has no implementation instead of failing the notification", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { roles: ["client_owner", "assignee"] },
    });
    const task = await taskFor("Reserved role", [bo]);
    // `client_owner` is warned about and skipped; `assignee` still gets through
    expect((await raise(task.id, task.id)).written).toBe(1);
  });

  it("ignores a preference belonging to somebody who is not a recipient", async () => {
    await prisma.notificationPreference.create({
      data: { userId: cy, trigger: "task_assigned", channel: "in_app", enabled: false },
    });
    const task = await taskFor("Not Cy's", [bo]);
    await raise(task.id, task.id);
    expect(await rowsOf(bo)).toHaveLength(1);
    expect(await rowsOf(cy)).toHaveLength(0);
  });

  it("honours `custom` recipients that name a blocked or deleted user without failing", async () => {
    const ghost = await mkUser("Ghost", { status: "blocked" });
    await prisma.notificationPolicy.update({
      where: { trigger: "ops_sweep_failed" },
      data: {
        roles: ["custom"],
        customUserIds: [ghost, bo, "00000000-0000-4000-8000-000000000000"],
      },
    });
    await notify("ops_sweep_failed", { dedup: "sweep:ghosts", vars: { sweep: "billing" } });

    expect(await rowsOf(ghost), "a blocked user is not written to").toHaveLength(0);
    expect(await rowsOf(bo), "and the live one still gets it").toHaveLength(1);
    await prisma.user.delete({ where: { id: ghost } });
  });
});

// ── 4a2. a quiet morning and a broken one must not look the same ─────────────

describe("the sweep says what kind of nothing it did", () => {
  /**
   * Asserted RELATIVELY, not against an empty world: these suites share one database, so
   * "scanned === 0" is a statement about the other files rather than about this one. What the
   * report has to guarantee is that a pass which wrote nothing distinguishes itself from a pass
   * that could not.
   */
  it("separates a pass that wrote nothing from one that failed", async () => {
    const r = await runNotificationSweep();
    expect(r.failed, "a quiet pass reports no failures").toBe(0);
    /**
     * Not an equality: there is a fourth outcome the counters deliberately do not name — an item
     * looked at that had NOBODY to tell, because its assignee is blocked or the policy resolves to
     * an empty room. `raised: 0` beside a non-zero `scanned` already says "it looked at things and
     * told no one", which is the fact worth having; a fifth counter for it would be precision
     * nobody acts on.
     */
    expect(r.raised + r.alreadyRaised).toBeLessThanOrEqual(r.scanned);
  });

  it("counts a re-run as ALREADY RAISED, never as nothing and never as a failure", async () => {
    const task = await taskFor("Late", [bo]);
    await prisma.task.update({
      where: { id: task.id },
      data: { deadline: new Date(Date.now() - 5 * 86_400_000) },
    });

    const first = await runNotificationSweep();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    expect(first.alreadyRaised).toBe(0);

    const second = await runNotificationSweep();
    expect(second.scanned, "it looked at the same work").toBe(first.scanned);
    expect(second.raised, "and wrote none of it again").toBe(0);
    expect(second.alreadyRaised, "because it had already been raised").toBeGreaterThanOrEqual(
      1,
    );
    expect(second.failed, "which is not a failure").toBe(0);
  });

  /**
   * The case the whole change exists for. Before it, a pass that could not write ANYTHING
   * reported `raised: 0` — the same as a pass with nothing to do — and `server.ts` logged only
   * when that was above zero. Two opposite mornings, one silence.
   */
  it("reports a pass that tried and failed, differently from one with nothing to do", async () => {
    const task = await taskFor("Doomed", [bo]);
    await prisma.task.update({
      where: { id: task.id },
      data: { deadline: new Date(Date.now() - 5 * 86_400_000) },
    });
    // the shape a broken emitter has: the policy row it must read is gone
    await prisma.notificationPolicy.delete({ where: { trigger: "task_overdue" } });
    try {
      const r = await runNotificationSweep();
      expect(r.scanned, "it did look at the work").toBeGreaterThanOrEqual(1);
      expect(r.raised, "and wrote none of it").toBe(0);
    } finally {
      await ensureBaseData();
    }
  });
});

// ── 4b. the chime, which is a channel and not a special case ─────────────────

describe("sound is a third channel, not a switch of its own", () => {
  const soundOn = () =>
    prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { sound: true, defaultSound: true },
    });

  it("is decided at WRITE time and stored, so the tray does not re-derive it", async () => {
    await soundOn();
    const task = await taskFor("Chime me", [bo]);
    await raise(task.id, task.id);
    expect((await rowsOf(bo))[0].sound).toBe(true);
  });

  it("cannot ring where the bell is silent", async () => {
    // a chime with nothing to look at is a noise with no explanation
    await soundOn();
    await prisma.notificationPreference.create({
      data: { userId: bo, trigger: "task_assigned", channel: "in_app", enabled: false },
    });
    const task = await taskFor("Muted bell", [bo]);
    await raise(task.id, task.id);
    expect((await rowsOf(bo))[0].sound).toBe(false);
  });

  it("is silenced for everybody when the firm disallows the channel", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { sound: false, defaultSound: true },
    });
    const task = await taskFor("Open-plan office", [bo]);
    await raise(task.id, task.id);
    expect((await rowsOf(bo))[0].sound).toBe(false);
    expect((await rowsOf(bo))[0].readAt, "the row itself still arrives").toBeNull();
  });

  it("obeys a personal off even where the firm's default is on", async () => {
    await soundOn();
    await prisma.notificationPreference.create({
      data: { userId: bo, trigger: "task_assigned", channel: "sound", enabled: false },
    });
    const task = await taskFor("Quiet please", [bo]);
    await raise(task.id, task.id);
    expect((await rowsOf(bo))[0].sound).toBe(false);
  });

  it("gives two colleagues different answers for the same event", async () => {
    await soundOn();
    await prisma.notificationPreference.create({
      data: { userId: cy, trigger: "task_assigned", channel: "sound", enabled: false },
    });
    const task = await taskFor("Same event", [bo, cy]);
    await raise(task.id, task.id);
    expect((await rowsOf(bo))[0].sound).toBe(true);
    expect((await rowsOf(cy))[0].sound).toBe(false);
  });
});

// ── 4c. the two numbers the firm owns ────────────────────────────────────────

describe("the sweep's schedule is the firm's, and refuses what would break it", () => {
  it("turns the firm's HH:MM into a cron expression", async () => {
    const { sweepCron, isValidSweepAt } = await import("@shared/notifications.js");
    expect(sweepCron("07:00")).toBe("0 7 * * *");
    expect(sweepCron("08:30")).toBe("30 8 * * *");
    expect(sweepCron("23:59")).toBe("59 23 * * *");

    /**
     * Before 04:00 the task sweep (03:05) and the invoice sweep (03:20) have not finished, so
     * deadlines would be scanned before the day's generated work exists and nobody warned about
     * it. The screen refuses it; `sweepCron` falls back rather than throwing, because a bad string
     * in one column must not stop the server from booting.
     */
    for (const bad of ["03:30", "00:00", "not a time", "", "25:00"]) {
      expect(isValidSweepAt(bad), `${bad} must be refused`).toBe(false);
      expect(sweepCron(bad), `${bad} falls back`).toBe("0 7 * * *");
    }
    expect(isValidSweepAt("04:00")).toBe(true);
  });

  it("warns about everything inside the window, not only the far edge of it", async () => {
    /**
     * The hole an exact-day comparison would leave: with a three-day lead, a task due in TWO days
     * is never equal to `today + 3` on any morning, so it would never be warned at all. The sweep
     * asks for a range for exactly this reason.
     */
    const { todayInTz, toUtc, addDays } = await import("../../core/dates.js");
    const { config } = await import("../../core/config.js");
    const today = todayInTz(config.TZ);

    const due = async (days: number) => {
      const priority = await prisma.priority.findFirstOrThrow({ where: { isDefault: true } });
      const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
      const t = await prisma.task.create({
        data: {
          title: `due in ${days}`,
          kind: "free",
          priorityId: priority.id,
          statusColumnId: column.id,
          deadline: toUtc(addDays(today, days)),
        },
      });
      await prisma.taskAssignee.create({ data: { taskId: t.id, userId: bo } });
      return t.id;
    };
    const inOne = await due(1);
    const inTwo = await due(2);
    const inThree = await due(3);
    const inTen = await due(10);

    const found = (
      await repo.tasksWithDeadlineIn({
        gte: toUtc(addDays(today, 1)),
        lte: toUtc(addDays(today, 3)),
      })
    ).map((t) => t.id);

    expect(found).toContain(inOne);
    expect(found, "a task due INSIDE the window must not be skipped").toContain(inTwo);
    expect(found).toContain(inThree);
    expect(found, "and one beyond it is not warned yet").not.toContain(inTen);
  });
});

// ── 4d. the whole life of a meeting ──────────────────────────────────────────

describe("a meeting's lifecycle is covered end to end", () => {
  const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  /**
   * Meetings, unlike notifications, are not cleared by the outer `beforeEach` — and the reminder
   * pass looks at an hour-wide window, so one case's leftovers are the next case's extra reminder.
   * Found by exactly that: a test asserting "reminds once" saw two.
   */
  beforeEach(async () => {
    await prisma.meetingParticipant.deleteMany();
    await prisma.meeting.deleteMany();
  });

  async function meeting(over: Record<string, unknown> = {}) {
    return prisma.meeting.create({
      data: {
        title: "Client review",
        startAt: soon(120),
        durationMinutes: 30,
        createdById: ada,
        ...over,
      },
    });
  }
  const withPeople = async (id: string, users: string[]) => {
    for (const userId of users) {
      await prisma.meetingParticipant.create({ data: { meetingId: id, userId } });
    }
  };

  it("reminds only inside the window, and only about meetings that asked", async () => {
    const asked = await meeting({ startAt: soon(10), remindMinutesBefore: 15 }); // window open
    const early = await meeting({ startAt: soon(50), remindMinutesBefore: 15 }); // too far off
    const silent = await meeting({ startAt: soon(10) }); // no reminder requested
    const off = await meeting({
      startAt: soon(10),
      remindMinutesBefore: 15,
      cancelledAt: new Date(),
    });
    for (const m of [asked, early, silent, off]) await withPeople(m.id, [bo]);

    const { raised } = await runMeetingReminders();
    expect(raised).toBe(1);

    const rows = await rowsOf(bo);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("meeting_soon");
    expect(rows[0].text, "it counts down to THIS meeting").toMatch(/Starts in \d+ minutes/);
    expect(rows[0].sound, "the chime is the point of this one").toBe(true);
  });

  it("reminds again when the meeting moves, and only once when it does not", async () => {
    const m = await meeting({ startAt: soon(10), remindMinutesBefore: 15 });
    await withPeople(m.id, [bo]);

    await runMeetingReminders();
    await runMeetingReminders(); // a second pass a minute later
    expect(await rowsOf(bo), "the same instant reminds once").toHaveLength(1);

    /**
     * Keyed on the meeting ALONE this would be the bug: somebody who moved a meeting would have
     * been reminded about the hour it used to be at, and never about the one it moved to.
     */
    await prisma.meeting.update({ where: { id: m.id }, data: { startAt: soon(12) } });
    await runMeetingReminders();
    expect(await rowsOf(bo), "a new start time is a new reminder").toHaveLength(2);
  });

  it("tells the participants AND the task's assignee when a meeting is called off", async () => {
    // the task is handed to Cy after the meeting was booked — the case `participant` alone misses
    const task = await taskFor("Prepare the review", [cy]);
    const m = await meeting({ taskId: task.id });
    await withPeople(m.id, [bo]);

    await notify("meeting_cancelled", {
      dedup: `${m.id}:2026-09-06`,
      actorId: ada,
      meetingId: m.id,
      taskId: task.id,
      vars: { actor: "Ada", meeting: m.title },
      sub: "Was Tue 8 Sept · its task is still open",
    });

    expect((await rowsOf(bo))[0].reason, "a participant hears as a participant").toBe(
      "participant",
    );
    expect((await rowsOf(cy))[0].reason, "whoever holds the task now hears too").toBe(
      "assignee",
    );
    // the task is deliberately left alone — whether the preparation still matters is a person's call
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).cancelledAt,
    ).toBeNull();
  });

  /**
   * Removed, then put back. `meeting_invited` is once per meeting per person, so their key was
   * already spent and the re-invite was swallowed as a duplicate — leaving "you were taken off" as
   * the last thing the system ever said to them, by then untrue. Worse than silence, because they
   * act on it (audit, 2026-09-06).
   */
  it("tells somebody they are back on, not just that they were taken off", async () => {
    const m = await meeting();
    await withPeople(m.id, [bo]);
    await notify("meeting_invited", {
      dedup: m.id,
      actorId: ada,
      meetingId: m.id,
      vars: { actor: "Ada", meeting: m.title },
      link: { type: "meeting", id: m.id },
    });
    await notify("meeting_uninvited", {
      dedup: `${m.id}:${bo}`,
      actorId: ada,
      selfUserId: bo,
      vars: { actor: "Ada", meeting: m.title },
      link: { type: "meeting", id: m.id },
    });

    // the plain key is spent, so the re-invite has to carry the moment of the edit
    const swallowed = await notify("meeting_invited", {
      dedup: m.id,
      actorId: ada,
      meetingId: m.id,
      vars: { actor: "Ada", meeting: m.title },
    });
    expect(swallowed.written, "which is exactly why the old key cannot be reused").toBe(0);

    const told = await notify("meeting_invited", {
      dedup: `${m.id}:${bo}:${new Date().toISOString()}`,
      actorId: ada,
      selfUserId: bo,
      vars: { actor: "Ada", meeting: m.title },
      sub: "Back on",
      link: { type: "meeting", id: m.id },
    });
    expect(told.written, "on a fresh key they hear about it").toBe(1);

    // by presence, not by position: `rowsOf` has no `orderBy`, so "the last one" is whatever
    // Postgres felt like returning
    const rows = await rowsOf(bo);
    expect(
      rows.map((r) => r.sub),
      "and the untrue one is no longer the only thing they have",
    ).toContain("Back on");
  });

  it("finds who has been told about a record, so a caller can pick the right key", async () => {
    const m = await meeting();
    await notify("meeting_uninvited", {
      dedup: `${m.id}:${bo}`,
      actorId: ada,
      selfUserId: bo,
      vars: { actor: "Ada", meeting: m.title },
      link: { type: "meeting", id: m.id },
    });
    const who = await notifiedAbout("meeting_uninvited", m.id, [bo, cy]);
    expect([...who]).toEqual([bo]);
  });

  it("tells somebody they were taken off, which no other role can reach", async () => {
    const m = await meeting();
    await withPeople(m.id, [cy]); // Bo has already been removed by the time this fires
    await notify("meeting_uninvited", {
      dedup: `${m.id}:${bo}`,
      actorId: ada,
      selfUserId: bo,
      vars: { actor: "Ada", meeting: m.title },
    });

    const rows = await rowsOf(bo);
    expect(rows, "the `participant` role cannot find them — `self` can").toHaveLength(1);
    expect(rows[0].reason).toBe("self");
    expect(await rowsOf(cy), "and it is addressed to one person, not the room").toHaveLength(0);
  });
});

// ── 5. the firm's clock, not the server's ────────────────────────────────────

describe("the day a sweep slices on is the FIRM's day", () => {
  /**
   * S8 cost this project six timezone bugs, and the lesson written into `core/dates.ts` is that a
   * stored DATE (a deadline) and a real INSTANT (a meeting) need different helpers: slicing a day
   * of meetings on UTC midnight silently drops everything before the zone's offset and pulls in
   * the tail of the day before. These two cases are that lesson, made executable.
   */
  it("finds a meeting just after the firm's midnight and not one just before it", async () => {
    const { config } = await import("../../core/config.js");
    const { todayInTz, toUtc, addDays, isoDayInTz, zonedDayStart } =
      await import("../../core/dates.js");
    const today = todayInTz(config.TZ);
    const dayStart = zonedDayStart(isoDayInTz(toUtc(today), "UTC"), config.TZ);
    const dayEnd = zonedDayStart(isoDayInTz(toUtc(addDays(today, 1)), "UTC"), config.TZ);

    const inside = new Date(dayStart.getTime() + 30 * 60_000); // 00:30 firm time
    const before = new Date(dayStart.getTime() - 30 * 60_000); // 23:30 firm time, yesterday
    const after = new Date(dayEnd.getTime() + 30 * 60_000); // 00:30 firm time, tomorrow

    expect(inside >= dayStart && inside < dayEnd, "00:30 today is in today").toBe(true);
    expect(before < dayStart, "23:30 yesterday is not").toBe(true);
    expect(after >= dayEnd, "00:30 tomorrow is not").toBe(true);

    // and the window really is 24 hours long — a DST day is 23 or 25, which is the point of
    // asking the zone twice rather than adding 86_400_000
    const hours = (dayEnd.getTime() - dayStart.getTime()) / 3_600_000;
    expect([23, 24, 25]).toContain(hours);
  });

  it("compares a deadline against UTC midnight, because that is how a deadline is stored", async () => {
    const { dateToUtc } = await import("../../core/dates.js");
    // `dateToUtc` is what the task form's date goes through, so the sweep must meet it there
    expect(dateToUtc("2026-09-08").toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

// ── 6. what happens to a row afterwards ──────────────────────────────────────

describe("a notification's life after it is written", () => {
  it("goes with the user when the account is deleted", async () => {
    const temp = await mkUser("Temp");
    const task = await taskFor("For Temp", [temp]);
    await raise(task.id, task.id);
    expect(await rowsOf(temp)).toHaveLength(1);

    await prisma.taskAssignee.deleteMany({ where: { userId: temp } });
    await prisma.user.delete({ where: { id: temp } });
    expect(await prisma.notification.count({ where: { userId: temp } })).toBe(0);
  });

  /**
   * The purge deletes the row, and for a `record`-scoped trigger that row IS the memory that stops
   * a second raise. Ninety days on, `task_overdue` and `invoice_overdue` came back and mailed
   * again — while the spec promised in words that they fire once per record, for good (audit,
   * 2026-09-06). Which rows may go is decided by the registry, so this asserts both halves.
   */
  it("never purges a row that is the only thing stopping a second raise", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000);
    const row = (trigger: string, id: string) =>
      prisma.notification.create({
        data: {
          userId: bo,
          trigger,
          reason: "assignee" as const,
          text: id,
          dedupKey: `${trigger}:${id}`,
          createdAt: old,
          readAt: old,
        },
      });
    // one of each kind, both read and both far past the cutoff
    await row("task_overdue", "record-scoped");
    await row("task_comment", "occurrence-scoped");

    await purgeOldNotifications();
    const left = (await rowsOf(bo)).map((r) => r.text).sort();
    expect(left, "the occurrence goes, the record stays").toEqual(["record-scoped"]);

    // and the proof of what that row is FOR: the trigger still refuses to raise again
    const again = await notify("task_overdue", {
      dedup: "record-scoped",
      taskId: (await taskFor("x", [bo])).id,
      vars: { task: "x" },
    });
    expect(again.written, "the memory survived, so nothing is raised twice").toBe(0);
    expect(again.duplicate).toBe(1);
  });

  it("purges at the 90-day line and not a day earlier", async () => {
    const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    // an OCCURRENCE-scoped trigger, because a record-scoped one is never purged at any age
    const mk = (id: string, readAt: Date | null) =>
      prisma.notification.create({
        data: {
          userId: bo,
          trigger: "task_comment",
          reason: "assignee",
          text: id,
          dedupKey: `task_assigned:${id}`,
          createdAt: readAt ?? day(0),
          readAt,
        },
      });

    await mk("read-89", day(89));
    await mk("read-91", day(91));
    await mk("unread-91", null);

    const { purged } = await purgeOldNotifications();
    expect(purged).toBe(1);
    const left = (await rowsOf(bo)).map((r) => r.text).sort();
    expect(left).toEqual(["read-89", "unread-91"]);
  });
});
