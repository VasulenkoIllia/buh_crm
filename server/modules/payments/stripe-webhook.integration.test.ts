import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { UNKNOWN_DISPUTE_RETRY_MS } from "./stripe-webhook.service.js";
import { fakeStripe, signWebhook } from "./stripe.fake.js";
import { setStripeGatewayForTests, STRIPE_API_VERSION } from "./stripe.js";

/**
 * **Stripe's webhook, stage B** (payments.md §11; stripe-plan-2026-11.md, Testing plan): the
 * signature, the payment it records once, what it refuses and tells the admins about, and the
 * refund and the dispute that leave the money as it is. Stripe is a fake in memory; the events are
 * signed by the library's own test helper and checked by its real code.
 */

const DOMAIN = "@stripehook.local";
const TAG = `sw${randomUUID().slice(0, 6)}`;
const WEBHOOK = "/api/stripe/webhook";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let clientId: string;
let stripe: ReturnType<typeof fakeStripe>;

interface InvoiceDto {
  id: string;
  number: string;
  balance: number;
  payUrl: string | null;
  payments: { amount: number; paidAt: string; createdByName: string; source: string }[];
}

const as = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: admin.cookie }, payload });

async function makeInvoice(amount = 50000): Promise<InvoiceDto> {
  const res = await as("POST", "/api/invoices", {
    clientId,
    amount,
    description: "Tax return",
  });
  expect(res.statusCode).toBe(201);
  return read(res.json<{ id: string }>().id);
}

const read = async (id: string) => (await as("GET", `/api/invoices/${id}`)).json<InvoiceDto>();

/** A session the pay link made, as Stripe would have it. */
async function openSession(invoice: InvoiceDto) {
  const res = await app.inject({ method: "GET", url: new URL(invoice.payUrl!).pathname });
  expect(res.statusCode).toBe(303);
  return prisma.stripeCheckout.findFirstOrThrow({
    where: { invoiceId: invoice.id, status: "open" },
    orderBy: { createdAt: "desc" },
  });
}

const eventId = () => `evt_${randomUUID().replaceAll("-", "")}`;
const intentId = () => `pi_${randomUUID().replaceAll("-", "")}`;

function stripeEvent<T extends object>(
  type: string,
  object: T,
  extra: { id?: string; created?: number } = {},
) {
  return {
    id: extra.id ?? eventId(),
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: extra.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  };
}

function completed(
  session: { sessionId: string; invoiceId: string; amount: number },
  fields: Record<string, unknown> = {},
) {
  return {
    id: session.sessionId,
    object: "checkout.session",
    amount_total: session.amount,
    currency: "usd",
    payment_status: "paid",
    payment_intent: intentId(),
    client_reference_id: session.invoiceId,
    metadata: { invoiceId: session.invoiceId },
    livemode: false,
    ...fields,
  };
}

/** Stripe's request: the body as bytes and its signature, unless a test says otherwise. */
function deliver(event: object, headers: Record<string, string> | null = null) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: WEBHOOK,
    payload: body,
    headers: headers ?? {
      "content-type": "application/json",
      "stripe-signature": signWebhook(body),
    },
  });
}

async function eventRow(id: string) {
  return prisma.stripeEvent.findUnique({ where: { id } });
}

async function noticesFor(trigger: string, invoiceId: string) {
  return prisma.notification.findMany({
    where: { trigger, linkId: invoiceId, userId: admin.id },
  });
}

async function journal(action: string, invoiceId: string) {
  const where = { action, subjectId: invoiceId };
  let rows = await prisma.activityEvent.findMany({ where });
  for (let attempt = 0; rows.length === 0 && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    rows = await prisma.activityEvent.findMany({ where });
  }
  return rows;
}

const forInvoices = { invoice: { client: { firstName: { startsWith: TAG } } } };

/** The journal is written after the response; a count of "no more rows" waits for it first. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

async function journalCount(action: string, invoiceId: string) {
  await settled();
  return prisma.activityEvent.count({ where: { action, subjectId: invoiceId } });
}

/** A second session still open on the invoice, as an older pay link would have left it. */
function anotherOpenSession(invoice: InvoiceDto) {
  return prisma.stripeCheckout.create({
    data: {
      sessionId: `cs_test_${randomUUID().replaceAll("-", "")}`,
      invoiceId: invoice.id,
      amount: invoice.balance,
      url: "https://checkout.stripe.test/older",
      expiresAt: new Date(Date.now() + 3_600_000),
      livemode: false,
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  await removePeople(DOMAIN);
  [admin] = await createPeople(app, DOMAIN, ["Ada"], "admin");
  const client = await prisma.client.create({
    data: { firstName: `${TAG} Olena`, lastName: "Petrenko", email: "olena@client.test" },
  });
  clientId = client.id;
});

beforeEach(() => {
  stripe = fakeStripe("sandbox");
  setStripeGatewayForTests(stripe.gateway);
});

afterEach(() => {
  setStripeGatewayForTests(undefined);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setStripeGatewayForTests(undefined);
  await prisma.stripeEvent.deleteMany({ where: forInvoices });
  await prisma.stripeEvent.deleteMany({
    where: { id: { startsWith: "evt_" }, invoiceId: null },
  });
  await prisma.stripeCheckout.deleteMany({ where: forInvoices });
  await prisma.invoiceLine.deleteMany({ where: forInvoices });
  await prisma.paymentAuditLog.deleteMany({ where: forInvoices });
  await prisma.payment.deleteMany({ where: forInvoices });
  await prisma.notification.deleteMany({ where: { userId: admin.id } });
  await prisma.invoice.deleteMany({ where: forInvoices.invoice });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("who may call the webhook", () => {
  it("refuses a request with no signature, a wrong one or a stale one, writing nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const event = stripeEvent("customer.created", { id: "cus_1" });
    const body = JSON.stringify(event);
    const unsigned = await deliver(event, { "content-type": "application/json" });
    const wrong = await deliver(event, {
      "content-type": "application/json",
      "stripe-signature": signWebhook(body, { secret: "whsec_somebody_else" }),
    });
    // older than the library's five minutes: a captured request replayed later
    const stale = await deliver(event, {
      "content-type": "application/json",
      "stripe-signature": signWebhook(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
    });
    expect([unsigned.statusCode, wrong.statusCode, stale.statusCode]).toEqual([400, 400, 400]);
    expect(await eventRow(event.id)).toBeNull();
  });

  it("answers 404 while Stripe is not configured", async () => {
    setStripeGatewayForTests(null);
    const res = await deliver(stripeEvent("customer.created", { id: "cus_1" }));
    expect(res.statusCode).toBe(404);
  });

  it("accepts an event it does not handle and writes it down as ignored", async () => {
    const event = stripeEvent("customer.created", { id: "cus_2" });
    const res = await deliver(event);
    expect(res.statusCode).toBe(200);
    expect(await eventRow(event.id)).toMatchObject({ outcome: "ignored", objectId: "cus_2" });
  });
});

describe("a paid session", () => {
  it("records one payment for what was paid, by Stripe, and tells the admins", async () => {
    const invoice = await makeInvoice(50000);
    const session = await openSession(invoice);
    const event = stripeEvent("checkout.session.completed", completed(session));
    const res = await deliver(event);
    expect(res.statusCode).toBe(200);

    const after = await read(invoice.id);
    expect(after.balance).toBe(0);
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({
      amount: 50000,
      createdByName: "Stripe",
      source: "stripe",
    });
    expect(await eventRow(event.id)).toMatchObject({
      outcome: "applied",
      invoiceId: invoice.id,
    });

    // the session is marked FIRST, so the close after the commit leaves the paid one alone
    const row = await prisma.stripeCheckout.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("completed");
    expect(row.paymentIntentId).toBe(event.data.object.payment_intent);
    expect(stripe.expired).not.toContain(session.sessionId);

    const audit = (await as("GET", `/api/invoices/${invoice.id}/audit`)).json<
      { action: string; byUserName: string }[]
    >();
    expect(audit[0]).toMatchObject({ action: "created", byUserName: "Stripe" });
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(1);
    const [entry] = await journal("invoice.paid_online", invoice.id);
    expect(entry).toMatchObject({ actorKind: "system", actorLabel: "Stripe", clientId });
  });

  it("takes the firm's date, not UTC's, across midnight", async () => {
    const invoice = await makeInvoice(20000);
    const session = await openSession(invoice);
    // 03:30 UTC on the 13th is 22:30 on the 12th in New York
    const created = Math.floor(Date.parse("2026-11-13T03:30:00Z") / 1000);
    await deliver(stripeEvent("checkout.session.completed", completed(session), { created }));
    const [payment] = (await read(invoice.id)).payments;
    expect(payment.paidAt).toBe("2026-11-12T00:00:00.000Z");
  });

  it("records one payment when the same event arrives twice, even at once", async () => {
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const event = stripeEvent("checkout.session.completed", completed(session));
    const [first, second] = await Promise.all([deliver(event), deliver(event)]);
    const third = await deliver(event);
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(1);
  });

  it("records one payment for two events about one payment", async () => {
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const object = completed(session);
    await deliver(stripeEvent("checkout.session.completed", object));
    const second = stripeEvent("checkout.session.completed", object);
    expect((await deliver(second)).statusCode).toBe(200);
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await eventRow(second.id)).toMatchObject({ outcome: "ignored" });
    // a repeat of the ignored one tells nobody, even with the first notice gone
    await prisma.notification.deleteMany({ where: { linkId: invoice.id } });
    await deliver(second);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(0);
  });

  it("closes the invoice's other open session once the payment is recorded", async () => {
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const older = await anotherOpenSession(invoice);
    await deliver(stripeEvent("checkout.session.completed", completed(session)));
    expect(stripe.expired).toContain(older.sessionId);
    expect(stripe.expired).not.toContain(session.sessionId);
  });

  it("tells the admins again when Stripe repeats the event, and journals it once", async () => {
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const event = stripeEvent("checkout.session.completed", completed(session));
    await deliver(event);
    expect(await journal("invoice.paid_online", invoice.id)).toHaveLength(1);
    // the notice lost after the commit: a restart, a failed write; and a session left open
    await prisma.notification.deleteMany({ where: { linkId: invoice.id } });
    const older = await anotherOpenSession(invoice);
    expect((await deliver(event)).statusCode).toBe(200);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(1);
    expect(stripe.expired).toContain(older.sessionId);
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await journalCount("invoice.paid_online", invoice.id)).toBe(1);
  });

  it("answers 500 when the notice cannot be written, and writes it on the next delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const event = stripeEvent("checkout.session.completed", completed(session));
    const older = await anotherOpenSession(invoice);
    vi.spyOn(prisma.notificationPolicy, "findUnique").mockRejectedValueOnce(
      new Error("db down"),
    );
    expect((await deliver(event)).statusCode).toBe(500);
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(0);
    // a payer still on the older page would be the second payment: closed despite the failure
    expect(stripe.expired).toContain(older.sessionId);

    expect((await deliver(event)).statusCode).toBe(200);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(1);
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await journalCount("invoice.paid_online", invoice.id)).toBe(1);
  });

  it("is ignored when it comes from the other mode", async () => {
    const invoice = await makeInvoice(30000);
    const session = await openSession(invoice);
    const event = {
      ...stripeEvent("checkout.session.completed", completed(session)),
      livemode: true,
    };
    expect((await deliver(event)).statusCode).toBe(200);
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({
      outcome: "ignored",
      reason: "a live event while the CRM runs sandbox",
    });
  });

  it("refuses a body that is not JSON before reading it", async () => {
    const body = "id=evt_1";
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK,
      payload: body,
      headers: { "content-type": "text/plain", "stripe-signature": signWebhook(body) },
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("money the invoice cannot take", () => {
  async function refused(prepare: (invoice: InvoiceDto) => Promise<unknown>, amount = 40000) {
    const invoice = await makeInvoice(40000);
    const session = await openSession(invoice);
    await prepare(invoice);
    const event = stripeEvent(
      "checkout.session.completed",
      completed(session, { amount_total: amount }),
    );
    expect((await deliver(event)).statusCode).toBe(200);
    return { invoice, event, session };
  }

  it("is not recorded on a cancelled invoice; the admins hear about it", async () => {
    const { invoice, event } = await refused((i) => as("POST", `/api/invoices/${i.id}/cancel`));
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "the invoice was cancelled before the payment arrived",
    });
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);
    const [entry] = await journal("invoice.online_payment_unapplied", invoice.id);
    expect(entry.changes).toMatchObject({ amount: 40000 });
  });

  it("is not recorded on an invoice paid by hand meanwhile, nor over what is left", async () => {
    const settled = await refused((i) =>
      as("POST", `/api/invoices/${i.id}/payments`, { amount: 40000, paidAt: "2026-11-12" }),
    );
    expect((await read(settled.invoice.id)).payments).toHaveLength(1);
    expect(await eventRow(settled.event.id)).toMatchObject({ outcome: "needs_attention" });

    const reduced = await refused((i) =>
      as("POST", `/api/invoices/${i.id}/payments`, { amount: 10000, paidAt: "2026-11-12" }),
    );
    expect((await read(reduced.invoice.id)).balance).toBe(30000);
    expect(await eventRow(reduced.event.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "the payment is more than the invoice still owes",
    });
  });

  it("is not recorded when Stripe did not confirm the card payment", async () => {
    const invoice = await makeInvoice(40000);
    const session = await openSession(invoice);
    const event = stripeEvent(
      "checkout.session.completed",
      completed(session, { payment_status: "unpaid" }),
    );
    await deliver(event);
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({ outcome: "needs_attention" });
    expect(await prisma.stripeCheckout.findUnique({ where: { id: session.id } })).toMatchObject(
      {
        status: "completed",
      },
    );
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);
    const [notice] = await noticesFor("invoice_online_attention", invoice.id);
    expect(notice.sub).toContain("Check it in Stripe before recording anything");
  });

  it("is not recorded in another currency, and is not shown as dollars", async () => {
    const invoice = await makeInvoice(40000);
    const session = await openSession(invoice);
    const event = stripeEvent(
      "checkout.session.completed",
      completed(session, { currency: "eur" }),
    );
    await deliver(event);
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "it was paid in eur",
    });
    const [notice] = await noticesFor("invoice_online_attention", invoice.id);
    expect(notice.sub).not.toContain("$");
    const [entry] = await journal("invoice.online_payment_unapplied", invoice.id);
    expect(entry.changes).not.toHaveProperty("amount");
  });

  it("is not recorded without the PaymentIntent that keeps it from being recorded twice", async () => {
    const invoice = await makeInvoice(40000);
    const session = await openSession(invoice);
    const event = stripeEvent(
      "checkout.session.completed",
      completed(session, { payment_intent: null }),
    );
    await deliver(event);
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "Stripe sent no payment id",
    });
  });
});

describe("events about payments this CRM did not ask for", () => {
  it("are ignored without a notice when no invoice here is named", async () => {
    const event = stripeEvent(
      "checkout.session.completed",
      completed({ sessionId: "cs_test_elsewhere", invoiceId: "TD-4471", amount: 9900 }),
    );
    expect((await deliver(event)).statusCode).toBe(200);
    expect(await eventRow(event.id)).toMatchObject({ outcome: "ignored", invoiceId: null });
  });

  it("need attention when they name an invoice here, and record nothing", async () => {
    const invoice = await makeInvoice(40000);
    const event = stripeEvent(
      "checkout.session.completed",
      completed({ sessionId: "cs_test_unknown", invoiceId: invoice.id, amount: 40000 }),
    );
    await deliver(event);
    expect((await read(invoice.id)).payments).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({ outcome: "needs_attention" });
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);
  });
});

describe("a refund and a dispute in Stripe", () => {
  async function paidInvoice() {
    const invoice = await makeInvoice(25000);
    const session = await openSession(invoice);
    const object = completed(session);
    await deliver(stripeEvent("checkout.session.completed", object));
    return { invoice, paymentIntent: object.payment_intent };
  }

  it("leave the payment as it is, and write the journal and a notice", async () => {
    const { invoice, paymentIntent } = await paidInvoice();
    const refund = stripeEvent("charge.refunded", {
      id: "ch_1",
      object: "charge",
      amount: 25000,
      amount_refunded: 10000,
      payment_intent: paymentIntent,
      metadata: {},
    });
    const dispute = stripeEvent("charge.dispute.created", {
      id: "dp_1",
      object: "dispute",
      amount: 25000,
      charge: "ch_1",
      payment_intent: paymentIntent,
      reason: "product_not_received",
    });
    expect((await deliver(refund)).statusCode).toBe(200);
    expect((await deliver(dispute)).statusCode).toBe(200);
    expect((await deliver(refund)).statusCode).toBe(200);

    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await eventRow(refund.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "$100.00 of $250.00 refunded in Stripe",
    });
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(2);
    const [refunded] = await journal("invoice.refunded_in_stripe", invoice.id);
    expect(refunded.changes).toMatchObject({ amount: 25000, refundedAmount: 10000 });
    const [disputed] = await journal("invoice.disputed_in_stripe", invoice.id);
    expect(disputed.changes).toMatchObject({ reason: "product not received" });

    // both notices lost after their commits: the next deliveries tell again, journal nothing
    await prisma.notification.deleteMany({ where: { linkId: invoice.id } });
    await deliver(refund);
    await deliver(dispute);
    const notices = await noticesFor("invoice_online_attention", invoice.id);
    expect(notices).toHaveLength(2);
    expect(notices.find((n) => n.dedupKey.endsWith(refund.id))?.sub).toContain(
      "The payment in the CRM stays until you correct it",
    );
    expect(await journalCount("invoice.refunded_in_stripe", invoice.id)).toBe(1);
    expect(await journalCount("invoice.disputed_in_stripe", invoice.id)).toBe(1);
  });

  it("find the invoice by the charge's metadata when the refund overtook the payment", async () => {
    const invoice = await makeInvoice(25000);
    const refund = stripeEvent("charge.refunded", {
      id: "ch_2",
      object: "charge",
      amount: 25000,
      amount_refunded: 25000,
      payment_intent: intentId(),
      metadata: { invoiceId: invoice.id },
    });
    await deliver(refund);
    expect(await eventRow(refund.id)).toMatchObject({
      outcome: "needs_attention",
      invoiceId: invoice.id,
      reason: "$250.00 refunded in full in Stripe",
    });
  });

  it("are ignored for a charge that is not ours", async () => {
    const refund = stripeEvent("charge.refunded", {
      id: "ch_3",
      object: "charge",
      amount: 5000,
      amount_refunded: 5000,
      payment_intent: intentId(),
      metadata: {},
    });
    await deliver(refund);
    expect(await eventRow(refund.id)).toMatchObject({ outcome: "ignored", invoiceId: null });
  });

  /**
   * Stripe does not keep its events in order. On production on 2026-11-12 the sandbox's dispute
   * card sent `charge.dispute.created` 150 ms before the `checkout.session.completed` it disputes;
   * the dispute found no invoice, was ignored with a 200, and nobody was told.
   */
  it("is delivered again when the dispute overtook its payment, then told", async () => {
    const invoice = await makeInvoice(25000);
    const session = await openSession(invoice);
    const object = completed(session);
    const dispute = stripeEvent("charge.dispute.created", {
      id: "dp_3",
      object: "dispute",
      amount: 25000,
      charge: "ch_5",
      payment_intent: object.payment_intent,
      reason: "fraudulent",
    });

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // every early delivery is turned back and leaves nothing to find
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await deliver(dispute)).statusCode).toBe(503);
      expect(await eventRow(dispute.id)).toBeNull();
    }
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(String(object.payment_intent)));

    await deliver(stripeEvent("checkout.session.completed", object));
    expect((await deliver(dispute)).statusCode).toBe(200);
    expect(await eventRow(dispute.id)).toMatchObject({
      outcome: "needs_attention",
      invoiceId: invoice.id,
      reason: "$250.00 disputed: fraudulent",
    });
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);
    expect(await journalCount("invoice.disputed_in_stripe", invoice.id)).toBe(1);
  });

  it("are ignored for a dispute that names no payment at all, however young", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispute = stripeEvent("charge.dispute.created", {
      id: "dp_4",
      object: "dispute",
      amount: 5000,
      charge: "ch_6",
      payment_intent: null,
      reason: "fraudulent",
    });
    expect((await deliver(dispute)).statusCode).toBe(200);
    expect(await eventRow(dispute.id)).toMatchObject({ outcome: "ignored", invoiceId: null });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("dp_4"));
  });

  it("are ignored for a dispute that is not ours, once it is too old to be overtaking one", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const createdMs = Date.now() - UNKNOWN_DISPUTE_RETRY_MS - 60_000;
    const dispute = stripeEvent(
      "charge.dispute.created",
      {
        id: "dp_2",
        object: "dispute",
        amount: 5000,
        charge: "ch_4",
        payment_intent: intentId(),
        reason: "fraudulent",
      },
      { created: Math.floor(createdMs / 1000) },
    );
    expect((await deliver(dispute)).statusCode).toBe(200);
    expect(await eventRow(dispute.id)).toMatchObject({ outcome: "ignored", invoiceId: null });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("dp_2"));
  });

  it("tell the admins about a refund of money no card payment recorded, in those words", async () => {
    const invoice = await makeInvoice(40000);
    const session = await openSession(invoice);
    await as("POST", `/api/invoices/${invoice.id}/cancel`);
    const object = completed(session);
    await deliver(stripeEvent("checkout.session.completed", object));
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);

    const refund = stripeEvent("charge.refunded", {
      id: "ch_5",
      object: "charge",
      amount: 40000,
      amount_refunded: 40000,
      payment_intent: object.payment_intent,
      metadata: { invoiceId: invoice.id },
    });
    await deliver(refund);
    expect(await eventRow(refund.id)).toMatchObject({
      outcome: "needs_attention",
      reason: "$400.00 refunded in full in Stripe",
    });
    // it may have been recorded by hand after the first notice: nobody is left guessing
    const notices = await noticesFor("invoice_online_attention", invoice.id);
    expect(notices).toHaveLength(2);
    const told = notices.find((n) => n.dedupKey.endsWith(refund.id));
    expect(told?.sub).toContain("No card payment was recorded for it here");
    expect(await journal("invoice.refunded_in_stripe", invoice.id)).toHaveLength(1);
  });

  it("record the payment that arrives after its own refund, and tell about both", async () => {
    const invoice = await makeInvoice(25000);
    const session = await openSession(invoice);
    const object = completed(session);
    await deliver(
      stripeEvent("charge.refunded", {
        id: "ch_6",
        object: "charge",
        amount: 25000,
        amount_refunded: 25000,
        payment_intent: object.payment_intent,
        metadata: { invoiceId: invoice.id },
      }),
    );
    await deliver(stripeEvent("checkout.session.completed", object));
    expect((await read(invoice.id)).payments).toHaveLength(1);
    expect(await noticesFor("invoice_online_attention", invoice.id)).toHaveLength(1);
    expect(await noticesFor("invoice_paid_online", invoice.id)).toHaveLength(1);
  });
});

describe("an expired session, and what Settings → System shows", () => {
  it("marks the session expired, never a completed one, and shows the last webhook", async () => {
    const invoice = await makeInvoice(15000);
    const session = await openSession(invoice);
    await deliver(
      stripeEvent("checkout.session.expired", {
        id: session.sessionId,
        object: "checkout.session",
      }),
    );
    expect(await prisma.stripeCheckout.findUnique({ where: { id: session.id } })).toMatchObject(
      {
        status: "expired",
      },
    );

    const health = (await as("GET", "/api/settings/system")).json<{
      stripe: { mode: string; lastWebhookAt: string | null };
    }>();
    expect(health.stripe.mode).toBe("sandbox");
    expect(Date.now() - Date.parse(health.stripe.lastWebhookAt!)).toBeLessThan(60_000);
  });

  it("leaves a completed session completed when its expiry comes late", async () => {
    const invoice = await makeInvoice(15000);
    const session = await openSession(invoice);
    await deliver(stripeEvent("checkout.session.completed", completed(session)));
    const late = stripeEvent("checkout.session.expired", {
      id: session.sessionId,
      object: "checkout.session",
    });
    await deliver(late);
    expect(await prisma.stripeCheckout.findUnique({ where: { id: session.id } })).toMatchObject(
      {
        status: "completed",
      },
    );
    expect(await eventRow(late.id)).toMatchObject({
      outcome: "ignored",
      reason: "the session was already closed",
    });
  });
});
