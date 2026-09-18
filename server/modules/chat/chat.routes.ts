import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { gate } from "../../core/access.js";
import type { StreamRouteConfig } from "../../core/route-inventory.js";
import { chatPingInput, type ChatPingResult, type ChatPresence } from "@shared/schema/chat.js";
import { publish, realtimeListening } from "../../core/realtime.js";
import { onlinePeople, openStream } from "./chat.stream.js";

const STREAM: StreamRouteConfig = { stream: true };

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The live connection (chat.md §7.1). `stream: true` tells every suite that walks the route
   * inventory that this response does not end (`core/route-inventory.ts`).
   *
   * No `HEAD`: Fastify adds one to every `GET`, and a `HEAD` of a stream means nothing.
   */
  app.get(
    "/stream",
    {
      exposeHeadRoute: false,
      config: { ...gate("chat"), ...STREAM },
    },
    async (request, reply) => openStream(request, reply),
  );

  /**
   * **The delivery test** (Settings → System, "Live connection"): a `pong` to the caller alone,
   * through the same `NOTIFY` every chat event takes, so the tab can time the whole round trip. It
   * changes nothing, which is why it is a quiet route (`server/test/quiet-routes.ts`).
   */
  app.post(
    "/stream/ping",
    { config: gate("chat"), schema: { body: chatPingInput } },
    async (request): Promise<ChatPingResult> => {
      await publish([request.currentUser!.id], "pong", { pingId: request.body.pingId });
      return { listening: realtimeListening() };
    },
  );

  /**
   * Who has a CRM tab open right now (chat.md §5.4): every colleague sees it. The tab reads it once,
   * and then keeps it current from the stream's `presence` events.
   */
  app.get("/presence", { config: gate("chat") }, async (): Promise<ChatPresence> => ({
    online: onlinePeople(),
  }));
}
