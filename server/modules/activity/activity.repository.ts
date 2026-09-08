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

function where(query: ActivityQuery, visible: string[]): Prisma.ActivityEventWhereInput {
  /**
   * **What this reader may see at all**, intersected before any of their own filters.
   *
   * §12 rule 1: the log must not become a way to read what a gate closed. A subject label is a
   * client name, so a reader whose `clients` gate is shut sees no `client`, `company`, `file` or
   * `subscription` events — the same answer they would get by opening the client list.
   */
  const filters: Prisma.ActivityEventWhereInput = { subject: { in: visible } };
  if (query.actorUserId) filters.actorUserId = query.actorUserId;
  // a named subject the reader cannot see resolves to an empty set rather than to itself
  if (query.subject) filters.subject = { in: visible.filter((v) => v === query.subject) };
  if (query.subjectId) filters.subjectId = query.subjectId;
  if (query.clientId) filters.clientId = query.clientId;
  if (query.action) filters.action = query.action;
  if (query.group) {
    // a group is a set of subjects, resolved from the registry rather than stored on the row: one
    // place decides which group a subject is in, and it is beside the registry (§4.3)
    const subjects = (Object.keys(SUBJECT_GROUP) as ActivitySubject[]).filter(
      (s) => SUBJECT_GROUP[s] === (query.group as ActivityGroup),
    );
    /**
     * Intersected with whatever `subject` already holds, not assigned over it. `subject` and
     * `group` are independent optional params, so a caller may send both — and overwriting turned
     * "just `client` events, within the clients group" into "every subject in the group". Latent
     * (the screen sends only one), and exposed on the API the moment a deep link sends both.
     */
    const inGroup = subjects.filter((subject) => visible.includes(subject));
    const already = (filters.subject as { in: string[] }).in;
    filters.subject = { in: inGroup.filter((subject) => already.includes(subject)) };
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

/**
 * One page of gestures, newest first — **and whether another page exists**.
 *
 * `hasMore` is read from ONE EXTRA ROW rather than from the total, and that is the whole point.
 * The total is deliberately capped (see `countGestures`), and deriving "is there more" from a
 * ceiling means the Next button dies at the ceiling: a two-year log that silently stops at 2000
 * gestures, on the one screen built to reach back through it. Caught in review, 2026-09-09.
 */
export async function findGestureIds(
  query: ActivityQuery,
  visible: string[],
): Promise<{ ids: string[]; hasMore: boolean }> {
  const groups = await prisma.activityEvent.groupBy({
    by: ["correlationId"],
    where: where(query, visible),
    _max: { occurredAt: true },
    orderBy: { _max: { occurredAt: "desc" } },
    take: query.pageSize + 1,
    skip: (query.page - 1) * query.pageSize,
  });
  return {
    ids: groups.slice(0, query.pageSize).map((g) => g.correlationId),
    hasMore: groups.length > query.pageSize,
  };
}

/**
 * **How many gestures match — counted up to a ceiling, and no further.**
 *
 * This used to be `findMany({ distinct })` with no limit, whose length was then read in JavaScript.
 * The database time was never the problem: measured at a million rows with the screen's own 30-day
 * window it is 8 ms. The problem was the other end — an unfiltered "All" pulled 666 000 uuids
 * across the wire and built 666 000 JavaScript objects to read `.length`, roughly 50 MB per page
 * load, per reader (measured 2026-09-08).
 *
 * A pager needs to know where it is and whether there is more; it does not need an exact total of
 * a two-year log. Past the ceiling the screen says "2000+", which is both honest and bounded.
 */
const COUNT_CEILING = 2000;

export async function countGestures(
  query: ActivityQuery,
  visible: string[],
): Promise<{ total: number; exact: boolean }> {
  const rows = await prisma.activityEvent.findMany({
    where: where(query, visible),
    distinct: ["correlationId"],
    select: { correlationId: true },
    take: COUNT_CEILING + 1,
  });
  return { total: Math.min(rows.length, COUNT_CEILING), exact: rows.length <= COUNT_CEILING };
}

/** Every row of the given gestures, oldest first inside each — the order they happened. */
export async function findRowsFor(correlationIds: string[], visible: string[]) {
  if (correlationIds.length === 0) return [];
  return prisma.activityEvent.findMany({
    // the gesture comes back whole, but only the parts of it this reader may see: saving a client
    // also touched a subscription, and a reader without `clients` must not meet either
    where: { correlationId: { in: correlationIds }, subject: { in: visible } },
    orderBy: { occurredAt: "asc" },
  });
}

export async function listPolicies() {
  return prisma.activityPolicy.findMany({ orderBy: { action: "asc" } });
}

export async function setPolicy(action: string, enabled: boolean) {
  return prisma.activityPolicy.update({ where: { action }, data: { enabled } });
}
