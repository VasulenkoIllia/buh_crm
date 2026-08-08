import type {
  AddTimeEntryInput,
  BulkArchiveTasksInput,
  CreateColumnInput,
  CreateTaskCommentInput,
  CreateTaskInput,
  SetSubtasksInput,
  StartTimerInput,
  StopTimerInput,
  TaskListQuery,
  UpdateColumnInput,
  UpdateTaskInput,
  UpdateTimeEntryInput,
} from "@shared/schema/task.js";
import { deriveStatus } from "@shared/schema/payment.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { dateToUtc, todayBusinessMs } from "../../core/dates.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { clientLabel } from "../../core/names.js";
import { issueJobInvoice } from "../payments/index.js";
import * as repo from "./tasks.repository.js";

/** The job's invoice WITH its settlement state — same derivation rule as the Billing screen. */
function toTaskInvoice(invoice: NonNullable<repo.TaskRecord["invoice"]>, todayMs: number) {
  const paid = invoice.paidTotal;
  return {
    id: invoice.id,
    number: invoice.number,
    amount: invoice.amount,
    paid,
    balance: invoice.cancelledAt ? 0 : Math.max(0, invoice.amount - paid),
    status: deriveStatus(
      {
        amount: invoice.amount,
        paid,
        dueDate: invoice.dueDate,
        cancelledAt: invoice.cancelledAt,
      },
      todayMs,
    ),
    sentAt: invoice.sentAt?.toISOString() ?? null,
    issuedAt: invoice.issuedAt.toISOString(),
    dueDate: invoice.dueDate?.toISOString() ?? null,
  };
}

export function toTaskDto(
  task: repo.TaskRecord,
  todayMs: number = todayBusinessMs(config.TZ),
) {
  return {
    id: task.id,
    title: task.title,
    clientId: task.clientId,
    companyId: task.companyId,
    leadId: task.leadId,
    serviceId: task.serviceId,
    kind: task.kind,
    priorityId: task.priorityId,
    statusColumnId: task.statusColumnId,
    done: task.done,
    deadline: task.deadline?.toISOString() ?? null,
    plannedMinutes: task.plannedMinutes,
    amount: task.amount,
    invoiceId: task.invoiceId,
    description: task.description,
    subscriptionId: task.subscriptionId,
    taskTemplateId: task.taskTemplateId,
    periodKey: task.periodKey,
    createdById: task.createdById,
    // labels travel with the task: the board used to resolve them from a page of clients,
    // which silently blanked names past the first 100
    clientName: task.client ? clientLabel(task.client) : null,
    companyName: task.company?.name ?? null,
    leadName: task.lead?.name ?? null,
    invoice: task.invoice ? toTaskInvoice(task.invoice, todayMs) : null,
    assignees: task.assignees.map((a) => a.userId),
    subtasks: task.subtasks.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      text: s.text,
      done: s.done,
      order: s.order,
    })),
    timeEntries: task.timeEntries.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      userId: e.userId,
      startedAt: e.startedAt.toISOString(),
      stoppedAt: e.stoppedAt?.toISOString() ?? null,
      seconds: e.seconds,
      comment: e.comment,
      source: e.source,
      createdById: e.createdById,
    })),
    comments: task.comments.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      authorId: c.authorId,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    })),
    trackedSeconds: task.timeEntries.reduce((sum, e) => sum + (e.seconds ?? 0), 0),
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    cancelledAt: task.cancelledAt?.toISOString() ?? null,
    cancelledByName: task.cancelledBy
      ? `${task.cancelledBy.firstName} ${task.cancelledBy.lastName}`.trim()
      : null,
  };
}

/** Team directory for assignee pickers (id + name + status; blocked shown with a badge). */
export function listAssignees() {
  return repo.listUserDirectory();
}

/**
 * Everything work can be filed against — clients AND leads — for the board's target filter.
 * Whole directory, not a page: a filter has to reach work this screen never loaded. Leads
 * carry `kind` so the picker can label them and send `leadId` instead of `clientId`.
 */
export async function listTaskTargets() {
  const [clients, leads] = await Promise.all([
    repo.listClientsWithTasks(),
    repo.listLeadsWithTasks(),
  ]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [
    ...clients.map((c) => ({ id: c.id, name: clientLabel(c), kind: "client" as const })).sort(byName),
    ...leads.map((l) => ({ id: l.id, name: l.name, kind: "lead" as const })).sort(byName),
  ];
}

// ── columns ──────────────────────────────────────────────────────────────────

export async function listColumns() {
  const columns = await repo.listColumns();
  return columns.map((c) => ({ id: c.id, name: c.name, order: c.order, isFixed: c.isFixed }));
}

export async function addColumn(input: CreateColumnInput) {
  const column = await repo.createColumn(input.name);
  return { id: column.id, name: column.name, order: column.order, isFixed: column.isFixed };
}

export async function updateColumn(id: string, input: UpdateColumnInput) {
  const column = await repo.findColumn(id);
  if (!column) throw new NotFoundError("Column not found");
  if (column.isFixed) {
    throw new ValidationError('The "New" column is fixed — it can\'t be renamed or moved');
  }
  if (input.order !== undefined && input.order < 1) {
    throw new ValidationError('Order 0 is reserved for the fixed "New" column');
  }
  const updated = await repo.updateColumn(id, input);
  return { id: updated.id, name: updated.name, order: updated.order, isFixed: updated.isFixed };
}

export async function removeColumn(id: string) {
  const column = await repo.findColumn(id);
  if (!column) throw new NotFoundError("Column not found");
  if (column.isFixed) throw new ValidationError('The "New" column can\'t be deleted');
  const count = await repo.countTasksInColumn(id);
  if (count > 0) {
    throw new ConflictError(`Move the ${count} task(s) out of this column first`);
  }
  await repo.deleteColumn(id);
  return { ok: true as const };
}

// ── tasks ────────────────────────────────────────────────────────────────────

/** The board is a working surface, not an archive — cap it and SAY so when it's capped. */
const BOARD_LIMIT = 500;

export async function listTasks(query: TaskListQuery) {
  const today = todayBusinessMs(config.TZ);
  // Every filter is ANDed rather than assigned onto one object: two filters that touch the same
  // field (status=done + overdue, which is open-only) must NARROW to nothing, not silently
  // overwrite each other and answer a question nobody asked.
  const and: Prisma.TaskWhereInput[] = [];

  // status applies to every view: the board asks for open work, Done for finished, Cancelled for
  // work that was called off. A cancelled task is NOT open — it left the board on purpose.
  if (query.status === "open") and.push({ done: false, cancelledAt: null });
  if (query.status === "cancelled") and.push({ cancelledAt: { not: null } });
  if (query.status === "done") and.push({ done: true, cancelledAt: null }); // "done" is not "called off"

  /**
   * The date window on a closed view — and it counts from a DIFFERENT COLUMN per view, which is
   * the whole reason the parameter is no longer called `doneWithinDays`. Done asks when the work
   * was finished; Cancelled asks when it was called off. Using `completedAt` for both would
   * silently return nothing on Cancelled, since called-off work is never completed.
   *
   * Counted in whole business days from the firm's today, so "7 days" is the last seven calendar
   * days, not 168 hours. (Both columns are real timestamps, so the oldest day's cut lands on UTC
   * midnight rather than the firm's — a few hours of slack at the far edge of a week-wide window.)
   */
  if (query.withinDays && (query.status === "done" || query.status === "cancelled")) {
    const since = new Date(today - (query.withinDays - 1) * 86_400_000);
    and.push(query.status === "done" ? { completedAt: { gte: since } } : { cancelledAt: { gte: since } });
  }
  if (query.search) and.push({ title: { contains: query.search, mode: "insensitive" } });
  if (query.assigneeId) and.push({ assignees: { some: { userId: query.assigneeId } } });
  if (query.clientId) and.push({ clientId: query.clientId });
  // "none" is not a service id — it means work that goes through no service at all, which is every
  // internal task. Without it they would be unreachable through this filter (user, 2026-08-08).
  if (query.serviceId) {
    and.push(query.serviceId === "none" ? { serviceId: null } : { serviceId: query.serviceId });
  }
  if (query.leadId) and.push({ leadId: query.leadId });
  // "overdue" is answered by SQL, not by filtering the page in the browser — otherwise the
  // filter would only ever search the rows the board happened to load. Same business-date rule
  // as `isTaskOverdue`: the whole deadline day must have passed. Overdue is open work by
  // definition, so asking for it alongside status=done correctly yields nothing.
  if (query.overdue) and.push({ done: false, cancelledAt: null, deadline: { lt: new Date(today) } });
  // An archived client's — or lead's — work leaves everyone's board. The data stays untouched, so
  // restoring them brings the tasks back; their invoices deliberately stay in Billing.
  //
  // Both halves are load-bearing. Leads only became archivable in S11; before that the lead half
  // was dead code, and adding archiving without it left tasks on the board that answer 404 when
  // opened, because `liveTaskOr404` has always refused both. A visible card that cannot be opened
  // is the one outcome worse than either behaviour on its own.
  //
  // The Archive screen is the single view that looks the other way.
  if (!query.archived) and.push(repo.liveTargetWhere());

  const where: Prisma.TaskWhereInput = {
    archivedAt: query.archived ? { not: null } : null,
    AND: and,
  };

  const paged = query.view === "table";
  const take = paged ? query.pageSize : BOARD_LIMIT;
  const { items, total } = await repo.listTasks({
    where,
    skip: paged ? (query.page - 1) * query.pageSize : 0,
    take,
    // finished work reads newest-finished-first; open work newest-created-first
    orderBy:
      query.status === "done"
        ? [{ completedAt: "desc" }, { createdAt: "desc" }] // legacy rows have no stamp
        : undefined,
  });
  return {
    // one "today" for the whole page — every row's invoice status is decided against the same day
    items: items.map((task) => toTaskDto(task, today)),
    total,
    page: paged ? query.page : 1,
    pageSize: paged ? query.pageSize : take,
    /** board only: there is more work than the board shows — narrow the filters */
    truncated: !paged && total > items.length,
  };
}

/**
 * A task is as gone as whoever it is FOR. Archiving a client takes their work off every board, but
 * each of these entry points only ever checked the task's own `archivedAt` — so an invoice's
 * "Job: …" link reopened the task by id and a timer could still run on work that was supposed to
 * have stopped (user, 2026-08-03). One helper, so a new entry point cannot forget.
 */
function liveTaskOr404(task: repo.TaskRecord | null): repo.TaskRecord {
  if (!task || task.archivedAt || task.client?.archivedAt || task.lead?.archivedAt) {
    throw new NotFoundError("Task not found");
  }
  return task;
}

export async function getTask(id: string) {
  return toTaskDto(liveTaskOr404(await repo.findTask(id)));
}

/** New assignees must be active; already-assigned users may stay (blocked badge in UI). */
async function assertAssignable(userIds: string[], current: Set<string> = new Set()) {
  const added = [...new Set(userIds)].filter((id) => !current.has(id));
  if (added.length > 0 && (await repo.countActiveUsersByIds(added)) !== added.length) {
    throw new ValidationError("Assignees must be active users");
  }
}

async function resolvePriorityColumn(priorityId?: string, statusColumnId?: string) {
  const priority = priorityId
    ? await repo.findPriority(priorityId)
    : await repo.findDefaultPriority();
  if (!priority) throw new ValidationError("Unknown priority");
  const column = statusColumnId
    ? await repo.findColumn(statusColumnId)
    : await repo.findFixedColumn();
  if (!column) throw new ValidationError("Unknown column");
  return { priorityId: priority.id, columnId: column.id };
}

/**
 * Task targeting (decision 2026-07-23):
 *  - LEAD task → free internal work (leads carry no paid service).
 *  - CLIENT task → always through one of the client's subscriptions:
 *      · one-time service → billable JOB: price + an invoice issued per the
 *        service trigger (on_create now / on_complete when marked done);
 *      · subscription service → FREE extra work included in the price (no invoice).
 *    The subscription pins BOTH the service (belonging) and the company target,
 *    so there's no ambiguity for multi-company clients.
 *  - Neither → internal free task (e.g. a standup).
 * kind, serviceId and companyId are DERIVED here — the client never sends them.
 */
export async function createTask(input: CreateTaskInput, actor: User) {
  await assertAssignable(input.assignees);
  const { priorityId, columnId } = await resolvePriorityColumn(input.priorityId, input.statusColumnId);

  let clientId: string | null = null;
  let leadId: string | null = null;
  let serviceId: string | null = null;
  let companyId: string | null = null;
  let subscriptionId: string | null = null;
  let kind: "once" | "free" = "free";
  let amount: number | null = null;
  let billNow = false;
  let dueDays: number | null = null;

  if (input.internal) {
    // Firm-side work. A client or lead may be named for ATTRIBUTION — organising their paperwork
    // is time spent on them and belongs on their card — but it goes through no service, so there
    // is no company, no price and nothing to invoice (user, 2026-08-01).
    if (input.leadId) {
      const lead = await repo.findLead(input.leadId);
      if (!lead) throw new ValidationError("Unknown or archived lead");
      leadId = lead.id;
    } else if (input.clientId) {
      const client = await repo.findActiveClient(input.clientId);
      if (!client) throw new ValidationError("Unknown or archived client");
      clientId = client.id;
    }
  } else if (input.leadId) {
    const lead = await repo.findLead(input.leadId);
    if (!lead) throw new ValidationError("Unknown or archived lead");
    leadId = lead.id; // lead task stays free/internal
  } else if (input.clientId) {
    const client = await repo.findActiveClient(input.clientId);
    if (!client) throw new ValidationError("Unknown or archived client");
    if (!input.subscriptionId) {
      throw new ValidationError("A client task goes through one of the client's services");
    }
    const sub = await repo.findClientSubscription(input.clientId, input.subscriptionId);
    // paused services are excluded by the query itself — ad-hoc work goes on the client's
    // one-time container, which is open-ended (decision 2026-07-29)
    if (!sub) throw new ValidationError("Pick one of the client's active services");
    clientId = client.id;
    subscriptionId = sub.id;
    serviceId = sub.serviceId; // belonging
    companyId = sub.companyId; // the company target is pinned by the subscription
    if (sub.service.type === "one_time") {
      kind = "once"; // billable job
      amount = input.amount ?? sub.amount; // per-client default job price prefills
      dueDays = sub.dueDays ?? sub.service.dueDays; // per-client override wins
      billNow = (sub.invoiceTrigger ?? sub.service.invoiceTrigger) === "on_create";
    } else {
      kind = "free"; // extra work included in the subscription price — no charge
    }
  }
  // else: no target → internal free task

  const task = await repo.createTask({
    title: input.title,
    clientId,
    companyId,
    leadId,
    serviceId,
    subscriptionId,
    kind,
    priorityId,
    statusColumnId: columnId,
    deadline: input.deadline ? dateToUtc(input.deadline) : null,
    plannedMinutes: input.plannedMinutes ?? null,
    amount,
    description: input.description ?? null,
    createdById: actor.id, // manual task → the actor; generated tasks stay null ("Auto")
  });
  await repo.setAssignees(task.id, input.assignees);
  if (input.subtasks?.length) {
    await repo.setSubtasks(
      task.id,
      input.subtasks.map((text) => ({ text, done: false })),
    );
  }

  if (kind === "once" && billNow && amount != null && clientId) {
    await issueJobInvoice({
      taskId: task.id,
      clientId,
      companyId,
      serviceId,
      amount,
      dueDays,
      createdById: actor.id,
    });
  }
  return getTask(task.id);
}

export async function updateTask(id: string, input: UpdateTaskInput, actor: User) {
  const task = liveTaskOr404(await repo.findTask(id));

  // a job's price is editable only until an invoice is issued
  if (input.amount !== undefined) {
    if (task.kind !== "once") {
      throw new ValidationError("Only one-time job tasks carry a price");
    }
    if (task.invoiceId) {
      throw new ValidationError("The invoice is already issued — the price is locked");
    }
  }
  if (input.priorityId && !(await repo.findPriority(input.priorityId))) {
    throw new ValidationError("Unknown priority");
  }
  if (input.statusColumnId && !(await repo.findColumn(input.statusColumnId))) {
    throw new ValidationError("Unknown column");
  }
  if (input.assignees) {
    await assertAssignable(input.assignees, new Set(task.assignees.map((a) => a.userId)));
  }

  /*
   * Cancelling = the work was raised by mistake or called off. It leaves the board like a
   * completed task but is never deleted: for a GENERATED task the row is exactly what stops the
   * nightly sweep posting it again (the sweep dedups on the (subscription, template, period) key),
   * and the history is what the Archive shows (user, 2026-08-01).
   *
   * It is refused once an invoice exists. Cancelling the work while the client stays billed is
   * the one outcome nobody wants silently — void the invoice first, then call the task off. The
   * same direction as Payments: an invoice with payments on it can't be cancelled either.
   */
  if (input.done === true && task.cancelledAt && input.cancelled !== false) {
    throw new ConflictError("This task was cancelled — restore it before marking it done");
  }
  if (input.cancelled === true && !task.cancelledAt && task.invoiceId) {
    throw new ConflictError(
      "This job is already invoiced — cancel the invoice first, then call the task off",
    );
  }

  await repo.updateTask(id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.priorityId !== undefined ? { priorityId: input.priorityId } : {}),
    ...(input.statusColumnId !== undefined ? { statusColumnId: input.statusColumnId } : {}),
    // stamp WHEN it was finished (the Done view filters on it); reopening clears the stamp,
    // so it always describes the current completion rather than an old one
    ...(input.done !== undefined
      ? { done: input.done, completedAt: input.done ? new Date() : null }
      : {}),
    // stamps WHO called it off as well as when — a cancelled task is a decision, and the log of
    // it is most of why the row is kept. Taking it back clears both.
    ...(input.cancelled !== undefined
      ? input.cancelled
        ? { cancelledAt: new Date(), cancelledById: actor.id }
        : { cancelledAt: null, cancelledById: null }
      : {}),
    ...(input.deadline !== undefined
      ? { deadline: input.deadline ? dateToUtc(input.deadline) : null }
      : {}),
    ...(input.plannedMinutes !== undefined ? { plannedMinutes: input.plannedMinutes } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (input.assignees) await repo.setAssignees(id, input.assignees);

  // one-time job billed on completion: issue the invoice the moment it's marked done
  if (input.done === true && task.kind === "once" && !task.invoiceId && task.clientId) {
    const amount = input.amount !== undefined ? input.amount : task.amount;
    if (amount != null) {
      const sub = task.subscriptionId
        ? await repo.findClientSubscription(task.clientId, task.subscriptionId)
        : null;
      const trigger = sub?.invoiceTrigger ?? sub?.service.invoiceTrigger;
      if (trigger === "on_complete") {
        await issueJobInvoice({
          taskId: task.id,
          clientId: task.clientId,
          companyId: task.companyId,
          serviceId: task.serviceId,
          amount,
          dueDays: sub?.dueDays ?? sub?.service.dueDays ?? null,
        });
      }
    }
  }
  return getTask(id);
}

export async function setSubtasks(id: string, input: SetSubtasksInput) {
  liveTaskOr404(await repo.findTask(id));
  await repo.setSubtasks(id, input.subtasks);
  return getTask(id);
}

// ── comments (any authenticated user; delete = own comment or admin) ───────────

export async function addComment(taskId: string, input: CreateTaskCommentInput, actor: User) {
  liveTaskOr404(await repo.findTask(taskId));
  await repo.addComment(taskId, actor.id, input.body);
  return getTask(taskId);
}

export async function deleteComment(commentId: string, actor: User) {
  const comment = await repo.findComment(commentId);
  if (!comment) throw new NotFoundError("Comment not found");
  // guard the parent task BEFORE the delete — otherwise an archived task would delete
  // the row then 404 on the getTask response (side effect with no confirmation)
  const task = await repo.findTask(comment.taskId);
  if (!task || task.archivedAt) throw new NotFoundError("Task not found");
  if (comment.authorId !== actor.id && actor.role !== "admin") {
    throw new ForbiddenError("You can only delete your own comments");
  }
  await repo.deleteComment(commentId);
  return getTask(comment.taskId);
}

/**
 * Archiving is tidying finished work out of the working lists — never a way to make open work
 * disappear. Only a DONE task can be archived (user, 2026-08-01), the same rule invoices follow:
 * otherwise something still owed to a client could leave the board with no trace of why.
 */
/** Closed business: finished, or called off. Open work must never be able to vanish. */
const archivableState = (t: { done: boolean; cancelledAt: Date | null }) => t.done || !!t.cancelledAt;

export async function archiveTask(id: string, actor: User) {
  const task = liveTaskOr404(await repo.findTask(id));
  if (!archivableState(task)) {
    throw new ConflictError(
      "Finish or cancel the task first — only closed work can be archived",
    );
  }
  await repo.updateTask(id, { archivedAt: new Date(), archivedById: actor.id });
  return { ok: true as const };
}

/**
 * Put an archived task back on the board — but only if there is a board for it to go back to.
 *
 * A task belonging to an archived client cannot be restored on its own: it would land in a state
 * the app has no view for (a live task hanging off a client nobody can open), and it is the same
 * hole that let an invoice's "Job:" link reopen an archived client's task and run a timer on it.
 * Restore the client first, and every one of their tasks comes back with them.
 */
export async function restoreTask(id: string) {
  const task = await repo.findTask(id);
  if (!task || !task.archivedAt) throw new NotFoundError("Task not found");
  if (task.client?.archivedAt || task.lead?.archivedAt) {
    throw new ConflictError(
      "This task belongs to an archived client — restore the client and its tasks come back too",
    );
  }
  await repo.updateTask(id, { archivedAt: null, archivedById: null });
  return getTask(id);
}

/**
 * Archive many at once.
 *
 * Eligibility is `archivableState` — the SAME predicate the single archive uses — so the two can
 * never disagree about what "closed work" means. Anything not eligible is counted and reported,
 * never silently skipped: a bulk action that does part of its job in silence is worse than one
 * that refuses outright.
 *
 * A task whose client or lead is archived is refused here too. It is already invisible everywhere,
 * and archiving it would bury it a second level down, out of reach of the client's own restore.
 */
export async function bulkArchive(input: BulkArchiveTasksInput, actor: User) {
  const tasks = await repo.findTasksByIds(input.taskIds);
  const eligible = tasks.filter(
    (t) => !t.archivedAt && !t.client?.archivedAt && !t.lead?.archivedAt && archivableState(t),
  );
  if (eligible.length > 0) {
    await repo.archiveTasks(eligible.map((t) => t.id), actor.id);
  }
  return { changed: eligible.length, skipped: input.taskIds.length - eligible.length };
}

// ── timer ────────────────────────────────────────────────────────────────────

const elapsedSeconds = (from: Date) => Math.max(1, Math.floor((Date.now() - from.getTime()) / 1000));

function toTimerDto(entry: { id: string; taskId: string; startedAt: Date }, task: { id: string; title: string }) {
  return {
    entryId: entry.id,
    taskId: task.id,
    taskTitle: task.title,
    startedAt: entry.startedAt.toISOString(),
  };
}

export async function getActiveTimer(actor: User) {
  const running = await repo.findRunningEntry(actor.id);
  return running ? toTimerDto(running, running.task) : null;
}

/**
 * Start tracking a task. If another timer is running: without closeComment →
 * 409 (the UI opens the comment modal); with it → close the old interval with
 * that comment and start the new one atomically. Cancel in the UI = nothing
 * happens and the old timer keeps running.
 */
export async function startTimer(actor: User, input: StartTimerInput) {
  const task = liveTaskOr404(await repo.findTask(input.taskId));
  // a completed task is a snapshot — no tracking new time on finished work (reopen first)
  if (task.done) throw new ValidationError("Task is completed — reopen it to track time");
  if (task.cancelledAt) throw new ValidationError("Task is cancelled — restore it to track time");

  const running = await repo.findRunningEntry(actor.id);
  if (running && running.taskId === input.taskId) {
    throw new ConflictError("Already tracking this task");
  }
  if (running && !input.closeComment) {
    throw new ConflictError(
      `Timer is already running on “${running.task.title}” — add a comment to close it first`,
    );
  }

  await repo.switchRunningEntry({
    userId: actor.id,
    taskId: input.taskId,
    close: running
      ? {
          id: running.id,
          stoppedAt: new Date(),
          seconds: elapsedSeconds(running.startedAt),
          comment: input.closeComment!,
        }
      : undefined,
  });
  return getActiveTimer(actor);
}

/** Every stop requires a comment — an interval never closes silently. */
export async function stopTimer(actor: User, input: StopTimerInput) {
  const running = await repo.findRunningEntry(actor.id);
  if (!running) throw new NotFoundError("No running timer");
  await repo.closeEntry(running.id, {
    stoppedAt: new Date(),
    seconds: elapsedSeconds(running.startedAt),
    comment: input.comment,
  });
  return { ok: true as const, taskId: running.taskId };
}

// ── admin time management ────────────────────────────────────────────────────

export async function addTimeEntry(admin: User, taskId: string, input: AddTimeEntryInput) {
  liveTaskOr404(await repo.findTask(taskId));
  if (!(await repo.findUser(input.userId))) throw new ValidationError("Unknown user");

  const startedAt = input.date ? dateToUtc(input.date) : new Date();
  const seconds = input.minutes * 60;
  await repo.createManualEntry({
    taskId,
    userId: input.userId,
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + seconds * 1000),
    seconds,
    comment: input.comment,
    createdById: admin.id,
  });
  return getTask(taskId);
}

export async function updateTimeEntry(entryId: string, input: UpdateTimeEntryInput) {
  const entry = await repo.findEntry(entryId);
  if (!entry) throw new NotFoundError("Time entry not found");
  if (!entry.stoppedAt) {
    throw new ValidationError("The timer is still running — stop it before editing");
  }
  const seconds = input.minutes !== undefined ? input.minutes * 60 : undefined;
  await repo.updateEntry(entryId, {
    ...(seconds !== undefined
      ? { seconds, stoppedAt: new Date(entry.startedAt.getTime() + seconds * 1000) }
      : {}),
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  });
  return getTask(entry.taskId);
}

/** Admin cleanup — also unblocks a stuck running timer (deleting it force-stops). */
export async function removeTimeEntry(entryId: string) {
  const entry = await repo.findEntry(entryId);
  if (!entry) throw new NotFoundError("Time entry not found");
  await repo.deleteEntry(entryId);
  return getTask(entry.taskId);
}
