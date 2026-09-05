import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  calendarQuery,
  createMeetingInput,
  updateMeetingInput,
} from "@shared/schema/calendar.js";
import { gate } from "../../core/access.js";
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

  /**
   * One gate for the whole module — the calendar owns no reference data anybody else reads. The
   * module-level `preHandler: requireAuth` is gone; the hook in `core/access.ts` decides.
   *
   * `GET /` is the one place in the app where a gate is read OUTSIDE that hook: with `tasks`
   * closed the service filters deadlines out of the response rather than refusing the request,
   * because that is a projection decision, not an access decision. It has its own test.
   */
  const calendar = gate("calendar");

  // the calendar screen's one read: meetings + projected deadlines for a window
  app.get("/", { config: calendar, schema: { querystring: calendarQuery } }, async (request) => {
    return service.getCalendar(request.query, request.currentUser!);
  });

  app.get("/conflicts", { config: calendar, schema: { querystring: conflictQuery } }, async (request) => {
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
    { config: calendar, schema: { querystring: z.object({ client: uuid.optional(), lead: uuid.optional() }) } },
    async (request) => {
      const { client, lead } = request.query;
      if (!client && !lead) return [];
      return service.listFor({ clientId: client, leadId: lead });
    },
  );

  app.get("/meetings/:id", { config: calendar, schema: { params: idParams } }, async (request) => {
    return service.getMeeting(request.params.id);
  });

  app.post("/meetings", { config: calendar, schema: { body: createMeetingInput } }, async (request, reply) => {
    const meeting = await service.createMeeting(request.body, request.currentUser!);
    return reply.status(201).send(meeting);
  });

  app.patch(
    "/meetings/:id",
    { config: calendar, schema: { params: idParams, body: updateMeetingInput } },
    async (request) => {
      return service.updateMeeting(request.params.id, request.body, request.currentUser!);
    },
  );
}
