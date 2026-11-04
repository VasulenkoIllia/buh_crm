import { describe, expect, it } from "vitest";
import { todayPlus } from "@/shared/lib/format";
import {
  billToOf,
  copiedDraft,
  invoiceDefaults,
  jobDefaults,
  prefilledPosition,
  termDays,
} from "./invoice-defaults";
import { completedLine, draftTotal, toLineInput } from "./invoice-lines-editor";

const service = { name: "Bookkeeping", dueDays: 14 };
const subscription = { amount: 10000, period: "month" as const, dueDays: null };

describe("what a job being billed fills in", () => {
  const job = { title: "Tax return", amount: 7000, serviceName: "Tax work" };
  const terms = { name: "Tax work", amount: 10000, dueDays: 14 };

  it("takes the job's price ahead of its service's, and the service's terms", () => {
    expect(jobDefaults(terms, job)).toEqual({ name: "Tax work", amount: 7000, dueDays: 14 });
  });

  it("falls back on the service's price for a job with none", () => {
    expect(jobDefaults(terms, { ...job, amount: null }).amount).toBe(10000);
  });

  it("stands alone for a job with no active service", () => {
    expect(jobDefaults(null, job)).toEqual({ name: "Tax work", amount: 7000, dueDays: null });
    expect(jobDefaults(null, { ...job, serviceName: null }).name).toBe("Tax return");
    expect(jobDefaults(null, { ...job, amount: null }).amount).toBe(0);
  });
});

describe("what a new invoice fills in by itself", () => {
  it("takes the price and the terms from the client's service", () => {
    expect(invoiceDefaults(subscription, service)).toEqual({
      name: "Bookkeeping",
      amount: 10000,
      dueDays: 14,
    });
  });

  it("lets a client's own terms win over the service's", () => {
    expect(invoiceDefaults({ ...subscription, dueDays: 7 }, service).dueDays).toBe(7);
  });

  it("has no terms when neither sets any", () => {
    const none = { name: "Bookkeeping", dueDays: null };
    expect(invoiceDefaults(subscription, none).dueDays).toBeNull();
  });

  it("bills one half of a price agreed by the month, the smaller one on an odd cent", () => {
    const half = { ...subscription, amount: 10001, period: "half_month" as const };
    expect(invoiceDefaults(half, service).amount).toBe(5000);
  });

  it("takes a one-time service's price as it is", () => {
    expect(invoiceDefaults({ ...subscription, period: null }, service).amount).toBe(10000);
  });

  it("still works before the catalogue has answered", () => {
    expect(invoiceDefaults(subscription, undefined)).toEqual({
      name: "",
      amount: 10000,
      dueDays: null,
    });
  });
});

describe("the first position", () => {
  const defaults = { name: "Bookkeeping", amount: 10000, dueDays: 14 };

  it("carries the service and the client's last rate, and leaves the hours to a person", () => {
    const first = prefilledPosition(defaults, 4000);
    expect(first).toMatchObject({
      description: "Bookkeeping",
      quantity: "",
      rate: "40.00",
      amount: "100.00",
      unit: "hour",
      itemId: null,
    });
    // the price and the rate are two of three, but nobody typed them: no hours are made up
    expect(completedLine(first)).toBe(first);
    expect(draftTotal([first])).toBe(100_00);
    expect(completedLine({ ...first, rate: "50" }).quantity).toBe("2");
  });

  it("is empty with no service and no earlier hours", () => {
    expect(prefilledPosition(null, null)).toMatchObject({
      description: "",
      quantity: "",
      rate: "",
      amount: "",
      unit: "hour",
      itemId: null,
    });
  });

  it("offers the rate on its own when there is no service", () => {
    expect(prefilledPosition(null, 4000).rate).toBe("40.00");
  });

  it("leaves a free service's amount empty rather than writing a zero", () => {
    expect(prefilledPosition({ ...defaults, amount: 0 }, null).amount).toBe("");
  });
});

describe("who the invoice is addressed to", () => {
  const client = {
    displayName: "Olena Petrenko",
    email: "olena@example.test",
    companies: [
      {
        id: "c1",
        name: "Petrenko LLC",
        phone: null,
        email: "books@example.test",
        description: null,
      },
      { id: "c2", name: "Nova Inc", phone: null, email: null, description: null },
    ],
  };

  it("is the client, without a company", () => {
    expect(billToOf(client, null)).toEqual({
      name: "Olena Petrenko",
      email: "olena@example.test",
    });
  });

  it("is the company at its own address", () => {
    expect(billToOf(client, "c1")).toEqual({
      name: "Petrenko LLC",
      email: "books@example.test",
    });
  });

  it("is the company at the client's address when it has none", () => {
    expect(billToOf(client, "c2")).toEqual({ name: "Nova Inc", email: "olena@example.test" });
  });
});

/** Duplicate on an invoice's card (owner, 2026-11-04): New invoice opens filled in from it. */
describe("what a copy of an invoice opens with", () => {
  const original = {
    description: "october",
    amount: 120_00,
    lines: [],
    issuedAt: "2026-10-01T15:30:00.000Z",
    dueDate: "2026-10-11T00:00:00.000Z",
  };

  it("keeps the note and the single amount, and the original's term counted from today", () => {
    expect(copiedDraft(original)).toEqual({
      description: "october",
      lines: null,
      amount: "120.00",
      dueDate: todayPlus(10),
    });
  });

  it("copies no due date where there was none, and no note", () => {
    const draft = copiedDraft({ ...original, description: null, dueDate: null });
    expect(draft.dueDate).toBeNull();
    expect(draft.description).toBe("");
  });

  it("keeps the positions at the same prices, with the items they came from", () => {
    const lines = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        order: 0,
        description: "Accounting services",
        quantity: 2650,
        unitRate: 30_00,
        amount: 795_00,
        unit: "hour" as const,
        itemId: "22222222-2222-4222-8222-222222222222",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        order: 1,
        description: "Filing fee",
        quantity: null,
        unitRate: null,
        amount: 50_00,
        unit: null,
        itemId: null,
      },
    ];
    const draft = copiedDraft({ ...original, amount: 845_00, lines });
    expect(draft.amount).toBeNull();
    expect(draftTotal(draft.lines!)).toBe(845_00);
    expect(toLineInput(draft.lines!)).toEqual([
      {
        description: "Accounting services",
        quantity: 2650,
        unitRate: 30_00,
        amount: 795_00,
        unit: "hour",
        itemId: "22222222-2222-4222-8222-222222222222",
      },
      {
        description: "Filing fee",
        quantity: null,
        unitRate: null,
        amount: 50_00,
        unit: null,
        itemId: null,
      },
    ]);
  });

  it("counts the term in calendar days, whatever the hour of issue, and never below none", () => {
    expect(termDays("2026-10-01T23:59:00.000Z", "2026-10-11T00:00:00.000Z")).toBe(10);
    expect(termDays("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toBe(0);
    expect(termDays("2026-10-05T10:00:00.000Z", "2026-10-01T00:00:00.000Z")).toBe(0);
  });
});
