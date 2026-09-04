import { describe, expect, it } from "vitest";
import type { Service } from "@shared/schema/catalog";
import type { Subscription } from "@shared/schema/client";
import {
  addStateFor,
  assignableServices,
  billingNote,
  existingFor,
} from "./subscription-add-rules";

const sub = (over: Partial<Subscription> & { serviceId: string }): Subscription =>
  ({
    id: `s-${over.serviceId}-${over.companyId ?? "main"}`,
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
  }) as Subscription;

const svc = (over: Partial<Service> & { id: string }): Service =>
  ({
    name: over.id,
    color: "#000",
    type: "one_time",
    defaultAmount: null,
    invoiceTrigger: "on_period_start",
    invoiceDay: null,
    dueDays: null,
    active: true,
    autoAddToNewClients: false,
    order: 0,
    clientsCount: 0,
    taskTemplates: [],
    ...over,
  }) as Service;

describe("assignableServices", () => {
  it("drops what a client cannot hold: internal services and retired catalog rows", () => {
    const list = assignableServices([
      svc({ id: "keep" }),
      svc({ id: "internal", type: "internal" }),
      svc({ id: "retired", active: false }),
    ]);
    expect(list.map((s) => s.id)).toEqual(["keep"]);
  });
});

describe("addStateFor", () => {
  it("is addable when the client holds nothing for that service", () => {
    expect(addStateFor("vat", [sub({ serviceId: "payroll" })], null)).toEqual({
      kind: "addable",
    });
  });

  it("is addable for a company when the existing row belongs to another target", () => {
    const held = [sub({ serviceId: "vat", companyId: "co-a" })];
    expect(addStateFor("vat", held, "co-b")).toEqual({ kind: "addable" });
    expect(addStateFor("vat", held, null)).toEqual({ kind: "addable" });
    expect(addStateFor("vat", held, "co-a")).toEqual({ kind: "in_force" });
  });

  it("names the day a scheduled service starts, instead of the server's blank refusal", () => {
    const held = [sub({ serviceId: "vat", state: "scheduled", inForceFrom: "2026-10-01" })];
    expect(addStateFor("vat", held, null)).toEqual({ kind: "scheduled", from: "2026-10-01" });
  });

  /**
   * The case the server gets wrong for the reader: a PAUSED service is not in the task form's
   * picker (it is not active) and cannot be added either — so "add it" is a dead end, and the way
   * back is Resume on the client card.
   */
  it("reports a paused service with its last served day", () => {
    const held = [
      sub({ serviceId: "vat", state: "paused", active: false, inForceUntil: "2026-08-12" }),
    ];
    expect(addStateFor("vat", held, null)).toEqual({ kind: "paused", until: "2026-08-12" });
  });

  it("tolerates a paused service with no end day", () => {
    const held = [
      sub({ serviceId: "vat", state: "paused", active: false, inForceUntil: null }),
    ];
    expect(addStateFor("vat", held, null)).toEqual({ kind: "paused", until: null });
  });
});

describe("existingFor", () => {
  it("gathers every company the client already holds the service on", () => {
    const held = existingFor("vat", [
      sub({ serviceId: "vat", companyId: "co-a" }),
      sub({ serviceId: "vat", companyId: null }),
      sub({ serviceId: "payroll", companyId: "co-a" }),
    ]);
    expect(held.map((s) => s.companyId)).toEqual(["co-a", null]);
  });
});

describe("billingNote", () => {
  const timing = { trigger: "on_period_start" as const, day: null };

  it("says nothing for a one-time service — it bills nothing on its own", () => {
    expect(billingNote(svc({ id: "job", type: "one_time" }), timing)).toBeNull();
  });

  it("warns that a subscription service starts billing on the spot", () => {
    expect(billingNote(svc({ id: "vat", type: "subscription" }), timing)).toContain(
      "as soon as the period starts",
    );
  });

  it("points at the end of the period when that is when it bills", () => {
    const note = billingNote(svc({ id: "vat", type: "subscription" }), {
      trigger: "on_period_end",
      day: null,
    });
    expect(note).toContain("end of the first period");
  });

  it("names the custom day rather than promising an immediate invoice", () => {
    const note = billingNote(svc({ id: "vat", type: "subscription" }), {
      trigger: "on_period_start",
      day: 10,
    });
    expect(note).toContain("day 10");
  });
});
