import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";

/**
 * The calendar (S8), and mainly the two things that are easy to get quietly wrong:
 *
 * 1. **Where the conflict boundary sits.** Back-to-back meetings must not warn, or the warning
 *    fires all day and stops being read. One shared minute must warn.
 * 2. **What a meeting's task actually is.** It goes through the tasks module's own `createTask`,
 *    so an internal one bills nothing and a one-time service still issues its invoice — the same
 *    behaviour as a hand-made task, because it is the same code path.
 */

const day = (offset: number): string => {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
};
/** An instant on a given day, in UTC — the clock the whole app stores business time on. */
const at = (dayIso: string, hhmm: string) => `${dayIso}T${hhmm}:00.000Z`;

/**
 * A wall-clock reading IN THE FIRM'S ZONE → the instant it names.
 *
 * Needed wherever a test cares which side of midnight something falls on. Hardcoding an offset
 * (`+03:00`) bakes one particular firm into the test, and the whole point of these cases is that
 * the code reads the configured zone rather than assuming one.
 */
function firmInstant(dayIso: string, hhmm: string): string {
  const guess = new Date(`${dayIso}T${hhmm}:00.000Z`);
  const offset = (probe: Date) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: config.TZ,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(probe);
    const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) -
      Math.floor(probe.getTime() / 60_000) * 60_000;
  };
  const first = new Date(guess.getTime() - offset(guess));
  return new Date(guess.getTime() - offset(first)).toISOString();
}

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let adminId: string;
let mateId: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}
const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload: payload ?? {} });
const patch = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

async function wipe() {
  await prisma.meetingParticipant.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.subscriptionPeriod.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await wipe();
  await prisma.user.deleteMany();

  const admin = await prisma.user.create({
    data: {
      firstName: "Cal",
      lastName: "Admin",
      email: "admin@calendar.local",
      passwordHash: await argon2.hash("password-123"),
      role: "admin",
      status: "active",
    },
  });
  adminId = admin.id;
  const mate = await prisma.user.create({
    data: {
      firstName: "Team",
      lastName: "Mate",
      email: "mate@calendar.local",
      passwordHash: await argon2.hash("password-123"),
      role: "user",
      status: "active",
    },
  });
  mateId = mate.id;

  cookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@calendar.local", password: "password-123" },
    }),
  );
});

afterAll(async () => {
  await wipe();
  await app.close();
});

const makeClient = async (firstName: string) => {
  const res = await post("/api/clients", { firstName, companies: [], people: [] });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};

describe("meetings — booking", () => {
  it("creates a meeting and puts the organiser in the room", async () => {
    const res = await post("/api/calendar/meetings", {
      title: "Kick-off",
      startAt: at(day(3), "10:00"),
      durationMinutes: 60,
      participantIds: [mateId],
    });
    expect(res.statusCode).toBe(201);
    const m = res.json();
    // the booker is in their own diary — left out, they would be invisible to their own clash check
    expect(m.participantIds.sort()).toEqual([adminId, mateId].sort());
    expect(m.createdById).toBe(adminId);
    expect(m.taskId).toBeNull();
  });

  it("refuses a meeting aimed at a client AND a lead", async () => {
    const clientId = await makeClient("Both");
    const lead = await post("/api/leads", { name: "Both lead" });
    const res = await post("/api/calendar/meetings", {
      title: "Confused",
      clientId,
      leadId: lead.json().id,
      startAt: at(day(3), "12:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an archived client", async () => {
    const clientId = await makeClient("Gone");
    await post(`/api/clients/${clientId}/archive`);
    const res = await post("/api/calendar/meetings", {
      title: "Too late",
      clientId,
      startAt: at(day(3), "13:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it("cancelling takes it off the calendar, and un-cancelling puts it back", async () => {
    const created = await post("/api/calendar/meetings", {
      title: "Might not happen",
      startAt: at(day(4), "09:00"),
      durationMinutes: 30,
    });
    const id = created.json().id;
    const onCalendar = async () =>
      (await get(`/api/calendar?from=${day(4)}&to=${day(5)}`)).json().meetings.map(
        (m: { id: string }) => m.id,
      );

    expect(await onCalendar()).toContain(id);
    expect((await patch(`/api/calendar/meetings/${id}`, { cancelled: true })).statusCode).toBe(200);
    expect(await onCalendar()).not.toContain(id);

    // one row, not two: a meeting called off and put back on is the same meeting
    await patch(`/api/calendar/meetings/${id}`, { cancelled: false });
    expect(await onCalendar()).toContain(id);
  });
});

describe("meetings — who can be booked with", () => {
  /**
   * The meeting form first fed its picker from the tasks BOARD FILTER list, which is scoped to
   * clients and leads that already have work — right for a filter, useless as a picker. A brand
   * new lead simply could not be chosen (user, 2026-08-06).
   *
   * The API never had that restriction, so this pins the contract the picker now relies on: a lead
   * or client with no tasks at all is a perfectly good meeting target.
   */
  it("books a meeting with a lead that has no tasks whatsoever", async () => {
    const lead = await post("/api/leads", { name: "Fresh lead, no work yet" });
    const leadId = lead.json().id as string;
    expect(await prisma.task.count({ where: { leadId } })).toBe(0);

    const res = await post("/api/calendar/meetings", {
      title: "First conversation",
      leadId,
      startAt: at(day(5), "10:00"),
      durationMinutes: 15,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ leadId, leadName: "Fresh lead, no work yet" });
  });

  it("books a meeting with a client that has no tasks whatsoever", async () => {
    const id = await makeClient("Untouched");
    expect(await prisma.task.count({ where: { clientId: id } })).toBe(0);

    const res = await post("/api/calendar/meetings", {
      title: "Intro call",
      clientId: id,
      startAt: at(day(5), "11:00"),
      durationMinutes: 15,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().clientName).toBe("Untouched");
  });
});

describe("meetings — the conflict boundary", () => {
  let baseId: string;

  it("sets up a 10:00–11:00 meeting for two people", async () => {
    const res = await post("/api/calendar/meetings", {
      title: "The one in the way",
      startAt: at(day(7), "10:00"),
      durationMinutes: 60,
      participantIds: [mateId],
    });
    baseId = res.json().id;
    expect(res.statusCode).toBe(201);
  });

  const conflicts = async (hhmm: string, minutes: number, users = [mateId], exclude?: string) => {
    const q = new URLSearchParams({
      startAt: at(day(7), hhmm),
      durationMinutes: String(minutes),
      userIds: users.join(","),
      ...(exclude ? { excludeMeetingId: exclude } : {}),
    });
    const res = await get(`/api/calendar/conflicts?${q}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("does NOT warn about a meeting starting the moment the last one ends", async () => {
    expect(await conflicts("11:00", 60)).toEqual([]);
    expect(await conflicts("09:00", 60)).toEqual([]); // and ending exactly as it starts
  });

  it("warns about one shared minute, naming who is busy", async () => {
    const clash = await conflicts("10:59", 30);
    expect(clash).toHaveLength(1);
    expect(clash[0]).toMatchObject({ meetingId: baseId, title: "The one in the way" });
    expect(clash[0].userIds).toEqual([mateId]);
  });

  it("warns about a meeting swallowed by a longer one", async () => {
    expect(await conflicts("10:15", 15)).toHaveLength(1);
  });

  it("says nothing when the busy person is not invited", async () => {
    expect(await conflicts("10:15", 15, [adminId])).toHaveLength(1); // the organiser IS in it
    const alone = await prisma.user.create({
      data: {
        firstName: "Not",
        lastName: "Invited",
        email: "spare@calendar.local",
        passwordHash: await argon2.hash("x"),
        role: "user",
        status: "active",
      },
    });
    expect(await conflicts("10:15", 15, [alone.id])).toEqual([]);
  });

  it("does not report a meeting as clashing with itself while it is being edited", async () => {
    expect(await conflicts("10:00", 60, [mateId])).toHaveLength(1);
    expect(await conflicts("10:00", 60, [mateId], baseId)).toEqual([]);
  });

  it("catches a meeting that STARTED before the window and is still running", async () => {
    // the SQL narrows on startAt, so a long meeting already in progress is the case that a naive
    // "starts inside the window" query silently misses
    await post("/api/calendar/meetings", {
      title: "The long one",
      startAt: at(day(7), "14:00"),
      durationMinutes: 240, // 14:00–18:00
      participantIds: [mateId],
    });
    const clash = await conflicts("17:00", 30);
    expect(clash.map((c: { title: string }) => c.title)).toContain("The long one");
  });

  it("ignores a cancelled meeting", async () => {
    await patch(`/api/calendar/meetings/${baseId}`, { cancelled: true });
    expect(await conflicts("10:15", 15)).toEqual([]);
    await patch(`/api/calendar/meetings/${baseId}`, { cancelled: false });
  });
});

describe("meetings — the task opened alongside", () => {
  let clientId: string;
  let subscriptionId: string;
  let oneTimeSubId: string;

  it("sets up a client with a subscription service and a one-time service", async () => {
    clientId = await makeClient("Bookable");
    const sub = await post("/api/catalog", { name: "Cal Bookkeeping", type: "subscription" });
    const once = await post("/api/catalog", {
      name: "Cal Consultation",
      type: "one_time",
      defaultAmount: 50_000,
      invoiceTrigger: "on_create",
    });
    const a = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId: sub.json().id,
      amount: 20_000,
      period: "month",
    });
    const b = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId: once.json().id,
      amount: 50_000,
      period: "month",
    });
    subscriptionId = a.json().subscriptions.find(
      (s: { serviceId: string }) => s.serviceId === sub.json().id,
    ).id;
    oneTimeSubId = b.json().subscriptions.find(
      (s: { serviceId: string }) => s.serviceId === once.json().id,
    ).id;
    expect(subscriptionId).toBeTruthy();
    expect(oneTimeSubId).toBeTruthy();
  });

  it("internal mode: attributes the time to the client and bills nothing", async () => {
    const res = await post("/api/calendar/meetings", {
      title: "Quarterly catch-up",
      clientId,
      startAt: at(day(9), "11:00"),
      durationMinutes: 45,
      participantIds: [mateId],
      task: { mode: "internal" },
    });
    expect(res.statusCode).toBe(201);
    const meeting = res.json();
    expect(meeting.taskId).toBeTruthy();

    const task = (await get(`/api/tasks/${meeting.taskId}`)).json();
    expect(task).toMatchObject({
      kind: "free", // firm time — never billable
      clientId, // but still attributed, so it shows on their card
      subscriptionId: null,
      invoice: null,
      amount: null,
    });
    // organiser + everyone invited, exactly as agreed
    expect(task.assignees.sort()).toEqual([adminId, mateId].sort());
    expect(task.deadline.slice(0, 10)).toBe(day(9));
    expect(task.plannedMinutes).toBe(45);
  });

  it("service mode on a ONE-TIME service issues its invoice, like any other client job", async () => {
    const invoicesBefore = await prisma.invoice.count();
    const res = await post("/api/calendar/meetings", {
      title: "Paid consultation",
      clientId,
      startAt: at(day(9), "15:00"),
      durationMinutes: 60,
      task: { mode: "service", subscriptionId: oneTimeSubId },
    });
    expect(res.statusCode).toBe(201);

    const task = (await get(`/api/tasks/${res.json().taskId}`)).json();
    expect(task.kind).toBe("once");
    expect(task.subscriptionId).toBe(oneTimeSubId);
    expect(task.amount).toBe(50_000);
    // the trigger is the service's, not the calendar's — the meeting changed nothing about billing
    expect(task.invoice).not.toBeNull();
    expect(await prisma.invoice.count()).toBe(invoicesBefore + 1);
  });

  it("service mode on a SUBSCRIPTION service is included work — no charge", async () => {
    const res = await post("/api/calendar/meetings", {
      title: "Included review",
      clientId,
      startAt: at(day(10), "10:00"),
      durationMinutes: 30,
      task: { mode: "service", subscriptionId },
    });
    const task = (await get(`/api/tasks/${res.json().taskId}`)).json();
    expect(task).toMatchObject({ kind: "free", subscriptionId, invoice: null });
  });

  it("refuses service mode without a client, or without a service", async () => {
    const noClient = await post("/api/calendar/meetings", {
      title: "Internal but billed?",
      startAt: at(day(10), "12:00"),
      durationMinutes: 30,
      task: { mode: "service", subscriptionId },
    });
    expect(noClient.statusCode).toBe(400);

    const noSub = await post("/api/calendar/meetings", {
      title: "Which service?",
      clientId,
      startAt: at(day(10), "13:00"),
      durationMinutes: 30,
      task: { mode: "service" },
    });
    expect(noSub.statusCode).toBe(400);
  });

  it("a lead's meeting can open a task, and it is free work", async () => {
    const lead = await post("/api/leads", { name: "Prospect with a call" });
    const res = await post("/api/calendar/meetings", {
      title: "Discovery call",
      leadId: lead.json().id,
      startAt: at(day(11), "09:30"),
      durationMinutes: 30,
      task: { mode: "internal" },
    });
    expect(res.statusCode).toBe(201);
    const task = (await get(`/api/tasks/${res.json().taskId}`)).json();
    expect(task).toMatchObject({ kind: "free", leadId: lead.json().id, clientId: null });
  });

  it("dates the task by the meeting's day IN THE FIRM'S ZONE, not UTC's", async () => {
    /**
     * Reading the day off the UTC clock shifts it by one — but WHICH end of the day breaks depends
     * on which side of UTC the firm sits, so both are checked and one of them is always the case
     * that bites:
     *
     *   east of UTC (Europe/Kyiv, +03:00) → 00:30 local is the PREVIOUS day in UTC
     *   west of UTC (America/New_York, −04:00) → 23:30 local is the NEXT day in UTC
     *
     * Testing only the morning was how this test quietly stopped protecting anything the moment
     * the firm moved from Kyiv to New York (2026-08-06).
     */
    for (const [hhmm, label] of [
      ["00:30", "just after midnight"],
      ["23:30", "just before midnight"],
    ] as const) {
      const res = await post("/api/calendar/meetings", {
        title: `Meeting ${label}`,
        clientId,
        startAt: firmInstant(day(12), hhmm),
        durationMinutes: 30,
        task: { mode: "internal" },
      });
      expect(res.statusCode).toBe(201);

      const task = (await get(`/api/tasks/${res.json().taskId}`)).json();
      expect(`${label}: ${task.deadline.slice(0, 10)}`).toBe(`${label}: ${day(12)}`);

      // …and the meeting itself lands on that same day on the calendar, so the two agree
      const cal = (await get(`/api/calendar?from=${day(12)}&to=${day(13)}`)).json();
      expect(cal.meetings.map((m: { id: string }) => m.id)).toContain(res.json().id);
    }
  });

  it("no task at all when none was asked for", async () => {
    const res = await post("/api/calendar/meetings", {
      title: "Just a chat",
      clientId,
      startAt: at(day(11), "16:00"),
      durationMinutes: 30,
    });
    expect(res.json().taskId).toBeNull();
  });
});

describe("meetings — edges found by probing the live module (2026-08-06)", () => {
  it("lets the organiser step out of a meeting they arranged for other people", async () => {
    const created = await post("/api/calendar/meetings", {
      title: "Booked for the others",
      startAt: at(day(14), "09:00"),
      durationMinutes: 60,
      participantIds: [mateId],
    });
    const id = created.json().id as string;
    // created FOR them, so the organiser is added by default…
    expect(created.json().participantIds).toContain(adminId);

    // …but the edit takes the list exactly as sent. Someone who arranges a meeting and does not
    // attend must be able to leave it; the organiser used to be forced back in every save.
    const edited = await patch(`/api/calendar/meetings/${id}`, { participantIds: [mateId] });
    expect(edited.json().participantIds).toEqual([mateId]);
  });

  it("moves the task's deadline when the meeting moves, and leaves the estimate alone", async () => {
    const clientId = await makeClient("Reschedule");
    const created = await post("/api/calendar/meetings", {
      title: "Will be moved",
      clientId,
      startAt: at(day(14), "10:00"),
      durationMinutes: 60,
      task: { mode: "internal" },
    });
    const taskId = created.json().taskId as string;
    expect((await get(`/api/tasks/${taskId}`)).json().deadline.slice(0, 10)).toBe(day(14));

    await patch(`/api/calendar/meetings/${created.json().id}`, {
      startAt: at(day(35), "10:00"),
      durationMinutes: 90,
    });

    const task = (await get(`/api/tasks/${taskId}`)).json();
    // the deadline is DERIVED — "the day of the meeting" — so it follows
    expect(task.deadline.slice(0, 10)).toBe(day(35));
    // the planned time is an ESTIMATE that belongs to the task; a meeting slipping must not
    // silently overwrite a person's own figure
    expect(task.plannedMinutes).toBe(60);
  });

  it("takes an archived client's meetings off the calendar, like their tasks", async () => {
    const clientId = await makeClient("Meets then goes");
    const created = await post("/api/calendar/meetings", {
      title: "With a client about to be archived",
      clientId,
      startAt: at(day(15), "11:00"),
      durationMinutes: 30,
      participantIds: [mateId],
    });
    const id = created.json().id as string;
    const onCalendar = async () =>
      (await get(`/api/calendar?from=${day(15)}&to=${day(16)}`)).json().meetings.map(
        (m: { id: string }) => m.id,
      );
    const clashes = async () =>
      (
        await get(
          `/api/calendar/conflicts?startAt=${at(day(15), "11:15")}&durationMinutes=15&userIds=${mateId}`,
        )
      ).json();

    expect(await onCalendar()).toContain(id);
    expect(await clashes()).toHaveLength(1);

    await post(`/api/clients/${clientId}/archive`);

    // half the relationship vanishing and half staying is worse than either
    expect(await onCalendar()).not.toContain(id);
    // and it no longer holds anyone's time, because it is no longer a meeting anybody will attend
    expect(await clashes()).toEqual([]);
  });

  it("takes an archived lead's meetings off the calendar too", async () => {
    const lead = await post("/api/leads", { name: "Meets then archived" });
    const leadId = lead.json().id as string;
    const created = await post("/api/calendar/meetings", {
      title: "With a lead about to be archived",
      leadId,
      startAt: at(day(16), "12:00"),
      durationMinutes: 30,
    });
    const onCalendar = async () =>
      (await get(`/api/calendar?from=${day(16)}&to=${day(17)}`)).json().meetings.map(
        (m: { id: string }) => m.id,
      );

    expect(await onCalendar()).toContain(created.json().id);
    await post(`/api/leads/${leadId}/archive`);
    expect(await onCalendar()).not.toContain(created.json().id);
  });

  it("survives its task being deleted, and takes a new one", async () => {
    const clientId = await makeClient("Task deleted");
    const created = await post("/api/calendar/meetings", {
      title: "Its task will be deleted",
      clientId,
      startAt: at(day(17), "13:00"),
      durationMinutes: 30,
      task: { mode: "internal" },
    });
    const id = created.json().id as string;
    await prisma.task.delete({ where: { id: created.json().taskId } });

    // SetNull, not Cascade: losing the task must not lose the record of the meeting
    expect((await get(`/api/calendar/meetings/${id}`)).json().taskId).toBeNull();
    const again = await patch(`/api/calendar/meetings/${id}`, { task: { mode: "internal" } });
    expect(again.json().taskId).toBeTruthy();
  });
});

describe("calendar — the two lanes", () => {
  it("returns meetings and projected deadlines for the window, and honours the lane chips", async () => {
    const clientId = await makeClient("Laned");
    await post("/api/tasks", {
      title: "Deadline in the window",
      clientId,
      internal: true,
      deadline: day(20),
      assignees: [adminId],
    });
    await post("/api/calendar/meetings", {
      title: "Meeting in the window",
      startAt: at(day(20), "10:00"),
      durationMinutes: 30,
    });

    const both = (await get(`/api/calendar?from=${day(20)}&to=${day(21)}`)).json();
    expect(both.meetings).toHaveLength(1);
    expect(both.deadlines).toHaveLength(1);
    expect(both.deadlines[0]).toMatchObject({ day: day(20), overdue: false });

    const onlyMeetings = (
      await get(`/api/calendar?from=${day(20)}&to=${day(21)}&deadlines=false`)
    ).json();
    expect(onlyMeetings.deadlines).toEqual([]);
    expect(onlyMeetings.meetings).toHaveLength(1);

    const onlyDeadlines = (
      await get(`/api/calendar?from=${day(20)}&to=${day(21)}&meetings=false`)
    ).json();
    expect(onlyDeadlines.meetings).toEqual([]);
    expect(onlyDeadlines.deadlines).toHaveLength(1);
  });

  it("projects only OPEN work — done, cancelled and archived tasks stay off the calendar", async () => {
    const clientId = await makeClient("Filtered");
    const mk = async (title: string) =>
      (
        await post("/api/tasks", {
          title,
          clientId,
          internal: true,
          deadline: day(21),
          assignees: [],
        })
      ).json().id as string;

    const open = await mk("Still open");
    const done = await mk("Finished");
    const cancelled = await mk("Called off");
    const archived = await mk("Tidied away");

    await patch(`/api/tasks/${done}`, { done: true });
    await patch(`/api/tasks/${cancelled}`, { cancelled: true });
    await patch(`/api/tasks/${archived}`, { done: true });
    await post(`/api/tasks/${archived}/archive`);

    const cal = (await get(`/api/calendar?from=${day(21)}&to=${day(22)}`)).json();
    expect(cal.deadlines.map((d: { taskId: string }) => d.taskId)).toEqual([open]);
  });

  it("an archived client's deadlines leave the calendar, like they leave the board", async () => {
    const clientId = await makeClient("Vanishing");
    await post("/api/tasks", {
      title: "Work for a client about to go",
      clientId,
      internal: true,
      deadline: day(22),
      assignees: [],
    });
    const dayHas = async () =>
      (await get(`/api/calendar?from=${day(22)}&to=${day(23)}`)).json().deadlines.length;

    expect(await dayHas()).toBe(1);
    await post(`/api/clients/${clientId}/archive`);
    expect(await dayHas()).toBe(0);
  });

  it("marks a deadline whose day has passed as overdue, but not one due today", async () => {
    const clientId = await makeClient("Timely");
    await post("/api/tasks", {
      title: "Due today",
      clientId,
      internal: true,
      deadline: day(0),
      assignees: [],
    });
    await post("/api/tasks", {
      title: "Due yesterday",
      clientId,
      internal: true,
      deadline: day(-1),
      assignees: [],
    });

    const cal = (await get(`/api/calendar?from=${day(-1)}&to=${day(1)}`)).json();
    const byTitle = Object.fromEntries(
      cal.deadlines.map((d: { title: string; overdue: boolean }) => [d.title, d.overdue]),
    );
    // the same rule the board and Billing use: a whole day must pass before it is late
    expect(byTitle["Due today"]).toBe(false);
    expect(byTitle["Due yesterday"]).toBe(true);
  });

  it("filters both lanes by person", async () => {
    const clientId = await makeClient("Mine");
    await post("/api/tasks", {
      title: "Mate's job",
      clientId,
      internal: true,
      deadline: day(25),
      assignees: [mateId],
    });
    await post("/api/tasks", {
      title: "Admin's job",
      clientId,
      internal: true,
      deadline: day(25),
      assignees: [adminId],
    });
    await post("/api/calendar/meetings", {
      title: "Mate's meeting",
      startAt: at(day(25), "10:00"),
      durationMinutes: 30,
      participantIds: [mateId],
    });

    const mine = (await get(`/api/calendar?from=${day(25)}&to=${day(26)}&userId=${mateId}`)).json();
    expect(mine.deadlines.map((d: { title: string }) => d.title)).toEqual(["Mate's job"]);
    expect(mine.meetings).toHaveLength(1);
  });

  it("refuses a range that is backwards or absurdly wide", async () => {
    expect((await get(`/api/calendar?from=${day(10)}&to=${day(5)}`)).statusCode).toBe(400);
    expect((await get(`/api/calendar?from=${day(0)}&to=${day(200)}`)).statusCode).toBe(400);
  });
});

/**
 * WHO at the client a meeting is with (S8, user 2026-08-28).
 *
 * A contact is a REFINEMENT of the client, never a target of its own. Everything here exists to
 * hold that line: the meeting keeps belonging to the client, so no rollup changes; the contact is
 * checked against THAT client, so a stray id cannot attach a stranger's phone number; and a
 * contact who leaves takes nothing with them.
 */
describe("meetings — the contact at the client", () => {
  const makeClientWithPeople = async (firstName: string, names: string[]) => {
    const res = await post("/api/clients", {
      firstName,
      companies: [],
      people: names.map((name) => ({ name, phone: `+1 555 000 ${names.indexOf(name)}` })),
    });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    return { id: c.id as string, people: c.people as { id: string; name: string }[] };
  };

  it("books a meeting with a named contact and reads the name back", async () => {
    const c = await makeClientWithPeople("Contactful", ["Maryna", "Serhii"]);
    const res = await post("/api/calendar/meetings", {
      title: "Quarterly review",
      clientId: c.id,
      personId: c.people[0].id,
      startAt: at(day(3), "14:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m.personId).toBe(c.people[0].id);
    // resolved server-side, like clientName — the calendar never resolves ids against a client list
    expect(m.personName).toBe("Maryna");
    // and the meeting still belongs to the CLIENT, which is what every rollup counts
    expect(m.clientId).toBe(c.id);
  });

  it("refuses a contact who belongs to a different client", async () => {
    const ours = await makeClientWithPeople("Ours", ["Ours person"]);
    const theirs = await makeClientWithPeople("Theirs", ["Theirs person"]);
    const res = await post("/api/calendar/meetings", {
      title: "Not yours to book",
      clientId: ours.id,
      personId: theirs.people[0].id,
      startAt: at(day(3), "15:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a contact with no client behind them", async () => {
    const c = await makeClientWithPeople("Orphaned", ["Someone"]);
    const res = await post("/api/calendar/meetings", {
      title: "Contact without a client",
      personId: c.people[0].id,
      startAt: at(day(3), "16:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a contact on a LEAD's meeting — a lead has no contacts", async () => {
    const c = await makeClientWithPeople("Has people", ["Person"]);
    const lead = await post("/api/leads", { name: "Lead with no people" });
    const res = await post("/api/calendar/meetings", {
      title: "Wrong side",
      leadId: lead.json().id,
      personId: c.people[0].id,
      startAt: at(day(3), "17:00"),
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets the contact be changed after booking, and cleared again", async () => {
    const c = await makeClientWithPeople("Changeable", ["First", "Second"]);
    const created = await post("/api/calendar/meetings", {
      title: "Learn who later",
      clientId: c.id,
      startAt: at(day(4), "10:00"),
      durationMinutes: 30,
    });
    expect(created.json().personId).toBeNull();

    const moved = await patch(`/api/calendar/meetings/${created.json().id}`, {
      personId: c.people[1].id,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().personName).toBe("Second");

    const cleared = await patch(`/api/calendar/meetings/${created.json().id}`, { personId: null });
    expect(cleared.json().personId).toBeNull();
  });

  it("refuses an edit that moves the contact to another client's person", async () => {
    const ours = await makeClientWithPeople("Edit ours", ["Right"]);
    const theirs = await makeClientWithPeople("Edit theirs", ["Wrong"]);
    const created = await post("/api/calendar/meetings", {
      title: "Guarded on edit too",
      clientId: ours.id,
      startAt: at(day(4), "11:00"),
      durationMinutes: 30,
    });
    const res = await patch(`/api/calendar/meetings/${created.json().id}`, {
      personId: theirs.people[0].id,
    });
    expect(res.statusCode).toBe(400);
  });

  it("a contact who leaves takes nothing with them — the meeting stays on the client", async () => {
    const c = await makeClientWithPeople("Leaver", ["Departing", "Staying"]);
    const created = await post("/api/calendar/meetings", {
      title: "Booked with someone who left",
      clientId: c.id,
      personId: c.people[0].id,
      startAt: at(day(5), "10:00"),
      durationMinutes: 30,
    });
    // the People tab replaces the list — dropping a row deletes that contact
    const kept = c.people[1];
    const upd = await patch(`/api/clients/${c.id}`, {
      people: [{ name: kept.name, phone: "+1 555 111 1" }],
    });
    expect(upd.statusCode).toBe(200);

    const after = await get(`/api/calendar/meetings/${created.json().id}`);
    expect(after.statusCode).toBe(200);
    expect(after.json().clientId).toBe(c.id);
    expect(after.json().personId).toBeNull();
    expect(after.json().personName).toBeNull();
  });
});
