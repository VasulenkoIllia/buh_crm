import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  addTimeEntryInput,
  createColumnInput,
  createTaskCommentInput,
  createTaskInput,
  setSubtasksInput,
  startTimerInput,
  stopTimerInput,
  taskListQuery,
  updateColumnInput,
  updateTaskInput,
  updateTimeEntryInput,
} from "@shared/schema/task.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import * as service from "./tasks.service.js";

const idParams = z.object({ id: uuid });
const entryParams = z.object({ entryId: uuid });
const commentParams = z.object({ commentId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // ── columns (board structure is admin-managed; everyone reads) ─────────────
  app.get("/columns", { preHandler: requireAuth }, async () => service.listColumns());

  // team directory for assignee pickers (GET /api/users stays admin-only)
  app.get("/assignees", { preHandler: requireAuth }, async () => service.listAssignees());

  // the board's target filter — every client AND lead with live work, so the filter isn't
  // limited to whatever the current page loaded
  app.get("/targets", { preHandler: requireAuth }, async () => service.listTaskTargets());

  app.post(
    "/columns",
    { preHandler: requireAdmin, schema: { body: createColumnInput } },
    async (request, reply) => reply.status(201).send(await service.addColumn(request.body)),
  );

  app.patch(
    "/columns/:id",
    { preHandler: requireAdmin, schema: { params: idParams, body: updateColumnInput } },
    async (request) => service.updateColumn(request.params.id, request.body),
  );

  app.delete(
    "/columns/:id",
    { preHandler: requireAdmin, schema: { params: idParams } },
    async (request) => service.removeColumn(request.params.id),
  );

  // ── timer (static paths before /:id) ───────────────────────────────────────
  app.get("/timer/active", { preHandler: requireAuth }, async (request) =>
    service.getActiveTimer(request.currentUser!),
  );

  app.post(
    "/timer/start",
    { preHandler: requireAuth, schema: { body: startTimerInput } },
    async (request) => service.startTimer(request.currentUser!, request.body),
  );

  app.post(
    "/timer/stop",
    { preHandler: requireAuth, schema: { body: stopTimerInput } },
    async (request) => service.stopTimer(request.currentUser!, request.body),
  );

  // ── admin time management ──────────────────────────────────────────────────
  app.patch(
    "/time/:entryId",
    { preHandler: requireAdmin, schema: { params: entryParams, body: updateTimeEntryInput } },
    async (request) => service.updateTimeEntry(request.params.entryId, request.body),
  );

  app.delete(
    "/time/:entryId",
    { preHandler: requireAdmin, schema: { params: entryParams } },
    async (request) => service.removeTimeEntry(request.params.entryId),
  );

  // ── tasks ──────────────────────────────────────────────────────────────────
  app.get(
    "/",
    { preHandler: requireAuth, schema: { querystring: taskListQuery } },
    async (request) => service.listTasks(request.query),
  );

  app.post(
    "/",
    { preHandler: requireAuth, schema: { body: createTaskInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createTask(request.body, request.currentUser!)),
  );

  app.get(
    "/:id",
    { preHandler: requireAuth, schema: { params: idParams } },
    async (request) => service.getTask(request.params.id),
  );

  app.patch(
    "/:id",
    { preHandler: requireAuth, schema: { params: idParams, body: updateTaskInput } },
    async (request) => service.updateTask(request.params.id, request.body, request.currentUser!),
  );

  app.put(
    "/:id/subtasks",
    { preHandler: requireAuth, schema: { params: idParams, body: setSubtasksInput } },
    async (request) => service.setSubtasks(request.params.id, request.body),
  );

  app.post(
    "/:id/archive",
    { preHandler: requireAuth, schema: { params: idParams } },
    async (request) => service.archiveTask(request.params.id, request.currentUser!),
  );

  app.post(
    "/:id/restore",
    { preHandler: requireAuth, schema: { params: idParams } },
    async (request) => service.restoreTask(request.params.id),
  );

  app.post(
    "/:id/time",
    { preHandler: requireAdmin, schema: { params: idParams, body: addTimeEntryInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addTimeEntry(request.currentUser!, request.params.id, request.body)),
  );

  // ── comments (any user adds; delete = own comment or admin) ────────────────
  app.post(
    "/:id/comments",
    { preHandler: requireAuth, schema: { params: idParams, body: createTaskCommentInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addComment(request.params.id, request.body, request.currentUser!)),
  );

  app.delete(
    "/comments/:commentId",
    { preHandler: requireAuth, schema: { params: commentParams } },
    async (request) => service.deleteComment(request.params.commentId, request.currentUser!),
  );
}
