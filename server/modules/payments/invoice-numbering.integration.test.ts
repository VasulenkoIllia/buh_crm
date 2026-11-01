import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithActivity } from "../../core/activity.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { todayInTz, toUtc } from "../../core/dates.js";
import { prisma } from "../../core/db.js";
import { firmYear, issueInvoice, issueInvoiceIn } from "./invoicing.js";
import { generateForSubscriptionInvoices } from "./payments.generation.js";
import { MAX_TAKEN_NUMBERS } from "./payments.repository.js";

/**
 * What happens to an invoice whose number is already somebody else's (owner, 2026-11-01).
 *
 * Its own prefix and its own rows, so nothing here depends on which suites ran first. The counter
 * is set by hand because that is the only way into these states: the screens cannot move it.
 */
const PREFIX = "NUM";
const YEAR = firmYear(toUtc(todayInTz(config.TZ)));
const number = (year: number, n: number) => `${PREFIX}-${year}-${String(n).padStart(4, "0")}`;

let clientId: string;
let serviceId: string;
let firmBefore: {
  invoicePrefix: string;
  invoiceCounterDigits: number;
  invoiceCounterYear: number | null;
  invoiceCounter: number;
};

const setCounter = (year: number | null, counter: number) =>
  prisma.firmProfile.update({
    where: { id: 1 },
    data: { invoiceCounterYear: year, invoiceCounter: counter },
  });

const readCounter = () =>
  prisma.firmProfile.findUniqueOrThrow({
    where: { id: 1 },
    select: { invoiceCounterYear: true, invoiceCounter: true },
  });

/** Rows that hold these numbers, written past the allocator as a legacy row would have been. */
const takeNumbers = (...numbers: string[]) =>
  prisma.invoice.createMany({
    data: numbers.map((n) => ({ number: n, clientId, amount: 100 })),
  });

const issue = (extra: { issuedAt?: Date } = {}) =>
  issueInvoice({ clientId, companyId: null, serviceId: null, amount: 1_000, ...extra });

/** A monthly subscription whole from this month's first day, so the sweep bills it at once. */
async function makeSubscription() {
  const now = toUtc(todayInTz(config.TZ));
  const sub = await prisma.subscription.create({
    data: {
      clientId,
      serviceId,
      amount: 5_000,
      period: "month",
      periods: {
        create: { startsOn: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) },
      },
    },
  });
  return sub.id;
}

const invoicesOf = (subscriptionId: string) =>
  prisma.invoice.findMany({ where: { subscriptionId } });

beforeAll(async () => {
  await ensureBaseData();
  firmBefore = await prisma.firmProfile.findUniqueOrThrow({
    where: { id: 1 },
    select: {
      invoicePrefix: true,
      invoiceCounterDigits: true,
      invoiceCounterYear: true,
      invoiceCounter: true,
    },
  });
  await prisma.firmProfile.update({
    where: { id: 1 },
    data: { invoicePrefix: PREFIX, invoiceCounterDigits: 4 },
  });
  const client = await prisma.client.create({
    data: { firstName: "Numbering", lastName: "Test" },
  });
  clientId = client.id;
  const service = await prisma.service.create({
    data: {
      name: `Numbering ${randomUUID().slice(0, 8)}`,
      color: "#000000",
      type: "subscription",
      invoiceTrigger: "on_period_start",
    },
  });
  serviceId = service.id;
});

beforeEach(async () => {
  await prisma.invoice.deleteMany({ where: { clientId } });
  await prisma.subscription.deleteMany({ where: { clientId } });
  await prisma.activityEvent.deleteMany({
    where: { action: "subscription.generation_failed", clientId },
  });
  await setCounter(YEAR, 41);
});

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { clientId } });
  await prisma.subscription.deleteMany({ where: { clientId } });
  await prisma.service.delete({ where: { id: serviceId } });
  await prisma.client.delete({ where: { id: clientId } });
  await prisma.firmProfile.update({ where: { id: 1 }, data: firmBefore });
});

describe("a number that is already taken", () => {
  it("is stepped over, and the counter stays past it", async () => {
    await takeNumbers(number(YEAR, 42));

    expect((await issue()).number).toBe(number(YEAR, 43));
    expect((await readCounter()).invoiceCounter).toBe(43);
    expect((await issue()).number).toBe(number(YEAR, 44));
  });

  it("takes the first free one after several in a row", async () => {
    await takeNumbers(number(YEAR, 42), number(YEAR, 43), number(YEAR, 44));

    expect((await issue()).number).toBe(number(YEAR, 45));
  });

  it("is stepped over inside a transaction the caller opened, which one-time jobs bill in", async () => {
    await takeNumbers(number(YEAR, 42));

    const invoice = await prisma.$transaction((tx) =>
      issueInvoiceIn(tx, { clientId, companyId: null, serviceId: null, amount: 1_000 }),
    );

    expect(invoice.number).toBe(number(YEAR, 43));
  });

  it("does not cost the sweep the client's invoice", async () => {
    await takeNumbers(number(YEAR, 42));
    const subscriptionId = await makeSubscription();

    const run = await generateForSubscriptionInvoices(subscriptionId);

    expect(run).toMatchObject({ created: 1, failed: 0 });
    expect((await invoicesOf(subscriptionId)).map((i) => i.number)).toEqual([number(YEAR, 43)]);
  });

  it("goes past the series' highest when too many in a row are taken, so billing never stops", async () => {
    const block = Array.from({ length: MAX_TAKEN_NUMBERS }, (_, i) => number(YEAR, 42 + i));
    await takeNumbers(...block, number(YEAR, 200));

    expect((await issue()).number).toBe(number(YEAR, 201));
    expect((await readCounter()).invoiceCounter).toBe(201);
  });
});

describe("a failure that is neither a taken number nor the same period", () => {
  /**
   * A real unique violation that is not the period's, from an index only this test makes. Nothing
   * in the application can produce one any more, which is the reason it needs staging: this is
   * what a number written past the allocator would look like, and it must not pass for a lost race.
   */
  it("names the client on the card, with the reason readable", async () => {
    await prisma.invoice.create({
      data: { number: number(YEAR, 900), clientId, amount: 5_000 },
    });
    const subscriptionId = await makeSubscription();
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "numbering_test_clash" ON "Invoice" ("amount") WHERE "clientId" = '${clientId}'`,
    );

    const run = await runWithActivity(
      { actor: { kind: "system", label: "The scheduler" } },
      () => generateForSubscriptionInvoices(subscriptionId),
    ).finally(() => prisma.$executeRawUnsafe(`DROP INDEX "numbering_test_clash"`));

    expect(run).toMatchObject({ created: 0, failed: 1 });
    expect(await invoicesOf(subscriptionId)).toEqual([]);
    const failure = await prisma.activityEvent.findFirst({
      where: { action: "subscription.generation_failed", clientId },
    });
    expect(failure?.outcome).toBe("failed");
    expect(JSON.stringify(failure?.changes)).toContain("Unique constraint failed");
  });
});

describe("the same period twice", () => {
  it("is still refused by the database", async () => {
    const subscriptionId = await makeSubscription();
    const row = {
      clientId,
      companyId: null,
      serviceId,
      subscriptionId,
      periodKey: "2026-01",
      amount: 5_000,
    };
    await issueInvoice(row);

    await expect(issueInvoice(row)).rejects.toMatchObject({ code: "P2002" });
    expect(await invoicesOf(subscriptionId)).toHaveLength(1);
    expect((await readCounter()).invoiceCounter).toBe(42); // the loser's number went back
  });

  /**
   * Two sweeps that both read "nothing issued yet" before either writes. The test holds the
   * counter's row lock until both are queued on it, so that order is a fact rather than a likely
   * timing: one bills, the other meets the (subscription, period) constraint.
   */
  it("is skipped without a word when a concurrent sweep got there first", async () => {
    const subscriptionId = await makeSubscription();

    let sweeps: Promise<{ created: number; failed: number }[]> | undefined;
    await prisma.$transaction(
      async (tx) => {
        await tx.firmProfile.update({
          where: { id: 1 },
          data: { invoiceCounter: { increment: 0 } },
        });
        sweeps = Promise.all([
          runWithActivity({ actor: { kind: "system", label: "The scheduler" } }, () =>
            generateForSubscriptionInvoices(subscriptionId),
          ),
          runWithActivity({ actor: { kind: "system", label: "The scheduler" } }, () =>
            generateForSubscriptionInvoices(subscriptionId),
          ),
        ]);
        await expect.poll(locksWaited, { timeout: 4_000, interval: 25 }).toBe(2);
      },
      { timeout: 4_500 },
    );
    const [first, second] = await sweeps!;

    expect(first.created + second.created).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    expect(await invoicesOf(subscriptionId)).toHaveLength(1);
    expect(
      await prisma.activityEvent.count({
        where: { action: "subscription.generation_failed", clientId },
      }),
    ).toBe(0);
  });
});

async function locksWaited() {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row.waiting;
}

describe("the year in the number", () => {
  it("a late invoice continues its own year's series and leaves the counter alone", async () => {
    await takeNumbers(number(YEAR - 1, 7), number(YEAR - 1, 12));

    const late = await issue({ issuedAt: new Date(Date.UTC(YEAR - 1, 11, 31)) });

    expect(late.number).toBe(number(YEAR - 1, 13));
    expect(await readCounter()).toEqual({ invoiceCounterYear: YEAR, invoiceCounter: 41 });
    expect((await issue()).number).toBe(number(YEAR, 42));
  });

  it("reads the series as numbers, so a wider one from an old digits setting still counts", async () => {
    await takeNumbers(number(YEAR - 1, 99), `${PREFIX}-${YEAR - 1}-00100`);

    const late = await issue({ issuedAt: new Date(Date.UTC(YEAR - 1, 11, 31)) });

    expect(late.number).toBe(number(YEAR - 1, 101));
  });

  it("starts a late year that has no invoices at one", async () => {
    const late = await issue({ issuedAt: new Date(Date.UTC(YEAR - 3, 5, 15)) });

    expect(late.number).toBe(number(YEAR - 3, 1));
  });

  it("does not lose a late invoice in the sweep", async () => {
    // the counter has moved on a year, as after a sweep that billed January first
    await setCounter(YEAR + 1, 15);
    await takeNumbers(number(YEAR, 1));
    const subscriptionId = await makeSubscription();

    const run = await generateForSubscriptionInvoices(subscriptionId);

    expect(run).toMatchObject({ created: 1, failed: 0 });
    expect((await invoicesOf(subscriptionId)).map((i) => i.number)).toEqual([number(YEAR, 2)]);
    expect(await readCounter()).toEqual({ invoiceCounterYear: YEAR + 1, invoiceCounter: 15 });
  });

  it("resets the counter when the year moves forward", async () => {
    await setCounter(YEAR - 1, 900);

    expect((await issue()).number).toBe(number(YEAR, 1));
    expect(await readCounter()).toEqual({ invoiceCounterYear: YEAR, invoiceCounter: 1 });
  });

  it("starts the first series the firm ever has", async () => {
    await setCounter(null, 0);

    expect((await issue()).number).toBe(number(YEAR, 1));
    expect(await readCounter()).toEqual({ invoiceCounterYear: YEAR, invoiceCounter: 1 });
  });
});
