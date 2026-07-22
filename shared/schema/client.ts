import { z } from "zod";
import { rhythmOverridesSchema } from "./catalog.js";
import { money, uuid } from "./common.js";
import { billingPeriod, clientType, invoiceTrigger } from "./enums.js";

export const companySchema = z.object({
  id: uuid,
  name: z.string().min(1),
});
export type Company = z.infer<typeof companySchema>;

/** A person in the client's "People" tab + the service they handle. */
export const clientPersonSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  serviceId: uuid.nullable(),
  /** legacy pre-S3 free-text label — shown until the person is edited */
  serviceLabel: z.string().nullable(),
  role: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type ClientPerson = z.infer<typeof clientPersonSchema>;

export const subscriptionSchema = z.object({
  id: uuid,
  clientId: uuid,
  companyId: uuid.nullable(),
  serviceId: uuid,
  amount: money,
  period: billingPeriod,
  /** per-client billing timing; null = inherit the service preset */
  invoiceTrigger: invoiceTrigger.nullable(),
  invoiceDay: z.number().int().nullable(),
  dueDays: z.number().int().nullable(),
  /** per-client task-template overrides keyed by templateId ({} = all inherit) */
  rhythmOverrides: rhythmOverridesSchema,
  active: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const clientSchema = z.object({
  id: uuid,
  /** category chips + subscription rows join against the catalog list client-side */
  categories: z.array(uuid),
  subscriptions: z.array(subscriptionSchema),
  type: clientType,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  /** individual → "First Last"; company → companyName (main). Computed server-side. */
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  address: z.string().nullable(),
  sourceId: uuid.nullable(),
  isRegular: z.boolean(),
  regularOverride: z.boolean().nullable(),
  description: z.string().nullable(),
  companies: z.array(companySchema),
  people: z.array(clientPersonSchema),
  /** derived in Payments (S7); 0 until invoices exist */
  debt: money,
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Client = z.infer<typeof clientSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────────

const optionalTrimmed = z
  .string()
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

export const clientPersonInput = z.object({
  name: z.string().trim().min(1),
  /** picked from the catalog (S3+); serviceLabel below is legacy display only */
  serviceId: uuid.nullable().optional(),
  serviceLabel: optionalTrimmed,
  role: optionalTrimmed,
  phone: optionalTrimmed,
  // tolerant of "" (→ null) like the other fields, but validated when present
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.email().nullable().optional(),
  ),
});
export type ClientPersonInput = z.infer<typeof clientPersonInput>;

const clientFields = z.object({
  type: clientType,
  firstName: optionalTrimmed,
  lastName: optionalTrimmed,
  companyName: optionalTrimmed,
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  address: optionalTrimmed,
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
  regularOverride: z.boolean().nullable().optional(),
  /** additional companies — plain text names, per client (order preserved) */
  companyNames: z.array(z.string().min(1)).max(50).default([]),
  /** the "People" tab */
  people: z.array(clientPersonInput).max(50).default([]),
});

/** individual → first+last required; company → companyName required. */
const requireByType = (v: {
  type: "individual" | "company";
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
}) => {
  if (v.type === "individual") return !!v.firstName && !!v.lastName;
  return !!v.companyName;
};
const requireMsg = {
  message: "Individual needs first and last name; company needs a company name",
};

export const createClientInput = clientFields.refine(requireByType, requireMsg);
export type CreateClientInput = z.infer<typeof createClientInput>;

export const updateClientInput = clientFields
  .partial()
  .extend({
    // stay truly optional on PATCH (no default) so omitting them leaves the lists untouched
    companyNames: z.array(z.string().min(1)).max(50).optional(),
    people: z.array(clientPersonInput).max(50).optional(),
  })
  .refine((v) => v.type === undefined || requireByType(v as never), requireMsg);
export type UpdateClientInput = z.infer<typeof updateClientInput>;

// ── Subscriptions & categories (S3) ─────────────────────────────────────────

const subscriptionBilling = {
  /** per-client billing timing (copied from the service preset in the UI) */
  invoiceTrigger: z.enum(["on_period_start", "on_period_end"]).nullable().optional(),
  invoiceDay: z.number().int().min(1).max(31).nullable().optional(),
  /** per-client overdue terms; null = inherit the service preset */
  dueDays: z.number().int().min(1).max(365).nullable().optional(),
};
const subscriptionBillingValid = (v: {
  invoiceTrigger?: "on_period_start" | "on_period_end" | null;
  invoiceDay?: number | null;
}) => v.invoiceDay == null || v.invoiceTrigger === "on_period_start";
const subscriptionBillingMsg = {
  path: ["invoiceDay"],
  message: "A custom day only applies when billing at the start of the period",
};

export const createSubscriptionInput = z
  .object({
    serviceId: uuid,
    companyId: uuid.nullable().optional(),
    amount: money,
    period: billingPeriod.default("month"),
    ...subscriptionBilling,
  })
  .refine(subscriptionBillingValid, subscriptionBillingMsg);
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionInput>;

export const updateSubscriptionInput = z
  .object({
    amount: money.optional(),
    period: billingPeriod.optional(),
    companyId: uuid.nullable().optional(),
    active: z.boolean().optional(),
    /** full replace of the per-client task overrides map */
    rhythmOverrides: rhythmOverridesSchema.optional(),
    ...subscriptionBilling,
  })
  // an omitted trigger means "not part of this patch" — the service layer re-checks the
  // rule against the MERGED row, so only an explicit day+wrong-trigger combo fails here
  .refine(
    (v) => v.invoiceTrigger === undefined || subscriptionBillingValid(v),
    subscriptionBillingMsg,
  );
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionInput>;

/** Full replace of the client's category chip set. */
export const setClientCategoriesInput = z.object({
  serviceIds: z.array(uuid).max(20),
});
export type SetClientCategoriesInput = z.infer<typeof setClientCategoriesInput>;

export const clientListQuery = z.object({
  tab: z.enum(["one_time", "regular"]).default("one_time"),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof clientListQuery>;