import type { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceTodayWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

const taskInclude = {
  // target labels ride along so no screen has to resolve ids against a (capped) client list
  // `archivedAt` rides along so every entry point can ask whether the CLIENT is gone —
  // a task outlives its client only in the database, never in the app (2026-08-03)
  client: { select: { firstName: true, lastName: true, archivedAt: true } },
  cancelledBy: { select: { firstName: true, lastName: true } },
  company: { select: { name: true } },
  lead: { select: { name: true, archivedAt: true } },
  assignees: { select: { userId: true } },
  subtasks: { orderBy: { order: "asc" } },
  timeEntries: { orderBy: { startedAt: "asc" } },
  comments: { orderBy: { createdAt: "asc" } },
  invoice: {
    // paidTotal/cancelledAt ride along so the task can show its own billing state (paid / partial
    // / overdue) without a second round-trip — the status itself is derived by the shared
    // `deriveStatus`, never stored, and `paidTotal` is the same figure Billing filters on
    select: {
      id: true,
      number: true,
      amount: true,
      paidTotal: true,
      issuedAt: true,
      dueDate: true,
      sentAt: true,
      cancelledAt: true,
    },
  },
} satisfies Prisma.TaskInclude;

export type TaskRecord = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

// ── columns ──────────────────────────────────────────────────────────────────

export function listColumns() {
  return prisma.taskColumn.findMany({ orderBy: { order: "asc" } });
}

/**
 * Put `columnId` immediately after `afterColumnId` — or as early as a column may go when that is
 * null. Renumbers the whole board 0..n-1 and writes only the rows that actually move, the same way
 * the catalog and the cards do it.
 *
 * The FIXED columns are held at the front and never take part. That is not a special case bolted
 * on: keeping them in their own list ahead of the movable ones makes "dropped past the left edge"
 * (`afterColumnId` null) and "dropped on the fixed column" (`afterColumnId` names it, so
 * `indexOf` is -1) resolve to the same place — first among the movable — instead of one of them
 * being an error somebody has to read.
 */
export async function moveColumn(columnId: string, afterColumnId: string | null) {
  return prisma.$transaction(async (tx) => {
    const all = await tx.taskColumn.findMany({
      orderBy: { order: "asc" },
      select: { id: true, order: true, isFixed: true },
    });
    const was = new Map(all.map((c) => [c.id, c.order]));
    const fixed = all.filter((c) => c.isFixed).map((c) => c.id);
    const movable = all.filter((c) => !c.isFixed && c.id !== columnId).map((c) => c.id);

    const at = afterColumnId ? movable.indexOf(afterColumnId) : -1;
    movable.splice(at + 1, 0, columnId);

    for (const [order, id] of [...fixed, ...movable].entries()) {
      if (was.get(id) === order) continue;
      await tx.taskColumn.update({ where: { id }, data: { order } });
    }
  });
}

/**
 * Put `taskId` in `columnId`, immediately after `afterTaskId` — or at the top when that is null.
 *
 * Renumbers the WHOLE column 0..n-1 rather than nudging one row, which is what makes the move
 * correct on a FILTERED board: the anchor is a card the reader can see, but cards a filter is
 * hiding keep their relative places instead of being renumbered out of the way. It is also why
 * there is no gap arithmetic to exhaust and no drift to reconcile.
 *
 * One transaction: a half-applied order is a board nobody can trust.
 */
export async function moveTaskInBoard(
  taskId: string,
  columnId: string,
  afterTaskId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const inColumn = await tx.task.findMany({
      where: { statusColumnId: columnId, id: { not: taskId } },
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      select: { id: true, boardOrder: true },
    });
    const was = new Map(inColumn.map((t) => [t.id, t.boardOrder]));
    const ids = inColumn.map((t) => t.id);

    // an anchor that is not in this column (a stale board, a card moved by someone else) means the
    // caller's picture is out of date — put the card on top rather than guess a position
    const at = afterTaskId ? ids.indexOf(afterTaskId) : -1;
    ids.splice(at + 1, 0, taskId);

    // Renumber in full, but WRITE only the rows whose number actually changes. A drop one place
    // down touches two rows, not the whole column — which is what keeps this honest on a column
    // that has grown past the board's own 500-card cap.
    for (const [order, id] of ids.entries()) {
      if (id === taskId || was.get(id) === order) continue;
      await tx.task.update({ where: { id }, data: { boardOrder: order } });
    }
    await tx.task.update({
      where: { id: taskId },
      data: { statusColumnId: columnId, boardOrder: ids.indexOf(taskId) },
    });
  });
}

/** New work lands on TOP of its column, which is where `createdAt desc` used to put it. */
export async function topOfColumn(columnId: string): Promise<number> {
  const first = await prisma.task.aggregate({
    where: { statusColumnId: columnId },
    _min: { boardOrder: true },
  });
  return (first._min.boardOrder ?? 0) - 1;
}

export function findColumn(id: string) {
  return prisma.taskColumn.findUnique({ where: { id } });
}

/** The fixed "New" column — default entry point (bootstrap guarantees it exists). */
export function findFixedColumn() {
  return prisma.taskColumn.findFirst({ where: { isFixed: true } });
}

export async function createColumn(name: string) {
  const max = await prisma.taskColumn.aggregate({ _max: { order: true } });
  return prisma.taskColumn.create({ data: { name, order: (max._max.order ?? 0) + 1 } });
}

export function updateColumn(id: string, data: Prisma.TaskColumnUpdateInput) {
  return prisma.taskColumn.update({ where: { id }, data });
}

export function deleteColumn(id: string) {
  return prisma.taskColumn.delete({ where: { id } });
}

export function countTasksInColumn(columnId: string) {
  return prisma.task.count({ where: { statusColumnId: columnId, archivedAt: null } });
}

// ── tasks ────────────────────────────────────────────────────────────────────

/**
 * "Its client and its lead are both still live" — the single rule that decides whether a task is
 * visible anywhere.
 *
 * It is a function, not two lines copied into each query, because it already drifted once: the
 * board excluded an archived CLIENT's tasks while `liveTaskOr404` refused an archived LEAD's too,
 * and the moment leads became archivable (S11) that gap became a card you could see but not open.
 * One definition, used by every list.
 */
/** The rows a bulk action was asked about — with the archive flags it needs to judge them. */
export function findTasksByIds(ids: string[]) {
  return prisma.task.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      done: true,
      cancelledAt: true,
      archivedAt: true,
      client: { select: { archivedAt: true } },
      lead: { select: { archivedAt: true } },
    },
  });
}

export function archiveTasks(ids: string[], byUserId: string) {
  return prisma.task.updateMany({
    where: { id: { in: ids } },
    data: { archivedAt: new Date(), archivedById: byUserId },
  });
}

export function liveTargetWhere(): Prisma.TaskWhereInput {
  return {
    AND: [
      { OR: [{ clientId: null }, { client: { archivedAt: null } }] },
      { OR: [{ leadId: null }, { lead: { archivedAt: null } }] },
    ],
  };
}

/**
 * Open work on one client — the number on the client card's Tasks tab.
 *
 * "Open" is the board's own rule, not a second one: not done, not cancelled, not archived. A badge
 * that counted differently from the tab it sits on would be worse than no badge.
 */
export function countOpenTasksForClient(clientId: string) {
  return prisma.task.count({
    where: { clientId, archivedAt: null, cancelledAt: null, done: false },
  });
}

/**
 * Open work whose deadline day falls inside `[from, to)` — what the Calendar projects.
 *
 * It lives here rather than in the calendar module because "which tasks are visible" is a rule
 * this module already owns, and two copies of it would drift the moment one view changed. Same
 * exclusions as the board: archived tasks, cancelled ones, and anything belonging to an archived
 * client are all gone. Done work is excluded too — a met deadline is not an appointment.
 */
export function listDeadlinesInRange(args: {
  from: Date;
  to: Date;
  userId?: string;
  clientId?: string;
}) {
  return prisma.task.findMany({
    where: {
      archivedAt: null,
      cancelledAt: null,
      done: false,
      deadline: { gte: args.from, lt: args.to },
      ...(args.userId ? { assignees: { some: { userId: args.userId } } } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      ...liveTargetWhere(),
    },
    /**
     * Priority sits between the day and the tie-break because the calendar's deadline lane shows
     * only the first few of a day and counts the rest: whichever ones survive that cut have to be
     * the ones worth seeing. Inside a single day `overdue` cannot decide it — every deadline in a
     * day column shares the day, so it shares the flag (user, 2026-08-28).
     *
     * DESCENDING, because `Priority.order` is a scale that climbs: Low 0, Normal 1, High 2,
     * Urgent 3 — it is the order a picker lists them in, so ascending would surface the least
     * urgent work and bury the rest behind "+6 more".
     *
     * `priorityId` is NOT nullable, so there is no null ordering to think about.
     */
    orderBy: [{ deadline: "asc" }, { priority: { order: "desc" } }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      deadline: true,
      client: { select: { firstName: true, lastName: true } },
      lead: { select: { name: true } },
      assignees: { select: { userId: true } },
    },
  });
}

export async function listTasks(args: {
  where: Prisma.TaskWhereInput;
  skip: number;
  take: number;
  orderBy?: Prisma.TaskOrderByWithRelationInput[];
}) {
  const [items, total] = await prisma.$transaction([
    prisma.task.findMany({
      where: args.where,
      include: taskInclude,
      // newest first — the ordinary list order. The BOARD passes its own (see `listTasks` in the
      // service): making the board's order the default here silently re-sorted the table and the
      // card rollups by a number that only means anything inside one column.
      orderBy: args.orderBy ?? [{ createdAt: "desc" }],
      skip: args.skip,
      take: args.take,
    }),
    prisma.task.count({ where: args.where }),
  ]);
  return { items, total };
}

export function findTask(id: string) {
  return prisma.task.findUnique({ where: { id }, include: taskInclude });
}

export function createTask(data: Prisma.TaskUncheckedCreateInput) {
  return prisma.task.create({ data, include: taskInclude });
}

export function updateTask(id: string, data: Prisma.TaskUncheckedUpdateInput) {
  return prisma.task.update({ where: { id }, data, include: taskInclude });
}

/** Full replace of the task's assignee set. */
export async function setAssignees(taskId: string, userIds: string[]) {
  await prisma.$transaction([
    prisma.taskAssignee.deleteMany({ where: { taskId } }),
    prisma.taskAssignee.createMany({
      data: [...new Set(userIds)].map((userId) => ({ taskId, userId })),
    }),
  ]);
}

/** Full replace of the checklist (order = array index). */
export async function setSubtasks(taskId: string, rows: { text: string; done: boolean }[]) {
  await prisma.$transaction([
    prisma.subtask.deleteMany({ where: { taskId } }),
    prisma.subtask.createMany({
      data: rows.map((r, order) => ({ taskId, order, ...r })),
    }),
  ]);
}

// ── comments ─────────────────────────────────────────────────────────────────

export function addComment(taskId: string, authorId: string, body: string) {
  return prisma.taskComment.create({ data: { taskId, authorId, body } });
}

export function findComment(id: string) {
  return prisma.taskComment.findUnique({ where: { id } });
}

export function deleteComment(id: string) {
  return prisma.taskComment.delete({ where: { id } });
}

// ── lookups for validation ───────────────────────────────────────────────────

export function findDefaultPriority() {
  return prisma.priority.findFirst({ where: { isDefault: true }, orderBy: { order: "asc" } });
}

export function findPriority(id: string) {
  return prisma.priority.findUnique({ where: { id } });
}

export function findActiveClient(id: string) {
  return prisma.client.findFirst({ where: { id, archivedAt: null } });
}

export function findClientCompany(clientId: string, companyId: string) {
  return prisma.company.findFirst({ where: { id: companyId, clientId } });
}

export function findLead(id: string) {
  return prisma.lead.findFirst({ where: { id, archivedAt: null } });
}

export function findActiveService(id: string) {
  return prisma.service.findFirst({ where: { id, active: true } });
}

/** One of the client's subscriptions that is IN FORCE today — work can only go on a live one. */
export function findClientSubscription(clientId: string, subscriptionId: string) {
  return prisma.subscription.findFirst({
    where: { id: subscriptionId, clientId, ...inForceTodayWhere(config.TZ) },
    include: { service: { select: { id: true, type: true, invoiceTrigger: true, dueDays: true } } },
  });
}


export function countActiveUsersByIds(ids: string[]) {
  return prisma.user.count({ where: { id: { in: ids }, status: "active" } });
}

export function findUser(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

/**
 * The clients that actually have live work — the board's client filter. Built from the whole
 * task table, not from the page the board happened to load, so the filter can reach every client.
 */
export function listClientsWithTasks() {
  return prisma.client.findMany({
    where: { archivedAt: null, tasks: { some: { archivedAt: null } } },
    select: { id: true, firstName: true, lastName: true },
  });
}

/** Leads with live work — the other half of the board's target filter. */
export function listLeadsWithTasks() {
  return prisma.lead.findMany({
    where: { archivedAt: null, tasks: { some: { archivedAt: null } } },
    select: { id: true, name: true },
  });
}

/**
 * Subscriptions with an end date coming up inside the notice window, so it can be announced.
 * Open-ended ones — the normal state — are simply never here: there is nothing to warn about.
 */
export function listEndingSubscriptions(from: Date, until: Date) {
  return prisma.subscription.findMany({
    where: {
      client: { archivedAt: null },
      periods: { some: { endsBefore: { gte: from, lte: until } } },
    },
    select: {
      id: true,
      clientId: true,
      companyId: true,
      serviceId: true,
      periods: { select: { endsBefore: true }, orderBy: { startsOn: "asc" } },
    },
  });
}

/**
 * Lightweight team directory for assignee pickers + name rendering (all-auth). Carries
 * `avatarFileId` so task surfaces can show the person's face rather than their initials —
 * without it the board had no way to know an avatar existed (2026-07-28).
 */
export function listUserDirectory() {
  return prisma.user.findMany({
    select: { id: true, firstName: true, lastName: true, status: true, avatarFileId: true },
    orderBy: { firstName: "asc" },
  });
}

// ── timer / time entries ─────────────────────────────────────────────────────

export function findRunningEntry(userId: string) {
  return prisma.timeEntry.findFirst({
    where: { userId, stoppedAt: null },
    include: { task: { select: { id: true, title: true } } },
  });
}

export function findEntry(id: string) {
  return prisma.timeEntry.findUnique({ where: { id } });
}

/** Close the old interval (if any) and open the new one atomically. */
export async function switchRunningEntry(args: {
  userId: string;
  taskId: string;
  close?: { id: string; stoppedAt: Date; seconds: number; comment: string };
}) {
  return prisma.$transaction(async (tx) => {
    if (args.close) {
      await tx.timeEntry.update({
        where: { id: args.close.id },
        data: {
          stoppedAt: args.close.stoppedAt,
          seconds: args.close.seconds,
          comment: args.close.comment,
        },
      });
    }
    // make sure the tracker is on the task's crew (tracking = working on it)
    await tx.taskAssignee.upsert({
      where: { taskId_userId: { taskId: args.taskId, userId: args.userId } },
      update: {},
      create: { taskId: args.taskId, userId: args.userId },
    });
    return tx.timeEntry.create({
      data: { taskId: args.taskId, userId: args.userId, startedAt: new Date() },
    });
  });
}

export function closeEntry(id: string, data: { stoppedAt: Date; seconds: number; comment: string }) {
  return prisma.timeEntry.update({ where: { id }, data });
}

export function createManualEntry(data: {
  taskId: string;
  userId: string;
  startedAt: Date;
  stoppedAt: Date;
  seconds: number;
  comment: string;
  createdById: string;
}) {
  return prisma.timeEntry.create({ data: { ...data, source: "manual" } });
}

export function updateEntry(id: string, data: Prisma.TimeEntryUncheckedUpdateInput) {
  return prisma.timeEntry.update({ where: { id }, data });
}

export function deleteEntry(id: string) {
  return prisma.timeEntry.delete({ where: { id } });
}

/**
 * The journal for a changed or deleted interval of somebody's working time.
 *
 * Values are SNAPSHOTTED rather than joined: `entryId` is nulled when the row itself goes, and a
 * log that cannot say what was lost is not worth keeping. Same shape as `SecretAuditLog`.
 */
export function recordTimeEntryAudit(data: {
  entryId: string | null;
  taskId: string;
  userId: string;
  byUserId: string;
  action: "updated" | "deleted";
  wasSeconds: number | null;
  wasComment: string | null;
  nowSeconds?: number | null;
  nowComment?: string | null;
}) {
  return prisma.timeEntryAuditLog.create({ data });
}

// ── the generation sweeps (scheduler job #1) ─────────────────────────────────

/** What every generated task needs: the default priority and the fixed entry column. */
export async function findGenerationDefaults() {
  const [priority, column] = await Promise.all([
    prisma.priority.findFirst({ where: { isDefault: true } }),
    prisma.taskColumn.findFirst({ where: { isFixed: true } }),
  ]);
  return priority && column ? { priorityId: priority.id, columnId: column.id } : null;
}

/**
 * Subscriptions that generate tasks: ACTIVE, on a subscription-type service, for a live client —
 * with the client/company/service labels the composed title needs and the templates to expand.
 */
// A FUNCTION, not a const — see the note in payments.repository: a module-level object would
// freeze "today" at server boot and every later sweep would ask about the wrong day.
const generatingSubscription = () =>
  ({
  where: {
    ...inForceTodayWhere(config.TZ),
    service: { type: "subscription" as const },
    client: { archivedAt: null },
  },
  include: {
    client: { select: { firstName: true, lastName: true } },
    company: { select: { name: true } },
    // an occurrence is generated only if the subscription was in force ON ITS DATE
    periods: { select: { startsOn: true, endsBefore: true }, orderBy: { startsOn: "asc" } },
    service: {
      select: {
        name: true,
        taskTemplates: {
          select: {
            id: true,
            name: true,
            periodicity: true,
            dayOfPeriod: true,
            monthOfPeriod: true,
            deadlineOffsetDays: true,
            estimatedMinutes: true,
            defaultChecklist: true,
            createdAt: true,
          },
        },
      },
    },
  },
  }) satisfies Prisma.SubscriptionFindManyArgs;

export type GeneratingSubscription = Prisma.SubscriptionGetPayload<
  ReturnType<typeof generatingSubscription>
>;

export function listGeneratingSubscriptions(): Promise<GeneratingSubscription[]> {
  return prisma.subscription.findMany(generatingSubscription());
}

export function findGeneratingSubscription(id: string): Promise<GeneratingSubscription | null> {
  return prisma.subscription.findFirst({
    ...generatingSubscription(),
    where: { ...generatingSubscription().where, id },
  });
}

/** Active internal (firm-only) services and their recurring templates. */
const internalService = {
  where: { active: true, type: "internal" as const },
  // The catalog's own order, the same one `listServices` hands the screens. This read had no
  // `orderBy` at all, so Postgres returned the categories in whatever order it liked and the
  // nightly sweep generated their tasks in that order — the one place internal services are
  // actually consumed, ignoring the order an admin had just set (user, 2026-08-27).
  orderBy: [{ order: "asc" as const }, { createdAt: "asc" as const }],
  select: {
    id: true,
    name: true,
    taskTemplates: {
      select: {
        id: true,
        name: true,
        periodicity: true,
        dayOfPeriod: true,
        monthOfPeriod: true,
        deadlineOffsetDays: true,
        estimatedMinutes: true,
        defaultChecklist: true,
        description: true,
        defaultAssigneeIds: true,
        createdAt: true,
      },
    },
  },
} satisfies Prisma.ServiceFindManyArgs;

export type InternalService = Prisma.ServiceGetPayload<typeof internalService>;

export function listInternalServices(): Promise<InternalService[]> {
  return prisma.service.findMany(internalService);
}

/** Bulk insert of generated tasks; the unique key makes it insert-or-skip. */
export async function createTasksSkippingDuplicates(rows: Prisma.TaskUncheckedCreateInput[]) {
  const { count } = await prisma.task.createMany({ data: rows, skipDuplicates: true });
  return count;
}

/**
 * One generated task with its checklist (and, for internal templates, its default crew).
 * `createMany` can't nest rows, so anything with children is created individually.
 */
export function createTaskWithChildren(
  task: Prisma.TaskUncheckedCreateInput,
  checklist: string[],
  assigneeIds: string[] = [],
) {
  return prisma.task.create({
    data: {
      ...task,
      subtasks: checklist.length
        ? { create: checklist.map((text, order) => ({ text, order })) }
        : undefined,
      // dedupe — a duplicate userId would hit the TaskAssignee PK (P2002) and, since the sweep's
      // catch can't tell it from the (template, period) race, silently drop the task forever
      assignees: assigneeIds.length
        ? { create: [...new Set(assigneeIds)].map((userId) => ({ userId })) }
        : undefined,
    },
  });
}

/** Which (subscription, template, period) keys already exist — the sweep's pre-check. */
export function listExistingGeneratedKeys(where: Prisma.TaskWhereInput) {
  return prisma.task.findMany({
    where,
    select: { subscriptionId: true, taskTemplateId: true, periodKey: true },
  });
}

/** The ids of every active team member — internal templates only seed active assignees. */
export async function listActiveUserIds() {
  const users = await prisma.user.findMany({ where: { status: "active" }, select: { id: true } });
  return users.map((u) => u.id);
}

// ── files (bytes live on the uploads volume; this is only the metadata) ──────

export function listTaskFiles(taskId: string) {
  return prisma.file.findMany({ where: { taskId }, orderBy: { createdAt: "desc" } });
}

/**
 * One row, two pointers. `clientId` is filled in from the TASK's client at upload time, which is
 * what makes the file appear on that client's card without anything being copied or kept in step.
 * A task on a lead, or an internal one, simply passes null.
 */
export function createTaskFile(data: {
  taskId: string;
  clientId: string | null;
  name: string;
  size: number;
  mime: string;
  path: string;
  uploadedById: string;
}) {
  return prisma.file.create({ data });
}

export function findTaskFile(taskId: string, fileId: string) {
  return prisma.file.findFirst({ where: { id: fileId, taskId } });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}
