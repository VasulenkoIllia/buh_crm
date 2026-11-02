import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaymentDetails } from "@shared/schema/payment-details.js";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { wipePaymentDetails } from "../../test/payment-details.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { generateForSubscriptionInvoices } from "./payments.generation.js";
import { invoicePaper } from "./payments.pdf.js";

/**
 * **The copy an invoice takes at issue** (payments.md §10, the owner's decision of 2026-11-02):
 * every issue path stores the client's set or the default, and the paper keeps that text whatever
 * happens to the set afterwards. Tested on the paper's words (`invoicePaper`), not on the PDF's
 * bytes, which carry the drawing date.
 */

const TAG = `pdc${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
const SETS = "/api/settings/payment-details";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;

/** a client on the firm's default, and one on a set of their own */
let plainClient: string;
let abroadClient: string;
let us: PaymentDetails;
let international: PaymentDetails;

const send = (method: "POST" | "PATCH" | "PUT", url: string, payload: object = {}) =>
  app.inject({ method, url, headers: { cookie: admin.cookie }, payload });

async function addSet(name: string) {
  const res = await send("POST", SETS, { name, details: `${name} bank\nAccount ${TAG}` });
  expect(res.statusCode).toBe(201);
  return res.json<PaymentDetails[]>().find((s) => s.name === name)!;
}

async function issue(clientId: string) {
  const res = await send("POST", "/api/invoices", { clientId, amount: 10_000 });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; paymentDetailsName: string | null }>();
}

const stored = (id: string) =>
  prisma.invoice.findUniqueOrThrow({
    where: { id },
    select: { paymentDetailsId: true, paymentInfo: true },
  });

const paymentLinesOf = async (id: string) => (await invoicePaper(id)).document.paymentLines;

async function makeClient(name: string) {
  const res = await send("POST", "/api/clients", {
    firstName: `${TAG} ${name}`,
    companies: [],
    people: [],
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

/** A service on its own terms, for the client; its subscription id. */
async function subscribe(clientId: string, service: object, subscription: object = {}) {
  const created = await send("POST", "/api/catalog", {
    name: `${TAG} ${randomUUID()}`,
    ...service,
  });
  expect(created.statusCode).toBe(201);
  const serviceId = created.json<{ id: string }>().id;
  const sub = await send("POST", `/api/clients/${clientId}/subscriptions`, {
    serviceId,
    amount: 5_000,
    ...subscription,
  });
  expect(sub.statusCode).toBe(201);
  return sub
    .json<{ subscriptions: { id: string; serviceId: string }[] }>()
    .subscriptions.find((s) => s.serviceId === serviceId)!.id;
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  await wipePaymentDetails();
  [admin] = await createPeople(app, DOMAIN, ["Olena"], "admin");
  plainClient = await makeClient("Plain");
  abroadClient = await makeClient("Abroad");
});

afterAll(async () => {
  await wipePaymentDetails();
  const mine = { client: { firstName: { startsWith: TAG } } };
  await prisma.taskAssignee.deleteMany({ where: { task: mine } });
  await prisma.task.deleteMany({ where: mine });
  await prisma.invoice.deleteMany({ where: mine });
  await prisma.subscription.deleteMany({ where: mine });
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: TAG } } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("before any set exists", () => {
  let legacy: string;

  it("issues with no copy, and the paper has no way to pay", async () => {
    legacy = (await issue(plainClient)).id;
    expect(await stored(legacy)).toEqual({ paymentDetailsId: null, paymentInfo: null });
    expect(await paymentLinesOf(legacy)).toEqual([""]);
  });

  it("prints the client's current set on that invoice once sets exist, as before R2", async () => {
    us = await addSet("US clients");
    international = await addSet("International");
    const moved = await send("PUT", `/api/clients/${abroadClient}/payment-details`, {
      paymentDetailsId: international.id,
    });
    expect(moved.statusCode).toBe(200);

    expect(await paymentLinesOf(legacy)).toEqual(us.details.split("\n"));
    // still no copy: the paper follows the client until the invoice has one of its own
    expect(await stored(legacy)).toEqual({ paymentDetailsId: null, paymentInfo: null });
  });
});

describe("every issue path takes the copy", () => {
  it("by hand: the client's own set, else the default, and the log names it", async () => {
    const abroad = await issue(abroadClient);
    expect(await stored(abroad.id)).toEqual({
      paymentDetailsId: international.id,
      paymentInfo: international.details,
    });
    expect(abroad.paymentDetailsName).toBe("International");

    const plain = await issue(plainClient);
    expect(await stored(plain.id)).toEqual({
      paymentDetailsId: us.id,
      paymentInfo: us.details,
    });

    let event = null;
    for (let attempt = 0; attempt < 50 && !event; attempt++) {
      event = await prisma.activityEvent.findFirst({
        where: { action: "invoice.issued", subjectId: abroad.id },
      });
      if (!event) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(event?.changes).toMatchObject({ paymentDetails: "International" });
  });

  it("a job billed when it is created", async () => {
    const subscriptionId = await subscribe(abroadClient, {
      type: "one_time",
      invoiceTrigger: "on_create",
    });
    const job = await send("POST", "/api/tasks", {
      title: `${TAG} Tax return`,
      clientId: abroadClient,
      subscriptionId,
      assignees: [admin.id],
    });
    expect(job.statusCode).toBe(201);
    const { invoiceId } = await prisma.task.findUniqueOrThrow({
      where: { id: job.json<{ id: string }>().id },
      select: { invoiceId: true },
    });
    expect(invoiceId).not.toBeNull();
    expect(await stored(invoiceId!)).toEqual({
      paymentDetailsId: international.id,
      paymentInfo: international.details,
    });
  });

  it("the period sweep", async () => {
    const subscriptionId = await subscribe(
      plainClient,
      { type: "subscription", invoiceTrigger: "on_period_start", defaultAmount: 5_000 },
      { period: "month" },
    );
    // served from the period's first day, so the period is whole and bills by itself
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
    await prisma.subscriptionPeriod.updateMany({
      where: { subscriptionId },
      data: { startsOn: new Date(`${today.slice(0, 8)}01T00:00:00.000Z`) },
    });
    expect((await generateForSubscriptionInvoices(subscriptionId)).created).toBe(1);

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId } });
    expect(await stored(invoice.id)).toEqual({
      paymentDetailsId: us.id,
      paymentInfo: us.details,
    });
  });
});

describe("the paper keeps its copy", () => {
  it("prints what it was issued with after the set is edited; the next invoice takes the edit", async () => {
    const before = await issue(abroadClient);
    const edited = await send("PATCH", `${SETS}/${international.id}`, {
      details: "International bank\nAccount 9999",
    });
    expect(edited.statusCode).toBe(200);

    expect(await paymentLinesOf(before.id)).toEqual(international.details.split("\n"));
    const after = await issue(abroadClient);
    expect(await paymentLinesOf(after.id)).toEqual(["International bank", "Account 9999"]);
  });

  it("follows the client's move for new invoices only", async () => {
    const before = await issue(abroadClient);
    await send("PUT", `/api/clients/${abroadClient}/payment-details`, {
      paymentDetailsId: null,
    });
    const after = await issue(abroadClient);
    expect((await stored(before.id)).paymentDetailsId).toBe(international.id);
    expect((await stored(after.id)).paymentDetailsId).toBe(us.id);
  });

  it("gives the default to a client left on an archived set", async () => {
    const old = await addSet("Old bank");
    // the race the archive's own check cannot see: a client moved onto it as it was archived
    await prisma.paymentDetails.update({
      where: { id: old.id },
      data: { archivedAt: new Date() },
    });
    await prisma.client.update({
      where: { id: plainClient },
      data: { paymentDetailsId: old.id },
    });
    const invoice = await issue(plainClient);
    expect((await stored(invoice.id)).paymentDetailsId).toBe(us.id);
  });
});
