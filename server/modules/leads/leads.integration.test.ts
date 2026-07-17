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
  await prisma.clientCompany.deleteMany();
  await prisma.file.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "User",
      email: "user@leads.local",
      passwordHash: await argon2.hash("password-123"),
      role: "user",
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "user@leads.local", password: "password-123" },
  });
  cookie = cookieOf(res);
});

afterAll(async () => {
  await app.close();
});

describe("leads", () => {
  let leadId: string;

  it("requires at least one contact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "No Contact" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a lead at first_contact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "Maria Bond", phone: "+380671234567" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    leadId = body.id;
    expect(body.stage).toBe("first_contact");
    expect(body.outcome).toBe("in_process");
  });

  it("moves the lead across pipeline stages", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { stage: "set_up_meeting" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stage).toBe("set_up_meeting");
  });

  it("cannot strip the last contact on edit", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { phone: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("marks lost and reopens", async () => {
    const lost = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/mark-lost`,
      headers: { cookie },
    });
    expect(lost.json().outcome).toBe("lost");

    const reopened = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/reopen`,
      headers: { cookie },
    });
    expect(reopened.json().outcome).toBe("in_process");
  });

  it("converts the lead into a client and locks it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/convert`,
      headers: { cookie },
      payload: { firstName: "Maria", lastName: "Bond", phone: "+380671234567" },
    });
    expect(res.statusCode).toBe(200);
    const { clientId, lead } = res.json();
    expect(lead.outcome).toBe("won");
    expect(lead.convertedClientId).toBe(clientId);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.firstName).toBe("Maria");

    // converted lead is read-only
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { name: "Changed" },
    });
    expect(edit.statusCode).toBe(400);

    const again = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/convert`,
      headers: { cookie },
      payload: { firstName: "X", lastName: "Y" },
    });
    expect(again.statusCode).toBe(400);
  });
});
