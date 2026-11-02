import { halvesOf } from "@shared/billing-periods";
import type { Service } from "@shared/schema/catalog";
import type { Client, Subscription } from "@shared/schema/client";
import type { UnbilledJob } from "@shared/schema/payment";
import { moneyInputValue } from "@/shared/lib/money";
import type { DraftLine } from "./invoice-lines-editor";

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

/** The service's name and price, and the rate this client's last hours were billed at. */
export function prefilledPosition(
  defaults: InvoiceDefaults | null,
  lastRate: number | null,
): DraftLine {
  return {
    description: defaults?.name ?? "",
    quantity: "",
    rate: lastRate !== null ? moneyInputValue(lastRate) : "",
    amount: suggestedAmount(defaults),
    unit: "hour",
    itemId: null,
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
