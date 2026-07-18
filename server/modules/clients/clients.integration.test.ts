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
});
