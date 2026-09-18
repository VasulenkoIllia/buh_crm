import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { gate } from "../../core/access.js";
import type { StreamRouteConfig } from "../../core/route-inventory.js";
import { openStream } from "./chat.stream.js";

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
}
