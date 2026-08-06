import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  calendarQuery,
  createMeetingInput,
  updateMeetingInput,
} from "@shared/schema/calendar.js";
import { requireAuth } from "../../core/auth.js";
import * as service from "./meetings.service.js";

const idParams = z.object({ id: uuid });

/** Asking "would this slot clash?" before committing to it — what the form calls as you type. */
const conflictQuery = z.object({
  startAt: z.iso.datetime(),
  durationMinutes: z.coerce.number().int().min(1).max(24 * 60),
  userIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : [])),
  /** editing an existing meeting: it must not be reported as clashing with itself */
  excludeMeetingId: uuid.optional(),
});

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  // the calendar screen's one read: meetings + projected deadlines for a window
  app.get("/", { schema: { querystring: calendarQuery } }, async (request) => {
    return service.getCalendar(request.query);
  });

  app.get("/conflicts", { schema: { querystring: conflictQuery } }, async (request) => {
    const { startAt, durationMinutes, userIds, excludeMeetingId } = request.query;
    return service.findConflicts({
      startAt: new Date(startAt),
      durationMinutes,
      userIds,
      excludeMeetingId,
    });
  });

  // one client's or one lead's meetings, for their card — cancelled ones included and flagged,
  // because "we called that off" is part of the history of a relationship
  app.get(
    "/for",
    { schema: { querystring: z.object({ client: uuid.optional(), lead: uuid.optional() }) } },
    async (request) => {
      const { client, lead } = request.query;
      if (!client && !lead) return [];
      return service.listFor({ clientId: client, leadId: lead });
    },
  );

  app.get("/meetings/:id", { schema: { params: idParams } }, async (request) => {
    return service.getMeeting(request.params.id);
  });

  app.post("/meetings", { schema: { body: createMeetingInput } }, async (request, reply) => {
    const meeting = await service.createMeeting(request.body, request.currentUser!);
    return reply.status(201).send(meeting);
  });

  app.patch(
    "/meetings/:id",
    { schema: { params: idParams, body: updateMeetingInput } },
    async (request) => {
      return service.updateMeeting(request.params.id, request.body, request.currentUser!);
    },
  );
}
