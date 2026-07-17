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
  await prisma.clientCompany.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.file.deleteMany();
  await prisma.client.deleteMany();
  await prisma.company.deleteMany();
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
  let clientId: string;

  it("creates a client with companies (created by name)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Ivan",
        lastName: "Petrenko",
        phone: "+380501112233",
        email: "ivan@example.com",
        companyNames: ["Alpha LLC", "Beta Inc"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    clientId = body.id;
    expect(body.companies.map((c: { name: string }) => c.name).sort()).toEqual([
      "Alpha LLC",
      "Beta Inc",
    ]);
    expect(body.isRegular).toBe(false);
    expect(body.debt).toBe(0);
  });

  it("shares an existing company between clients (M:N, case-insensitive)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Olha",
        lastName: "Shevchenko",
        email: "olha@example.com",
        companyNames: ["alpha llc"],
      },
    });
    expect(res.statusCode).toBe(201);
    // no duplicate company created
    expect(await prisma.company.count()).toBe(2);
    const alpha = await prisma.company.findFirstOrThrow({ where: { name: "Alpha LLC" } });
    expect(await prisma.clientCompany.count({ where: { companyId: alpha.id } })).toBe(2);
  });

  it("searches by company name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients?search=beta",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].firstName).toBe("Ivan");
  });

  it("regular tab honors the manual override", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}`,
      headers: { cookie },
      payload: { regularOverride: true },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(clientId);
    expect(body.items[0].isRegular).toBe(true);
  });

  it("archives a client — gone from lists and from GET", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/archive`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/clients", headers: { cookie } });
    expect(list.json().items.some((c: { id: string }) => c.id === clientId)).toBe(false);

    const get = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}`,
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

    const list = await app.inject({
      method: "GET",
      url: `/api/clients/${other.id}/files`,
      headers: { cookie },
    });
    expect(list.json()).toHaveLength(1);

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
    expect(
      (await app.inject({
        method: "GET",
        url: `/api/clients/${other.id}/files`,
        headers: { cookie },
      })).json(),
    ).toHaveLength(0);
  });
});
