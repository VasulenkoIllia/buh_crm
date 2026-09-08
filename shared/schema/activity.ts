import { z } from "zod";
import { uuid } from "./common.js";

/**
 * **What the activity screen asks for, and what it gets back.**
 *
 * The four filters are the four indexes (activity-log.md §5.2) plus the one this build added:
 * who · what happened to · which client · what kind of action · when. A filter with no index behind
 * it is a promise the table cannot keep at 200k rows a year, so the two lists are deliberately the
 * same list.
 */
export const activityQuery = z.object({
  /** "everything Olena did" */
  actorUserId: uuid.optional(),
  /** "everything that happened to Petrenko" — the subject's own row */
  subject: z.string().max(40).optional(),
  subjectId: uuid.optional(),
  /** "everything that concerns this client", across every subject (the client card's tab) */
  clientId: uuid.optional(),
  /** one registry key — "every file download" */
  action: z.string().max(80).optional(),
  /** a whole group of subjects — the screen opens on these */
  group: z.string().max(20).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** free text over the snapshotted labels — the actor's name or the subject's */
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ActivityQuery = z.infer<typeof activityQuery>;

export const activityRow = z.object({
  id: uuid,
  action: z.string(),
  subject: z.string(),
  subjectId: uuid.nullable(),
  subjectLabel: z.string().nullable(),
  clientId: uuid.nullable(),
  /** the client's name as it read when this happened — "whose", which a uuid cannot answer */
  clientLabel: z.string().nullable(),
  changes: z.unknown().nullable(),
  outcome: z.enum(["ok", "refused", "failed"]),
  refusalCode: z.string().nullable(),
  method: z.string().nullable(),
  route: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});
export type ActivityRow = z.infer<typeof activityRow>;

/**
 * **One gesture, one entry.** Saving a client edits the client, reconciles two companies and
 * touches a subscription; the owner's requirement is that the screen shows who did what, not a wall
 * of rows (§6). So the API groups by `correlationId` and the screen expands.
 *
 * The whole gesture comes back, not only the rows that matched the filter: an entry that showed
 * three of its five changes because two were filtered out would be a worse answer than either.
 */
export const activityEntry = z.object({
  correlationId: uuid,
  occurredAt: z.iso.datetime(),
  actorKind: z.enum(["user", "client", "system"]),
  actorUserId: uuid.nullable(),
  actorLabel: z.string(),
  ip: z.string().nullable(),
  rows: z.array(activityRow),
});
export type ActivityEntry = z.infer<typeof activityEntry>;

export const activityPage = z.object({
  entries: z.array(activityEntry),
  total: z.number().int(),
  /**
   * False when `total` is a ceiling rather than a count. An exact total of a two-year log costs a
   * scan of every matching gesture on every page load; a pager needs to know where it is and
   * whether there is more, so past the ceiling the screen says "2000+" (see `countGestures`).
   */
  totalIsExact: z.boolean(),
  /**
   * Whether another page exists — read from one extra row of THIS page, never from `total`.
   * `total` is capped, and a Next button derived from a ceiling stops at the ceiling.
   */
  hasMore: z.boolean(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ActivityPage = z.infer<typeof activityPage>;

export const setActivityPolicyInput = z.object({ enabled: z.boolean() });
