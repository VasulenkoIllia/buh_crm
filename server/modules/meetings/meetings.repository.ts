/** All Prisma access for meetings (see the repository rule in eslint.config.js). */
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const meetingInclude = {
  // labels ride along so the calendar never has to resolve ids against a (capped) client list —
  // the same reason the task board carries them
  client: { select: { firstName: true, lastName: true } },
  lead: { select: { name: true } },
  person: { select: { name: true } },
  service: { select: { name: true } },
  participants: { select: { userId: true } },
} satisfies Prisma.MeetingInclude;

export type MeetingRecord = Prisma.MeetingGetPayload<{ include: typeof meetingInclude }>;

/**
 * "Its client and its lead are both still live" — the same rule the task board applies, in the
 * shape a meeting query needs.
 *
 * Without it an archived client's TASKS left the calendar while their MEETINGS stayed, which is
 * the worst of both: half the relationship vanished and half did not. Written once here for the
 * same reason the tasks module has `liveTargetWhere` — two copies drift, and this pair already did.
 */
function liveTargetWhere(): Prisma.MeetingWhereInput {
  return {
    AND: [
      { OR: [{ clientId: null }, { client: { archivedAt: null } }] },
      { OR: [{ leadId: null }, { lead: { archivedAt: null } }] },
    ],
  };
}

/**
 * Live meetings that START inside the window.
 *
 * Deliberately not "meetings that overlap the window": a meeting is drawn from its start, and one
 * running across midnight into the first day shown would otherwise appear with its head cut off in
 * a lane it doesn't belong to. The calendar asks for whole days, so anything starting on a shown
 * day is shown.
 */
export function listMeetings(args: {
  from: Date;
  to: Date;
  userId?: string;
  clientId?: string;
}) {
  return prisma.meeting.findMany({
    where: {
      cancelledAt: null,
      startAt: { gte: args.from, lt: args.to },
      ...(args.userId ? { participants: { some: { userId: args.userId } } } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      ...liveTargetWhere(),
    },
    orderBy: { startAt: "asc" },
    include: meetingInclude,
  });
}

/** A client's or lead's meetings for their card's rollup — cancelled ones included, flagged. */
export function listMeetingsFor(target: { clientId?: string; leadId?: string }) {
  return prisma.meeting.findMany({
    where: target.clientId ? { clientId: target.clientId } : { leadId: target.leadId },
    orderBy: { startAt: "desc" },
    include: meetingInclude,
  });
}

/**
 * Meetings on one client that have not happened yet — the number on the card's Meetings tab.
 *
 * Upcoming, not "all": a client seen twelve times last year would wear a permanent 12 that means
 * nothing to act on. Cancelled ones are out for the same reason.
 */
export function countUpcomingMeetingsForClient(clientId: string, now: Date) {
  return prisma.meeting.count({
    where: { clientId, cancelledAt: null, startAt: { gte: now } },
  });
}

export function findMeeting(id: string) {
  return prisma.meeting.findUnique({ where: { id }, include: meetingInclude });
}

/**
 * Live meetings that could collide with `[from, to)` for any of `userIds`.
 *
 * The window is widened backwards by the longest meeting the app allows (24h), because a meeting
 * that STARTED before the window can still be running inside it. Narrowing on `startAt` alone
 * would miss exactly the clash a person cares about — the one already in progress. The precise
 * overlap is then decided by the shared rule, not by SQL.
 */
export function findPotentialConflicts(args: {
  userIds: string[];
  from: Date;
  to: Date;
  excludeMeetingId?: string;
}) {
  const LONGEST_MEETING_MS = 24 * 60 * 60_000;
  return prisma.meeting.findMany({
    where: {
      cancelledAt: null,
      startAt: { gte: new Date(args.from.getTime() - LONGEST_MEETING_MS), lt: args.to },
      participants: { some: { userId: { in: args.userIds } } },
      ...(args.excludeMeetingId ? { id: { not: args.excludeMeetingId } } : {}),
      // an archived client's meeting is off the calendar, so it no longer holds anyone's time
      ...liveTargetWhere(),
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      title: true,
      startAt: true,
      durationMinutes: true,
      participants: { select: { userId: true } },
    },
  });
}

export function createMeeting(data: Prisma.MeetingUncheckedCreateInput) {
  return prisma.meeting.create({ data, select: { id: true } });
}

export function updateMeeting(id: string, data: Prisma.MeetingUncheckedUpdateInput) {
  return prisma.meeting.update({ where: { id }, data, select: { id: true } });
}

/** Full replace — the form always sends the complete list. */
export async function setParticipants(meetingId: string, userIds: string[]) {
  await prisma.$transaction([
    prisma.meetingParticipant.deleteMany({ where: { meetingId } }),
    prisma.meetingParticipant.createMany({
      data: userIds.map((userId) => ({ meetingId, userId })),
      skipDuplicates: true,
    }),
  ]);
}

// ── lookups for validation (same pattern the tasks repository follows) ───────

export function findActiveClient(id: string) {
  return prisma.client.findFirst({ where: { id, archivedAt: null }, select: { id: true } });
}

/**
 * A contact, but only if they belong to THIS client. A person id is guessable and arrives from the
 * browser; without the `clientId` in the WHERE, one client's meeting could carry another client's
 * contact — and with it their name and phone number.
 */
export function findClientPerson(id: string, clientId: string) {
  return prisma.clientPerson.findFirst({ where: { id, clientId }, select: { id: true } });
}

export function findLead(id: string) {
  return prisma.lead.findFirst({ where: { id, archivedAt: null }, select: { id: true } });
}

export function findActiveService(id: string) {
  return prisma.service.findFirst({ where: { id, active: true }, select: { id: true } });
}

/** Only ACTIVE team members can be booked — an invited leaver is a meeting nobody attends. */
export function countActiveUsers(ids: string[]) {
  return prisma.user.count({ where: { id: { in: ids }, status: "active" } });
}

/**
 * Move a meeting's task to a new deadline day.
 *
 * The one write this module makes into the tasks table. It is a single derived column — "the day
 * of the meeting" — rather than a task edit, so it goes here instead of through the tasks module's
 * `updateTask`, which would also touch workflow fields this module has no business setting.
 */
export function setTaskDeadline(taskId: string, deadline: Date) {
  return prisma.task.update({ where: { id: taskId }, data: { deadline }, select: { id: true } });
}
