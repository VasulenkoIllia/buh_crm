import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InvoiceItem } from "@shared/schema/invoice-items.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **Invoice items** (payments.md §3; the client's request 1 of 2026-11-02): Settings → Invoices
 * keeps the list, an invoice's line records which item it came from and keeps its own copy.
 */

const TAG = `ii${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
const BASE = "/api/settings/invoice-items";
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
    delete: (url: string) => app.inject({ method: "DELETE", url, headers }),
  };
}

/** The log is written after the response, so an assertion on it waits. */
const recorded = (action: string, subjectId: string, since: Date) =>
  vi.waitFor(
    async () => {
      const row = await prisma.activityEvent.findFirst({
        where: { action, subjectId, occurredAt: { gte: since } },
        orderBy: { occurredAt: "desc" },
      });
      if (!row) throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
      return row;
    },
    { timeout: 1000, interval: 20 },
  );

async function add(name: string, unit: "hour" | "item", price: number | null) {
  const res = await as(admin).post(BASE, { name, unit, price });
  expect(res.statusCode).toBe(201);
  return res.json<InvoiceItem[]>().find((item) => item.name === name)!;
}

const mine = (list: InvoiceItem[]) => list.filter((item) => item.name.startsWith(TAG));

type Line = {
  description: string;
  unitRate: number | null;
  amount: number;
  itemId: string | null;
};

async function issue(lines: object[]) {
  return as(admin).post("/api/invoices", { clientId, amount: 1, lines });
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  [admin] = await createPeople(app, DOMAIN, ["Olena"], "admin");
  [colleague] = await createPeople(app, DOMAIN, ["Petro"]);
  const client = await as(admin).post("/api/clients", {
    firstName: `${TAG} Taylor`,
    companies: [],
    people: [],
  });
  expect(client.statusCode).toBe(201);
  clientId = client.json().id;
});

afterAll(async () => {
  const ofMine = { client: { firstName: { startsWith: TAG } } };
  await prisma.invoiceLine.deleteMany({ where: { invoice: ofMine } });
  await prisma.invoice.deleteMany({ where: ofMine });
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await prisma.invoiceItem.deleteMany({ where: { name: { startsWith: TAG } } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("the list on Settings → Invoices", () => {
  it("adds items, lists them by name, and logs the unit and the price", async () => {
    const since = new Date();
    const w2 = await add(`${TAG} W-2 form`, "item", 50_00);
    await add(`${TAG} Advice`, "hour", null);
    expect(w2).toMatchObject({ unit: "item", price: 50_00, active: true });

    const list = mine((await as(admin).get(BASE)).json<InvoiceItem[]>());
    expect(list.map((item) => item.name)).toEqual([`${TAG} Advice`, `${TAG} W-2 form`]);

    const created = await recorded("invoice_item.created", w2.id, since);
    expect(created.subjectLabel).toBe(`${TAG} W-2 form`);
    expect(created.changes).toEqual({ unit: "item", price: 50_00 });
  });

  it("refuses a second item of the same name, whatever the case", async () => {
    const res = await as(admin).post(BASE, {
      name: `${TAG} w-2 FORM`,
      unit: "hour",
      price: null,
    });
    expect(res.statusCode).toBe(409);
  });

  it("compares whole names, so a % or a trailing \\ is only a character", async () => {
    await add(`${TAG} W-2%`, "item", null);
    await add(`${TAG} Filing \\`, "item", null);
  });

  it("is read by everybody, and changed only by whoever may change Settings", async () => {
    expect((await as(colleague).get(BASE)).statusCode).toBe(200);
    const res = await as(colleague).post(BASE, { name: `${TAG} Mine`, unit: "item", price: 1 });
    expect(res.statusCode).toBe(403);
  });

  it("changes a name, a unit, a price and the switch, and logs each change in words", async () => {
    const item = await add(`${TAG} Payroll`, "hour", 40_00);
    const since = new Date();
    const res = await as(admin).patch(`${BASE}/${item.id}`, {
      name: `${TAG} Payroll run`,
      unit: "item",
      price: 45_00,
      active: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<InvoiceItem[]>().find((i) => i.id === item.id)).toMatchObject({
      name: `${TAG} Payroll run`,
      unit: "item",
      price: 45_00,
      active: false,
    });
    const updated = await recorded("invoice_item.updated", item.id, since);
    expect(updated.changes).toEqual({
      name: { from: `${TAG} Payroll`, to: `${TAG} Payroll run` },
      unit: { from: "hour", to: "item" },
      price: { from: 40_00, to: 45_00 },
      active: { from: true, to: false },
    });
  });

  it("refuses a rename onto another item's name, and lets an item change its own case", async () => {
    const item = await add(`${TAG} Audit`, "hour", null);
    const clash = await as(admin).patch(`${BASE}/${item.id}`, { name: `${TAG} advice` });
    expect(clash.statusCode).toBe(409);
    const recased = await as(admin).patch(`${BASE}/${item.id}`, { name: `${TAG} AUDIT` });
    expect(recased.statusCode).toBe(200);
    expect(recased.json<InvoiceItem[]>().find((i) => i.id === item.id)?.name).toBe(
      `${TAG} AUDIT`,
    );
  });

  it("keeps an inactive item on the list Settings reads", async () => {
    const list = mine((await as(admin).get(BASE)).json<InvoiceItem[]>());
    expect(list.find((i) => i.name === `${TAG} Payroll run`)?.active).toBe(false);
  });

  it("deletes an item no line came from", async () => {
    const item = await add(`${TAG} Spare`, "item", null);
    const since = new Date();
    const res = await as(admin).delete(`${BASE}/${item.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<InvoiceItem[]>().some((i) => i.id === item.id)).toBe(false);
    await recorded("invoice_item.deleted", item.id, since);
  });
});

/** An invoice's Position box adds a name it does not find (owner, 2026-11-04). */
describe("an item added from an invoice's row", () => {
  const FROM_ROW = "/api/invoices/items";

  it("is added by whoever bills, Settings closed, and lands on the list Settings reads", async () => {
    const since = new Date();
    const res = await as(colleague).post(FROM_ROW, {
      name: `${TAG} Legal name change`,
      unit: "item",
      price: 120_00,
    });
    expect(res.statusCode).toBe(201);
    const added = res.json<InvoiceItem[]>().find((i) => i.name === `${TAG} Legal name change`);
    expect(added).toMatchObject({ unit: "item", price: 120_00, active: true });

    const list = mine((await as(admin).get(BASE)).json<InvoiceItem[]>());
    expect(list.some((i) => i.id === added!.id)).toBe(true);
    const created = await recorded("invoice_item.created", added!.id, since);
    expect(created.actorUserId).toBe(colleague.id);
    expect(created.changes).toEqual({ unit: "item", price: 120_00 });
  });

  it("refuses a name already on the list, and says when that item is switched off", async () => {
    const taken = await as(colleague).post(FROM_ROW, {
      name: `${TAG} legal NAME change`,
      unit: "hour",
      price: null,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toMatch(/already exists/);
    // switched off by the earlier describe
    const off = await as(colleague).post(FROM_ROW, {
      name: `${TAG} Payroll run`,
      unit: "hour",
      price: null,
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toMatch(/exists, switched off/);
  });

  it("is refused to somebody Billing is closed to", async () => {
    await prisma.accessOverride.create({
      data: { userId: colleague.id, gate: "billing", state: "closed" },
    });
    invalidateAccessCache();
    try {
      const res = await as(colleague).post(FROM_ROW, {
        name: `${TAG} Closed`,
        unit: "item",
        price: null,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await prisma.accessOverride.deleteMany({ where: { userId: colleague.id } });
      invalidateAccessCache();
    }
  });
});

describe("a line picked from an item", () => {
  let item: InvoiceItem;
  let invoiceId: string;

  beforeAll(async () => {
    item = await add(`${TAG} Bookkeeping`, "item", 100_00);
  });

  it("is stored as the form sent it, with the item it came from", async () => {
    const res = await issue([
      {
        description: `${TAG} Bookkeeping, October`,
        quantity: 200,
        unitRate: 90_00,
        amount: 0,
        unit: "item",
        itemId: item.id,
      },
      { description: "Filing fee", amount: 35_00 },
    ]);
    expect(res.statusCode).toBe(201);
    invoiceId = res.json().id;
    expect(res.json<{ lines: Line[] }>().lines).toMatchObject([
      {
        description: `${TAG} Bookkeeping, October`,
        unitRate: 90_00,
        amount: 180_00,
        itemId: item.id,
      },
      { description: "Filing fee", itemId: null },
    ]);
  });

  it("stays the same after the item is renamed and repriced", async () => {
    await as(admin).patch(`${BASE}/${item.id}`, { name: `${TAG} Books`, price: 120_00 });
    const res = await as(admin).get(`/api/invoices/${invoiceId}`);
    expect(res.json<{ lines: Line[] }>().lines[0]).toMatchObject({
      description: `${TAG} Bookkeeping, October`,
      unitRate: 90_00,
      amount: 180_00,
      itemId: item.id,
    });
  });

  it("refuses to delete the item, and says to switch it off", async () => {
    const res = await as(admin).delete(`${BASE}/${item.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/1 invoice position\. Switch it off/);
  });

  it("accepts an inactive item, which may have been switched off while the form was open", async () => {
    await as(admin).patch(`${BASE}/${item.id}`, { active: false });
    const res = await issue([
      {
        description: "Books",
        quantity: 100,
        unitRate: 10_00,
        amount: 10_00,
        unit: "item",
        itemId: item.id,
      },
    ]);
    expect(res.statusCode).toBe(201);
  });

  it("refuses an item that does not exist, in words", async () => {
    const res = await issue([{ description: "Ghost", amount: 10_00, itemId: randomUUID() }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/deleted meanwhile/);
  });

  it("keeps the link through the admin's correction", async () => {
    const res = await as(admin).patch(`/api/invoices/${invoiceId}`, {
      lines: [
        {
          description: "Books",
          quantity: 100,
          unitRate: 70_00,
          amount: 0,
          unit: "item",
          itemId: item.id,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lines: Line[] }>().lines).toMatchObject([
      { unitRate: 70_00, amount: 70_00, itemId: item.id },
    ]);
    const ghost = await as(admin).patch(`/api/invoices/${invoiceId}`, {
      lines: [{ description: "Ghost", amount: 10_00, itemId: randomUUID() }],
    });
    expect(ghost.statusCode).toBe(400);
  });
});
