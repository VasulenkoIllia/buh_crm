import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import {
  TIER1_REQUEST,
  SUBJECT_GROUP,
  type ActivityGroup,
  type ActivitySubject,
  UNROUTED_REQUEST,
} from "@shared/activity.js";
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
  // a SUCCESSFUL bare request row is kept and not shown unless asked for — by the switch, or by
  // picking that exact key from the action list. A FAILED one stays in view: a request that went
  // wrong and that no service described is a signal an audit log exists to show, and hiding it with
  // the noise was the first version's mistake (security review, 2026-09-10)
  else if (!query.technical) {
    // …and so is one that matched no route. None has been written since 2026-09-13, and the ones
    // written before — a scanner's 221 POSTs for WordPress among them — are noise, not acts
    filters.NOT = {
      action: TIER1_REQUEST,
      OR: [{ outcome: "ok" }, { route: UNROUTED_REQUEST }],
    };
  }
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
    // the correlation id is the tiebreaker, and it is not decoration: a flush writes every row of a
    // gesture in ONE statement, so two gestures that commit in the same millisecond have equal
    // `MAX(occurredAt)` — and an unstable sort under LIMIT/OFFSET returns one of them on two pages
    // and the other on none (audit, 2026-09-09)
    orderBy: [{ _max: { occurredAt: "desc" } }, { correlationId: "desc" }],
    take: query.pageSize + 1,
    skip: (query.page - 1) * query.pageSize,
  });
  return {
    ids: groups.slice(0, query.pageSize).map((g) => g.correlationId),
    hasMore: groups.length > query.pageSize,
  };
}

const COUNT_CEILING = 2000;

/**
 * **How many gestures match — counted up to a ceiling, and no further.**
 *
 * An exact total of a two-year log costs a scan of every matching gesture on every page load. A
 * pager needs to know where it is and whether there is more; past the ceiling the screen says
 * "2000+", which is both honest and bounded.
 *
 * **`groupBy`, not `findMany({ distinct })` — because only one of the two puts a `LIMIT` in the
 * SQL.**
 *
 * Prisma applies `distinct` in the query engine, AFTER the rows have crossed the wire: the
 * statement it emits for `findMany({ distinct, take })` carries an `OFFSET` and no `LIMIT` at all
 * (verified against this database, 2026-09-09). So the ceiling above was decorative — the query
 * still selected every matching row and then counted them in memory, which is the 50 MB-per-load
 * regression the previous rewrite was for. `groupBy` pushes both the grouping and the limit into
 * Postgres, which is what `findGestureIds` two functions up has been doing all along.
 *
 * A pager needs to know where it is and whether there is more; it does not need an exact total of a
 * two-year log. Past the ceiling the screen says "2000+", which is both honest and bounded.
 */
export async function countGestures(
  query: ActivityQuery,
  visible: string[],
): Promise<{ total: number; exact: boolean }> {
  const rows = await prisma.activityEvent.groupBy({
    by: ["correlationId"],
    where: where(query, visible),
    // Prisma requires an `orderBy` beside `take`; which order does not matter for a count, so it is
    // the grouping column itself rather than an aggregate the database would have to compute.
    orderBy: { correlationId: "asc" },
    take: COUNT_CEILING + 1,
  });
  return { total: Math.min(rows.length, COUNT_CEILING), exact: rows.length <= COUNT_CEILING };
}

/**
 * Every row of the given gestures, oldest first inside each — the order they happened.
 *
 * **`id` breaks the tie, and there is always a tie.** A flush writes a gesture with one
 * `createMany`, so every row of it carries the identical `occurredAt`; ordering by that column
 * alone left the order to Postgres, and the screen takes `rows[0]` as the entry's sentence, its
 * actor and its time. The headline of "Olena updated Petrenko" could differ between two loads of
 * the same page (audit, 2026-09-09). `id` is a uuid rather than a sequence, so this buys stability
 * rather than truth — but a stable arbitrary order is what a list needs, and within a gesture the
 * rows are simultaneous by construction.
 *
 * **Deliberately NOT capped**, though a gesture is not bounded by the page size: the scheduler wraps
 * a whole job in one context, so a night that issues four hundred invoices is ONE correlation id
 * with four hundred rows while `pageSize` counts gestures. A `take` here would be worse than the
 * problem — the rows of a page arrive oldest-first across every gesture on it, so a cut would empty
 * the newest gestures rather than trim the longest one, and `list()` drops an entry with no rows.
 * Entries vanishing from the top of the feed is not a trade worth making for a payload. Bounding it
 * properly means a per-gesture limit and a "+N more" count from the server, which is a change to
 * the read contract and is written up as open work rather than done here (audit, 2026-09-09).
 */
export async function findRowsFor(correlationIds: string[], visible: string[]) {
  if (correlationIds.length === 0) return [];
  return prisma.activityEvent.findMany({
    // the gesture comes back whole, but only the parts of it this reader may see: saving a client
    // also touched a subscription, and a reader without `clients` must not meet either
    where: { correlationId: { in: correlationIds }, subject: { in: visible } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
}

export async function listPolicies() {
  return prisma.activityPolicy.findMany({ orderBy: { action: "asc" } });
}

export async function setPolicy(action: string, enabled: boolean) {
  return prisma.activityPolicy.update({ where: { action }, data: { enabled } });
}
