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
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Client = z.infer<typeof clientSchema>;
