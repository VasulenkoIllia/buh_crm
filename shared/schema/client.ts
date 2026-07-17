import { z } from "zod";
import { money, uuid } from "./common.js";
import { billingPeriod } from "./enums.js";

export const companySchema = z.object({
  id: uuid,
  name: z.string().min(1),
});
export type Company = z.infer<typeof companySchema>;

export const subscriptionSchema = z.object({
  id: uuid,
  clientId: uuid,
  companyId: uuid.nullable(),
  serviceId: uuid,
  amount: money,
  period: billingPeriod,
  active: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const clientSchema = z.object({
  id: uuid,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  address: z.string().nullable(),
  sourceId: uuid.nullable(),
  /** isRegular = regularOverride ?? hasActiveSubscription — computed server-side */
  isRegular: z.boolean(),
  regularOverride: z.boolean().nullable(),
  description: z.string().nullable(),
  companies: z.array(companySchema),
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

export const createClientInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  address: optionalTrimmed,
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
  regularOverride: z.boolean().nullable().optional(),
  /** company names — existing names get linked, new ones created (M:N by name) */
  companyNames: z.array(z.string().min(1)).max(50).default([]),
});
export type CreateClientInput = z.infer<typeof createClientInput>;

// companyNames must stay truly optional here (no default): when omitted, the update
// leaves the M:N links untouched. (createClientInput's .default([]) would otherwise
// reset companies to empty on any partial update, e.g. the Regular toggle.)
export const updateClientInput = createClientInput.partial().extend({
  companyNames: z.array(z.string().min(1)).max(50).optional(),
});
export type UpdateClientInput = z.infer<typeof updateClientInput>;

export const clientListQuery = z.object({
  tab: z.enum(["all", "regular", "one_time"]).default("all"),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof clientListQuery>;
