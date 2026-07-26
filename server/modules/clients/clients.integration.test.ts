import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";

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

  it("creates an individual with companies + people", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "individual",
        firstName: "Ivan",
        lastName: "Petrenko",
        phone: "+380501112233",
        email: "ivan@example.com",
        companyNames: ["Alpha LLC", "Beta Inc"],
        people: [{ name: "Olena Book", serviceLabel: "Bookkeeping", phone: "+380671110000" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    individualId = body.id;
    expect(body.type).toBe("individual");
    expect(body.displayName).toBe("Ivan Petrenko");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Alpha LLC", "Beta Inc"]);
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({ name: "Olena Book", serviceLabel: "Bookkeeping" });
    expect(body.isRegular).toBe(false);
    expect(body.debt).toBe(0);
  });

  it("rejects an individual without a name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { type: "individual", firstName: "OnlyFirst", email: "x@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a company-type client (displayName = company name)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "company",
        companyName: "Romashka LLC",
        firstName: "Petro",
        lastName: "Tkach",
        companyNames: ["Romashka Trade LLC"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe("company");
    expect(body.displayName).toBe("Romashka LLC");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Romashka Trade LLC"]);
  });

  it("rejects a company-type client without a company name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { type: "company", firstName: "No", lastName: "Company" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("companies are per-client text (not shared)", async () => {
    // Ivan(2) + Romashka Trade(1) = 3 rows total, none shared
    expect(await prisma.company.count()).toBe(3);
    const alphas = await prisma.company.findMany({ where: { name: "Alpha LLC" } });
    expect(alphas).toHaveLength(1);
    expect(alphas[0].clientId).toBe(individualId);
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

  it("a partial update (regular toggle only) keeps companies + people", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { regularOverride: true }, // no companyNames/people -> must not touch them
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isRegular).toBe(true);
    expect(res.json().companies).toHaveLength(2);
    expect(res.json().people).toHaveLength(1);
  });

  it("cannot blank an individual's name via a partial update", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { firstName: "" }, // no `type` in the patch — must still be rejected
    });
    expect(res.statusCode).toBe(400);
  });

  it("preserves an explicit regularOverride=false on an unrelated edit", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { regularOverride: false },
    });
    // edit an unrelated field WITHOUT sending regularOverride
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { address: "Kyiv" },
    });
    expect(res.statusCode).toBe(200);
    const dbClient = await prisma.client.findUniqueOrThrow({ where: { id: individualId } });
    expect(dbClient.regularOverride).toBe(false);
    // restore for later tests
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { regularOverride: true },
    });
  });

  it("rejects a whitespace-only person name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "individual",
        firstName: "A",
        lastName: "B",
        email: "ws@example.com",
        people: [{ name: "   " }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("regular tab honors the manual override", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.items.some((c: { id: string }) => c.id === individualId)).toBe(true);
    expect(body.counts.regular).toBeGreaterThanOrEqual(1);
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
        type: "individual",
        firstName: "Company",
        lastName: "Dimension",
        companyNames: ["Alpha Ltd", "Beta Ltd"],
        people: [],
      },
    });
    const client = created.json();
    const alpha = client.companies.find((c: { name: string }) => c.name === "Alpha Ltd");

    await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 5_000, period: "month", companyId: alpha.id },
    });

    // an ordinary edit that re-sends the same company list
    const resaved = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { phone: "+380000000000", companyNames: ["Alpha Ltd", "Beta Ltd"] },
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
      payload: { companyNames: ["Beta Ltd"] },
    });
    expect(drop.statusCode).toBe(409);
    expect(drop.json().error.message).toContain("Alpha Ltd");

    // an unused one still goes away
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { companyNames: ["Alpha Ltd"] },
    });
    expect(ok.json().companies.map((c: { name: string }) => c.name)).toEqual(["Alpha Ltd"]);
  });

  it("archiving a client takes their tasks off the board but leaves the invoices", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { type: "individual", firstName: "Gone", lastName: "Away", companyNames: [], people: [] },
    });
    const client = created.json();
    const service = await prisma.service.create({
      data: { name: "Archived client job", color: "#1f8f3a", type: "one_time", defaultAmount: 1_000 },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 1_000, period: "month" },
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
});