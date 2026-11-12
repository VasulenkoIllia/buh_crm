import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./payments.routes.js";

export async function paymentsModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// invoice issuing — Tasks bills one-time jobs through this (Payments owns numbering)
export { failureReason, issueInvoice, issueJobInvoice } from "./invoicing.js";

// scheduler job #2 + instant per-subscription billing (used by the clients module)
export {
  generatePeriodInvoices,
  generateForSubscriptionInvoices,
} from "./payments.generation.js";

// debt rollup (used by the clients module)
export { debtByClient } from "./payments.service.js";

// the client card's Invoices tab badge
export { countOwedInvoicesForClient } from "./payments.repository.js";

// the public pay link, registered beside /health (app.ts), and Stripe's line on Settings → System
export { registerPayLinkRoutes } from "./pay-link.routes.js";
export { stripeStatus } from "./pay-link.service.js";
