import { z } from "zod";
import { money, uuid } from "./common.js";
import { invoiceStatus } from "./enums.js";

export const paymentSchema = z.object({
  id: uuid,
  invoiceId: uuid,
  amount: money,
  paidAt: z.iso.datetime(),
  createdById: uuid,
});
export type Payment = z.infer<typeof paymentSchema>;

export const invoiceSchema = z.object({
  id: uuid,
  number: z.string().min(1),
  clientId: uuid,
  companyId: uuid.nullable(),
  serviceId: uuid.nullable(),
  amount: money,
  /** derived: Σ payments */
  paid: money,
  /** derived: amount − paid */
  balance: money,
  /** derived from paid/balance/dueDate */
  status: invoiceStatus,
  dueDate: z.iso.datetime().nullable(),
  issuedAt: z.iso.datetime(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
