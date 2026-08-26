import { z } from "zod";
import { rhythmOverridesSchema } from "./catalog.js";
import { money, uuid } from "./common.js";
import { billingPeriod, invoiceTrigger } from "./enums.js";

/**
 * A company OWNED BY ONE CLIENT — the dimension `companyId` points at on subscriptions, tasks
 * and invoices. `name` is unique across the whole system, case-insensitively. `email` is where
 * this company's invoices will go once S10 lands; with none set, the client's own email is the
 * fallback. A client that holds no companies is the ordinary case: everything hangs off the
 * client directly (`companyId = null`).
 */
export const companySchema = z.object({
  id: uuid,
  name: z.string().min(1),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  description: z.string().nullable(),
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
  /**
   * DERIVED from the served periods ("some period covers today") — never stored. Kept in the DTO
   * because every service picker filters on it; the periods themselves stay server-side.
   */
  active: z.boolean(),
  /** start of the current (or next, or last) served period */
  inForceFrom: z.iso.date(),
  /** last served day, INCLUSIVE — null while the subscription is open-ended, the normal state */
  inForceUntil: z.iso.date().nullable(),
  /** what the row says: serving now · starts on a future date · paused since a past one */
  state: z.enum(["in_force", "scheduled", "paused"]),
  /** the client's usual service — prefills their service pickers. At most one per client. */
  isDefault: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const clientSchema = z.object({
  id: uuid,
  /** derived: the services of the client's ACTIVE subscriptions (joined to the catalog in the UI) */
  categories: z.array(uuid),
  subscriptions: z.array(subscriptionSchema),
  firstName: z.string(),
  lastName: z.string().nullable(),
  /** informational label only ("trades as / works at") — never the client's identity */
  companyName: z.string().nullable(),
  /** "First Last", trimmed. Computed server-side. */
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  address: z.string().nullable(),
  sourceId: uuid.nullable(),
  /** derived: holds an active subscription-type service. Not stored, not settable. */
  isRegular: z.boolean(),
  description: z.string().nullable(),
  companies: z.array(companySchema),
  people: z.array(clientPersonSchema),
  /** derived in Payments (S7); 0 until invoices exist */
  debt: money,
  /**
   * THIS reader keeps them at the top of their own list — never a firm-wide flag.
   * Authoritative on the list and the single-client read; a mutation response does not know who
   * asked and reports `false`, so refetch rather than reading it from one.
   */
  pinned: z.boolean(),
  /**
   * How much is still LIVE behind each of the card's tabs — open tasks, meetings still to come,
   * unsettled invoices, files held. Optional because only the single-client read computes it: the
   * list would pay for four aggregates per page to show a number no row displays.
   *
   * Each count is the owning module's own rule, imported from it rather than restated here, so a
   * badge can never disagree with the tab it sits on.
   */
  counts: z
    .object({
      tasks: z.number().int(),
      meetings: z.number().int(),
      invoices: z.number().int(),
      files: z.number().int(),
    })
    .optional(),
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

/**
 * One company as the client's editor sends it. `id` present = an existing row being edited (so a
 * rename keeps the same company, and everything pointing at it follows); absent = a new one.
 * Only the name is required — the create form uses that to add companies by name alone, and the
 * card's Companies tab fills in the rest.
 */
export const companyInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, "Company name is required").max(160),
  phone: optionalTrimmed,
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.email().nullable().optional(),
  ),
  description: optionalTrimmed,
});
export type CompanyInput = z.infer<typeof companyInput>;

const clientFields = z.object({
  /** the client's identity — the last name is optional (user, 2026-07-26) */
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: optionalTrimmed,
  /** informational label only; the client's real companies are the list below */
  companyName: optionalTrimmed,
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  address: optionalTrimmed,
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
  /** the client's companies, in display order — a full replace of the list */
  companies: z.array(companyInput).max(50).default([]),
  /** the "People" tab */
  people: z.array(clientPersonInput).max(50).default([]),
});

export const createClientInput = clientFields;
export type CreateClientInput = z.infer<typeof createClientInput>;

export const updateClientInput = clientFields.partial().extend({
  // stay truly optional on PATCH (no default) so omitting them leaves the lists untouched
  companies: z.array(companyInput).max(50).optional(),
  people: z.array(clientPersonInput).max(50).optional(),
});
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
    /** first day of service; defaults to today. There is no end — see pause/resume below. */
    startsOn: z.iso.date().optional(),
    ...subscriptionBilling,
  })
  .refine(subscriptionBillingValid, subscriptionBillingMsg);
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionInput>;

/**
 * Pause and resume are their own actions, not an `active` flag, because each carries a DATE — and
 * that date is the whole point: it is what lets the system answer "was this client being served on
 * the 1st" months later (decision 2026-07-29).
 */
export const pauseSubscriptionInput = z.object({
  /**
   * Last day still served, INCLUSIVE; omitted = today. May be in the future to plan ahead, and may
   * be changed later by pausing again. Explicit `null` REMOVES a scheduled end — the service goes
   * back to open-ended, which is how a planned pause is called off.
   */
  lastDay: z.iso.date().nullable().optional(),
  note: z.string().trim().max(200).optional(),
});
export type PauseSubscriptionInput = z.infer<typeof pauseSubscriptionInput>;

export const resumeSubscriptionInput = z.object({
  /** first day served again; defaults to today. May be in the future to plan ahead. */
  startsOn: z.iso.date().optional(),
  note: z.string().trim().max(200).optional(),
});
export type ResumeSubscriptionInput = z.infer<typeof resumeSubscriptionInput>;

export const updateSubscriptionInput = z
  .object({
    amount: money.optional(),
    period: billingPeriod.optional(),
    companyId: uuid.nullable().optional(),
    /** make this the client's default service (clears the previous one) or drop the flag */
    isDefault: z.boolean().optional(),
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

export const clientListQuery = z.object({
  /**
   * "all" = no regularity filter (pickers); the clients screen uses the 2 tabs.
   * "archived" is the odd one out — it ignores regularity and returns ONLY archived clients,
   * which is what the Archive screen reads. Every other tab excludes them.
   */
  tab: z.enum(["one_time", "regular", "all", "archived"]).default("one_time"),
  search: z.string().trim().optional(),
  /**
   * Clients holding this service RIGHT NOW. A client's services are derived from subscriptions in
   * force today, never stored — so this filter must ask the same question the row's chips answer,
   * or the two disagree about who has what (see `inForceTodayWhere`).
   */
  serviceId: uuid.optional(),
  /**
   * Row order WITHIN each block — pinned clients always lead, whatever this says.
   *
   * `recent` (newest first) is the default because it is what the screen has always done; naming
   * it rather than leaving it implicit is what lets the other two exist. `updated` answers "what
   * did we touch last", which is the question a 177-client book actually gets asked.
   */
  sort: z.enum(["recent", "updated", "name"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  /** 100 is the ceiling everywhere in the app; the clients screen lets the reader pick */
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof clientListQuery>;
// ── client secrets (S7.5) ────────────────────────────────────────────────────

/**
 * A credential the firm holds for a client. The VALUE never appears here — the list endpoint
 * returns label + description only, and revealing goes through its own audited endpoint.
 */
export const clientSecretSchema = z.object({
  id: uuid,
  label: z.string().min(1),
  description: z.string().nullable(),
  /** false = a pointer-only entry: nothing is stored, the description says where it lives */
  hasValue: z.boolean(),
  createdByName: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ClientSecret = z.infer<typeof clientSecretSchema>;

export const clientSecretInput = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  /**
   * The secret itself. Omitted on edit = leave the stored value alone; explicit `null` = drop it
   * and keep the entry as a pointer. Capped because this is a credential, not a document.
   */
  value: z.string().max(10_000).nullable().optional(),
});
export type ClientSecretInput = z.infer<typeof clientSecretInput>;

/** Re-authentication: the admin's OWN login password, for a five-minute grant on ONE client. */
export const unlockSecretsInput = z.object({ password: z.string().min(1).max(200) });
export type UnlockSecretsInput = z.infer<typeof unlockSecretsInput>;

export const secretGrantSchema = z.object({ expiresAt: z.iso.datetime() });
export const revealedSecretSchema = z.object({
  value: z.string(),
  expiresAt: z.iso.datetime(),
});
