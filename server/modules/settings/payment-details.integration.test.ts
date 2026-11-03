import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import type { PaymentDetails } from "@shared/schema/payment-details.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { wipePaymentDetails } from "../../test/payment-details.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { makePaymentDetailsDefault } from "./payment-details.repository.js";

/**
 * **Sets of payment details, and a set per client** (payments.md §10; the client's requests 3 and
 * 4 of 2026-11-02): Settings → Invoices edits them, an admin's writes; the client card names one.
 * What an invoice copies at issue is `payments/payment-details-copy.integration.test.ts`.
 */

const TAG = `pd${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
const BASE = "/api/settings/payment-details";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let colleague: Person;
let clientId: string;

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers, payload }),
    patch: (url: string, payload: object = {}) =>
      app.inject({ method: "PATCH", url, headers, payload }),
    put: (url: string, payload: object = {}) =>
      app.inject({ method: "PUT", url, headers, payload }),
  };
}

async function setGate(who: Person, gate: GateKey, state: "open" | "read_only" | "closed") {
  await prisma.accessOverride.upsert({
    where: { userId_gate_action: { userId: who.id, gate, action: "*" } },
    update: { state },
    create: { userId: who.id, gate, state },
  });
  invalidateAccessCache();
}

/** The log is written after the response, so an assertion on it waits. */
async function recorded(action: string, subjectId: string, since: Date) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

async function add(name: string, details = `Bank ${name}\nAccount ${TAG}`) {
  const res = await as(admin).post(BASE, { name, details });
  expect(res.statusCode).toBe(201);
  const list = res.json<PaymentDetails[]>();
  return { list, set: list.find((s) => s.name === name)! };
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  await wipePaymentDetails();
  [admin] = await createPeople(app, DOMAIN, ["Olena"], "admin");
  [colleague] = await createPeople(app, DOMAIN, ["Petro"]);
  const client = await prisma.client.create({ data: { firstName: `${TAG} Taylor` } });
  clientId = client.id;
});

afterAll(async () => {
  await wipePaymentDetails();
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("the sets", () => {
  let us: PaymentDetails;
  let international: PaymentDetails;

  it("makes the first set the default, and logs its text", async () => {
    const since = new Date();
    // every live client names no set yet, so the default is theirs
    const everybody = await prisma.client.count({ where: { archivedAt: null } });
    const { list, set } = await add("US clients");
    us = set;
    expect(list).toHaveLength(1);
    expect(us).toMatchObject({ isDefault: true, archivedAt: null, clients: everybody });

    const created = await recorded("payment_details.created", us.id, since);
    expect(created.changes).toEqual({ details: us.details });
    await recorded("payment_details.default_changed", us.id, since);
  });

  it("adds the next one beside it, and refuses a name a live set already has", async () => {
    ({ set: international } = await add("International"));
    expect(international.isDefault).toBe(false);
    const clash = await as(admin).post(BASE, { name: "international", details: "x" });
    expect(clash.statusCode).toBe(409);
  });

  it("logs the changed line of a long block, past what the log keeps of a value", async () => {
    const opening = Array.from({ length: 12 }, (_, i) => `Bank line ${i} of the block`).join(
      "\n",
    );
    const first = new Date();
    await as(admin).patch(`${BASE}/${international.id}`, {
      details: `${opening}\nAccount 1111`,
    });
    // that save's own row first, or it could be the one read below
    await recorded("payment_details.updated", international.id, first);
    const since = new Date();
    const res = await as(admin).patch(`${BASE}/${international.id}`, {
      name: "Outside the US",
      details: `${opening}\nAccount 2222`,
    });
    expect(res.statusCode).toBe(200);

    const event = await recorded("payment_details.updated", international.id, since);
    expect(event.changes).toEqual({
      name: { from: "International", to: "Outside the US" },
      details: { from: "Account 1111", to: "Account 2222" },
    });
    expect(event.subjectLabel).toBe("Outside the US");
  });

  it("writes nothing for a save that changes nothing", async () => {
    const since = new Date();
    const res = await as(admin).patch(`${BASE}/${us.id}`, { name: us.name });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.activityEvent.count({
      where: {
        action: "payment_details.updated",
        subjectId: us.id,
        occurredAt: { gte: since },
      },
    });
    expect(rows).toBe(0);
  });

  it("saves lines that only changed their order, and says so in the log", async () => {
    const reordered = us.details.split("\n").reverse().join("\n");
    const res = await as(admin).patch(`${BASE}/${us.id}`, { details: reordered });
    expect(res.json<PaymentDetails[]>().find((s) => s.id === us.id)?.details).toBe(reordered);
    // by its content rather than its time: this set has no other update row
    await expect
      .poll(
        async () =>
          (
            await prisma.activityEvent.findFirst({
              where: { action: "payment_details.updated", subjectId: us.id },
            })
          )?.changes,
      )
      .toEqual({ details: { from: us.details, to: reordered } });
    us = { ...us, details: reordered };
  });

  it("moves the default, and the database holds one live default", async () => {
    const since = new Date();
    const res = await as(admin).post(`${BASE}/${international.id}/default`);
    const list = res.json<PaymentDetails[]>();
    expect(list.filter((s) => s.isDefault).map((s) => s.id)).toEqual([international.id]);
    await recorded("payment_details.default_changed", international.id, since);

    await expect(
      prisma.paymentDetails.update({ where: { id: us.id }, data: { isDefault: true } }),
    ).rejects.toMatchObject({ code: "P2002" });

    await as(admin).post(`${BASE}/${us.id}/default`);
  });

  it("archives only a set that is not the default and no client names", async () => {
    expect((await as(admin).post(`${BASE}/${us.id}/archive`)).statusCode).toBe(409);

    await prisma.client.update({
      where: { id: clientId },
      data: { paymentDetailsId: international.id },
    });
    const inUse = await as(admin).post(`${BASE}/${international.id}/archive`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error.message).toMatch(/used by 1 client/);

    await prisma.client.update({ where: { id: clientId }, data: { paymentDetailsId: null } });
    const since = new Date();
    const res = await as(admin).post(`${BASE}/${international.id}/archive`);
    expect(res.statusCode).toBe(200);
    expect(
      res.json<PaymentDetails[]>().find((s) => s.id === international.id)?.archivedAt,
    ).not.toBeNull();
    await recorded("payment_details.archived", international.id, since);
  });

  it("keeps an archived set as it was: no edit, no default, out of the options", async () => {
    expect(
      (await as(admin).patch(`${BASE}/${international.id}`, { name: "x" })).statusCode,
    ).toBe(409);
    expect((await as(admin).post(`${BASE}/${international.id}/default`)).statusCode).toBe(409);
    const options = await as(admin).get(`${BASE}/options`);
    expect(options.json<{ id: string }[]>().map((o) => o.id)).not.toContain(international.id);
    // and its name can be used again by a live set
    await add("International");
  });

  it("lets a set go that only an archived client still names", async () => {
    const { set: old } = await add("Old bank");
    await prisma.client.create({
      data: { firstName: `${TAG} Gone`, archivedAt: new Date(), paymentDetailsId: old.id },
    });
    const res = await as(admin).post(`${BASE}/${old.id}/archive`);
    expect(res.statusCode).toBe(200);
  });

  it("holds both rules in the database, past the service's own check", async () => {
    // a set archived between the service's read and the write, by another admin
    const archived = await prisma.paymentDetails.findFirstOrThrow({
      where: { archivedAt: { not: null } },
    });
    await expect(makePaymentDetailsDefault(archived.id)).rejects.toThrow(/archived meanwhile/);
    expect(
      (await prisma.paymentDetails.findMany({ where: { isDefault: true, archivedAt: null } }))
        .length,
    ).toBe(1);
    // the client's half is `clients/client-payment-details.integration.test.ts`
  });

  it("compares whole names, so a % or a trailing \\ is only a character", async () => {
    await add("Wire 50 hours");
    await add("Wire 50%");
    await add("Wire \\");
    const clash = await as(admin).post(BASE, { name: "WIRE 50%", details: "x" });
    expect(clash.statusCode).toBe(409);
  });
});

describe("who sees what", () => {
  it("gives every screen the names, never the text", async () => {
    await setGate(colleague, "settings", "closed");
    const res = await as(colleague).get(`${BASE}/options`);
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      isDefault: expect.any(Boolean),
    });
    expect(res.body).not.toContain(TAG);
    expect((await as(colleague).get(BASE)).statusCode).toBe(403);
    // nor on the settings every screen reads, which is `shared()` as well
    expect((await as(colleague).get("/api/settings")).body).not.toContain(TAG);
  });

  it("reads the text for whoever has Settings, and leaves every write an admin's", async () => {
    await setGate(colleague, "settings", "open");
    expect((await as(colleague).get(BASE)).statusCode).toBe(200);
    const [set] = (await as(colleague).get(BASE)).json<PaymentDetails[]>();
    expect((await as(colleague).post(BASE, { name: "Mine", details: "x" })).statusCode).toBe(
      403,
    );
    expect((await as(colleague).patch(`${BASE}/${set.id}`, { name: "y" })).statusCode).toBe(
      403,
    );
    expect((await as(colleague).post(`${BASE}/${set.id}/default`)).statusCode).toBe(403);
    expect((await as(colleague).post(`${BASE}/${set.id}/archive`)).statusCode).toBe(403);
  });
});

describe("a client's own set", () => {
  const url = () => `/api/clients/${clientId}/payment-details`;

  it("is an admin's to change, and logged in words", async () => {
    const [set] = (await as(admin).get(`${BASE}/options`))
      .json<{ id: string; name: string; isDefault: boolean }[]>()
      .filter((o) => !o.isDefault);

    let since = new Date();
    const res = await as(admin).put(url(), { paymentDetailsId: set.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().paymentDetails).toEqual({ id: set.id, name: set.name });
    let event = await recorded("client.payment_details_changed", clientId, since);
    expect(event.changes).toEqual({ paymentDetails: { from: "Firm default", to: set.name } });
    expect(event.clientId).toBe(clientId);

    since = new Date();
    await as(admin).put(url(), { paymentDetailsId: null });
    event = await recorded("client.payment_details_changed", clientId, since);
    expect(event.changes).toEqual({ paymentDetails: { from: set.name, to: "Firm default" } });
  });

  it("takes the client back to everybody when the default is picked, and counts them there", async () => {
    const options = (await as(admin).get(`${BASE}/options`)).json<
      { id: string; name: string; isDefault: boolean }[]
    >();
    const fallback = options.find((o) => o.isDefault)!;
    const other = options.find((o) => !o.isDefault)!;
    const count = async (id: string) =>
      (await as(admin).get(BASE)).json<PaymentDetails[]>().find((s) => s.id === id)!.clients;
    const before = { fallback: await count(fallback.id), other: await count(other.id) };

    expect((await as(admin).put(url(), { paymentDetailsId: other.id })).statusCode).toBe(200);
    expect(await count(fallback.id)).toBe(before.fallback - 1);
    expect(await count(other.id)).toBe(before.other + 1);

    const since = new Date();
    const back = await as(admin).put(url(), { paymentDetailsId: fallback.id });
    expect(back.statusCode).toBe(200);
    // not pinned to the default by id: the firm's next default would leave such a client behind
    expect(back.json().paymentDetails).toBeNull();
    const event = await recorded("client.payment_details_changed", clientId, since);
    expect(event.changes).toEqual({ paymentDetails: { from: other.name, to: "Firm default" } });
    expect(await count(fallback.id)).toBe(before.fallback);
    expect(await count(other.id)).toBe(before.other);
  });

  it("unpins a client pinned to the default by id, and counts one on an archived set there", async () => {
    const fallback = (await as(admin).get(BASE))
      .json<PaymentDetails[]>()
      .find((s) => s.isDefault)!;
    // a pin made while the set was not yet the default
    await prisma.client.update({
      where: { id: clientId },
      data: { paymentDetailsId: fallback.id },
    });
    const since = new Date();
    const res = await as(admin).put(url(), { paymentDetailsId: fallback.id });
    expect(res.json().paymentDetails).toBeNull();
    const event = await recorded("client.payment_details_changed", clientId, since);
    expect(event.changes).toEqual({
      paymentDetails: { from: fallback.name, to: "Firm default" },
    });

    // restored onto a set archived meanwhile: they print the default, so they count there
    const archived = await prisma.paymentDetails.findFirstOrThrow({
      where: { archivedAt: { not: null } },
    });
    await prisma.client.create({
      data: { firstName: `${TAG} Restored`, paymentDetailsId: archived.id },
    });
    const after = (await as(admin).get(BASE)).json<PaymentDetails[]>();
    expect(after.find((s) => s.id === fallback.id)!.clients).toBe(fallback.clients + 1);
  });

  it("shows on the client's card for everybody, by name", async () => {
    const res = await as(colleague).get(`/api/clients/${clientId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("paymentDetails", null);
  });

  it("refuses an archived set, and a colleague", async () => {
    const archived = await prisma.paymentDetails.findFirstOrThrow({
      where: { archivedAt: { not: null } },
    });
    const res = await as(admin).put(url(), { paymentDetailsId: archived.id });
    expect(res.statusCode).toBe(400);

    await setGate(colleague, "clients", "open");
    expect((await as(colleague).put(url(), { paymentDetailsId: null })).statusCode).toBe(403);
  });
});
