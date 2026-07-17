import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./leads.routes.js";

export async function leadsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
