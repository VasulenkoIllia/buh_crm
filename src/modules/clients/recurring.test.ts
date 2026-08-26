import { describe, expect, it } from "vitest";
import { recurringByPeriod } from "./recurring";

type Sub = Parameters<typeof recurringByPeriod>[0]["subscriptions"][number];

const sub = (over: Partial<Sub> & { serviceId: string }): Sub =>
  ({
    id: `s-${over.serviceId}-${over.period ?? "job"}`,
    clientId: "c1",
    companyId: null,
    amount: 0,
    period: "month",
    invoiceTrigger: null,
    invoiceDay: null,
    dueDays: null,
    rhythmOverrides: {},
    active: true,
    inForceFrom: "2026-01-01",
    inForceUntil: null,
    state: "in_force",
    isDefault: false,
    ...over,
  }) as Sub;

/** the catalog map the row already holds — only `type` is ever read */
const catalog = new Map<string, { type: "subscription" | "one_time" | "internal" }>([
  ["recurring", { type: "subscription" }],
  ["recurring2", { type: "subscription" }],
  ["job", { type: "one_time" }],
]);

describe("recurringByPeriod", () => {
  it("ignores one-time services — their price is per JOB, not per period", () => {
    // exactly the client that exposed this: $600/month plus three one-time jobs read as $1,800
    const client = {
      subscriptions: [
        sub({ serviceId: "job", amount: 0, period: null }),
        sub({ serviceId: "recurring", amount: 60_000, period: "month" }),
        sub({ serviceId: "job", amount: 45_000, period: null }),
        sub({ serviceId: "job", amount: 75_000, period: null }),
      ],
    };
    expect(recurringByPeriod(client, catalog)).toEqual([["month", 60_000]]);
  });

  it("keeps different periods apart instead of inventing a total", () => {
    const client = {
      subscriptions: [
        sub({ serviceId: "recurring", amount: 60_000, period: "month" }),
        sub({ serviceId: "recurring2", amount: 30_000, period: "quarter" }),
      ],
    };
    // never 90_000 of anything — no one bills that
    expect(recurringByPeriod(client, catalog)).toEqual([
      ["month", 60_000],
      ["quarter", 30_000],
    ]);
  });

  it("adds up services that DO share a period", () => {
    const client = {
      subscriptions: [
        sub({ serviceId: "recurring", amount: 60_000, period: "month" }),
        sub({ serviceId: "recurring2", amount: 20_000, period: "month" }),
      ],
    };
    expect(recurringByPeriod(client, catalog)).toEqual([["month", 80_000]]);
  });

  it("orders month → quarter → year, not by insertion", () => {
    const client = {
      subscriptions: [
        sub({ serviceId: "recurring", amount: 1_000, period: "year" }),
        sub({ serviceId: "recurring2", amount: 2_000, period: "month" }),
      ],
    };
    expect(recurringByPeriod(client, catalog).map(([p]) => p)).toEqual(["month", "year"]);
  });

  it("counts only what is in force — a paused service bills nothing", () => {
    const client = {
      subscriptions: [
        sub({ serviceId: "recurring", amount: 60_000, period: "month", active: false }),
      ],
    };
    expect(recurringByPeriod(client, catalog)).toEqual([]);
  });

  it("returns nothing for a client with only one-time work", () => {
    const client = { subscriptions: [sub({ serviceId: "job", amount: 45_000, period: null })] };
    expect(recurringByPeriod(client, catalog)).toEqual([]);
  });

  it("refuses a legacy row that still carries a period on a one-time service", () => {
    // the back-fill cleared these, but the type check is the rule the rest of the app derives from
    // and must hold on its own — a stale period must not put a job price into a recurring total
    const client = {
      subscriptions: [sub({ serviceId: "job", amount: 45_000, period: "month" })],
    };
    expect(recurringByPeriod(client, catalog)).toEqual([]);
  });
});
