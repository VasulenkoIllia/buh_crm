import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./mailouts.routes.js";

export async function mailoutsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
