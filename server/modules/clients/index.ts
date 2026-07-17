import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./clients.routes.js";

export { toClientDto } from "./clients.service.js";

export async function clientsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
