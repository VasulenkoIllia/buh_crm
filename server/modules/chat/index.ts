import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./chat.routes.js";
import { closeAllStreams } from "./chat.stream.js";

export async function chatModule(app: FastifyInstance) {
  await registerRoutes(app);
  // `app.close()` waits for every open connection, and a stream never finishes by itself
  app.addHook("preClose", async () => closeAllStreams());
}
