import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOTIFICATION_TRIGGERS, NOTIFICATION_TRIGGER_KEYS } from "@shared/notifications.js";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { recordSweepFailure, resetSweepFailures } from "../../core/sweep-health.js";
import { purgeOldNotifications, runNotificationSweep } from "./index.js";

/**
 * Notifications (S9), and mostly the four things that would be silently wrong:
 *
 * 1. **Precedence.** Two contours decide every send, and getting their order wrong is invisible —
 *    the notification simply does not arrive, or arrives for somebody who asked it not to.
 * 2. **Dedup.** `catchUp` re-runs sweeps on EVERY boot and the mail is sent only when the insert
 *    succeeds, so a nullable or a re-composed key would mail the whole firm on every deploy.
 *    That is the single riskiest line in the module, and it is tested by running a sweep twice.
 * 3. **Who is dropped.** The actor, and blocked users. Both are one line, both are load-bearing.
 * 4. **Registry ↔ policy.** The registry is the source; a seeded row with no entry, or an entry
 *    with no row, is drift the settings screens would render wrongly.
 */

const day = (offset: number): string => {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
};

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let mateCookie: string;
let adminId: string;
let mateId: string;
let blockedId: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}
const asAdmin = {
  get: (url: string) => app.inject({ method: "GET", url, headers: { cookie: adminCookie } }),
  post: (url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: adminCookie },
      payload: payload ?? {},
    }),
  patch: (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url, headers: { cookie: adminCookie }, payload }),
  put: (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url, headers: { cookie: adminCookie }, payload }),
};
const asMate = {
  get: (url: string) => app.inject({ method: "GET", url, headers: { cookie: mateCookie } }),
  post: (url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: mateCookie },
      payload: payload ?? {},
    }),
  put: (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url, headers: { cookie: mateCookie }, payload }),
};

async function wipe() {
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.meetingParticipant.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.taskComment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.subscriptionPeriod.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
}

const user = (firstName: string, over: Record<string, unknown> = {}) => ({
  firstName,
  lastName: "Tester",
  email: `${firstName.toLowerCase()}@notify.local`,
  passwordHash: undefined as unknown as string,
  role: "user" as const,
  status: "active" as const,
  ...over,
});

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await wipe();
  await prisma.user.deleteMany();
  await ensureBaseData(); // priorities, the fixed column, AND the sixteen policy rows

  const hash = await argon2.hash("password-123");
  adminId = (
    await prisma.user.create({
      data: { ...user("Ada", { role: "admin" }), passwordHash: hash },
    })
  ).id;
  mateId = (await prisma.user.create({ data: { ...user("Bo"), passwordHash: hash } })).id;
  blockedId = (
    await prisma.user.create({
      data: { ...user("Cy", { status: "blocked" }), passwordHash: hash },
    })
  ).id;

  adminCookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ada@notify.local", password: "password-123" },
    }),
  );
  mateCookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bo@notify.local", password: "password-123" },
    }),
  );
});

afterAll(async () => {
  await wipe();
  await app.close();
});

beforeEach(async () => {
  testOutbox.length = 0;
  resetSweepFailures();
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
});

/** Put every policy row back the way `ensureBaseData` seeded it, so cases cannot leak into each other. */
afterEach(async () => {
  for (const [trigger, spec] of Object.entries(NOTIFICATION_TRIGGERS)) {
    await prisma.notificationPolicy.update({
      where: { trigger },
      data: {
        enabled: true,
        mandatory: spec.mandatory,
        inApp: true,
        email: true,
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

const rowsFor = (userId: string, trigger?: string) =>
  prisma.notification.findMany({ where: { userId, ...(trigger ? { trigger } : {}) } });

/** A task the admin created with Bo on it — the shape most of these cases need. */
async function taskAssignedToMate(title = "Prepare the filing") {
  const res = await asAdmin.post("/api/tasks", {
    title,
    internal: true,
    assignees: [mateId],
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// ── the emitter ──────────────────────────────────────────────────────────────

describe("the emitter", () => {
  it("tells the assignee, and never the person who did it", async () => {
    await taskAssignedToMate();

    const mine = await rowsFor(mateId, "task_assigned");
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain("Ada Tester");
    expect(mine[0].reason).toBe("assignee");
    expect(mine[0].linkType).toBe("task");

    // Ada assigned it. Nobody is told about their own action, and there is no setting for that.
    expect(await rowsFor(adminId, "task_assigned")).toHaveLength(0);
  });

  it("writes nothing for a blocked user", async () => {
    await asAdmin.post("/api/tasks", {
      title: "For someone cut off",
      internal: true,
      assignees: [blockedId],
    });
    expect(await rowsFor(blockedId)).toHaveLength(0);
  });

  it("resolves `participant` from who has already written in the thread", async () => {
    // BO creates the task and takes it himself, so he is both its author and its assignee. Ada
    // then comments, which is the only thing that makes her a participant — she is neither the
    // author nor an assignee, so `participant` is the only role that can reach her.
    const created = await asMate.post("/api/tasks", {
      title: "Bo's own work",
      internal: true,
      assignees: [mateId],
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;
    await asAdmin.post(`/api/tasks/${taskId}/comments`, { body: "Any progress?" });
    await prisma.notification.deleteMany();

    await asMate.post(`/api/tasks/${taskId}/comments`, { body: "Filed this morning." });

    const ada = await rowsFor(adminId, "task_comment");
    expect(ada).toHaveLength(1);
    expect(ada[0].reason).toBe("participant");
    expect(ada[0].sub).toBe("Filed this morning.");
    expect(await rowsFor(mateId, "task_comment")).toHaveLength(0); // Bo wrote it
  });

  it("keeps the FIRST role that matched, in the registry's order", async () => {
    // Ada is the author AND a participant. `task_comment` declares assignee, author, participant,
    // so she is notified as the author — which is what makes "assigned but not merely mentioned"
    // expressible at all.
    const taskId = await taskAssignedToMate();
    await asAdmin.post(`/api/tasks/${taskId}/comments`, { body: "Kicking off." });
    await prisma.notification.deleteMany();

    await asMate.post(`/api/tasks/${taskId}/comments`, { body: "Done." });
    expect((await rowsFor(adminId, "task_comment"))[0].reason).toBe("author");
  });

  it("writes no row when the author is null, and does not treat that as an error", async () => {
    // a GENERATED task has no creator ("generated tasks stay null"), so `task_done` — whose only
    // recipient role is `author` — has nobody to tell
    const priority = await prisma.priority.findFirst({ where: { isDefault: true } });
    const column = await prisma.taskColumn.findFirst({ where: { isFixed: true } });
    const task = await prisma.task.create({
      data: {
        title: "Generated work",
        kind: "free",
        priorityId: priority!.id,
        statusColumnId: column!.id,
        createdById: null,
      },
    });

    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      headers: { cookie: mateCookie },
      payload: { done: true },
    });
    expect(done.statusCode).toBe(200);
    expect(await prisma.notification.count({ where: { trigger: "task_done" } })).toBe(0);
  });

  it("raises nothing at all when the policy is off", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { enabled: false },
    });
    await taskAssignedToMate();
    expect(await rowsFor(mateId, "task_assigned")).toHaveLength(0);
  });
});

// ── precedence ───────────────────────────────────────────────────────────────

describe("precedence", () => {
  const wants = (trigger: string, channel: "in_app" | "email", enabled: boolean | null) =>
    asMate.put("/api/notifications/preferences", {
      changes: [{ trigger, channel, enabled }],
    });

  it("a policy that is off beats a personal on", async () => {
    await wants("task_assigned", "in_app", true);
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { enabled: false },
    });

    await taskAssignedToMate();
    expect(await rowsFor(mateId, "task_assigned")).toHaveLength(0);
  });

  it("mandatory beats a personal off", async () => {
    await wants("task_assigned", "in_app", false);
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { mandatory: true },
    });

    await taskAssignedToMate();
    expect(await rowsFor(mateId, "task_assigned")).toHaveLength(1);
  });

  it("an absent preference follows the policy default", async () => {
    // no rows written at all — which is the whole design: changing the default later reaches
    // everyone who never made a choice
    expect(await prisma.notificationPreference.count({ where: { userId: mateId } })).toBe(0);

    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultInApp: false, defaultEmail: false },
    });
    await taskAssignedToMate();
    expect(await rowsFor(mateId, "task_assigned")).toHaveLength(0);
  });

  it("a channel the policy disallows cannot be turned on personally", async () => {
    await wants("task_assigned", "email", true);
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { email: false },
    });

    await taskAssignedToMate();
    expect(await rowsFor(mateId, "task_assigned")).toHaveLength(1); // the bell still rings
    expect(testOutbox.filter((m) => m.to === "bo@notify.local")).toHaveLength(0);
  });

  it("`follow the default` is stored as the ABSENCE of a row", async () => {
    await wants("task_comment", "email", true);
    expect(
      await prisma.notificationPreference.count({
        where: { userId: mateId, trigger: "task_comment", channel: "email" },
      }),
    ).toBe(1);

    const res = await wants("task_comment", "email", null);
    expect(res.statusCode).toBe(200);
    expect(
      await prisma.notificationPreference.count({
        where: { userId: mateId, trigger: "task_comment", channel: "email" },
      }),
    ).toBe(0);
  });
});

// ── email ────────────────────────────────────────────────────────────────────

describe("email", () => {
  it("mails only when the row was written, and stamps when it did", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { defaultEmail: true },
    });
    await taskAssignedToMate("Quarterly VAT");

    const letters = testOutbox.filter((m) => m.to === "bo@notify.local");
    expect(letters).toHaveLength(1);
    expect(letters[0].subject).toContain("Quarterly VAT");
    // the client brand shell is for CLIENTS: a staff letter carries no unsubscribe link
    expect(letters[0].html).not.toContain("/unsubscribe/");

    const [row] = await rowsFor(mateId, "task_assigned");
    expect(await mailedAt(row.id)).not.toBeNull();
  });
});

// ── the sweep, and the reason dedupKey is NOT NULL ───────────────────────────

describe("the sweep", () => {
  it("raises a deadline warning once, however often it runs", async () => {
    const taskId = await taskAssignedToMate("Due tomorrow");
    await prisma.task.update({
      where: { id: taskId },
      data: { deadline: new Date(`${day(1)}T00:00:00.000Z`) },
    });
    await prisma.notification.deleteMany();

    const first = await runNotificationSweep();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    expect(await rowsFor(mateId, "task_deadline_near")).toHaveLength(1);
    const mailsAfterFirst = testOutbox.length;

    /**
     * The second run is the one that matters. `catchUp` re-runs sweeps on EVERY boot, and mail is
     * sent only when the insert succeeds — so a key that was nullable, or composed at the call
     * site, would mail the whole firm on every deploy. This is that guard.
     */
    const second = await runNotificationSweep();
    expect(second.raised).toBe(0);
    expect(await rowsFor(mateId, "task_deadline_near")).toHaveLength(1);
    expect(testOutbox).toHaveLength(mailsAfterFirst);
  });

  it("raises an overdue warning once per task, ever", async () => {
    const taskId = await taskAssignedToMate("Late one");
    await prisma.task.update({
      where: { id: taskId },
      data: { deadline: new Date(`${day(-3)}T00:00:00.000Z`) },
    });
    await prisma.notification.deleteMany();

    await runNotificationSweep();
    await runNotificationSweep();
    expect(await rowsFor(mateId, "task_overdue")).toHaveLength(1);
  });

  it("tells the firm when a generating sweep skipped work", async () => {
    recordSweepFailure("period-invoice-generation", 3);
    await runNotificationSweep();

    const [row] = await rowsFor(adminId, "ops_sweep_failed");
    expect(row.text).toContain("period-invoice-generation");
    expect(row.sub).toContain("3 items skipped");

    // drained, not read: one bad night is reported once, and the next report only happens if a
    // sweep fails again
    await prisma.notification.deleteMany();
    await runNotificationSweep();
    expect(await rowsFor(adminId, "ops_sweep_failed")).toHaveLength(0);
  });

  it("names a broken mailbox, and stops repeating itself while the error is the same", async () => {
    await prisma.mailSenderAccount.updateMany({ data: { bounceError: "Invalid credentials" } });
    try {
      await runNotificationSweep();
      expect(await rowsFor(adminId, "ops_mailbox_broken")).toHaveLength(1);
      await runNotificationSweep();
      expect(await rowsFor(adminId, "ops_mailbox_broken")).toHaveLength(1);
    } finally {
      await prisma.mailSenderAccount.updateMany({ data: { bounceError: null } });
    }
  });
});

// ── the tray ─────────────────────────────────────────────────────────────────

describe("the tray", () => {
  it("counts every unread row, not just the page it renders", async () => {
    await taskAssignedToMate("One");
    await taskAssignedToMate("Two");

    const res = await asMate.get("/api/notifications");
    expect(res.statusCode).toBe(200);
    expect(res.json().unread).toBe(2);
    expect(res.json().items).toHaveLength(2);
  });

  /**
   * The failure this guards was not hypothetical: the first production forecast (2026-09-06)
   * showed one admin waking to 24 unread, of which the tray could render 20 and no screen could
   * reach the other four.
   */
  it("pages past the first twenty instead of hiding them", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      userId: mateId,
      trigger: "task_assigned",
      reason: "assignee" as const,
      text: `row ${i}`,
      dedupKey: `task_assigned:page-${i}`,
      createdAt: new Date(Date.now() - i * 60_000),
    }));
    await prisma.notification.createMany({ data: many });

    const first = (await asMate.get("/api/notifications")).json();
    expect(first.unread).toBe(25);
    expect(first.items).toHaveLength(20);

    const more = (await asMate.get("/api/notifications?limit=40")).json();
    expect(more.items, "every unread row is reachable").toHaveLength(25);
    // newest first, still
    expect(more.items[0].text).toBe("row 0");
    expect(more.items[24].text).toBe("row 24");

    // and a hand-written limit cannot ask for the table
    const huge = await asMate.get("/api/notifications?limit=99999");
    expect(huge.statusCode, "an out-of-range limit is refused").toBe(400);
  });

  it("dismissing stamps the row read instead of destroying it", async () => {
    await taskAssignedToMate();
    const [row] = await rowsFor(mateId);

    const res = await asMate.post(`/api/notifications/${row.id}/read`);
    expect(res.statusCode).toBe(200);

    const after = await prisma.notification.findUnique({ where: { id: row.id } });
    expect(after).not.toBeNull(); // the prototype REMOVES it; we keep it and hide it
    expect(after!.readAt).not.toBeNull();
    expect((await asMate.get("/api/notifications")).json().unread).toBe(0);
  });

  it("never hands one person another person's tray", async () => {
    await taskAssignedToMate();
    const [row] = await rowsFor(mateId);

    // Ada is an admin, and it makes no difference: there is no userId anywhere in this API
    const res = await asAdmin.post(`/api/notifications/${row.id}/read`);
    expect(res.statusCode).toBe(404);
    expect(
      (await prisma.notification.findUnique({ where: { id: row.id } }))!.readAt,
    ).toBeNull();
  });
});

// ── retention ────────────────────────────────────────────────────────────────

describe("retention", () => {
  it("purges a read row after 90 days and keeps an unread one of the same age", async () => {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const read = await prisma.notification.create({
      data: {
        userId: mateId,
        // occurrence-scoped: a record-scoped row is never purged, whatever its age (S9 §19)
        trigger: "task_comment",
        reason: "participant",
        text: "Old and seen",
        dedupKey: "task_comment:old-read",
        createdAt: old,
        readAt: old,
      },
    });
    const unread = await prisma.notification.create({
      data: {
        userId: mateId,
        trigger: "task_comment",
        reason: "participant",
        text: "Old and never seen",
        dedupKey: "task_comment:old-unread",
        createdAt: old,
      },
    });

    const { purged } = await purgeOldNotifications();
    expect(purged).toBe(1);
    expect(await prisma.notification.findUnique({ where: { id: read.id } })).toBeNull();
    // a notification nobody has seen has not done its job yet, at any age
    expect(await prisma.notification.findUnique({ where: { id: unread.id } })).not.toBeNull();
  });
});

// ── the registry is the source ───────────────────────────────────────────────

describe("the registry and the policy table cannot drift", () => {
  it("every registry key has a seeded row, and every row has a registry key", async () => {
    await ensureBaseData();
    const seeded = (await prisma.notificationPolicy.findMany()).map((p) => p.trigger).sort();
    expect(seeded).toEqual([...NOTIFICATION_TRIGGER_KEYS].sort());
  });

  /**
   * The failure this catches was real and silent (2026-09-05): the registry's recipients for
   * `ops_mailout_errors` were corrected during the build, every existing database kept the old
   * `["custom"]`, and the trigger then sat enabled on the Settings screen reaching nobody —
   * because `customUserIds` is empty by default. Nothing anywhere said so.
   */
  it("keeps every policy's recipients equal to the registry, on every boot", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_assigned" },
      data: { roles: ["custom"] }, // as a stale seed, or a hand edit, would leave it
    });
    await ensureBaseData();

    for (const [trigger, spec] of Object.entries(NOTIFICATION_TRIGGERS)) {
      const row = await prisma.notificationPolicy.findUniqueOrThrow({ where: { trigger } });
      expect(row.roles, `${trigger} drifted from the registry`).toEqual(spec.defaultRecipients);
    }
  });

  /**
   * The trap this catches bit twice in one day (2026-09-05/06).
   *
   * `ensureBaseData` deliberately does not overwrite a policy row's defaults — they are the
   * firm's from the moment they are first written. The consequence, which nothing announced, is
   * that a NEW FIELD in the registry reaches new installs only: `defaultSound` was added with a
   * column default of `false`, and on every already-seeded database the chime would simply never
   * have rung. Bringing existing rows to the state a fresh install would have is a MIGRATION's
   * job, and this case is what says so if it is ever forgotten again.
   *
   * It asserts against a freshly seeded row, so it proves the registry→database path; the
   * migration is what carries the same values to a database that already had the row.
   */
  it("seeds every default from the registry, field by field", async () => {
    await prisma.notificationPolicy.deleteMany({ where: { trigger: "task_assigned" } });
    await ensureBaseData();

    const spec = NOTIFICATION_TRIGGERS.task_assigned;
    const row = await prisma.notificationPolicy.findUniqueOrThrow({
      where: { trigger: "task_assigned" },
    });
    expect({
      roles: row.roles,
      defaultInApp: row.defaultInApp,
      defaultEmail: row.defaultEmail,
      defaultSound: row.defaultSound,
      mandatory: row.mandatory,
    }).toEqual({
      roles: spec.defaultRecipients,
      defaultInApp: spec.defaultInApp,
      defaultEmail: spec.defaultEmail,
      defaultSound: spec.defaultSound,
      mandatory: spec.mandatory,
    });
  });

  it("re-seeding never overwrites what the firm changed", async () => {
    await prisma.notificationPolicy.update({
      where: { trigger: "task_comment" },
      data: { enabled: false },
    });
    await ensureBaseData(); // as every boot does

    const row = await prisma.notificationPolicy.findUnique({
      where: { trigger: "task_comment" },
    });
    expect(row!.enabled).toBe(false);
  });

  it("only an admin may change the firm's policy", async () => {
    expect((await asMate.get("/api/notifications/policies")).statusCode).toBe(403);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/policies/task_assigned",
      headers: { cookie: mateCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an unknown trigger is a 404, not a new row", async () => {
    const res = await asAdmin.patch("/api/notifications/policies/not_a_trigger", {
      enabled: false,
    });
    expect(res.statusCode).toBe(404);
    expect(await prisma.notificationPolicy.count()).toBe(NOTIFICATION_TRIGGER_KEYS.length);
  });
});
