import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { SUBJECT_GROUP, type ActivityGroup, type ActivitySubject } from "@shared/activity.js";
import type { ActivityQuery } from "@shared/schema/activity.js";

/**
 * **Reading the log, grouped by gesture.**
 *
 * Two queries rather than one, and the reason is the grouping. A page of ROWS cannot be grouped
 * afterwards without gestures straddling the page boundary — the last entry of every page would be
 * half of itself. So the page is a page of CORRELATION IDS, ordered by when each gesture last
 * wrote, and the rows come back whole in a second query.
 *
 * That also decides what a filter means: it selects GESTURES, and a selected gesture returns all
 * its rows. An entry showing three of its five changes because two were filtered out would be a
 * worse answer than either.
 */

function where(query: ActivityQuery): Prisma.ActivityEventWhereInput {
  const filters: Prisma.ActivityEventWhereInput = {};
  if (query.actorUserId) filters.actorUserId = query.actorUserId;
  if (query.subject) filters.subject = query.subject;
  if (query.subjectId) filters.subjectId = query.subjectId;
  if (query.clientId) filters.clientId = query.clientId;
  if (query.action) filters.action = query.action;
  if (query.group) {
    // a group is a set of subjects, resolved from the registry rather than stored on the row: one
    // place decides which group a subject is in, and it is beside the registry (§4.3)
    const subjects = (Object.keys(SUBJECT_GROUP) as ActivitySubject[]).filter(
      (s) => SUBJECT_GROUP[s] === (query.group as ActivityGroup),
    );
    filters.subject = { in: subjects };
  }
  if (query.from || query.to) {
    filters.occurredAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  if (query.q) {
    // the snapshotted labels, which is the only text this table holds — and the only text it
    // SHOULD hold, since §5.1 keeps field values out of it
    filters.OR = [
      { subjectLabel: { contains: query.q, mode: "insensitive" } },
      { actorLabel: { contains: query.q, mode: "insensitive" } },
    ];
  }
  return filters;
}

/** The ids of one page of gestures, newest gesture first. */
export async function findGestureIds(query: ActivityQuery): Promise<string[]> {
  const groups = await prisma.activityEvent.groupBy({
    by: ["correlationId"],
    where: where(query),
    _max: { occurredAt: true },
    orderBy: { _max: { occurredAt: "desc" } },
    take: query.pageSize,
    skip: (query.page - 1) * query.pageSize,
  });
  return groups.map((g) => g.correlationId);
}

/** How many gestures match — the count the pager needs, not the count of rows. */
export async function countGestures(query: ActivityQuery): Promise<number> {
  const rows = await prisma.activityEvent.findMany({
    where: where(query),
    distinct: ["correlationId"],
    select: { correlationId: true },
  });
  return rows.length;
}

/** Every row of the given gestures, oldest first inside each — the order they happened. */
export async function findRowsFor(correlationIds: string[]) {
  if (correlationIds.length === 0) return [];
  return prisma.activityEvent.findMany({
    where: { correlationId: { in: correlationIds } },
    orderBy: { occurredAt: "asc" },
  });
}

export async function listPolicies() {
  return prisma.activityPolicy.findMany({ orderBy: { action: "asc" } });
}

export async function setPolicy(action: string, enabled: boolean) {
  return prisma.activityPolicy.update({ where: { action }, data: { enabled } });
}
