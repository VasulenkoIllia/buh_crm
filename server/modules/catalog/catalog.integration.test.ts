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
