import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./access.routes.js";

export async function accessModule(app: FastifyInstance) {
  await registerRoutes(app);
}
