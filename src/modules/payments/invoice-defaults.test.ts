import { describe, expect, it } from "vitest";
import { billToOf, invoiceDefaults, jobDefaults, prefilledPosition } from "./invoice-defaults";

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
    expect(prefilledPosition(defaults, 4000)).toEqual({
      description: "Bookkeeping",
      hours: "",
      rate: "40.00",
      amount: "100.00",
    });
  });

  it("is empty with no service and no earlier hours", () => {
    expect(prefilledPosition(null, null)).toEqual({
      description: "",
      hours: "",
      rate: "",
      amount: "",
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
