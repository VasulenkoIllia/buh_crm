import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./settings.routes.js";

export async function settingsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
