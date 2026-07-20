import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./catalog.routes.js";

export async function catalogModule(app: FastifyInstance) {
  await registerRoutes(app);
}
