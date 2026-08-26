import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { generatePeriodInvoices } from "../payments/index.js";

/**
 * Days ago as "YYYY-MM-DD". Subscriptions in these tests start in the PAST so they can be paused
 * with effect right now: "last day served = today" deliberately still serves today, and a last
 * served day before the service even started is refused.
 */
function daysAgoIso(n: number): string {
  // anchored to the FIRM timezone, which is what the server calls "today" — a local-clock anchor
  // disagrees with it for a few hours around midnight and flipped these fixtures by a day
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d - n));
  return at.toISOString().slice(0, 10);
}
const yesterdayIso = () => daysAgoIso(1);
/**
 * A subscription can no longer be CREATED in the past (user, 2026-08-01: a service is never agreed
 * backwards). Tests that need an already-running service therefore create it normally and backdate
 * its period directly — the state is legitimate, only the door into it is closed.
 */
const startedEarlier = () => ({});
async function backdateStart(subscriptionId: string, days = 20) {
  await prisma.subscriptionPeriod.updateMany({
    where: { subscriptionId },
    data: { startsOn: new Date(`${daysAgoIso(days)}T00:00:00.000Z`) },
  });
}
const inDaysIso = (n: number) => daysAgoIso(-n);

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.file.deleteMany();
  await prisma.clientPin.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "User",
      email: "user@clients.local",
      passwordHash: await argon2.hash("password-123"),
      role: "user",
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "user@clients.local", password: "password-123" },
  });
  cookie = cookieOf(res);
});

afterAll(async () => {
  // this suite now creates tasks + invoices (company-dimension and archive cases) — leave the
  // database as clean as we found it, or the next suite trips over the foreign keys
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
  await app.close();
});

describe("clients", () => {
  let individualId: string;

  it("creates a client with companies + people", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Ivan",
        lastName: "Petrenko",
        phone: "+380501112233",
        email: "ivan@example.com",
        companies: [{ name: "Alpha LLC" }, { name: "Beta Inc" }],
        people: [{ name: "Olena Book", serviceLabel: "Bookkeeping", phone: "+380671110000" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    individualId = body.id;
    expect(body.displayName).toBe("Ivan Petrenko");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Alpha LLC", "Beta Inc"]);
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({ name: "Olena Book", serviceLabel: "Bookkeeping" });
    expect(body.isRegular).toBe(false);
    expect(body.debt).toBe(0);
  });

  // the last name is optional (user, 2026-07-26) — a first name alone identifies the client
  it("accepts a client with only a first name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Lesya", email: "lesya@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.lastName).toBeNull();
    expect(body.displayName).toBe("Lesya"); // no trailing space from the missing half
  });

  it("rejects a client with no first name at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { lastName: "Petrenko", email: "x@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  // an edit must not be able to strip the name either — the merged check runs on PATCH
  it("rejects clearing the first name on an existing client", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Olha", lastName: "Koval" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { firstName: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets an edit drop the last name", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Ihor", lastName: "Bondar" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { lastName: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Ihor");
  });

  // `companyName` is a plain label now — it never was, and never becomes, a Company row
  it("keeps companyName as a label, separate from the client's companies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        companyName: "Romashka LLC",
        firstName: "Petro",
        lastName: "Tkach",
        companies: [{ name: "Romashka Trade LLC" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.displayName).toBe("Petro Tkach"); // the person, never the label
    expect(body.companyName).toBe("Romashka LLC");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Romashka Trade LLC"]);
  });

  it("a company belongs to exactly one client", async () => {
    // Ivan(2) + Romashka Trade(1) = 3 rows total
    expect(await prisma.company.count()).toBe(3);
    const alphas = await prisma.company.findMany({ where: { name: "Alpha LLC" } });
    expect(alphas).toHaveLength(1);
    expect(alphas[0].clientId).toBe(individualId);
  });

  // a company name identifies ONE company for the whole firm (user, 2026-07-26)
  it("refuses a company name another client already holds, and says who", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      // different case on purpose — the rule is case-insensitive
      payload: { firstName: "Copycat", companies: [{ name: "alpha llc" }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("Ivan Petrenko");
    // and the refused create left NOTHING behind — the name is checked before anything is written
    expect(await prisma.client.count({ where: { firstName: "Copycat" } })).toBe(0);
  });

  it("stores a company's own contact details and keeps its id across a rename", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Detail",
        companies: [
          {
            name: "Detailed Co",
            phone: "+380671234567",
            email: "billing@detailed.co",
            description: "invoices go to accounting",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const company = created.json().companies[0];
    expect(company).toMatchObject({
      name: "Detailed Co",
      phone: "+380671234567",
      email: "billing@detailed.co",
      description: "invoices go to accounting",
    });

    // renaming by id keeps the same row, so anything pointing at it follows along
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { companies: [{ id: company.id, name: "Detailed Group", email: "ap@detailed.co" }] },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().companies[0].id).toBe(company.id);
    expect(renamed.json().companies[0].name).toBe("Detailed Group");
    expect(renamed.json().companies[0].email).toBe("ap@detailed.co");
    // an OMITTED field is left alone (2026-07-28). It used to be cleared, which meant saving the
    // client's profile form — whose tag input carries names and nothing else — wiped every
    // company's phone, email and description, the invoice address among them.
    expect(renamed.json().companies[0].phone).toBe("+380671234567");
    expect(renamed.json().companies[0].description).toBe("invoices go to accounting");

    // …and that is exactly the shape the profile form sends: bare names, no details
    const profileSave = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { phone: "+380991110000", companies: [{ name: "Detailed Group" }] },
    });
    expect(profileSave.statusCode).toBe(200);
    expect(profileSave.json().companies[0]).toMatchObject({
      id: company.id,
      phone: "+380671234567",
      email: "ap@detailed.co",
      description: "invoices go to accounting",
    });

    // an EXPLICIT null still clears — that's how the Companies tab empties a field
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { companies: [{ id: company.id, name: "Detailed Group", phone: null }] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().companies[0].phone).toBeNull();
    expect(cleared.json().companies[0].email).toBe("ap@detailed.co"); // untouched
  });

  it("searches by company name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients?tab=one_time&search=beta",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].displayName).toBe("Ivan Petrenko");
  });

  it("a partial update keeps companies + people untouched", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { address: "Kyiv" }, // no companies/people -> must not touch them
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().companies).toHaveLength(2);
    expect(res.json().people).toHaveLength(1);
  });

  it("cannot blank a client's name via a partial update", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { firstName: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * "Regular" is not a setting (user, 2026-07-26): it follows from the services the client holds.
   * A subscription-type service makes them regular; stopping it makes them one-time again — and
   * a one-time service never counts, however many of them there are.
   */
  it("derives regular from the subscriptions, and follows them both ways", async () => {
    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Derived", lastName: "Regular" },
    });
    const clientId = client.json().id;
    expect(client.json().isRegular).toBe(false);

    const [oneTime, monthly] = await Promise.all([
      prisma.service.create({ data: { name: "Derived one-off", color: "#000", type: "one_time" } }),
      prisma.service.create({ data: { name: "Derived monthly", color: "#000", type: "subscription" } }),
    ]);

    // a one-time service is only a container for ad-hoc jobs — it never makes anyone regular
    const withOneTime = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: oneTime.id, amount: 5000, ...startedEarlier() },
    });
    expect(withOneTime.json().isRegular).toBe(false);

    const withSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: monthly.id, amount: 10_000, period: "month", ...startedEarlier() },
    });
    expect(withSub.json().isRegular).toBe(true);
    const subId = withSub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === monthly.id).id;
    await backdateStart(subId); // it has to have been running to be stopped as of yesterday

    // …and stopping it hands them straight back to One-time, with nothing to un-tick
    const stopped = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subId}/pause`,
      headers: { cookie },
      payload: { lastDay: yesterdayIso() },
    });
    expect(stopped.json().isRegular).toBe(false);

    // the tab filters agree with the DTO — they are the same rule, expressed in SQL
    const oneTimeTab = await app.inject({
      method: "GET",
      url: "/api/clients?tab=one_time&search=Derived",
      headers: { cookie },
    });
    expect(oneTimeTab.json().items.map((c: { id: string }) => c.id)).toContain(clientId);

    // …and resuming brings them back, from the day service starts again
    const resumed = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subId}/resume`,
      headers: { cookie },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().isRegular).toBe(true);
    const regularTab = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular&search=Derived",
      headers: { cookie },
    });
    expect(regularTab.json().items.map((c: { id: string }) => c.id)).toContain(clientId);
  });

  // A service is never agreed BACKWARDS (user, 2026-08-01). This is the guard that stops one
  // mistyped year from having the nightly sweep raise a manual-invoice reminder for every month
  // since — work already done is billed with a one-off invoice instead.
  it("refuses a backdated start, on both the first period and a resume", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Backdate", lastName: "Guard" },
    });
    const clientId = created.json().id;
    const svc = await prisma.service.create({
      data: { name: "Backdate svc", color: "#000", type: "subscription" },
    });

    const past = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: svc.id, amount: 1000, period: "month", startsOn: yesterdayIso() },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.message).toMatch(/can't start in the past/i);

    // today is fine, and so is a date agreed ahead
    const todayOk = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: svc.id, amount: 1000, period: "month", startsOn: daysAgoIso(0) },
    });
    expect(todayOk.statusCode).toBe(201);
    const subId = todayOk.json().subscriptions[0].id;

    // …and a resume can't reach backwards either, or the same hole reopens
    await backdateStart(subId, 30);
    await app.inject({ // it is this client's first service, so it holds the default flag
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie },
      payload: { isDefault: false },
    });
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subId}/pause`,
      headers: { cookie },
      payload: { lastDay: daysAgoIso(10) },
    });
    const backResume = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subId}/resume`,
      headers: { cookie },
      payload: { startsOn: daysAgoIso(5) },
    });
    expect(backResume.statusCode).toBe(400);
    expect(backResume.json().error.message).toMatch(/can't resume in the past/i);

    const forward = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subId}/resume`,
      headers: { cookie },
      payload: { startsOn: inDaysIso(3) },
    });
    expect(forward.statusCode).toBe(200);
  });

  // The "first service claims the default" rule counted services in force TODAY, so once start
  // dates could be in the FUTURE a client whose first service was scheduled claimed nothing — and
  // nothing re-ran when it started, leaving their pickers permanently un-prefilled (2026-08-01).
  it("a client whose first service is scheduled still ends up with a default", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Scheduled", lastName: "Default" },
    });
    const clientId = created.json().id;
    const svc = await prisma.service.create({
      data: { name: "Scheduled svc", color: "#000", type: "subscription" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: svc.id, amount: 1000, period: "month", startsOn: inDaysIso(14) },
    });
    expect(res.statusCode).toBe(201);
    const sub = res.json().subscriptions[0];
    expect(sub.state).toBe("scheduled");
    expect(sub.isDefault).toBe(true); // their only service — there is nothing else to choose
  });

  it("a planned pause can be moved and called off, and a mistyped date can't erase service", async () => {
    const service = await prisma.service.create({
      data: { name: "Planned pause svc", color: "#2f4fd6", type: "subscription", defaultAmount: 9_000 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Planned", lastName: "Pause", companies: [], people: [] },
    });
    const clientId = created.json().id;
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 9_000, period: "month", ...startedEarlier() },
    });
    const subId = sub
      .json()
      .subscriptions.find((x: { serviceId: string }) => x.serviceId === service.id).id;
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie },
      payload: { isDefault: false },
    });
    const pauseUrl = `/api/clients/${clientId}/subscriptions/${subId}/pause`;
    const sixtyDays = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const ninetyDays = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const readSub = (res: { json: () => { subscriptions: Record<string, unknown>[] } }) =>
      res.json().subscriptions.find((x) => x.id === subId)!;

    // agreed in advance: it stops in 60 days but is STILL SERVED until then
    const planned = await app.inject({
      method: "POST",
      url: pauseUrl,
      headers: { cookie },
      payload: { lastDay: sixtyDays, note: "client asked in advance" },
    });
    expect(planned.statusCode).toBe(200);
    expect(readSub(planned)).toMatchObject({ state: "in_force", inForceUntil: sixtyDays });

    // the date can be MOVED — pausing again adjusts it instead of answering "already paused"
    const moved = await app.inject({
      method: "POST",
      url: pauseUrl,
      headers: { cookie },
      payload: { lastDay: ninetyDays },
    });
    expect(moved.statusCode).toBe(200);
    expect(readSub(moved)).toMatchObject({ state: "in_force", inForceUntil: ninetyDays });

    // …and CALLED OFF entirely: explicit null puts the service back to open-ended
    const calledOff = await app.inject({
      method: "POST",
      url: pauseUrl,
      headers: { cookie },
      payload: { lastDay: null },
    });
    expect(calledOff.statusCode).toBe(200);
    expect(readSub(calledOff)).toMatchObject({ state: "in_force", inForceUntil: null });

    // removing an end date that isn't there is a clear refusal, not a silent no-op
    const nothingToRemove = await app.inject({
      method: "POST",
      url: pauseUrl,
      headers: { cookie },
      payload: { lastDay: null },
    });
    expect(nothingToRemove.statusCode).toBe(409);

    // a last-served day BEFORE the service started must not wipe the period (it used to, with 200)
    const tooEarly = await app.inject({
      method: "POST",
      url: pauseUrl,
      headers: { cookie },
      payload: { lastDay: daysAgoIso(90) },
    });
    expect(tooEarly.statusCode).toBe(400);
    const stillThere = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}`,
      headers: { cookie },
    });
    expect(
      stillThere.json().subscriptions.find((x: { id: string }) => x.id === subId).state,
    ).toBe("in_force");
  });

  it("rejects a whitespace-only person name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "A",
        lastName: "B",
        email: "ws@example.com",
        people: [{ name: "   " }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * One of a client's services is "the usual one" (user, 2026-07-26). With a single service that
   * is automatic; with several the firm picks. At most one, and it can't be stopped while it
   * holds the flag — clear it first.
   */
  it("keeps exactly one default service per client, and guards it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Default", lastName: "Service" },
    });
    const clientId = created.json().id;
    const [first, second] = await Promise.all([
      prisma.service.create({ data: { name: "Default first", color: "#000", type: "subscription" } }),
      prisma.service.create({ data: { name: "Default second", color: "#000", type: "subscription" } }),
    ]);

    // the first service is the default by itself — with one option there is nothing to choose
    const one = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: first.id, amount: 1000, period: "month", ...startedEarlier() },
    });
    const subA = one.json().subscriptions.find((s: { serviceId: string }) => s.serviceId === first.id);
    expect(subA.isDefault).toBe(true);
    await backdateStart(subA.id);

    // a second service does NOT steal the flag
    const two = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: second.id, amount: 2000, period: "month", ...startedEarlier() },
    });
    const subB = two.json().subscriptions.find((s: { serviceId: string }) => s.serviceId === second.id);
    expect(subB.isDefault).toBe(false);
    await backdateStart(subB.id);

    // the default can't be stopped while it holds the flag
    const blocked = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subA.id}/pause`,
      headers: { cookie },
      payload: { lastDay: yesterdayIso() },
    });
    expect(blocked.statusCode).toBe(409);

    // …but an end date ALREADY on the default service can still be removed: that makes it more in
    // force, not less, so the guard must not block it (2026-07-30 audit). Schedule the end while
    // subB is ordinary, then hand it the flag.
    const planned = inDaysIso(30);
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}/pause`,
      headers: { cookie },
      payload: { lastDay: planned },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { isDefault: true },
    });
    const removed = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}/pause`,
      headers: { cookie },
      payload: { lastDay: null },
    });
    expect(removed.statusCode).toBe(200);
    const reopened = removed
      .json()
      .subscriptions.find((s: { id: string }) => s.id === subB.id);
    expect(reopened.inForceUntil).toBeNull();
    expect(reopened.isDefault).toBe(true);
    // setting one on the default is still refused, though
    const stillBlocked = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}/pause`,
      headers: { cookie },
      payload: { lastDay: planned },
    });
    expect(stillBlocked.statusCode).toBe(409);
    // hand the flag back so the next step is a real move again
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subA.id}`,
      headers: { cookie },
      payload: { isDefault: true },
    });

    // moving it clears the previous holder — never two at once
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { isDefault: true },
    });
    const subs = moved.json().subscriptions;
    expect(subs.filter((s: { isDefault: boolean }) => s.isDefault)).toHaveLength(1);
    expect(subs.find((s: { id: string }) => s.id === subB.id).isDefault).toBe(true);

    // …and now the first one is free to stop
    const stopped = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subA.id}/pause`,
      headers: { cookie },
      payload: { lastDay: yesterdayIso() },
    });
    expect(stopped.statusCode).toBe(200);

    // clearing the flag entirely is allowed — that's how you stop the last service
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { isDefault: false },
    });
    expect(cleared.json().subscriptions.every((s: { isDefault: boolean }) => !s.isDefault)).toBe(true);
    const lastStop = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}/pause`,
      headers: { cookie },
      payload: { lastDay: yesterdayIso() },
    });
    expect(lastStop.statusCode).toBe(200);
  });

  // the two tabs partition every client: there is no third state and no manual override
  it("the tabs split every client between them, with no overlap", async () => {
    const [regular, oneTime] = await Promise.all([
      app.inject({ method: "GET", url: "/api/clients?tab=regular&pageSize=100", headers: { cookie } }),
      app.inject({ method: "GET", url: "/api/clients?tab=one_time&pageSize=100", headers: { cookie } }),
    ]);
    const regularIds = regular.json().items.map((c: { id: string }) => c.id);
    const oneTimeIds = oneTime.json().items.map((c: { id: string }) => c.id);

    expect(regularIds.filter((id: string) => oneTimeIds.includes(id))).toHaveLength(0);
    expect(regularIds.length + oneTimeIds.length).toBe(
      regular.json().counts.regular + regular.json().counts.one_time,
    );
    // and each side matches what the DTO says about those clients
    for (const c of [...regular.json().items, ...oneTime.json().items]) {
      expect(c.isRegular).toBe(regularIds.includes(c.id));
    }
  });

  it("archives a client — gone from lists and from GET", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${individualId}/archive`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular",
      headers: { cookie },
    });
    expect(list.json().items.some((c: { id: string }) => c.id === individualId)).toBe(false);

    const get = await app.inject({
      method: "GET",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);
  });

  it("uploads, lists, and deletes a client file", async () => {
    const other = await prisma.client.findFirstOrThrow({ where: { archivedAt: null } });
    const boundary = "----test-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: text/plain",
      "",
      "hello client file",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const up = await app.inject({
      method: "POST",
      url: `/api/clients/${other.id}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(up.statusCode).toBe(201);
    const file = up.json();

    const download = await app.inject({
      method: "GET",
      url: `/api/clients/${other.id}/files/${file.id}`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello client file");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/clients/${other.id}/files/${file.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
  });
  it("re-saving a client keeps the company dimension on its subscriptions and invoices", async () => {
    // companies used to be deleted+recreated on every save, so the new ids silently blanked
    // (FK SetNull) the company on subscriptions, tasks and ISSUED INVOICES
    const service = await prisma.service.create({
      data: { name: "Company FK service", color: "#2f4fd6", type: "subscription", defaultAmount: 5_000 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Company",
        lastName: "Dimension",
        companies: [{ name: "Alpha Ltd" }, { name: "Beta Ltd" }],
        people: [],
      },
    });
    const client = created.json();
    const alpha = client.companies.find((c: { name: string }) => c.name === "Alpha Ltd");

    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 5_000, period: "month", companyId: alpha.id },
    });
    expect(sub.statusCode).toBe(201);
    // From the period's first day, so the period is whole and its invoice is issued — this test is
    // about the company surviving on an ISSUED invoice. Written to the row because a service can no
    // longer be CREATED with a past start (2026-08-01), and from the 2nd onwards that day is past.
    const { y, m } = { y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() + 1 };
    await prisma.subscriptionPeriod.updateMany({
      where: { subscriptionId: sub.json().subscriptions[0].id },
      data: { startsOn: new Date(Date.UTC(y, m - 1, 1)) },
    });
    await generatePeriodInvoices(); // the period is whole now, so the sweep issues its invoice

    // an ordinary edit that re-sends the same company list
    const resaved = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { phone: "+380000000000", companies: [{ name: "Alpha Ltd" }, { name: "Beta Ltd" }] },
    });
    expect(resaved.statusCode).toBe(200);
    expect(resaved.json().companies.find((c: { name: string }) => c.name === "Alpha Ltd").id).toBe(
      alpha.id,
    );
    expect(resaved.json().subscriptions[0].companyId).toBe(alpha.id);

    const invoices = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${client.id}`,
      headers: { cookie },
    });
    expect(invoices.json().items[0].companyName).toBe("Alpha Ltd");

    // and a company something still points at can't just be dropped
    const drop = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { companies: [{ name: "Beta Ltd" }] },
    });
    expect(drop.statusCode).toBe(409);
    expect(drop.json().error.message).toContain("Alpha Ltd");

    // an unused one still goes away
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { companies: [{ name: "Alpha Ltd" }] },
    });
    expect(ok.json().companies.map((c: { name: string }) => c.name)).toEqual(["Alpha Ltd"]);
  });

  it("archiving a client takes their tasks off the board but leaves the invoices", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Gone", lastName: "Away", companies: [], people: [] },
    });
    const client = created.json();
    const service = await prisma.service.create({
      data: { name: "Archived client job", color: "#1f8f3a", type: "one_time", defaultAmount: 1_000 },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 1_000, period: "month", ...startedEarlier() },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Work for a client about to be archived",
        clientId: client.id,
        subscriptionId: sub.json().subscriptions[0].id,
        amount: 1_000,
        assignees: [],
      },
    });

    const before = await app.inject({ method: "GET", url: "/api/tasks?view=board", headers: { cookie } });
    expect(before.json().items.some((t: { clientId: string }) => t.clientId === client.id)).toBe(true);

    await app.inject({ method: "POST", url: `/api/clients/${client.id}/archive`, headers: { cookie } });

    const after = await app.inject({ method: "GET", url: "/api/tasks?view=board", headers: { cookie } });
    expect(after.json().items.some((t: { clientId: string }) => t.clientId === client.id)).toBe(false);

    // the money stays visible — archiving a client must not hide what they owe
    const invoices = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${client.id}`,
      headers: { cookie },
    });
    expect(invoices.json().items).toHaveLength(1);
    expect(invoices.json().items[0].clientArchived).toBe(true);
  });

  // ── a one-time service has no billing period (2026-08-26) ─────────────────

  describe("period belongs to a subscription, not to a job", () => {
    let clientId: string;

    beforeAll(async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { cookie },
        payload: { firstName: "Period", lastName: "Rules", companies: [], people: [] },
      });
      clientId = created.json().id;
    });

    afterAll(async () => {
      await prisma.subscription.deleteMany({ where: { clientId } });
      await prisma.client.deleteMany({ where: { id: clientId } });
      await prisma.service.deleteMany({ where: { name: { startsWith: "PeriodRule" } } });
    });

    const addService = async (type: "one_time" | "subscription", period?: string) => {
      const service = await prisma.service.create({
        data: { name: `PeriodRule ${type} ${period ?? "none"}`, color: "#1f8f3a", type },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/clients/${clientId}/subscriptions`,
        headers: { cookie },
        payload: { serviceId: service.id, amount: 50_000, ...(period ? { period } : {}) },
      });
      expect(res.statusCode).toBe(201);
      return res.json().subscriptions.find(
        (x: { serviceId: string }) => x.serviceId === service.id,
      );
    };

    it("stores NO period for a one-time service, even when one is sent", async () => {
      // the caller may send anything; the server derives this from the service's type, because a
      // placeholder that means nothing is one some screen will eventually believe
      const sub = await addService("one_time", "quarter");
      expect(sub.period).toBeNull();
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(row.period).toBeNull();
    });

    it("keeps the period a subscription service was given", async () => {
      const sub = await addService("subscription", "quarter");
      expect(sub.period).toBe("quarter");
    });

    it("defaults a subscription service to monthly when none is asked for", async () => {
      const sub = await addService("subscription");
      expect(sub.period).toBe("month");
    });

    it("the client's auto-added default service carries no period either", async () => {
      const fresh = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { cookie },
        payload: { firstName: "Auto", lastName: "Default", companies: [], people: [] },
      });
      const subs = fresh.json().subscriptions as { period: string | null }[];
      // there may be no catalog default in this suite; when there is, it is one-time by definition
      for (const s of subs) expect(s.period).toBeNull();
      await prisma.subscription.deleteMany({ where: { clientId: fresh.json().id } });
      await prisma.client.deleteMany({ where: { id: fresh.json().id } });
    });
  });

  // ── list order: sort + the reader's own pins (2026-08-26) ──────────────────

  describe("ordering the clients list", () => {
    const names = ["Zulu", "Alpha", "Mike"];
    let ids: Record<string, string> = {};

    const create = async (firstName: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { cookie },
        payload: { firstName, lastName: "Order", companies: [], people: [] },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    const list = async (query = "") => {
      const res = await app.inject({
        method: "GET",
        url: `/api/clients?tab=all&pageSize=100&search=Order${query}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json().items as { id: string; firstName: string; pinned: boolean }[];
    };

    beforeAll(async () => {
      ids = {};
      for (const n of names) {
        ids[n] = await create(n); // created Zulu → Alpha → Mike, so "newest first" is the reverse
      }
    });

    afterAll(async () => {
      await prisma.clientPin.deleteMany();
      await prisma.client.deleteMany({ where: { lastName: "Order" } });
    });

    it("defaults to newest first, which is what the screen always did", async () => {
      const items = await list();
      expect(items.map((c) => c.firstName)).toEqual(["Mike", "Alpha", "Zulu"]);
    });

    it("sorts by name when asked", async () => {
      const items = await list("&sort=name");
      expect(items.map((c) => c.firstName)).toEqual(["Alpha", "Mike", "Zulu"]);
    });

    it("sorts by last edited — an old client edited today comes first", async () => {
      // Zulu is the OLDEST by creation; touching it must float it to the top of `updated`
      await app.inject({
        method: "PATCH",
        url: `/api/clients/${ids.Zulu}`,
        headers: { cookie },
        payload: { description: "touched" },
      });
      const items = await list("&sort=updated");
      expect(items[0].firstName).toBe("Zulu");
      // and the default sort is untouched by the edit
      expect((await list()).map((c) => c.firstName)).toEqual(["Mike", "Alpha", "Zulu"]);
    });

    it("orders the pinned block by WHEN it was pinned, not by the list's sort", async () => {
      // Zulu first, then Alpha — the reverse of name order and of creation order, so only pin
      // time can produce it. This is the whole point: an existing pin must not move when the
      // reader changes the sort (user, 2026-08-26).
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Alpha}/pin`, headers: { cookie } });

      for (const sort of ["", "&sort=name", "&sort=updated"]) {
        const items = await list(sort);
        expect(items.slice(0, 2).map((c) => c.firstName), `sort=${sort || "recent"}`).toEqual([
          "Zulu",
          "Alpha",
        ]);
      }

      // a THIRD pin lands underneath the other two and moves neither
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Mike}/pin`, headers: { cookie } });
      expect((await list("&sort=name")).slice(0, 3).map((c) => c.firstName)).toEqual([
        "Zulu",
        "Alpha",
        "Mike",
      ]);

      for (const id of Object.values(ids)) {
        await app.inject({ method: "DELETE", url: `/api/clients/${id}/pin`, headers: { cookie } });
      }
    });

    it("re-pinning sends the client to the BOTTOM of the block, where a new pin belongs", async () => {
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Alpha}/pin`, headers: { cookie } });
      expect((await list()).slice(0, 2).map((c) => c.firstName)).toEqual(["Zulu", "Alpha"]);

      // unpin then pin again — it is a new pin, so it goes last
      await app.inject({ method: "DELETE", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
      expect((await list()).slice(0, 2).map((c) => c.firstName)).toEqual(["Alpha", "Zulu"]);

      for (const id of Object.values(ids)) {
        await app.inject({ method: "DELETE", url: `/api/clients/${id}/pin`, headers: { cookie } });
      }
    });

    it("floats a pinned client to the top of every sort, and says so on the row", async () => {
      const pinned = await app.inject({
        method: "PUT",
        url: `/api/clients/${ids.Zulu}/pin`,
        headers: { cookie },
      });
      expect(pinned.statusCode).toBe(200);

      for (const sort of ["", "&sort=name", "&sort=updated"]) {
        const items = await list(sort);
        expect(items[0].firstName, `sort=${sort || "recent"}`).toBe("Zulu");
        expect(items[0].pinned).toBe(true);
        expect(items.slice(1).every((c) => !c.pinned)).toBe(true);
      }

      // the card agrees with the row
      const card = await app.inject({
        method: "GET",
        url: `/api/clients/${ids.Zulu}`,
        headers: { cookie },
      });
      expect(card.json().pinned).toBe(true);
    });

    it("un-pinning puts the client back where the sort says it belongs", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/clients/${ids.Zulu}/pin`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const items = await list("&sort=name");
      expect(items.map((c) => c.firstName)).toEqual(["Alpha", "Mike", "Zulu"]);
      expect(items.every((c) => !c.pinned)).toBe(true);
    });

    it("pinning twice is a no-op, not a duplicate row", async () => {
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Mike}/pin`, headers: { cookie } });
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Mike}/pin`, headers: { cookie } });
      expect(await prisma.clientPin.count({ where: { clientId: ids.Mike } })).toBe(1);
      const items = await list("&sort=name");
      expect(items.map((c) => c.firstName)).toEqual(["Mike", "Alpha", "Zulu"]);
      await app.inject({ method: "DELETE", url: `/api/clients/${ids.Mike}/pin`, headers: { cookie } });
    });

    it("a pin reorders the page without changing what is on it", async () => {
      // the count is the whole filtered set either way — pinning must never add or hide a row
      const before = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&pageSize=2&search=Order",
        headers: { cookie },
      });
      expect(before.json().total).toBe(3);

      await app.inject({ method: "PUT", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });

      const page1 = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&pageSize=2&sort=name&search=Order",
        headers: { cookie },
      });
      const page2 = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&pageSize=2&page=2&sort=name&search=Order",
        headers: { cookie },
      });
      expect(page1.json().total).toBe(3);
      // pinned leads, then the rest in name order — and the two pages together are still everyone,
      // each exactly once. Paging ACROSS the pinned block is where the arithmetic can go wrong.
      const seen = [...page1.json().items, ...page2.json().items].map(
        (c: { firstName: string }) => c.firstName,
      );
      expect(seen).toEqual(["Zulu", "Alpha", "Mike"]);

      await app.inject({ method: "DELETE", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
    });

    it("a pin is one reader's, not the firm's", async () => {
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });

      await prisma.user.create({
        data: {
          firstName: "Other",
          lastName: "Reader",
          email: "other@clients.local",
          passwordHash: await argon2.hash("password-123"),
          role: "user",
          status: "active",
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "other@clients.local", password: "password-123" },
      });
      const otherCookie = cookieOf(login);

      const theirs = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&pageSize=100&sort=name&search=Order",
        headers: { cookie: otherCookie },
      });
      // the other reader sees plain name order and no pin at all
      expect(theirs.json().items.map((c: { firstName: string }) => c.firstName)).toEqual([
        "Alpha",
        "Mike",
        "Zulu",
      ]);
      expect(theirs.json().items.every((c: { pinned: boolean }) => !c.pinned)).toBe(true);

      await app.inject({ method: "DELETE", url: `/api/clients/${ids.Zulu}/pin`, headers: { cookie } });
      await prisma.session.deleteMany({ where: { user: { email: "other@clients.local" } } });
      await prisma.user.deleteMany({ where: { email: "other@clients.local" } });
    });

    it("caps the pinned block, because the whole block is read on every list request", async () => {
      const me = await prisma.user.findFirstOrThrow({ where: { email: "user@clients.local" } });
      const bulk = Array.from({ length: 50 }, (_, i) => ({
        firstName: `Bulk${String(i).padStart(2, "0")}`,
        lastName: "Capped",
      }));
      await prisma.client.createMany({ data: bulk });
      const created = await prisma.client.findMany({
        where: { lastName: "Capped" },
        select: { id: true },
      });
      expect(created).toHaveLength(50);
      await prisma.clientPin.createMany({
        data: created.map((c) => ({ userId: me.id, clientId: c.id })),
      });

      const over = await app.inject({
        method: "PUT",
        url: `/api/clients/${ids.Zulu}/pin`,
        headers: { cookie },
      });
      expect(over.statusCode).toBe(400);
      expect(over.json().error.message).toMatch(/at most 50/);

      // re-pinning one that is ALREADY pinned still works at the limit — the upsert is a no-op,
      // and refusing it would make the cap punish something that changes nothing
      const again = await app.inject({
        method: "PUT",
        url: `/api/clients/${created[0].id}/pin`,
        headers: { cookie },
      });
      expect(again.statusCode).toBe(200);

      await prisma.clientPin.deleteMany({ where: { userId: me.id } });
      await prisma.client.deleteMany({ where: { lastName: "Capped" } });
    });

    it("archiving takes the client out of the pinned block, and un-archiving does not restore it", async () => {
      await app.inject({ method: "PUT", url: `/api/clients/${ids.Mike}/pin`, headers: { cookie } });
      expect((await list())[0].firstName).toBe("Mike");

      await app.inject({ method: "POST", url: `/api/clients/${ids.Mike}/archive`, headers: { cookie } });
      expect(await prisma.clientPin.count({ where: { clientId: ids.Mike } })).toBe(0);

      // a stale pin would otherwise float them to the top of the Archive screen, which reads as a
      // mistake — and like the stopped services, the pin is not brought back on restore
      await app.inject({ method: "POST", url: `/api/clients/${ids.Mike}/restore`, headers: { cookie } });
      const back = await list();
      expect(back.find((c) => c.firstName === "Mike")?.pinned).toBe(false);
    });

    it("refuses to pin an archived client", async () => {
      await app.inject({ method: "POST", url: `/api/clients/${ids.Alpha}/archive`, headers: { cookie } });
      const res = await app.inject({
        method: "PUT",
        url: `/api/clients/${ids.Alpha}/pin`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      await app.inject({ method: "POST", url: `/api/clients/${ids.Alpha}/restore`, headers: { cookie } });
    });

    it("a page past the pinned block still lands on the right rows", async () => {
      // the repository takes a cheaper branch once `skip` is past the block — it must produce
      // exactly the same sequence as walking through it
      for (const n of ["Zulu", "Alpha"]) {
        await app.inject({ method: "PUT", url: `/api/clients/${ids[n]}/pin`, headers: { cookie } });
      }
      const pages: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/clients?tab=all&pageSize=1&page=${page}&sort=name&search=Order`,
          headers: { cookie },
        });
        pages.push(...res.json().items.map((c: { firstName: string }) => c.firstName));
      }
      expect(pages).toEqual(["Zulu", "Alpha", "Mike"]);
      for (const id of Object.values(ids)) {
        await app.inject({ method: "DELETE", url: `/api/clients/${id}/pin`, headers: { cookie } });
      }
    });

    it("rejects an unknown sort rather than silently ignoring it", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&sort=whatever",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── the card's tab badges (2026-08-26) ─────────────────────────────────────

  describe("what is still live behind each tab", () => {
    let clientId: string;
    let taskId: string;

    const counts = async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json().counts as {
        tasks: number;
        meetings: number;
        invoices: number;
        files: number;
      };
    };

    beforeAll(async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { cookie },
        payload: { firstName: "Badge", lastName: "Counts", companies: [], people: [] },
      });
      clientId = created.json().id;
    });

    afterAll(async () => {
      await prisma.invoice.deleteMany({ where: { clientId } });
      await prisma.task.deleteMany({ where: { clientId } });
      await prisma.meeting.deleteMany({ where: { clientId } });
      await prisma.client.deleteMany({ where: { id: clientId } });
    });

    it("is all zeroes on a client with nothing on them", async () => {
      expect(await counts()).toEqual({ tasks: 0, meetings: 0, invoices: 0, files: 0 });
    });

    it("counts an open task, and stops counting it once it is done", async () => {
      const task = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { cookie },
        // internal: firm-side work attributed to this client. It needs no subscription, and it is
        // exactly what the card's Tasks tab shows — which is the rule the badge has to match.
        payload: { title: "Something to do", clientId, internal: true, assignees: [] },
      });
      expect(task.statusCode).toBe(201);
      taskId = task.json().id;
      expect((await counts()).tasks).toBe(1);

      await app.inject({
        method: "PATCH",
        url: `/api/tasks/${taskId}`,
        headers: { cookie },
        payload: { done: true },
      });
      // the badge asks the same question the tab does: what is still OPEN
      expect((await counts()).tasks).toBe(0);
    });

    it("counts a meeting still to come, but not one already past", async () => {
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
      await prisma.meeting.create({
        data: { title: "Next week", clientId, startAt: new Date(future), durationMinutes: 15 },
      });
      await prisma.meeting.create({
        data: { title: "Last week", clientId, startAt: new Date(past), durationMinutes: 15 },
      });
      expect((await counts()).meetings).toBe(1);
    });

    it("stops counting a cancelled meeting", async () => {
      await prisma.meeting.updateMany({
        where: { clientId, title: "Next week" },
        data: { cancelledAt: new Date() },
      });
      expect((await counts()).meetings).toBe(0);
    });

    it("counts what is still owed, and drops it when the invoice is settled", async () => {
      const invoice = await prisma.invoice.create({
        data: { number: `BADGE-${Date.now()}`, clientId, amount: 5_000, paidTotal: 0 },
      });
      expect((await counts()).invoices).toBe(1);

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { paidTotal: 5_000 },
      });
      expect((await counts()).invoices).toBe(0);
    });

    it("does not count a cancelled invoice as something to chase", async () => {
      const invoice = await prisma.invoice.create({
        data: { number: `BADGE-VOID-${Date.now()}`, clientId, amount: 7_000, paidTotal: 0 },
      });
      expect((await counts()).invoices).toBe(1);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { cancelledAt: new Date() },
      });
      expect((await counts()).invoices).toBe(0);
    });

    it("counts the files on the card", async () => {
      const form =
        `--X\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\nhello\r\n--X--\r\n`;
      const up = await app.inject({
        method: "POST",
        url: `/api/clients/${clientId}/files`,
        headers: { cookie, "content-type": "multipart/form-data; boundary=X" },
        payload: form,
      });
      expect(up.statusCode).toBe(201);
      expect((await counts()).files).toBe(1);
    });

    it("the LIST does not pay for the counts — they are the card's read alone", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/clients?tab=all&pageSize=100&search=Badge",
        headers: { cookie },
      });
      const row = res.json().items.find((c: { id: string }) => c.id === clientId);
      expect(row).toBeTruthy();
      expect(row.counts).toBeUndefined();
    });
  });
});
