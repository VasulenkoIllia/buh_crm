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
import { gate, own, shared } from "../../core/access.js";
import { readFileStream } from "../../core/files.js";
import { ValidationError } from "../../core/errors.js";
import * as service from "./tasks.service.js";

const idParams = z.object({ id: uuid });
const entryParams = z.object({ entryId: uuid });
const fileParams = z.object({ id: uuid, fileId: uuid });
const commentParams = z.object({ commentId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const tasks = gate("tasks");
  /**
   * The shape of the board is admin-managed, and no gate state can say that: `tasks` has to stay
   * open for everyone who works it. Same per-ACTION rule as the leads pipeline and the five
   * billing corrections — stage 2 turns each into a row; until then it rides on the declaration
   * so the one hook still decides everything.
   */
  const boardStructure = gate("tasks", { adminOnly: true });

  // ── columns (board structure is admin-managed; everyone reads) ─────────────
  app.get("/columns", { config: tasks }, async () => service.listColumns());

  // team directory for assignee pickers (GET /api/users stays admin-only)
  app.get("/assignees", { config: shared() }, async () => service.listAssignees());

  // the board's target filter — every client AND lead with live work, so the filter isn't
  // limited to whatever the current page loaded
  app.get("/targets", { config: tasks }, async () => service.listTaskTargets());

  app.post(
    "/columns",
    { config: boardStructure, schema: { body: createColumnInput } },
    async (request, reply) => reply.status(201).send(await service.addColumn(request.body)),
  );

  app.patch(
    "/columns/:id",
    { config: boardStructure, schema: { params: idParams, body: updateColumnInput } },
    async (request) => service.updateColumn(request.params.id, request.body),
  );

  /**
   * Dragging a column along the board. Its own route because the body is an ANCHOR describing a
   * position, not a property of the column — the same reason the catalog has one.
   */
  app.patch(
    "/columns/:id/position",
    { config: boardStructure, schema: { params: idParams, body: moveColumnInput } },
    async (request) => service.moveColumn(request.params.id, request.body),
  );

  app.delete(
    "/columns/:id",
    { config: boardStructure, schema: { params: idParams } },
    async (request) => service.removeColumn(request.params.id),
  );

  // ── timer (static paths before /:id) ───────────────────────────────────────
  app.get("/timer/active", { config: own() }, async (request) =>
    service.getActiveTimer(request.currentUser!),
  );

  /**
   * **Start is the `tasks` gate; active and stop are the caller's own.**
   *
   * Audit finding, 2026-09-07. All three shipped as `own()` because a timer looks like the most
   * personal thing in the app — but `start` takes a `taskId` and writes a `TimeEntry` against
   * somebody else's module. With Tasks closed, a person who knew a task id could still track time
   * against it: not a leak, but a write into an area they cannot open, which is exactly what a
   * closed gate is supposed to refuse.
   *
   * `active` and `stop` stay `own()` deliberately, and the reason is not symmetry. A running timer
   * must always be stoppable: the database holds a partial unique index of ONE running entry per
   * person, so a timer stranded by a gate closing mid-session would block that person from ever
   * tracking anything again, on any task, in any module — with no screen able to release it.
   */
  app.post(
    "/timer/start",
    { config: tasks, schema: { body: startTimerInput } },
    async (request) => service.startTimer(request.currentUser!, request.body),
  );

  app.post(
    "/timer/stop",
    { config: own(), schema: { body: stopTimerInput } },
    async (request) => service.stopTimer(request.currentUser!, request.body),
  );

  /**
   * ── time management ────────────────────────────────────────────────────────
   *
   * Editing and deleting an interval is an OWNERSHIP rule, decided in the service: your own, or an
   * admin's. It is not folded into the `tasks` gate because `tasks` can never be fully closed, and
   * folding it in would simply delete the rule. Every change writes a `TimeEntryAuditLog` row.
   *
   * Adding time ON SOMEBODY ELSE'S behalf (`POST /:id/time` below) stays admin.
   */
  app.patch(
    "/time/:entryId",
    { config: tasks, schema: { params: entryParams, body: updateTimeEntryInput } },
    async (request) =>
      service.updateTimeEntry(request.params.entryId, request.body, request.currentUser!),
  );

  app.delete(
    "/time/:entryId",
    { config: tasks, schema: { params: entryParams } },
    async (request) => service.removeTimeEntry(request.params.entryId, request.currentUser!),
  );

  // ── tasks ──────────────────────────────────────────────────────────────────
  app.get(
    "/",
    { config: tasks, schema: { querystring: taskListQuery } },
    async (request) => service.listTasks(request.query),
  );

  app.post(
    "/",
    { config: tasks, schema: { body: createTaskInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createTask(request.body, request.currentUser!)),
  );

  app.get(
    "/:id",
    { config: tasks, schema: { params: idParams } },
    async (request) => service.getTask(request.params.id),
  );

  app.patch(
    "/:id",
    { config: tasks, schema: { params: idParams, body: updateTaskInput } },
    async (request) => service.updateTask(request.params.id, request.body, request.currentUser!),
  );

  /**
   * Dropping a card. Its own route rather than a field on the PATCH above: the body carries an
   * ANCHOR ("place me after this card"), which describes a position on a board and not a property
   * of the task.
   */
  app.patch(
    "/:id/position",
    { config: tasks, schema: { params: idParams, body: moveTaskInput } },
    async (request) => service.moveTask(request.params.id, request.body),
  );

  app.put(
    "/:id/subtasks",
    { config: tasks, schema: { params: idParams, body: setSubtasksInput } },
    async (request) => service.setSubtasks(request.params.id, request.body),
  );

  app.post(
    "/:id/archive",
    { config: tasks, schema: { params: idParams } },
    async (request) => service.archiveTask(request.params.id, request.currentUser!),
  );

  app.post(
    "/bulk-archive",
    { config: tasks, schema: { body: bulkArchiveTasksInput } },
    async (request) => service.bulkArchive(request.body, request.currentUser!),
  );

  app.post(
    "/:id/restore",
    { config: tasks, schema: { params: idParams } },
    async (request) => service.restoreTask(request.params.id),
  );

  app.post(
    "/:id/time",
    { config: boardStructure, schema: { params: idParams, body: addTimeEntryInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addTimeEntry(request.currentUser!, request.params.id, request.body)),
  );

  // ── comments (any user adds; delete = own comment or admin) ────────────────
  app.post(
    "/:id/comments",
    { config: tasks, schema: { params: idParams, body: createTaskCommentInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addComment(request.params.id, request.body, request.currentUser!)),
  );

  app.delete(
    "/comments/:commentId",
    { config: tasks, schema: { params: commentParams } },
    async (request) => service.deleteComment(request.params.commentId, request.currentUser!),
  );

  // ── files ───────────────────────────────────────────────────────────────────
  // The same four the client card has, on the same storage boundary. Downloads go through the API
  // with a permission check like every other file here — there is no public static directory.

  app.get("/:id/files", { config: tasks, schema: { params: idParams } }, async (request) =>
    service.listFiles(request.params.id),
  );

  app.post(
    "/:id/files",
    { config: tasks, schema: { params: idParams } },
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
    { config: tasks, schema: { params: fileParams } },
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
    { config: tasks, schema: { params: fileParams } },
    async (request) => service.removeFile(request.params.id, request.params.fileId),
  );
}
