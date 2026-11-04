import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./settings.routes.js";

// an invoice item added from an invoice's Position box, under Billing's gate (payments.md §3)
export { createInvoiceItem } from "./invoice-items.service.js";

export async function settingsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
