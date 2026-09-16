/** All Prisma access for the vault (see the repository rule in eslint.config.js). */
import type { SecretTemplate } from "@shared/schema/secrets.js";
import type { Prisma, SecretAuditAction } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ForbiddenError } from "../../core/errors.js";
import type { SealedSecret } from "../../core/secrets-crypto.js";

type Tx = Prisma.TransactionClient;

/**
 * What the search reads (secrets.md §10): the open words of a secret, lower-cased, written on every
 * save. The title, the description and the template's OPEN fields — never a secret field, which is
 * the rule a test proves by searching for a stored password and finding nothing.
 */
export const searchTextOf = (
  label: string,
  description: string | null,
  fields: Record<string, string> = {},
) =>
  // a card's last four are open, to tell two cards apart in a list, but the search never reads a
  // number of that kind (§3.2)
  [
    label,
    description ?? "",
    ...Object.entries(fields).flatMap(([k, v]) => (k === "last4" ? [] : [v])),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The open fields as they come back from a Json column: strings only, and never null. */
export function openFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * **A place is a value on the row** (secrets.md §4.1), so there is no tree and no cascade: a list is
 * one `where`, and a move is one `UPDATE`. The fixed nodes are drawn by the screen, which is why no
 * code path can delete, rename or empty them.
 */
export type Place =
  | { space: "personal"; ownerId: string }
  | { space: "company" }
  | { space: "client"; clientId: string };

export const placeWhere = (place: Place): Prisma.SecretWhereInput =>
  place.space === "personal"
    ? { space: "personal", ownerId: place.ownerId }
    : place.space === "company"
      ? { space: "company" }
      : { space: "client", clientId: place.clientId };

/** The three columns a place sets, and the two it clears. */
export const placeColumns = (place: Place) => ({
  space: place.space,
  ownerId: place.space === "personal" ? place.ownerId : null,
  clientId: place.space === "client" ? place.clientId : null,
});

/** Whose My secrets a place is, when it is anybody's. */
export const ownerOf = (place: Place) => (place.space === "personal" ? place.ownerId : null);

/**
 * **A write into somebody's My secrets first takes a share lock on their row** (secrets.md §8), and
 * refuses once they are no longer active. Blocking moves My secrets into Company in the status
 * change's own transaction; a save racing it waits here and then sees the new status, rather than
 * landing in a list nobody can reach. The same guard as My files (files.md §8.3).
 */
async function ownerStillHere(tx: Tx, ownerId: string) {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM "User" WHERE id = ${ownerId}::uuid AND status = 'active' FOR SHARE
  `;
  if (rows.length === 0) throw new ForbiddenError("These personal secrets are no longer open");
}

/** `write`, behind the guard for every My secrets it touches; with none, straight through. */
function guarded<T>(owners: (string | null)[], write: (db: Tx) => Promise<T>): Promise<T> {
  const ids = [...new Set(owners.filter((o): o is string => !!o))].sort();
  if (ids.length === 0) return write(prisma);
  return prisma.$transaction(async (tx) => {
    for (const id of ids) await ownerStillHere(tx, id);
    return write(tx);
  });
}

export function clientExists(clientId: string) {
  return prisma.client
    .findFirst({ where: { id: clientId, archivedAt: null }, select: { id: true } })
    .then(Boolean);
}

/**
 * Labels for a client's list. The crypto columns are NOT selected — the only place they leave the
 * database is `findSecret`, which one audited endpoint calls. Trashed secrets are never here.
 */
export function listSecrets(place: Place) {
  return prisma.secret.findMany({
    where: { ...placeWhere(place), deletedAt: null },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      template: true,
      label: true,
      description: true,
      fields: true,
      updatedAt: true,
      movedFromName: true,
      // presence only — enough to tell a real secret from a pointer-only entry
      ciphertext: true,
      createdBy: { select: { firstName: true, lastName: true } },
      updatedBy: { select: { firstName: true, lastName: true } },
    },
  });
}

export function findSecret(place: Place, id: string) {
  return prisma.secret.findFirst({ where: { id, ...placeWhere(place), deletedAt: null } });
}

export function createSecret(data: {
  place: Place;
  template: SecretTemplate;
  label: string;
  description: string | null;
  fields: Record<string, string>;
  sealed: SealedSecret | null;
  createdById: string;
}) {
  return guarded([ownerOf(data.place)], (db) =>
    db.secret.create({
      data: {
        ...placeColumns(data.place),
        template: data.template,
        label: data.label,
        description: data.description,
        fields: data.fields,
        searchText: searchTextOf(data.label, data.description, data.fields),
        ciphertext: data.sealed ? Buffer.from(data.sealed.ciphertext) : null,
        iv: data.sealed ? Buffer.from(data.sealed.iv) : null,
        authTag: data.sealed ? Buffer.from(data.sealed.authTag) : null,
        keyVersion: data.sealed?.keyVersion ?? 1,
        createdById: data.createdById,
      },
      select: { id: true },
    }),
  );
}

export function updateSecret(
  place: Place,
  id: string,
  data: {
    label: string;
    description: string | null;
    fields: Record<string, string>;
    sealed: SealedSecret | null | undefined;
    updatedById: string;
  },
) {
  let crypto: Prisma.SecretUpdateInput = {}; // `undefined` = leave the stored value alone
  if (data.sealed === null) {
    crypto = { ciphertext: null, iv: null, authTag: null }; // becomes a pointer-only entry
  } else if (data.sealed) {
    crypto = {
      ciphertext: Buffer.from(data.sealed.ciphertext),
      iv: Buffer.from(data.sealed.iv),
      authTag: Buffer.from(data.sealed.authTag),
      keyVersion: data.sealed.keyVersion,
    };
  }
  return guarded([ownerOf(place)], (db) =>
    db.secret.update({
      where: { id },
      data: {
        label: data.label,
        description: data.description,
        fields: data.fields,
        searchText: searchTextOf(data.label, data.description, data.fields),
        updatedBy: { connect: { id: data.updatedById } },
        ...crypto,
      },
      select: { id: true },
    }),
  );
}

/** The rows a move names, in the place it says they are. Fewer back means one of them is not. */
export function findInPlace(place: Place, ids: string[]) {
  return prisma.secret.findMany({
    where: { id: { in: ids }, ...placeWhere(place), deletedAt: null },
    select: { id: true, label: true, space: true, movedFromName: true },
  });
}

/**
 * **A move is one statement** (secrets.md §7): there are no folders, so nothing cascades and the
 * ciphertext is not touched — the key is the same in every place. A secret that leaves Company also
 * drops the badge a leaver's move put on it (§8).
 */
export function applyMove(ids: string[], from: Place, to: Place) {
  return guarded([ownerOf(from), ownerOf(to)], (db) =>
    db.secret.updateMany({
      where: { id: { in: ids }, ...placeWhere(from), deletedAt: null },
      data: {
        ...placeColumns(to),
        ...(from.space === "company" ? { movedFromName: null } : {}),
      },
    }),
  );
}

/** A client's name for the log, so a move reads "Clients › Petrenko Olena" rather than a uuid. */
export async function clientLabel(clientId: string): Promise<string | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { firstName: true, lastName: true, companyName: true },
  });
  if (!client) return null;
  return (
    client.companyName || `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || null
  );
}

/**
 * **A delete is a move to the Trash** (secrets.md §9): three columns, set together, and nothing
 * else about the row changes. The gesture's id is what Undo and a batch restore work on in stage B.
 */
export function trashSecret(place: Place, id: string, deletedById: string, batchId: string) {
  return guarded([ownerOf(place)], (db) =>
    db.secret.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById, trashBatchId: batchId },
      select: { id: true },
    }),
  );
}

// ── the tree's own reads (secrets.md §4) ─────────────────────────────────────

/** How many live secrets sit in a place. The Trash is counted by its own filter. */
export function countWhere(where: Prisma.SecretWhereInput) {
  return prisma.secret.count({ where });
}

/** Every client whose list exists, which is every client that is not archived. */
export function liveClients() {
  return prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, code: true, firstName: true, lastName: true, companyName: true },
    orderBy: [{ companyName: "asc" }, { firstName: "asc" }, { lastName: "asc" }],
  });
}

/** Several at once, as one gesture: one batch id, so Undo and the Trash see them together. */
export function trashMany(place: Place, ids: string[], deletedById: string, batchId: string) {
  return guarded([ownerOf(place)], (db) =>
    db.secret.updateMany({
      where: { id: { in: ids }, ...placeWhere(place), deletedAt: null },
      data: { deletedAt: new Date(), deletedById, trashBatchId: batchId },
    }),
  );
}

// ── a leaver's My secrets (secrets.md §8) ────────────────────────────────────

/** What a person's My secrets holds, the Trash's included: the Block dialog's one figure. */
export function personalCount(ownerId: string) {
  return prisma.secret.count({ where: { space: "personal", ownerId } });
}

/**
 * **Blocking moves the whole of a person's My secrets into Company** (§8), in the status change's
 * own transaction, after the status has changed: one statement, the Trash's included, each row
 * marked with whose it was. There are no folders, so the mark is the badge and the filter. The
 * rows are read first, in the same transaction, so the journal can name each one afterwards.
 */
export async function movePersonalIntoCompany(tx: Tx, ownerId: string, movedFromName: string) {
  const rows = await tx.secret.findMany({
    where: { space: "personal", ownerId },
    select: { id: true, label: true, deletedAt: true },
  });
  if (rows.length === 0) return null;
  await tx.secret.updateMany({
    where: { space: "personal", ownerId },
    data: { space: "company", ownerId: null, clientId: null, movedFromName },
  });
  return rows;
}

// ── the search and one secret's History (secrets.md §10, §11) ────────────────

/** Newest first, capped: a firm holds hundreds of secrets, not thousands. */
export function searchSecrets(where: Prisma.SecretWhereInput, take: number) {
  return prisma.secret.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      template: true,
      label: true,
      description: true,
      fields: true,
      ciphertext: true,
      updatedAt: true,
      space: true,
      clientId: true,
    },
  });
}

/** Live clients a query names, the first ten: the way to one that holds no secrets yet. */
export function searchClients(where: Prisma.ClientWhereInput, take: number) {
  return prisma.client.findMany({
    where: { AND: [{ archivedAt: null }, where] },
    select: { id: true, code: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take,
  });
}

/** How many secrets each of those clients holds, in one query. */
export async function countByClient(ids: string[]): Promise<Map<string, number>> {
  const rows = await prisma.secret.groupBy({
    by: ["clientId"],
    where: { space: "client", deletedAt: null, clientId: { in: ids } },
    _count: { _all: true },
  });
  return new Map(
    rows.flatMap((r) =>
      r.clientId ? ([[r.clientId, r._count._all]] as [string, number][]) : [],
    ),
  );
}

/** Is this secret one the reader may see at all? The place is inside `seen`. */
export function findVisible(seen: Prisma.SecretWhereInput, id: string) {
  return prisma.secret.findFirst({ where: { AND: [seen, { id }] }, select: { id: true } });
}

/** A secret's own journal rows, newest first: who stored it, looked at it, changed it. */
export function historyOf(secretId: string) {
  return prisma.secretAuditLog.findMany({
    where: { secretId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      action: true,
      createdAt: true,
      byUser: { select: { firstName: true, lastName: true } },
    },
  });
}

// ── the Trash (secrets.md §9) ────────────────────────────────────────────────

/** Each delete as it happened, newest first: who, when, and how many went together. */
export function trashBatches(seen: Prisma.SecretWhereInput, take: number) {
  return prisma.secret.groupBy({
    by: ["trashBatchId"],
    where: seen,
    _max: { deletedAt: true },
    _count: { _all: true },
    orderBy: { _max: { deletedAt: "desc" } },
    take,
  });
}

export function trashedSecrets(seen: Prisma.SecretWhereInput, batchIds: string[]) {
  return prisma.secret.findMany({
    where: { AND: [seen, { trashBatchId: { in: batchIds } }] },
    orderBy: [{ deletedAt: "desc" }, { label: "asc" }],
    select: {
      id: true,
      label: true,
      template: true,
      space: true,
      clientId: true,
      trashBatchId: true,
      deletedAt: true,
      deletedBy: { select: { firstName: true, lastName: true } },
    },
  });
}

/** The rows a restore names, but only the ones this reader may see (§4.3). */
export function findTrashed(seen: Prisma.SecretWhereInput, what: Prisma.SecretWhereInput) {
  return prisma.secret.findMany({
    where: { AND: [seen, what] },
    select: { id: true, label: true, space: true, clientId: true },
  });
}

/** Out of the Trash: the three columns are cleared together, as they were set together. */
export function applyRestore(ids: string[]) {
  return prisma.secret.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: null, deletedById: null, trashBatchId: null },
  });
}

/**
 * Everything past its thirty days, oldest first. No cap: these are database rows rather than
 * objects in a bucket, so a big clean-up costs one statement and needs no nights to drain (§9).
 */
export function dueSecrets(cutoff: Date) {
  return prisma.secret.findMany({
    where: { deletedAt: { lt: cutoff } },
    orderBy: { deletedAt: "asc" },
    select: { id: true, label: true, space: true, clientId: true, template: true },
  });
}

export function deleteSecrets(ids: string[]) {
  return prisma.secret.deleteMany({ where: { id: { in: ids } } });
}

/** Client names for the places a Trash page or a purge names, in one query. */
export async function clientLabels(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, companyName: true },
  });
  return new Map(
    rows.map((c) => [
      c.id,
      c.companyName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "a client",
    ]),
  );
}

type AuditEntry = {
  secretId: string | null;
  /** null for Company, My secrets and an unlock: the vault is wider than one client */
  clientId: string | null;
  byUserId: string;
  action: SecretAuditAction;
  /** snapshot of the secret's name — the FK goes null once the secret is purged */
  label: string | null;
  ip: string | null;
};

export function writeAudit(entry: AuditEntry) {
  return prisma.secretAuditLog.create({ data: entry, select: { id: true } });
}

/** One act on a selection is one statement in the journal, however many secrets it names. */
export function writeAudits(entries: AuditEntry[]) {
  return prisma.secretAuditLog.createMany({ data: entries });
}

export async function listAudit(clientId: string, page: number, pageSize: number) {
  const [items, total] = await Promise.all([
    prisma.secretAuditLog.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        action: true,
        label: true,
        createdAt: true,
        secret: { select: { label: true } },
        byUser: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.secretAuditLog.count({ where: { clientId } }),
  ]);
  return { items, total };
}

/**
 * Did this user already look at this secret a moment ago? Opening the edit form reveals the value
 * too, so a few clicks used to leave a run of identical rows a second apart — one look told seven
 * times (user, 2026-08-03). One row per look is the useful record.
 */
export function recentReveal(secretId: string, byUserId: string, since: Date) {
  return prisma.secretAuditLog
    .findFirst({
      where: { secretId, byUserId, action: "revealed", createdAt: { gte: since } },
      select: { id: true },
    })
    .then(Boolean);
}
