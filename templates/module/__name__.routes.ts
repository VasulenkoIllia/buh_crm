import type { FastifyInstance } from "fastify";
import { list__Name__ } from "./__name__.service.js";

export async function registerRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return list__Name__();
  });
}
