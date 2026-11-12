import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { fakeStripe } from "./stripe.fake.js";
import { setStripeGatewayForTests } from "./stripe.js";

/**
 * **The pay link, stage A** (payments.md §11; stripe-plan-2026-11.md, Testing plan): what
 * `/pay/:token` answers, the session it reuses or makes, the sessions a change of the balance
 * closes, and where the link shows. Stripe is a fake in memory; nothing here reaches the network.
 */

const DOMAIN = "@paylink.local";
const TAG = `pl${randomUUID().slice(0, 6)}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let clientId: string;
let stripe: ReturnType<typeof fakeStripe>;

interface InvoiceRow {
  id: string;
  number: string;
  balance: number;
  payUrl: string | null;
  payments: { id: string }[];
}

const as = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: admin.cookie }, payload });

/**
 * A request with no session, from wherever the payer is. Each from an address of its own unless
 * one is named, so the route's own limit is met only by the test that is about it.
 */
let nextAddress = 1;
const pay = (path: string, remoteAddress = `203.0.113.${nextAddress++ % 250}`) =>
  app.inject({ method: "GET", url: path, remoteAddress });

const pathOf = (url: string) => new URL(url).pathname;

/** Stripe's own error classes, built the way the library builds them from an answer. */
const stripeError = {
  network: () =>
    new Stripe.errors.StripeConnectionError({ message: "connect ETIMEDOUT" } as never),
  refused: (statusCode: number, param?: string) =>
    new Stripe.errors.StripeInvalidRequestError({
      message: "refused",
      type: "invalid_request_error",
      statusCode,
      param,
    } as never),
};

const said = (spy: { mock: { calls: unknown[][] } }, text: string) =>
  spy.mock.calls.some(([line]) => String(line).includes(text));

async function tokenOf(invoiceId: string) {
  return (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).payToken;
}

async function makeInvoice(amount = 50000): Promise<InvoiceRow> {
  const res = await as("POST", "/api/invoices", {
    clientId,
    amount,
    description: "Tax return",
  });
  expect(res.statusCode).toBe(201);
  return read(res.json<{ id: string }>().id);
}

async function read(id: string): Promise<InvoiceRow> {
  return (await as("GET", `/api/invoices/${id}`)).json<InvoiceRow>();
}

async function addPayment(id: string, amount: number) {
  const res = await as("POST", `/api/invoices/${id}/payments`, {
    amount,
    paidAt: "2026-11-12",
  });
  expect(res.statusCode).toBe(201);
  return res.json<InvoiceRow>();
}

async function checkouts(invoiceId: string) {
  return prisma.stripeCheckout.findMany({
    where: { invoiceId },
    orderBy: { createdAt: "asc" },
  });
}

async function removeCheckouts() {
  await prisma.stripeCheckout.deleteMany({
    where: { invoice: { client: { firstName: { startsWith: TAG } } } },
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
  await removeCheckouts();
  const invoices = { invoice: { client: { firstName: { startsWith: TAG } } } };
  await prisma.invoiceLine.deleteMany({ where: invoices });
  await prisma.paymentAuditLog.deleteMany({ where: invoices });
  await prisma.payment.deleteMany({ where: invoices });
  await prisma.invoice.deleteMany({ where: invoices.invoice });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("a click on the pay link", () => {
  it("sends the payer to a session for exactly the balance, cards only by the gateway", async () => {
    const invoice = await makeInvoice(50000);
    expect(invoice.payUrl).toMatch(/^https:\/\/localhost\/pay\/[A-Za-z0-9_-]{43}$/);

    const before = Date.now();
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(303);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(stripe.created).toHaveLength(1);
    const [request] = stripe.created;
    expect(res.headers.location).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/);
    expect(request).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amount: 50000,
      customerEmail: "olena@client.test",
      successUrl: `${invoice.payUrl}?back=paid`,
      cancelUrl: `${invoice.payUrl}?back=cancelled`,
    });
    // Stripe's floor is 30 minutes; the window makes it 31 to 36
    const minutes = (request.expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(30.9);
    expect(minutes).toBeLessThanOrEqual(36.1);

    const [row] = await checkouts(invoice.id);
    expect(row).toMatchObject({ amount: 50000, status: "open", livemode: false });
  });

  it("gives a second click, a second tab included, the same open session", async () => {
    const invoice = await makeInvoice();
    const first = await pay(pathOf(invoice.payUrl!));
    const second = await pay(pathOf(invoice.payUrl!));
    expect(second.headers.location).toBe(first.headers.location);
    expect(stripe.created).toHaveLength(1);
    expect(await checkouts(invoice.id)).toHaveLength(1);
  });

  it("asks only for the rest after a payment by hand, and closes the old session", async () => {
    const invoice = await makeInvoice(50000);
    await pay(pathOf(invoice.payUrl!));
    const [old] = await checkouts(invoice.id);

    await addPayment(invoice.id, 20000);
    expect(stripe.expired).toEqual([old.sessionId]);

    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(303);
    expect(stripe.created.at(-1)?.amount).toBe(30000);
    expect((await checkouts(invoice.id)).map((c) => [c.amount, c.status])).toEqual([
      [50000, "expired"],
      [30000, "open"],
    ]);
  });

  it("records a new session in the journal once, with the link as the actor", async () => {
    const invoice = await makeInvoice(12345);
    const since = new Date();
    await pay(pathOf(invoice.payUrl!));
    await pay(pathOf(invoice.payUrl!));
    const where = { action: "invoice.pay_link_opened", subjectId: invoice.id };
    let rows = await prisma.activityEvent.findMany({ where });
    for (let attempt = 0; rows.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await prisma.activityEvent.findMany({ where });
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // a mail scanner opens links too: whoever clicked is not known, so no person is named
      actorKind: "system",
      actorLabel: "Pay link",
      clientId,
      subjectLabel: invoice.number,
      changes: { amount: 12345 },
    });
    expect(rows[0].occurredAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
  });

  it("answers a page, never a 500 with details, when Stripe fails", async () => {
    const invoice = await makeInvoice();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failCreate(stripeError.network());
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("The payment page did not open");
    expect(res.body).not.toContain("ETIMEDOUT");
    expect(complaint).toHaveBeenCalledOnce();
    expect(String(complaint.mock.calls[0][0])).toContain(invoice.number);
    expect(await checkouts(invoice.id)).toEqual([]);
  });

  it("says it is not available, not 'try again', when Stripe will refuse again", async () => {
    const invoice = await makeInvoice();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failCreate(stripeError.refused(403));
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Online payment is not available");
    expect(res.body).not.toContain("Try again");
  });

  it("drops an email Stripe will not take, once, and the payer types their own", async () => {
    const invoice = await makeInvoice();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failCreateOnce(stripeError.refused(400, "customer_email"));
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(303);
    expect(stripe.created.map((r) => r.customerEmail)).toEqual(["olena@client.test", null]);
    expect(said(complaint, "refused the email")).toBe(true);
  });

  it("offers no link below Stripe's smallest charge, and an old one says so", async () => {
    const invoice = await makeInvoice(50000);
    expect((await addPayment(invoice.id, 49960)).payUrl).toBeNull();
    const res = await pay(`/pay/${await tokenOf(invoice.id)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Online payment is not available");
    expect(stripe.created).toEqual([]);
  });

  it("answers from the invoice as it is now when it is paid while Stripe answers", async () => {
    const invoice = await makeInvoice(40000);
    stripe.whileCreating(() => addPayment(invoice.id, 40000));
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("This invoice is paid");
    // the payment closed what it could see; the session saved after it is closed by the click
    const rows = await checkouts(invoice.id);
    expect(rows.map((c) => c.status)).toEqual(["expired"]);
    expect(stripe.expired).toEqual([rows[0].sessionId]);
  });

  it("asks for the new balance when part of it is paid while Stripe answers", async () => {
    const invoice = await makeInvoice(40000);
    stripe.whileCreating(() => addPayment(invoice.id, 10000));
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(303);
    const rows = await checkouts(invoice.id);
    expect(rows.map((c) => [c.amount, c.status])).toEqual([
      [40000, "expired"],
      [30000, "open"],
    ]);
    expect(res.headers.location).toBe(rows[1].url);
  });

  it("says TEST in the sandbox and not in live mode", async () => {
    const invoice = await makeInvoice();
    const back = await pay(`${pathOf(invoice.payUrl!)}?back=paid`);
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("Thank you for your payment");
    expect(back.body).toContain("TEST");

    setStripeGatewayForTests(fakeStripe("live").gateway);
    const live = await pay(`${pathOf(invoice.payUrl!)}?back=paid`);
    expect(live.body).toContain("Thank you for your payment");
    expect(live.body).not.toContain("TEST");
  });

  it("brings a payer who gave up back to a button that tries again, asking Stripe nothing", async () => {
    const invoice = await makeInvoice();
    const res = await pay(`${pathOf(invoice.payUrl!)}?back=cancelled`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Payment not completed");
    expect(res.body).toContain(`href="${pathOf(invoice.payUrl!)}"`);
    expect(stripe.created).toEqual([]);
  });

  it("answers 404 for a token nobody holds, a mangled one, and has no HEAD", async () => {
    const res = await pay(`/pay/${"x".repeat(43)}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("This link is not valid");
    expect((await pay("/pay/%3Cscript%3E")).body).not.toContain("<script>");
    expect((await pay(`/pay/${"y".repeat(43)}?back=paid`)).statusCode).toBe(404);

    const invoice = await makeInvoice();
    const head = await app.inject({ method: "HEAD", url: pathOf(invoice.payUrl!) });
    expect(head.statusCode).toBe(404);
    expect(stripe.created).toEqual([]);
  });

  it("is limited per address, tighter than the rest of the app", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      codes.push((await pay(`/pay/${"z".repeat(43)}`, "198.51.100.7")).statusCode);
    }
    expect(codes.slice(0, 30).every((code) => code === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("a change to what the invoice owes closes its open session", () => {
  async function opened(amount = 40000) {
    const invoice = await makeInvoice(amount);
    await pay(pathOf(invoice.payUrl!));
    const [session] = await checkouts(invoice.id);
    return { invoice, session };
  }

  it("a cancel, after which the link says so", async () => {
    const { invoice, session } = await opened();
    expect((await as("POST", `/api/invoices/${invoice.id}/cancel`)).statusCode).toBe(200);
    expect(stripe.expired).toEqual([session.sessionId]);
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("This invoice was cancelled");
    expect((await read(invoice.id)).payUrl).toBeNull();
  });

  it("a correction of the amount, after which the link asks for the new one", async () => {
    const { invoice, session } = await opened(40000);
    expect(
      (await as("PATCH", `/api/invoices/${invoice.id}`, { amount: 45000 })).statusCode,
    ).toBe(200);
    expect(stripe.expired).toEqual([session.sessionId]);
    await pay(pathOf(invoice.payUrl!));
    expect(stripe.created.at(-1)?.amount).toBe(45000);
  });

  it("not an edit that leaves the amount where it was", async () => {
    const { invoice } = await opened();
    await as("PATCH", `/api/invoices/${invoice.id}`, { description: "Tax return 2025" });
    expect(stripe.expired).toEqual([]);
  });

  it("settling it by hand, after which the link says it is paid", async () => {
    const { invoice, session } = await opened(40000);
    await addPayment(invoice.id, 40000);
    expect(stripe.expired).toEqual([session.sessionId]);
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.body).toContain("This invoice is paid");
    expect((await read(invoice.id)).payUrl).toBeNull();
  });

  it("settling several at once from the list", async () => {
    const one = await opened();
    const two = await opened();
    const res = await as("POST", "/api/invoices/mark-paid", {
      invoiceIds: [one.invoice.id, two.invoice.id],
    });
    expect(res.json()).toMatchObject({ settled: 2, skipped: 0 });
    expect(stripe.expired.sort()).toEqual(
      [one.session.sessionId, two.session.sessionId].sort(),
    );
  });

  it("a payment deleted by an admin", async () => {
    const invoice = await makeInvoice(40000);
    const paid = await addPayment(invoice.id, 10000);
    await pay(pathOf(invoice.payUrl!));
    const [session] = await checkouts(invoice.id);
    await as("DELETE", `/api/invoices/payments/${paid.payments[0].id}`);
    expect(stripe.expired).toEqual([session.sessionId]);
  });

  it("and the act still succeeds when the expire fails, and the next visit tries again", async () => {
    const { invoice, session } = await opened();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failExpire(stripeError.network());
    expect((await as("POST", `/api/invoices/${invoice.id}/cancel`)).statusCode).toBe(200);
    expect(said(complaint, "could not be expired")).toBe(true);
    expect(said(complaint, "paid twice")).toBe(false);
    expect((await checkouts(invoice.id))[0].status).toBe("open");

    stripe.failExpire(null);
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.body).toContain("This invoice was cancelled");
    expect(stripe.expired).toEqual([session.sessionId]);
    expect((await checkouts(invoice.id))[0].status).toBe("expired");
  });

  it("warns of a possible double payment when Stripe says the session is no longer open", async () => {
    const { invoice } = await opened();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failExpire(stripeError.refused(400));
    await addPayment(invoice.id, 40000);
    expect(said(complaint, "may now be paid twice")).toBe(true);
  });

  it("but not when the key itself is refused", async () => {
    const { invoice } = await opened();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failExpire(stripeError.refused(403));
    await addPayment(invoice.id, 40000);
    expect(said(complaint, "could not be expired")).toBe(true);
    expect(said(complaint, "paid twice")).toBe(false);
  });

  it("a payment that leaves less than Stripe's smallest charge, retried by the next visit", async () => {
    const { invoice, session } = await opened(40000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    stripe.failExpire(stripeError.network());
    await addPayment(invoice.id, 39960);
    expect((await checkouts(invoice.id))[0].status).toBe("open");

    stripe.failExpire(null);
    const res = await pay(pathOf(invoice.payUrl!));
    expect(res.body).toContain("Online payment is not available");
    expect(stripe.expired).toEqual([session.sessionId]);
    expect((await checkouts(invoice.id))[0].status).toBe("expired");
  });
});

describe("with Stripe off", () => {
  beforeEach(() => setStripeGatewayForTests(null));

  it("shows nothing: no link on the card, no row on System, a polite page on an old link", async () => {
    const invoice = await makeInvoice();
    expect(invoice.payUrl).toBeNull();
    const system = await as("GET", "/api/settings/system");
    expect(system.json<{ stripe: unknown }>().stripe).toBeNull();

    const res = await pay(`/pay/${await tokenOf(invoice.id)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Online payment is not available");
  });
});

describe("where the link shows", () => {
  it("System names the mode read off the key", async () => {
    const system = await as("GET", "/api/settings/system");
    expect(system.json<{ stripe: unknown }>().stripe).toEqual({ mode: "sandbox" });
  });

  it("the PDF carries it in live mode only", async () => {
    const invoice = await makeInvoice();
    const sandbox = await as("GET", `/api/invoices/${invoice.id}/pdf`);
    expect(sandbox.rawPayload.toString("latin1")).not.toContain("/URI");

    setStripeGatewayForTests(fakeStripe("live").gateway);
    const live = await as("GET", `/api/invoices/${invoice.id}/pdf`);
    expect(live.rawPayload.toString("latin1")).toContain(`/URI (${invoice.payUrl})`);
  });

  it("every invoice has its own token, a copy of one included", async () => {
    const one = await makeInvoice();
    const copy = await makeInvoice();
    expect(one.payUrl).not.toBe(copy.payUrl);
  });
});
