import type {
  CalendarQuery,
  CreateMeetingInput,
  MeetingTaskInput,
  UpdateMeetingInput,
} from "@shared/schema/calendar.js";
import { MAX_CALENDAR_RANGE_DAYS } from "@shared/schema/calendar.js";
import { isPastBusinessDate } from "@shared/dates.js";
import { overlapping, spanEndMs } from "@shared/meetings.js";
import type { User } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { dateToUtc, isoDayInTz, todayBusinessMs, zonedDayStart } from "../../core/dates.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { clientLabel, personName } from "../../core/names.js";
import { notify } from "../../core/notify.js";
import { createTask, listDeadlinesInRange } from "../tasks/index.js";
import * as repo from "./meetings.repository.js";

export function toMeetingDto(m: repo.MeetingRecord) {
  return {
    id: m.id,
    title: m.title,
    clientId: m.clientId,
    leadId: m.leadId,
    personId: m.personId,
    serviceId: m.serviceId,
    startAt: m.startAt.toISOString(),
    durationMinutes: m.durationMinutes,
    link: m.link,
    description: m.description,
    participantIds: m.participants.map((p) => p.userId),
    clientName: m.client ? clientLabel(m.client) : null,
    leadName: m.lead?.name ?? null,
    personName: m.person?.name ?? null,
    serviceName: m.service?.name ?? null,
    taskId: m.taskId,
    createdById: m.createdById,
    cancelledAt: m.cancelledAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * A calendar window — and it needs TWO of them, because the screen draws two different kinds of
 * thing.
 *
 * A **deadline** is a stored calendar day, pinned to UTC midnight like every business date here,
 * so its window is UTC-to-UTC. A **meeting** is a real instant, so its window runs from midnight
 * IN THE FIRM'S ZONE. Using the deadline window for meetings looks perfectly correct in a UTC test
 * environment and is three hours out in Kyiv — silently hiding everything before 03:00 and pulling
 * in the tail of the day before.
 *
 * The day itself is always the firm's, never the viewer's: two people in the same office must not
 * see the same meeting on different days.
 */
function windowOf(query: CalendarQuery) {
  const days = (dateToUtc(query.to).getTime() - dateToUtc(query.from).getTime()) / 86_400_000;
  if (days <= 0) throw new ValidationError("The end of the range must be after its start");
  if (days > MAX_CALENDAR_RANGE_DAYS) {
    throw new ValidationError(`Ask for at most ${MAX_CALENDAR_RANGE_DAYS} days at a time`);
  }
  return {
    /** instants — for meetings */
    from: zonedDayStart(query.from, config.TZ),
    to: zonedDayStart(query.to, config.TZ),
    /** UTC-midnight days — for stored deadline dates */
    fromDay: dateToUtc(query.from),
    toDay: dateToUtc(query.to),
  };
}

export async function getCalendar(query: CalendarQuery) {
  const { from, to, fromDay, toDay } = windowOf(query);
  const todayMs = todayBusinessMs(config.TZ);

  const [meetings, deadlines] = await Promise.all([
    query.meetings
      ? repo.listMeetings({ from, to, userId: query.userId, clientId: query.clientId })
      : Promise.resolve([]),
    query.deadlines
      ? listDeadlinesInRange({
          from: fromDay,
          to: toDay,
          userId: query.userId,
          clientId: query.clientId,
        })
      : Promise.resolve([]),
  ]);

  return {
    meetings: meetings.map(toMeetingDto),
    deadlines: deadlines.map((t) => ({
      taskId: t.id,
      title: t.title,
      // a deadline is a whole calendar day; the ISO day is read off the UTC clock it was stored on
      day: t.deadline!.toISOString().slice(0, 10),
      clientName: t.client ? clientLabel(t.client) : null,
      leadName: t.lead?.name ?? null,
      assigneeIds: t.assignees.map((a) => a.userId),
      // the same rule the board and the invoices use — a task due today is due today, not late
      overdue: isPastBusinessDate(t.deadline, todayMs),
    })),
  };
}

export async function getMeeting(id: string) {
  const meeting = await repo.findMeeting(id);
  if (!meeting) throw new NotFoundError("Meeting not found");
  return toMeetingDto(meeting);
}

export async function listFor(target: { clientId?: string; leadId?: string }) {
  const meetings = await repo.listMeetingsFor(target);
  return meetings.map(toMeetingDto);
}

/**
 * Who is already booked over this slot.
 *
 * A warning, never a refusal (plan + design): people double-book on purpose — a call they will
 * take notes in, a session two of them split. Blocking it would mean arguing with how the office
 * actually works, and a check that cannot be overridden gets worked around by not using the app.
 */
export async function findConflicts(args: {
  startAt: Date;
  durationMinutes: number;
  userIds: string[];
  excludeMeetingId?: string;
}) {
  if (args.userIds.length === 0 || args.durationMinutes <= 0) return [];
  const span = { startAt: args.startAt, durationMinutes: args.durationMinutes };
  const candidates = await repo.findPotentialConflicts({
    userIds: args.userIds,
    from: args.startAt,
    to: new Date(spanEndMs(span)),
    excludeMeetingId: args.excludeMeetingId,
  });

  const wanted = new Set(args.userIds);
  return overlapping(span, candidates)
    .map((m) => ({
      meetingId: m.id,
      title: m.title,
      startAt: m.startAt.toISOString(),
      durationMinutes: m.durationMinutes,
      userIds: m.participants.map((p) => p.userId).filter((id) => wanted.has(id)),
    }))
    .filter((c) => c.userIds.length > 0);
}

/** Client XOR lead, both optional; each must exist and be live. */
async function resolveTarget(input: { clientId?: string | null; leadId?: string | null }) {
  if (input.clientId && input.leadId) {
    throw new ValidationError("Pick a client or a lead, not both");
  }
  if (input.clientId) {
    if (!(await repo.findActiveClient(input.clientId))) {
      throw new ValidationError("Unknown or archived client");
    }
    return { clientId: input.clientId, leadId: null };
  }
  if (input.leadId) {
    if (!(await repo.findLead(input.leadId))) {
      throw new ValidationError("Unknown or archived lead");
    }
    return { clientId: null, leadId: input.leadId };
  }
  return { clientId: null, leadId: null };
}

/**
 * The contact is a REFINEMENT of the client, so it is only ever valid against that client.
 *
 * Checked on edit as well as on create: the target is frozen once a meeting exists, but the
 * contact is not — you often learn who you are dealing with afterwards — so this is the only
 * thing standing between a stale id and someone else's phone number.
 */
async function assertPersonBelongs(personId: string, clientId: string | null) {
  if (!clientId) {
    throw new ValidationError("A contact person belongs to a client — pick the client too");
  }
  if (!(await repo.findClientPerson(personId, clientId))) {
    throw new ValidationError("That contact does not belong to this client");
  }
}

async function assertBookable(userIds: string[]) {
  if (userIds.length === 0) return;
  if ((await repo.countActiveUsers(userIds)) !== userIds.length) {
    throw new ValidationError("One of the people invited is no longer an active team member");
  }
}

/**
 * Open the task a meeting asked for.
 *
 * It goes through the tasks module's own `createTask` — the same door a hand-made task uses. That
 * is what makes a meeting's task validate, bill and appear identically to any other: a one-time
 * service still issues its invoice on its own trigger, and a paused service is still refused.
 * Assignees are the organiser plus everyone invited; the deadline is the day of the meeting
 * (user, 2026-08-04).
 *
 * One implementation, called from both create and update, so a task attached later is in every
 * respect the same as one asked for up front.
 */
async function openTaskFor(
  meeting: {
    title: string;
    clientId: string | null;
    leadId: string | null;
    startAt: Date;
    durationMinutes: number;
    description: string | null;
    participantIds: string[];
  },
  task: MeetingTaskInput,
  actor: User,
) {
  const throughService = task.mode === "service";
  if (throughService) {
    // the create input refines this too; an update can only be checked here, where the target is
    if (!meeting.clientId) {
      throw new ValidationError("Only a client's meeting can route its task through a service");
    }
    if (!task.subscriptionId) {
      throw new ValidationError("Pick which of the client's services the work goes through");
    }
  }
  return createTask(
    {
      title: meeting.title,
      clientId: meeting.clientId,
      leadId: meeting.leadId,
      internal: !throughService,
      subscriptionId: throughService ? task.subscriptionId : null,
      // the day of the meeting IN THE FIRM'S ZONE — see `isoDayInTz`
      deadline: isoDayInTz(meeting.startAt, config.TZ),
      plannedMinutes: meeting.durationMinutes,
      assignees: meeting.participantIds,
      description: meeting.description,
    },
    actor,
  );
}

export async function createMeeting(input: CreateMeetingInput, actor: User) {
  const target = await resolveTarget(input);
  if (input.personId) await assertPersonBelongs(input.personId, target.clientId);
  if (input.serviceId && !(await repo.findActiveService(input.serviceId))) {
    throw new ValidationError("Unknown or inactive service");
  }
  // the organiser is in the room. Left out of the list, they would be invisible to their own
  // conflict check — the one person whose diary the booker is definitely filling.
  const participantIds = [...new Set([actor.id, ...input.participantIds])];
  await assertBookable(participantIds);

  const startAt = new Date(input.startAt);

  // The MEETING is written first, then its task, then the link between them.
  //
  // The order is the whole point. Creating the task first meant a failure on the meeting insert
  // left a task on the board belonging to a meeting that does not exist — invisible from the
  // calendar and impossible to explain. This way the worst case is a meeting saved without its
  // task, which is visible, obvious, and fixable in the UI: the form can attach one afterwards.
  const created = await repo.createMeeting({
    title: input.title,
    clientId: target.clientId,
    leadId: target.leadId,
    personId: input.personId ?? null,
    serviceId: input.serviceId ?? null,
    startAt,
    durationMinutes: input.durationMinutes,
    link: input.link ?? null,
    description: input.description ?? null,
    createdById: actor.id,
  });
  await repo.setParticipants(created.id, participantIds);

  if (input.task) {
    const task = await openTaskFor(
      {
        title: input.title,
        clientId: target.clientId,
        leadId: target.leadId,
        startAt,
        durationMinutes: input.durationMinutes,
        description: input.description ?? null,
        participantIds,
      },
      input.task,
      actor,
    );
    await repo.updateMeeting(created.id, { taskId: task.id });
  }

  // after the writes, and never inside them — a booking that rolls back must not leave an
  // invitation in somebody's tray. The organiser is dropped by the emitter: they were there.
  await notifyInvited(created.id, input.title, startAt, actor);
  return getMeeting(created.id);
}

/**
 * "You are in a meeting you did not book" — the definition of news, and the reason the dedup key
 * is the MEETING: a participant list edited three times invites each new person exactly once, and
 * nobody twice.
 */
function notifyInvited(meetingId: string, title: string, startAt: Date, actor: User) {
  return notify("meeting_invited", {
    dedup: meetingId,
    actorId: actor.id,
    meetingId,
    vars: { actor: personName(actor), meeting: title },
    sub: meetingWhen(startAt),
    link: { type: "meeting", id: meetingId },
  });
}

/** The one place a meeting instant is written into notification text, so the two triggers agree. */
function meetingWhen(startAt: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(startAt);
}

/** Move a meeting's task to the meeting's new day. Never touches anything else on the task. */
async function retimeTask(taskId: string, startAt: Date) {
  await repo.setTaskDeadline(taskId, dateToUtc(isoDayInTz(startAt, config.TZ)));
}

export async function updateMeeting(id: string, input: UpdateMeetingInput, actor: User) {
  const existing = await repo.findMeeting(id);
  if (!existing) throw new NotFoundError("Meeting not found");
  if (input.personId) await assertPersonBelongs(input.personId, existing.clientId);
  if (input.serviceId && !(await repo.findActiveService(input.serviceId))) {
    throw new ValidationError("Unknown or inactive service");
  }

  // On CREATE the organiser is added for them — they are booking their own time. On EDIT the list
  // is taken exactly as sent: someone who arranges a meeting for two colleagues and does not
  // attend must be able to step out of it. Forcing them back in made that impossible.
  let participantIds: string[] | undefined;
  if (input.participantIds) {
    participantIds = [...new Set(input.participantIds)];
    await assertBookable(participantIds);
  }

  // attaching a task to a meeting that has none. It can never REPLACE one: the existing task may
  // already carry time, comments or an invoice, and silently orphaning that is not an edit.
  let attachedTaskId: string | undefined;
  if (input.task) {
    if (existing.taskId) {
      throw new ConflictError("This meeting already has a task");
    }
    const created = await openTaskFor(
      {
        title: input.title ?? existing.title,
        clientId: existing.clientId,
        leadId: existing.leadId,
        startAt: input.startAt ? new Date(input.startAt) : existing.startAt,
        durationMinutes: input.durationMinutes ?? existing.durationMinutes,
        description: input.description ?? existing.description,
        participantIds: participantIds ?? existing.participants.map((p) => p.userId),
      },
      input.task,
      actor,
    );
    attachedTaskId = created.id;
  }

  await repo.updateMeeting(id, {
    ...(attachedTaskId ? { taskId: attachedTaskId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.personId !== undefined ? { personId: input.personId } : {}),
    ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
    ...(input.startAt !== undefined ? { startAt: new Date(input.startAt) } : {}),
    ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
    ...(input.link !== undefined ? { link: input.link } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    // cancelling is reversible: a meeting called off and put back on is one row, not two
    ...(input.cancelled !== undefined
      ? { cancelledAt: input.cancelled ? new Date() : null }
      : {}),
  });
  if (participantIds) await repo.setParticipants(id, participantIds);

  /**
   * A moved meeting takes its task's DEADLINE with it. The deadline is not an independent choice —
   * `openTaskFor` defines it as "the day of the meeting", so leaving it behind when the meeting
   * moves produces a task due before the thing it exists to prepare for.
   *
   * `plannedMinutes` is deliberately NOT synced. It starts as the duration but is an ESTIMATE that
   * belongs to the task, and people refine estimates on the board; silently overwriting that
   * because a meeting slipped an hour would throw away a person's judgement.
   */
  const movedTo = input.startAt ? new Date(input.startAt) : null;
  const linkedTask = attachedTaskId ?? existing.taskId;
  if (movedTo && linkedTask && movedTo.getTime() !== existing.startAt.getTime()) {
    await retimeTask(linkedTask, movedTo);
  }

  const title = input.title ?? existing.title;
  // somebody added to the list now is being invited, exactly as on create
  if (participantIds) await notifyInvited(id, title, movedTo ?? existing.startAt, actor);

  // Turning up to a moved meeting is the failure this prevents, so the dedup key is the new
  // INSTANT: a meeting pushed twice tells people twice, and a save that did not move it is silent.
  if (movedTo && movedTo.getTime() !== existing.startAt.getTime()) {
    await notify("meeting_moved", {
      dedup: `${id}:${movedTo.toISOString()}`,
      actorId: actor.id,
      meetingId: id,
      vars: { meeting: title, when: meetingWhen(movedTo) },
      sub: `Was ${meetingWhen(existing.startAt)}`,
      link: { type: "meeting", id },
    });
  }
  return getMeeting(id);
}
