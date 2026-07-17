import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./__name__.routes.js";

// Public surface of the module — the only file other code may import.
export async function __name__Module(app: FastifyInstance) {
  await registerRoutes(app);
}
