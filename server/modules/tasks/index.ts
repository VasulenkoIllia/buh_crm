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

// used by the meetings module (S8): opening a task from a meeting goes through the SAME
// createTask as a hand-made one, so a meeting's task bills and validates identically
export { createTask } from "./tasks.service.js";
export { listDeadlinesInRange, countOpenTasksForClient } from "./tasks.repository.js";
