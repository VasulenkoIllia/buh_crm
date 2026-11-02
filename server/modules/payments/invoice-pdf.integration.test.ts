import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { storeFile } from "../../core/files.js";
import { png, smallPng } from "../../test/png.js";

/**
 * **An invoice on paper, and what fills one in** (payments.md §10): the PDF's two ways out, a copy
 * in the client's files, the firm's invoice details, and the rate a new position starts from.
 */

const TAG = `pdf${randomUUID().slice(0, 6)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
let colleague: Person;
let clientId: string;
const people: string[] = [];

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@pdf.local`;
  const user = await prisma.user.create({
    data: {
      firstName: role,
      lastName: TAG,
      email,
      passwordHash: await argon2.hash("password-123"),
      role,
      status: "active",
    },
  });
  people.push(user.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  return { id: user.id, cookie: cookieOf(res) };
}

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers, payload }),
    patch: (url: string, payload: object = {}) =>
      app.inject({ method: "PATCH", url, headers, payload }),
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
async function recorded(
  action: string,
  subjectId: string | null,
  label?: string,
  since?: Date,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, subjectLabel: label, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

async function makeInvoice(payload: object = {}, client = clientId) {
  const res = await as(admin).post("/api/invoices", {
    clientId: client,
    amount: 10000,
    description: "Tax return",
    ...payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; number: string }>();
}

const hourly = (unitRate: number) => [
  { description: "Consultation", quantity: 200, unitRate, amount: 2 * unitRate },
];

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin");
  colleague = await person("user");
  const client = await prisma.client.create({ data: { firstName: `${TAG} Petrenko` } });
  clientId = client.id;
});

afterEach(async () => {
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
});

afterAll(async () => {
  await prisma.firmProfile.update({
    where: { id: 1 },
    data: {
      invoiceFromName: null,
      invoiceFromAddress: null,
      invoiceFromWebsite: null,
      invoiceFromEmail: null,
      invoiceFromPhone: null,
      invoicePaymentInfo: null,
    },
  });
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  const invoices = { invoice: { client: { firstName: { startsWith: TAG } } } };
  await prisma.invoiceLine.deleteMany({ where: invoices });
  await prisma.paymentAuditLog.deleteMany({ where: invoices });
  await prisma.payment.deleteMany({ where: invoices });
  await prisma.invoice.deleteMany({ where: invoices.invoice });
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("the PDF", () => {
  it("opens in the browser, and downloads under the invoice's number", async () => {
    const invoice = await makeInvoice();
    const inline = await as(admin).get(`/api/invoices/${invoice.id}/pdf`);
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toBe("application/pdf");
    expect(inline.headers["content-disposition"]).toMatch(/^inline/);
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");
    expect(inline.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const download = await as(admin).get(`/api/invoices/${invoice.id}/pdf?download=1`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe(
      `attachment; filename*=UTF-8''invoice_${invoice.number}.pdf`,
    );
  });

  it("prints positions, a part-paid invoice and a cancelled one", async () => {
    const positions = await makeInvoice({ lines: hourly(4000) });
    expect((await as(admin).get(`/api/invoices/${positions.id}/pdf`)).statusCode).toBe(200);

    const partPaid = await makeInvoice();
    const paid = await as(admin).post(`/api/invoices/${partPaid.id}/payments`, {
      amount: 2500,
      paidAt: "2026-10-01",
    });
    expect(paid.statusCode).toBe(201);
    expect((await as(admin).get(`/api/invoices/${partPaid.id}/pdf`)).statusCode).toBe(200);

    const cancelled = await makeInvoice();
    expect((await as(admin).post(`/api/invoices/${cancelled.id}/cancel`)).statusCode).toBe(200);
    expect((await as(admin).get(`/api/invoices/${cancelled.id}/pdf`)).statusCode).toBe(200);
  });

  it("marks nothing: downloading a paper does not hand it over", async () => {
    const invoice = await makeInvoice();
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    await as(admin).get(`/api/invoices/${invoice.id}/pdf?download=1`);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(
      before,
    );
  });

  it("refuses an invoice that does not exist and a query it does not know", async () => {
    const missing = await as(admin).get(`/api/invoices/${randomUUID()}/pdf`);
    expect(missing.statusCode).toBe(404);
    const invoice = await makeInvoice();
    const odd = await as(admin).get(`/api/invoices/${invoice.id}/pdf?download=yes`);
    expect(odd.statusCode).toBe(400);
  });

  describe("with a logo", () => {
    /** A file on the firm's letterhead, for the length of one PDF. */
    async function printWith(bytes: Buffer | null, mime = "image/png") {
      const stored = bytes ? await storeFile(bytes) : { path: "does-not-exist.png" };
      const file = await prisma.file.create({
        data: {
          ...stored,
          name: "letterhead.png",
          size: bytes?.length ?? 0,
          mime,
          uploadedById: admin.id,
        },
      });
      await prisma.firmProfile.update({ where: { id: 1 }, data: { mailLogoFileId: file.id } });
      try {
        const invoice = await makeInvoice();
        return await as(admin).get(`/api/invoices/${invoice.id}/pdf`);
      } finally {
        await prisma.firmProfile.update({ where: { id: 1 }, data: { mailLogoFileId: null } });
        await prisma.file.delete({ where: { id: file.id } });
      }
    }

    it("prints it", async () => {
      const plain = await as(admin).get(`/api/invoices/${(await makeInvoice()).id}/pdf`);
      const res = await printWith(smallPng());
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.length).toBeGreaterThan(plain.rawPayload.length);
    });

    it("prints without it when its bytes are gone, a damaged PNG, or a type it cannot read", async () => {
      const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await printWith(null)).statusCode).toBe(200);
        expect(complaint).toHaveBeenCalled();
        const damaged = png({ idat: Buffer.from("garbage") });
        expect((await printWith(damaged)).statusCode).toBe(200);
        expect((await printWith(smallPng(), "image/webp")).statusCode).toBe(200);
      } finally {
        complaint.mockRestore();
      }
    });
  });

  it("stays behind the Billing gate", async () => {
    const invoice = await makeInvoice();
    await setGate(colleague, "billing", "read_only");
    expect((await as(colleague).get(`/api/invoices/${invoice.id}/pdf`)).statusCode).toBe(200);
    await setGate(colleague, "billing", "closed");
    expect((await as(colleague).get(`/api/invoices/${invoice.id}/pdf`)).statusCode).toBe(403);
    const anonymous = await app.inject({ url: `/api/invoices/${invoice.id}/pdf` });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("a copy in the client's files", () => {
  it("lands in Shared with client, and every part of it is logged", async () => {
    const invoice = await makeInvoice();
    const res = await as(admin).post(`/api/invoices/${invoice.id}/save-pdf`);
    expect(res.statusCode).toBe(200);
    const saved = res.json<{ fileId: string; name: string }>();
    expect(saved.name).toBe(`invoice_${invoice.number}.pdf`);

    const file = await prisma.file.findUniqueOrThrow({ where: { id: saved.fileId } });
    expect(file).toMatchObject({ clientId, zone: "shared", mime: "application/pdf" });

    const event = await recorded("invoice.pdf_saved", invoice.id);
    expect(event).toMatchObject({ clientId, subjectLabel: invoice.number });
    expect(event.changes).toEqual({ file: saved.name });
    await recorded("file.uploaded", saved.fileId);
    await recorded("file.shared_with_client", saved.fileId);
  });

  it("keeps an earlier copy as it was: the second gets a name of its own", async () => {
    const invoice = await makeInvoice();
    const first = await as(admin).post(`/api/invoices/${invoice.id}/save-pdf`);
    const second = await as(admin).post(`/api/invoices/${invoice.id}/save-pdf`);
    expect(second.json<{ name: string }>().name).toBe(`invoice_${invoice.number} (2).pdf`);
    expect(second.json<{ fileId: string }>().fileId).not.toBe(
      first.json<{ fileId: string }>().fileId,
    );
  });

  it("asks for Billing open, and for the client's files open too", async () => {
    const invoice = await makeInvoice();
    const url = `/api/invoices/${invoice.id}/save-pdf`;

    await setGate(colleague, "billing", "read_only");
    expect((await as(colleague).post(url)).statusCode).toBe(403);

    await setGate(colleague, "billing", "open");
    await setGate(colleague, "clients", "read_only");
    expect((await as(colleague).post(url)).statusCode).toBe(403);
    expect(await prisma.file.count({ where: { uploadedById: colleague.id } })).toBe(0);
  });
});

describe("the rate a new position starts from", () => {
  const rateOf = async (client: string) => {
    const res = await as(admin).get(`/api/invoices/last-rate?clientId=${client}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ unitRate: number | null }>().unitRate;
  };
  const newClient = async (name: string) =>
    (await prisma.client.create({ data: { firstName: `${TAG} ${name}` } })).id;

  it("is empty for a client who was never billed by the hour", async () => {
    const client = await newClient("flat");
    expect(await rateOf(client)).toBeNull();
    await makeInvoice({}, client);
    await makeInvoice(
      { lines: [{ description: "Filing", quantity: null, unitRate: null, amount: 5000 }] },
      client,
    );
    expect(await rateOf(client)).toBeNull();
  });

  it("is the latest invoice's, and a rate with no hours beside it does not count", async () => {
    const client = await newClient("hourly");
    await makeInvoice({ lines: hourly(4000) }, client);
    await makeInvoice({ lines: hourly(4500) }, client);
    expect(await rateOf(client)).toBe(4500);
    await makeInvoice(
      { lines: [{ description: "Fee", quantity: null, unitRate: 9900, amount: 9900 }] },
      client,
    );
    expect(await rateOf(client)).toBe(4500);
  });

  it("is never an item's price, which is no rate per hour", async () => {
    const client = await newClient("items");
    await makeInvoice({ lines: hourly(4000) }, client);
    await makeInvoice(
      {
        lines: [
          { description: "W-2 form", quantity: 200, unitRate: 5000, amount: 1, unit: "item" },
        ],
      },
      client,
    );
    expect(await rateOf(client)).toBe(4000);
  });

  it("skips a cancelled invoice", async () => {
    const client = await newClient("cancelled");
    await makeInvoice({ lines: hourly(4000) }, client);
    const wrong = await makeInvoice({ lines: hourly(9000) }, client);
    await as(admin).post(`/api/invoices/${wrong.id}/cancel`);
    expect(await rateOf(client)).toBe(4000);
  });

  it("stays behind the Billing gate", async () => {
    await setGate(colleague, "billing", "closed");
    const res = await as(colleague).get(`/api/invoices/last-rate?clientId=${clientId}`);
    expect(res.statusCode).toBe(403);
  });
});

describe("the firm's invoice details", () => {
  const url = "/api/settings/invoice-details";
  const details = {
    name: `${TAG} Books`,
    address: "1 Main St",
    website: "acme.test",
    email: "billing@acme.test",
    phone: "+1 555 0100",
  };
  let firmName: string;

  beforeAll(async () => {
    firmName = (await prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } })).name;
  });

  it("starts from the firm's own name while nothing is set", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { invoiceFromName: null } });
    const firm = await prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } });
    const res = await as(admin).get(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: firm.name, logo: null });
  });

  it("is an admin's to change, and logged with the values", async () => {
    const res = await as(admin).patch(url, details);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(details);

    const event = await recorded("settings.invoice_details_changed", null, details.name);
    expect(event.changes).toMatchObject({
      invoiceFromPhone: { to: details.phone },
    });
  });

  it("reads for whoever has Settings, and stays an admin's to change", async () => {
    await as(admin).patch(url, details);
    expect((await as(colleague).get(url)).statusCode).toBe(403);
    await setGate(colleague, "settings", "open");
    expect((await as(colleague).get(url)).json()).toMatchObject(details);
    expect((await as(colleague).patch(url, details)).statusCode).toBe(403);
  });

  it("changes only what was sent, so a stale form cannot undo a colleague", async () => {
    await as(admin).patch(url, details);
    const since = new Date();
    const res = await as(admin).patch(url, { phone: "+1 555 0199" });
    expect(res.json()).toMatchObject({ ...details, phone: "+1 555 0199" });

    const event = await recorded("settings.invoice_details_changed", null, firmName, since);
    expect(Object.keys(event.changes as object)).toEqual(["invoiceFromPhone"]);
  });

  it("leaves the firm's name a fallback when a save does not touch it", async () => {
    await as(admin).patch(url, { name: null });
    await as(admin).patch(url, { phone: "+1 555 0177" });
    const row = await prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.invoiceFromName).toBeNull();
  });

  it("does nothing on an empty save", async () => {
    await as(admin).patch(url, details);
    const res = await as(admin).patch(url, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(details);
  });

  it("refuses an address that is not one", async () => {
    const res = await as(admin).patch(url, { ...details, email: "not an address" });
    expect(res.statusCode).toBe(400);
  });

  it("clears back to the firm's name", async () => {
    const res = await as(admin).patch(url, { ...details, name: null });
    const firm = await prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } });
    expect(res.json()).toMatchObject({ name: firm.name, address: details.address });
  });
});
