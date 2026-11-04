import { halvesOf } from "@shared/billing-periods";
import type { Service } from "@shared/schema/catalog";
import type { Client, Subscription } from "@shared/schema/client";
import type { Invoice, UnbilledJob } from "@shared/schema/payment";
import { todayPlus } from "@/shared/lib/format";
import { moneyInputValue } from "@/shared/lib/money";
import { offeredLine, toDraftLines, type DraftLine } from "./invoice-lines-editor";

/**
 * **What a new invoice can fill in by itself** (payments.md §10). Only suggestions: the form shows
 * these until somebody types, and what is typed is never replaced.
 */
export interface InvoiceDefaults {
  name: string;
  amount: number;
  /** null = the service sets no terms, so the date stays empty */
  dueDays: number | null;
}

export function invoiceDefaults(
  subscription: Pick<Subscription, "amount" | "period" | "dueDays">,
  service: Pick<Service, "name" | "dueDays"> | undefined,
): InvoiceDefaults {
  const { amount, period, dueDays } = subscription;
  return {
    name: service?.name ?? "",
    // twice a month is a monthly price; a hand-made invoice bills one half of it
    amount: period === "half_month" ? halvesOf(amount)[0] : amount,
    dueDays: dueDays ?? service?.dueDays ?? null, // per-client override wins, as on the server
  };
}

/**
 * What a job being billed suggests: its own price, ahead of its service's. It has to stand alone,
 * because a job can have no active service, or none at all.
 */
export function jobDefaults(
  defaults: InvoiceDefaults | null,
  job: Pick<UnbilledJob, "title" | "amount" | "serviceName">,
): InvoiceDefaults {
  return {
    name: defaults?.name || job.serviceName || job.title,
    amount: job.amount ?? defaults?.amount ?? 0,
    dueDays: defaults?.dueDays ?? null,
  };
}

/** A free service suggests nothing: "0.00" in the box would only have to be typed over. */
export const suggestedAmount = (defaults: InvoiceDefaults | null) =>
  defaults && defaults.amount > 0 ? moneyInputValue(defaults.amount) : "";

/**
 * The service's name and price, and the rate this client's last hours were billed at. Offered, not
 * typed: the price and the rate are two of three, and the hours are still a person's to give.
 */
export function prefilledPosition(
  defaults: InvoiceDefaults | null,
  lastRate: number | null,
): DraftLine {
  return offeredLine({
    description: defaults?.name ?? "",
    quantity: "",
    rate: lastRate !== null ? moneyInputValue(lastRate) : "",
    amount: suggestedAmount(defaults),
    unit: "hour",
    itemId: null,
  });
}

const DAY_MS = 86_400_000;

/** Days from issue to due, by the dates the card shows (UTC, as `fmtBizDate` reads them). */
export const termDays = (issuedAt: string, dueDate: string) =>
  Math.max(
    0,
    Math.round((Date.parse(dueDate.slice(0, 10)) - Date.parse(issuedAt.slice(0, 10))) / DAY_MS),
  );

/**
 * **What a copy of an invoice opens with** (Duplicate, owner 2026-11-04, as TaxDome does it): the
 * same note, and the same positions at the same prices with the items they came from, or the same
 * single amount. The number and the date of issue are the new invoice's own, given on Create. The
 * due date keeps the original's term from today: issued on the 1st and due on the 11th, the copy
 * is due ten days from now. One with no due date copies none.
 */
export function copiedDraft(
  invoice: Pick<Invoice, "description" | "amount" | "lines" | "dueDate" | "issuedAt">,
) {
  const itemised = invoice.lines.length > 0;
  return {
    description: invoice.description ?? "",
    lines: itemised ? toDraftLines(invoice.lines) : null,
    amount: itemised ? null : moneyInputValue(invoice.amount),
    dueDate: invoice.dueDate ? todayPlus(termDays(invoice.issuedAt, invoice.dueDate)) : null,
  };
}

/** Who the paper will address: the same two answers `invoicePdf` gives on the server. */
export function billToOf(
  client: Pick<Client, "displayName" | "email" | "companies">,
  companyId: string | null,
) {
  const company = client.companies.find((c) => c.id === companyId);
  return {
    name: company?.name ?? client.displayName,
    email: company?.email ?? client.email,
  };
}
