import { z } from "zod";
import { money, uuid } from "./common.js";
import { billingPeriod, clientType } from "./enums.js";

export const companySchema = z.object({
  id: uuid,
  name: z.string().min(1),
});
export type Company = z.infer<typeof companySchema>;

/** A person in the client's "People" tab + the service they handle. */
export const clientPersonSchema = z.object({
  id: uuid,
  name: z.string().min(1),
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
  active: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const clientSchema = z.object({
  id: uuid,
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

export const clientListQuery = z.object({
  tab: z.enum(["one_time", "regular"]).default("one_time"),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof clientListQuery>;