import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./activity.routes.js";

export async function activityModule(app: FastifyInstance) {
  await registerRoutes(app);
}
