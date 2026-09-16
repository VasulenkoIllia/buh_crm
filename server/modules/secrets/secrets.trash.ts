/**
 * **The Trash** (secrets.md §9). Every delete goes here, and nothing else about the row changes: a
 * mistake is undone rather than paid for, which is why deleting stopped costing the viewer's
 * password (decision 4, 2026-09-15).
 *
 * A delete is ONE gesture. The three columns are set together, the batch id ties them, and both the
 * card's Undo and the Trash's "Restore all" work on that batch. After thirty days the nightly job
 * removes the rows for good and records each one: that record is the firm's disposal evidence, and
 * it is the reason the journal keeps its label snapshot.
 */
import type { User } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { NotFoundError } from "../../core/errors.js";
import * as repo from "./secrets.repository.js";
import { placesSeenBy } from "./secrets.search.js";

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How many gestures the Trash lists, newest first. It is not paged: thirty days of a firm's deletes
 * fit well inside this, and every one of them must stay restorable from the screen (audit,
 * 2026-09-16, when it was 30 and an older gesture could not be reached).
 */
const SHOWN = 500;

const personName = (who: { firstName: string; lastName: string } | null) =>
  who ? `${who.firstName} ${who.lastName}`.trim() : "somebody";

/**
 * **What this reader may see in the Trash** (§4.3, §9): their own My secrets, Company, and the
 * clients they can open. A colleague's My secrets are not here, and neither is an archived client's
 * list — the Trash shows each item by the rule of the place it came from.
 */
export async function trashWhere(user: User): Promise<Prisma.SecretWhereInput> {
  return seenFilter(user);
}

async function seenFilter(user: User): Promise<Prisma.SecretWhereInput> {
  return { deletedAt: { not: null }, OR: await placesSeenBy(user) };
}

/** A place in the words the Trash shows beside each item. */
function placeWords(
  row: { space: string; clientId: string | null },
  clients: Map<string, string>,
): string {
  if (row.space === "personal") return "My secrets";
  if (row.space === "company") return "Company";
  return `Clients › ${(row.clientId && clients.get(row.clientId)) || "a client"}`;
}

export interface TrashBatch {
  batchId: string;
  deletedAt: string;
  deletedBy: string;
  daysLeft: number;
  items: { id: string; label: string; template: string; place: string }[];
}

/** The Trash, grouped by the gesture that filled it, newest first. */
export async function trashList(
  user: User,
  now = new Date(),
): Promise<{ batches: TrashBatch[] }> {
  const seen = await seenFilter(user);
  const groups = await repo.trashBatches(seen, SHOWN);
  const batchIds = groups.flatMap((g) => (g.trashBatchId ? [g.trashBatchId] : []));
  if (batchIds.length === 0) return { batches: [] };

  const rows = await repo.trashedSecrets(seen, batchIds);
  const clients = await repo.clientLabels([
    ...new Set(rows.flatMap((r) => (r.clientId ? [r.clientId] : []))),
  ]);

  const batches = batchIds.flatMap((batchId) => {
    const mine = rows.filter((r) => r.trashBatchId === batchId);
    if (mine.length === 0) return [];
    const first = mine[0];
    const deletedAt = first.deletedAt ?? now;
    return [
      {
        batchId,
        deletedAt: deletedAt.toISOString(),
        deletedBy: personName(first.deletedBy),
        // what is left of the thirty days, which is the only number that matters here
        daysLeft: Math.max(
          0,
          TRASH_DAYS - Math.floor((now.getTime() - deletedAt.getTime()) / DAY_MS),
        ),
        items: mine.map((r) => ({
          id: r.id,
          label: r.label,
          template: r.template,
          place: placeWords(r, clients),
        })),
      },
    ];
  });
  return { batches };
}

async function restore(
  user: User,
  what: Prisma.SecretWhereInput,
  ip: string | null,
): Promise<{ restored: number }> {
  const seen = await seenFilter(user);
  const rows = await repo.findTrashed(seen, what);
  if (rows.length === 0) throw new NotFoundError("That is not in the Trash any more");

  await repo.applyRestore(rows.map((r) => r.id));
  await repo.writeAudits(
    rows.map((row) => ({
      secretId: row.id,
      clientId: row.clientId,
      byUserId: user.id,
      action: "restored" as const,
      label: row.label,
      ip,
    })),
  );
  for (const row of rows) {
    record("secret.restored", {
      subjectId: row.id,
      // My secrets keep their neutral name in the log, here as everywhere (§11)
      subjectLabel: row.space === "personal" ? "a personal secret" : row.label,
      clientId: row.clientId ?? undefined,
    });
  }
  return { restored: rows.length };
}

/** Undo, and the Trash's "Restore all": one gesture, put back as it went. */
export const restoreBatch = (batchId: string, user: User, ip: string | null) =>
  restore(user, { trashBatchId: batchId }, ip);

/** One item out of a gesture, leaving the rest where they are. */
export const restoreSecret = (secretId: string, user: User, ip: string | null) =>
  restore(user, { id: secretId }, ip);

/**
 * **Thirty days later** (§9). The rows go; the journal stays, because `SecretAuditLog.secretId` is
 * `SetNull` and every row carries the label it described. `secret.purged` is the disposal record,
 * kept long: it is what answers "what happened to that credential" a year afterwards.
 *
 * It ignores archiving: a client's list is hidden when they are archived, and hidden is not kept.
 */
export async function purgeTrash(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - TRASH_DAYS * DAY_MS);
  const due = await repo.dueSecrets(cutoff);
  if (due.length === 0) return { note: "nothing was due" };

  const clients = await repo.clientLabels([
    ...new Set(due.flatMap((r) => (r.clientId ? [r.clientId] : []))),
  ]);
  await repo.deleteSecrets(due.map((r) => r.id));

  for (const row of due) {
    record("secret.purged", {
      subjectId: row.id,
      subjectLabel: row.space === "personal" ? "a personal secret" : row.label,
      clientId: row.clientId ?? undefined,
      changes: { from: placeWords(row, clients) },
    });
  }
  const one = due.length === 1;
  return { note: `${due.length} secret${one ? "" : "s"} removed for good` };
}
