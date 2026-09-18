import type { FastifyInstance } from "fastify";
import { onRealtime, releaseRealtime, retainRealtime } from "../../core/realtime.js";
import { registerRoutes } from "./chat.routes.js";
import { closeAllStreams, deliverToStreams, useStreamLogger } from "./chat.stream.js";

export async function chatModule(app: FastifyInstance) {
  await registerRoutes(app);

  // every notification, from whichever process published it, goes to the streams this one holds
  onRealtime(deliverToStreams);
  useStreamLogger(app.log);
  let listening = false;
  app.addHook("onReady", async () => {
    await retainRealtime(app.log);
    listening = true;
  });
  // `app.close()` waits for every open connection, and a stream never finishes by itself
  app.addHook("preClose", async () => closeAllStreams(app));
  app.addHook("onClose", async () => {
    if (listening) await releaseRealtime();
  });
}
