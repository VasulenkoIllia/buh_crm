import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  addTimeEntryInput,
  bulkArchiveTasksInput,
  createColumnInput,
  createTaskCommentInput,
  createTaskInput,
  setSubtasksInput,
  moveTaskInput,
  startTimerInput,
  stopTimerInput,
  taskListQuery,
  moveColumnInput,
  updateColumnInput,
  updateTaskInput,
  updateTimeEntryInput,
} from "@shared/schema/task.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import { readFileStream } from "../../core/files.js";
import { ValidationError } from "../../core/errors.js";
import * as service from "./tasks.service.js";

const idParams = z.object({ id: uuid });
const entryParams = z.object({ entryId: uuid });
const fileParams = z.object({ id: uuid, fileId: uuid });
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

  /**
   * Dragging a column along the board. Its own route because the body is an ANCHOR describing a
   * position, not a property of the column — the same reason the catalog has one.
   */
  app.patch(
    "/columns/:id/position",
    { preHandler: requireAdmin, schema: { params: idParams, body: moveColumnInput } },
    async (request) => service.moveColumn(request.params.id, request.body),
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

  /**
   * Dropping a card. Its own route rather than a field on the PATCH above: the body carries an
   * ANCHOR ("place me after this card"), which describes a position on a board and not a property
   * of the task.
   */
  app.patch(
    "/:id/position",
    { preHandler: requireAuth, schema: { params: idParams, body: moveTaskInput } },
    async (request) => service.moveTask(request.params.id, request.body),
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
    "/bulk-archive",
    { preHandler: requireAuth, schema: { body: bulkArchiveTasksInput } },
    async (request) => service.bulkArchive(request.body, request.currentUser!),
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

  // ── files ───────────────────────────────────────────────────────────────────
  // The same four the client card has, on the same storage boundary. Downloads go through the API
  // with a permission check like every other file here — there is no public static directory.

  app.get("/:id/files", { preHandler: requireAuth, schema: { params: idParams } }, async (request) =>
    service.listFiles(request.params.id),
  );

  app.post(
    "/:id/files",
    { preHandler: requireAuth, schema: { params: idParams } },
    async (request, reply) => {
      const part = await request.file();
      if (!part) throw new ValidationError("File is required");
      const buffer = await part.toBuffer();
      const file = await service.addFile(request.params.id, request.currentUser!, {
        buffer,
        filename: part.filename,
        mimetype: part.mimetype,
      });
      return reply.status(201).send(file);
    },
  );

  app.get(
    "/:id/files/:fileId",
    { preHandler: requireAuth, schema: { params: fileParams } },
    async (request, reply) => {
      const file = await service.getFile(request.params.id, request.params.fileId);
      reply.header("Content-Type", file.mime);
      // ATTACHMENT, deliberately. Serving somebody's upload inline from the app's own origin runs
      // whatever is in it — an .html or an .svg — with the reader's session. Preview is a decision
      // for the day files move to storage of their own (user, 2026-08-28).
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      return reply.send(readFileStream(file.path));
    },
  );

  app.delete(
    "/:id/files/:fileId",
    { preHandler: requireAuth, schema: { params: fileParams } },
    async (request) => service.removeFile(request.params.id, request.params.fileId),
  );
}
