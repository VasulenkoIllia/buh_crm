import {
  ACTIVITY_EVENTS,
  SUBJECT_GATE,
  isActivityKey,
  type ActivitySubject,
} from "@shared/activity.js";
import type { User } from "../../generated/prisma/client.js";
import { accessMapFor } from "../../core/access.js";
import { isGateKey } from "@shared/access.js";
import type { ActivityEntry, ActivityPage, ActivityQuery } from "@shared/schema/activity.js";
import { NotFoundError } from "../../core/errors.js";
import { invalidateActivityPolicy, record } from "../../core/activity.js";
import * as repo from "./activity.repository.js";

/**
 * **The log, read back as gestures rather than rows** (activity-log.md §6, §12).
 *
 * The screen renders every sentence from `shared/activity.ts`, so this service returns facts and no
 * prose: an event's title and its group live in the registry, which both ends read. That is what
 * keeps a new event a constant rather than a constant plus a switch statement in here.
 */
/**
 * **The subjects this reader may see** — §12 rule 1, enforced rather than assumed.
 *
 * A subject whose gate is `closed` for them is not in the answer at all. `read_only` counts as
 * open: it means "you may look and not touch", and the log is a thing you look at.
 */
async function visibleSubjects(user: Pick<User, "id" | "role">): Promise<string[]> {
  const access = await accessMapFor(user);
  return (Object.keys(SUBJECT_GATE) as ActivitySubject[]).filter((subject) => {
    const gate = SUBJECT_GATE[subject];
    // a subject naming a gate this build does not know is hidden rather than shown: the registry
    // test makes that unreachable, and hiding is the safe direction if it ever happens
    return isGateKey(gate) && access[gate] !== "closed";
  });
}

export async function list(user: Pick<User, "id" | "role">, query: ActivityQuery): Promise<ActivityPage> {
  const visible = await visibleSubjects(user);
  const ids = await repo.findGestureIds(query, visible);
  const [rows, count] = await Promise.all([
    repo.findRowsFor(ids, visible),
    repo.countGestures(query, visible),
  ]);

  const byGesture = new Map<string, ActivityEntry>();
  for (const id of ids) byGesture.set(id, null as unknown as ActivityEntry);

  for (const row of rows) {
    const existing = byGesture.get(row.correlationId);
    const entry: ActivityEntry = existing ?? {
      correlationId: row.correlationId,
      // the gesture is dated by its FIRST row: a person reads "when did this happen", not "when did
      // the last of its five writes land"
      occurredAt: row.occurredAt.toISOString(),
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      actorLabel: row.actorLabel,
      ip: row.ip,
      rows: [],
    };
    entry.rows.push({
      id: row.id,
      action: row.action,
      subject: row.subject,
      subjectId: row.subjectId,
      subjectLabel: row.subjectLabel,
      clientId: row.clientId,
      changes: row.changes ?? null,
      outcome: row.outcome,
      refusalCode: row.refusalCode,
      method: row.method,
      route: row.route,
      occurredAt: row.occurredAt.toISOString(),
    });
    byGesture.set(row.correlationId, entry);
  }

  return {
    // `ids` order is the page's order; the map preserves it
    entries: ids.map((id) => byGesture.get(id)).filter((e): e is ActivityEntry => Boolean(e)),
    total: count.total,
    totalIsExact: count.exact,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Which events the firm has switched off, joined to what they are.
 *
 * A row with no registry entry is a key a later build removed; it is returned rather than hidden,
 * because a switch for an event nothing writes is exactly the kind of quiet lie this module exists
 * to end. The screen shows it as unknown and offers to forget it.
 */
export async function policies() {
  const rows = await repo.listPolicies();
  return rows.map((row) => ({
    action: row.action,
    enabled: row.enabled,
    known: isActivityKey(row.action),
    spec: isActivityKey(row.action) ? ACTIVITY_EVENTS[row.action] : null,
  }));
}

export async function setPolicy(action: string, enabled: boolean) {
  if (!isActivityKey(action)) throw new NotFoundError("No such activity event");
  const before = (await repo.listPolicies()).find((p) => p.action === action);
  const row = await repo.setPolicy(action, enabled);
  // the reader caches for thirty seconds; a switch the firm just flipped must take now
  invalidateActivityPolicy();
  if (before?.enabled !== enabled) {
    record("settings.activity_switched", {
      subjectLabel: action,
      changes: { enabled: { from: before?.enabled ?? null, to: enabled } },
    });
  }
  return { action: row.action, enabled: row.enabled };
}
