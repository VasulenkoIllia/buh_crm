import { ACTIVITY_EVENTS, isActivityKey } from "@shared/activity.js";
import type { ActivityEntry, ActivityPage, ActivityQuery } from "@shared/schema/activity.js";
import { NotFoundError } from "../../core/errors.js";
import { invalidateActivityPolicy } from "../../core/activity.js";
import * as repo from "./activity.repository.js";

/**
 * **The log, read back as gestures rather than rows** (activity-log.md §6, §12).
 *
 * The screen renders every sentence from `shared/activity.ts`, so this service returns facts and no
 * prose: an event's title and its group live in the registry, which both ends read. That is what
 * keeps a new event a constant rather than a constant plus a switch statement in here.
 */
export async function list(query: ActivityQuery): Promise<ActivityPage> {
  const ids = await repo.findGestureIds(query);
  const [rows, total] = await Promise.all([repo.findRowsFor(ids), repo.countGestures(query)]);

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
    total,
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
  const row = await repo.setPolicy(action, enabled);
  // the reader caches for thirty seconds; a switch the firm just flipped must take now
  invalidateActivityPolicy();
  return { action: row.action, enabled: row.enabled };
}
