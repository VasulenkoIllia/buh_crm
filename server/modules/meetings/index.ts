import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./meetings.routes.js";

export async function meetingsModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// the client card's and lead card's "Meetings" rollups
export { listFor as listMeetingsFor } from "./meetings.service.js";

// the client card's Meetings tab badge
export { countUpcomingMeetingsForClient } from "./meetings.repository.js";
