import type { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceTodayWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

const taskInclude = {
  // target labels ride along so no screen has to resolve ids against a (capped) client list
  client: { select: { firstName: true, lastName: true } },
  cancelledBy: { select: { firstName: true, lastName: true } },
  company: { select: { name: true } },
  lead: { select: { name: true } },
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
