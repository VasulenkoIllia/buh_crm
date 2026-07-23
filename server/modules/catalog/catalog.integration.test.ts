import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.clientServiceCategory.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.file.deleteMany();
  await prisma.service.deleteMany();
  await prisma.user.deleteMany();

  const pass = await argon2.hash("password-123");
  await prisma.user.createMany({
    data: [
      { firstName: "Cat", lastName: "Admin", email: "cat-admin@test.local", passwordHash: pass, role: "admin", status: "active" },
      { firstName: "Cat", lastName: "User", email: "cat-user@test.local", passwordHash: pass, role: "user", status: "active" },
    ],
  });
  adminCookie = await login("cat-admin@test.local", "password-123");
  userCookie = await login("cat-user@test.local", "password-123");
});

afterAll(async () => {
  await prisma.subscription.deleteMany();
  await prisma.clientServiceCategory.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
  await app.close();
});

describe("catalog", () => {
  let serviceId: string;

  it("admin creates a service (color auto-assigned) — non-admin cannot", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: userCookie },
      payload: { name: "Bookkeeping", type: "subscription" },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bookkeeping", type: "subscription", defaultAmount: 20000, invoiceTrigger: "on_period_start", invoiceDay: 5 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    serviceId = body.id;
    expect(body.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(body.clientsCount).toBe(0);

    // duplicate name in a different case → 409
    const dup = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "bookkeeping", type: "one_time" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("everyone can read the catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog", headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("validates rhythm day-of-period against the periodicity", async () => {
    const bad = [
      { periodicity: "monthly", dayOfPeriod: 40 },
      { periodicity: "weekly", dayOfPeriod: 8 },
      { periodicity: "once", dayOfPeriod: 1 },
    ];
    for (const rhythm of bad) {
      const res = await app.inject({
        method: "POST",
        url: `/api/catalog/${serviceId}/tasks`,
        headers: { cookie: adminCookie },
        payload: { name: "Bad rhythm", ...rhythm },
      });
      expect(res.statusCode).toBe(400);
    }

    const ok = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Bank reconciliation", periodicity: "monthly", dayOfPeriod: 25, deadlineOffsetDays: 2, estimatedMinutes: 90 },
    });
    expect(ok.statusCode).toBe(201);
    const tpl = ok.json().taskTemplates[0];
    expect(tpl).toMatchObject({ name: "Bank reconciliation", dayOfPeriod: 25, estimatedMinutes: 90 });
  });

  it("supports last-day (-1) and quarterly month-of-period rhythms", async () => {
    const lastDay = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Close the month", periodicity: "monthly", dayOfPeriod: -1 },
    });
    expect(lastDay.statusCode).toBe(201);

    const quarterly = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Quarterly report", periodicity: "quarterly", monthOfPeriod: 2, dayOfPeriod: -1 },
    });
    expect(quarterly.statusCode).toBe(201);
    const tpl = quarterly
      .json()
      .taskTemplates.find((t: { name: string }) => t.name === "Quarterly report");
    expect(tpl).toMatchObject({ monthOfPeriod: 2, dayOfPeriod: -1 });

    const badMonth = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Bad", periodicity: "quarterly", monthOfPeriod: 4, dayOfPeriod: 1 },
    });
    expect(badMonth.statusCode).toBe(400);
  });

  it("enforces billing rule ↔ service type combinations", async () => {
    // one-time cannot bill by period
    const badOneTime = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bad one-time", type: "one_time", invoiceTrigger: "on_period_start" },
    });
    expect(badOneTime.statusCode).toBe(400);

    // subscription cannot bill on complete
    const badSub = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bad sub", type: "subscription", invoiceTrigger: "on_complete" },
    });
    expect(badSub.statusCode).toBe(400);

    // end-of-period is valid for subscriptions
    const endOk = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Payroll", type: "subscription", invoiceTrigger: "on_period_end" },
    });
    expect(endOk.statusCode).toBe(201);

    // merged check on PATCH: flipping type must not leave an invalid rule behind
    const flip = await app.inject({
      method: "PATCH",
      url: `/api/catalog/${serviceId}`,
      headers: { cookie: adminCookie },
      payload: { type: "one_time" }, // service currently bills on_period_start
    });
    expect(flip.statusCode).toBe(400);
  });

  it("subscription flips the client to regular and counts toward clientsCount", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Sub", lastName: "Client", companyNames: [], people: [] },
    });
    const clientId = created.json().id;
    expect(created.json().isRegular).toBe(false);

    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 25000, period: "month" },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().isRegular).toBe(true);
    expect(sub.json().subscriptions[0]).toMatchObject({ serviceId, amount: 25000, period: "month", active: true });

    const catalog = await app.inject({ method: "GET", url: "/api/catalog", headers: { cookie: adminCookie } });
    expect(catalog.json()[0].clientsCount).toBe(1);

    // deactivate → back to one-time (regularOverride stays null)
    const subId = sub.json().subscriptions[0].id;
    const off = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    expect(off.json().isRegular).toBe(false);
  });

  it("a one-time subscription does NOT make the client regular", async () => {
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Ad-hoc Jobs", type: "one_time" },
    });
    const oneTimeId = svc.json().id;

    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Adhoc", lastName: "Client", companyNames: [], people: [] },
    });
    const clientId = created.json().id;

    // one-time sub = container for manual jobs — client stays one-time
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: oneTimeId, amount: 5000 },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().isRegular).toBe(false);

    // …and the list keeps them on the one-time tab
    const list = await app.inject({
      method: "GET",
      url: "/api/clients?tab=one_time",
      headers: { cookie: adminCookie },
    });
    expect(list.json().items.some((c: { id: string }) => c.id === clientId)).toBe(true);

    // a subscription-type service still flips them to regular
    const regular = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    expect(regular.json().isRegular).toBe(true);
  });

  it("stores per-client billing timing on the subscription (preset override)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Bill", lastName: "Override", companyNames: [], people: [] },
    });
    const clientId = created.json().id;

    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000, period: "quarter", invoiceTrigger: "on_period_end" },
    });
    expect(sub.statusCode).toBe(201);
    const row = sub.json().subscriptions[0];
    expect(row).toMatchObject({ period: "quarter", invoiceTrigger: "on_period_end", invoiceDay: null });

    // switch to a custom day per client
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${row.id}`,
      headers: { cookie: adminCookie },
      payload: { invoiceTrigger: "on_period_start", invoiceDay: 10 },
    });
    expect(patched.json().subscriptions[0]).toMatchObject({
      invoiceTrigger: "on_period_start",
      invoiceDay: 10,
    });

    // day-only PATCH is fine while the stored trigger is start-of-period (merged check)
    const dayOnly = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${row.id}`,
      headers: { cookie: adminCookie },
      payload: { invoiceDay: 20 },
    });
    expect(dayOnly.statusCode).toBe(200);
    expect(dayOnly.json().subscriptions[0].invoiceDay).toBe(20);

    // a custom day requires start-of-period billing
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${row.id}`,
      headers: { cookie: adminCookie },
      payload: { invoiceTrigger: "on_period_end", invoiceDay: 10 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("carries dueDays preset → subscription override; deletes only unused services", async () => {
    // dueDays preset on a fresh service
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Due Test", type: "subscription", dueDays: 14 },
    });
    expect(svc.statusCode).toBe(201);
    expect(svc.json().dueDays).toBe(14);
    const dueServiceId = svc.json().id;

    // subscription can override the preset
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Due", lastName: "Days", companyNames: [], people: [] },
    });
    const clientId = created.json().id;
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: dueServiceId, amount: 5000, dueDays: 30 },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().subscriptions[0].dueDays).toBe(30);

    // used service cannot be deleted…
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/catalog/${dueServiceId}`,
      headers: { cookie: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);

    // …an unused one can
    const fresh = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Throwaway", type: "one_time" },
    });
    const gone = await app.inject({
      method: "DELETE",
      url: `/api/catalog/${fresh.json().id}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/catalog", headers: { cookie: adminCookie } });
    expect(list.json().some((s: { name: string }) => s.name === "Throwaway")).toBe(false);
  });

  it("stores category chips and rejects unknown services", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Cat", lastName: "Chips", companyNames: [], people: [] },
    });
    const clientId = created.json().id;

    const ok = await app.inject({
      method: "PUT",
      url: `/api/clients/${clientId}/categories`,
      headers: { cookie: adminCookie },
      payload: { serviceIds: [serviceId] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().categories).toEqual([serviceId]);

    const bad = await app.inject({
      method: "PUT",
      url: `/api/clients/${clientId}/categories`,
      headers: { cookie: adminCookie },
      payload: { serviceIds: ["00000000-0000-4000-8000-000000000000"] },
    });
    expect(bad.statusCode).toBe(400);

    // NEW chips must reference active services; existing chips survive deactivation
    const tmp = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Chip Retired", type: "subscription" },
    });
    const retiredId = tmp.json().id;
    await app.inject({
      method: "PUT",
      url: `/api/clients/${clientId}/categories`,
      headers: { cookie: adminCookie },
      payload: { serviceIds: [serviceId, retiredId] },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/catalog/${retiredId}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    const keep = await app.inject({
      method: "PUT",
      url: `/api/clients/${clientId}/categories`,
      headers: { cookie: adminCookie },
      payload: { serviceIds: [serviceId, retiredId] },
    });
    expect(keep.statusCode).toBe(200); // keeping the now-inactive chip is fine…

    const other = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Cat2", lastName: "Chips", companyNames: [], people: [] },
    });
    const inactiveAdd = await app.inject({
      method: "PUT",
      url: `/api/clients/${other.json().id}/categories`,
      headers: { cookie: adminCookie },
      payload: { serviceIds: [retiredId] },
    });
    expect(inactiveAdd.statusCode).toBe(400); // …adding it fresh elsewhere is not
  });

  it("merge-validates subscription billing and template rhythm on partial PATCH", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Merge", lastName: "Check", companyNames: [], people: [] },
    });
    const clientId = created.json().id;
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 1000, invoiceTrigger: "on_period_start", invoiceDay: 5 },
    });
    const subId = sub.json().subscriptions[0].id;

    // trigger-only PATCH must not leave a stale custom day behind
    const badPatch = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: { invoiceTrigger: "on_period_end" },
    });
    expect(badPatch.statusCode).toBe(400);

    // template: day-only PATCH must respect the stored weekly periodicity
    const tpl = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Weekly check", periodicity: "weekly", dayOfPeriod: 1 },
    });
    const tplId = tpl
      .json()
      .taskTemplates.find((t: { name: string }) => t.name === "Weekly check").id;
    const badDay = await app.inject({
      method: "PATCH",
      url: `/api/catalog/${serviceId}/tasks/${tplId}`,
      headers: { cookie: adminCookie },
      payload: { dayOfPeriod: 25 },
    });
    expect(badDay.statusCode).toBe(400);
  });

  it("blocks duplicate subscriptions for the same target, allows different companies", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: {
        type: "individual",
        firstName: "Dup",
        lastName: "Rule",
        companyNames: ["Alpha LLC"],
        people: [],
      },
    });
    const client = created.json();
    const companyId = client.companies[0].id;

    const first = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 1000 },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 2000 },
    });
    expect(dup.statusCode).toBe(400); // same target (client root)

    const otherCompany = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 2000, companyId },
    });
    expect(otherCompany.statusCode).toBe(201); // different company — allowed
  });

  it("stores per-client task overrides on the subscription (rhythmOverrides)", async () => {
    // fresh service + template + client + subscription
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Override Svc", type: "subscription" },
    });
    const ovServiceId = svc.json().id;
    const tpl = await app.inject({
      method: "POST",
      url: `/api/catalog/${ovServiceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Weekly report", periodicity: "weekly", dayOfPeriod: 1 },
    });
    const templateId = tpl.json().taskTemplates[0].id;

    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Ov", lastName: "Client", companyNames: [], people: [] },
    });
    const clientId = created.json().id;
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: ovServiceId, amount: 1000 },
    });
    const subId = sub.json().subscriptions[0].id;

    // valid per-client override (different weekday + planned time)
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: {
        rhythmOverrides: {
          [templateId]: {
            enabled: true,
            periodicity: "weekly",
            dayOfPeriod: 3,
            monthOfPeriod: null,
            deadlineOffsetDays: 2,
            estimatedMinutes: 150,
          },
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().subscriptions[0].rhythmOverrides[templateId]).toMatchObject({
      dayOfPeriod: 3,
      estimatedMinutes: 150,
    });

    // flag-only override: excludes the task but keeps following the template's rhythm
    const flagOnly = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: { rhythmOverrides: { [templateId]: { enabled: false } } },
    });
    expect(flagOnly.statusCode).toBe(200);
    expect(flagOnly.json().subscriptions[0].rhythmOverrides[templateId]).toEqual({
      enabled: false,
    });

    // a day without its periodicity is meaningless against a changing template → 400
    const orphanDay = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: { rhythmOverrides: { [templateId]: { enabled: true, dayOfPeriod: 3 } } },
    });
    expect(orphanDay.statusCode).toBe(400);

    // override keyed on a template that isn't part of this service → 400
    const wrongKey = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: {
        rhythmOverrides: {
          "00000000-0000-4000-8000-000000000000": {
            enabled: true,
            periodicity: "monthly",
            dayOfPeriod: 1,
            monthOfPeriod: null,
            deadlineOffsetDays: null,
            estimatedMinutes: null,
          },
        },
      },
    });
    expect(wrongKey.statusCode).toBe(400);

    // invalid rhythm inside the override (weekly + day 25) → 400
    const badRhythm = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie: adminCookie },
      payload: {
        rhythmOverrides: {
          [templateId]: {
            enabled: true,
            periodicity: "weekly",
            dayOfPeriod: 25,
            monthOfPeriod: null,
            deadlineOffsetDays: null,
            estimatedMinutes: null,
          },
        },
      },
    });
    expect(badRhythm.statusCode).toBe(400);
  });

  it("one-time services hold job presets only (periodicity once)", async () => {
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Job Container", type: "one_time" },
    });
    const oneTimeId = svc.json().id;

    // a rhythmic template on a one-time service is rejected…
    const weekly = await app.inject({
      method: "POST",
      url: `/api/catalog/${oneTimeId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Weekly nonsense", periodicity: "weekly", dayOfPeriod: 1 },
    });
    expect(weekly.statusCode).toBe(400);

    // …a job preset (once + deadline + planned time) is fine
    const preset = await app.inject({
      method: "POST",
      url: `/api/catalog/${oneTimeId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Prepare documents", periodicity: "once", deadlineOffsetDays: 5, estimatedMinutes: 60 },
    });
    expect(preset.statusCode).toBe(201);
    const tplId = preset.json().taskTemplates[0].id;

    // …and cannot gain a rhythm later via PATCH either
    const drift = await app.inject({
      method: "PATCH",
      url: `/api/catalog/${oneTimeId}/tasks/${tplId}`,
      headers: { cookie: adminCookie },
      payload: { periodicity: "monthly", dayOfPeriod: 1 },
    });
    expect(drift.statusCode).toBe(400);
  });

  it("convert carries the lead's service into the client's categories", async () => {
    const lead = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie: adminCookie },
      payload: { type: "individual", name: "Converted WithService", phone: "+380501110000", serviceId },
    });
    const convert = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.json().id}/convert`,
      headers: { cookie: adminCookie },
      payload: { type: "individual", firstName: "Converted", lastName: "WithService" },
    });
    expect(convert.statusCode).toBe(200);
    const client = await app.inject({
      method: "GET",
      url: `/api/clients/${convert.json().clientId}`,
      headers: { cookie: adminCookie },
    });
    expect(client.json().categories).toContain(serviceId);
  });

  it("persists the service on leads and people", async () => {
    const lead = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie: adminCookie },
      payload: { type: "individual", name: "Lead WithService", phone: "+380501112233", serviceId },
    });
    expect(lead.statusCode).toBe(201);
    expect(lead.json().serviceId).toBe(serviceId);

    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: {
        type: "individual",
        firstName: "Person",
        lastName: "Service",
        companyNames: [],
        people: [{ name: "Handler", serviceId }],
      },
    });
    expect(client.statusCode).toBe(201);
    expect(client.json().people[0].serviceId).toBe(serviceId);
  });
});
