import type { FastifyInstance } from "fastify";
import { registerCampaignRoutes } from "./campaigns.routes.js";
import { registerRoutes } from "./mailouts.routes.js";

export async function mailoutsModule(app: FastifyInstance) {
  await registerRoutes(app);
  await registerCampaignRoutes(app);
}

/** The scheduler's entry point — S10.1, one sweep for every campaign whose date has come. */
export { runDueCampaigns } from "./campaigns.service.js";
export { sweepBounces, sweepStalledSends } from "./mailouts.service.js";
