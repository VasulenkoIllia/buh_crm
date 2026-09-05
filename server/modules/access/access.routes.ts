import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { gateKey } from "@shared/access.js";
import { setAccessStateInput } from "@shared/schema/access.js";
import { uuid } from "@shared/schema/common.js";
import { userRole } from "@shared/schema/enums.js";
import { gate } from "../../core/access.js";
import * as service from "./access.service.js";

const policyParams = z.object({ gate: gateKey, role: userRole });
const overrideParams = z.object({ userId: uuid, gate: gateKey });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The access screen sits behind the `team` gate: whoever manages people manages their access.
   *
   * It is not its own switch, and it must not be. A gate that could open the screen which edits
   * the gates is a gate that opens all of them.
   */
  const team = gate("team");

  app.get("/", { config: team }, async () => service.getTable());

  app.put(
    "/policies/:gate/:role",
    { config: team, schema: { params: policyParams, body: setAccessStateInput } },
    async (request) =>
      service.setPolicy(request.params.gate, request.params.role, request.body),
  );

  app.put(
    "/overrides/:userId/:gate",
    { config: team, schema: { params: overrideParams, body: setAccessStateInput } },
    async (request) =>
      service.setOverride(request.params.userId, request.params.gate, request.body),
  );

  app.delete(
    "/overrides/:userId/:gate",
    { config: team, schema: { params: overrideParams } },
    async (request) => service.clearOverride(request.params.userId, request.params.gate),
  );
}
