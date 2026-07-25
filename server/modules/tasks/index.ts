import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./tasks.routes.js";

export async function tasksModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// scheduler job + instant per-subscription generation (used by the clients module)
export {
  generateSubscriptionTasks,
  generateForSubscription,
  generateInternalTasks,
} from "./tasks.generation.js";
