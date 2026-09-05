import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./notifications.routes.js";

export async function notificationsModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// the two scheduled passes (server.ts) and the housekeeping purge
export {
  runNotificationSweep,
  runMeetingReminders,
  purgeOldNotifications,
  RETENTION_DAYS,
} from "./notifications.sweep.js";
