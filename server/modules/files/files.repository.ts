import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ForbiddenError } from "../../core/errors.js";
import type { StoredFile } from "../../core/files.js";
import type { FileTotals } from "@shared/schema/files.js";

/**
 * All of the library's database access (files.md §14.2). The tree is an adjacency list; subtrees,
 * breadcrumbs and folder totals are `WITH RECURSIVE`, repeating the scope at every level so the
 * scope indexes serve them.
 */

type Tx = Prisma.TransactionClient;

// ── the places, as filters (files.md §4.3) ───────────────────────────────────

export const inScope = (scope: string): Prisma.FileWhereInput => ({ scope, deletedAt: null });

/** Files on the firm's internal tasks: tasks with neither a client nor a lead (owner, 2026-09-14). */
export const internalTaskFiles: Prisma.FileWhereInput = {
  deletedAt: null,
  task: { is: { clientId: null, leadId: null } },
};

/**
 * A client's files, or every client's: its zones and its tasks' files, while it is not archived
 * (§4.4). A filed attachment is one row, counted once.
 */
export function clientFiles(clientId?: string): Prisma.FileWhereInput {
  return {
    deletedAt: null,
    clientId: clientId ?? { not: null },
    OR: [{ space: "client" }, { taskId: { not: null } }],
    client: { is: { archivedAt: null } },
  };
}

// ── totals: read when asked, never stored (§4.4) ─────────────────────────────

export async function totals(where: Prisma.FileWhereInput): Promise<FileTotals> {
  const r = await prisma.file.aggregate({
    where,
    _count: { _all: true },
    _sum: { size: true },
  });
  return { files: r._count._all, bytes: Number(r._sum.size ?? 0) };
}

export async function totalsByClient(): Promise<Map<string, FileTotals>> {
  const rows = await prisma.file.groupBy({
    by: ["clientId"],
    where: clientFiles(),
    _count: { _all: true },
    _sum: { size: true },
  });
  return new Map(
    rows
      .filter((r) => r.clientId !== null)
      .map((r) => [
        r.clientId as string,
        { files: r._count._all, bytes: Number(r._sum.size ?? 0) },
      ]),
  );
}

export async function totalsByZone(clientId: string): Promise<Map<string, FileTotals>> {
  const rows = await prisma.file.groupBy({
    by: ["zone"],
    where: { clientId, space: "client", deletedAt: null },
    _count: { _all: true },
    _sum: { size: true },
  });
  return new Map(
    rows.map((r) => [
      String(r.zone),
      { files: r._count._all, bytes: Number(r._sum.size ?? 0) },
    ]),
  );
}

export function countFiledAttachments(clientId: string) {
  return prisma.file.count({
    where: { clientId, taskId: { not: null }, scope: { not: null }, deletedAt: null },
  });
}

/**
 * Every live folder of a place with the files below it, subfolders included (§14.2). `sum` comes
 * back as a bigint and is read with `Number()`: `::int` would overflow on a folder above 2 GiB.
 */
export async function folderTotals(scope: string): Promise<Map<string, FileTotals>> {
  const rows = await prisma.$queryRaw<{ id: string; files: number; bytes: bigint | number }[]>`
    WITH RECURSIVE tree AS (
      SELECT f.id AS root, f.id FROM "Folder" f WHERE f.scope = ${scope} AND f."deletedAt" IS NULL
      UNION ALL
      SELECT t.root, c.id FROM tree t
      JOIN "Folder" c ON c."parentId" = t.id AND c.scope = ${scope} AND c."deletedAt" IS NULL
    )
    SELECT t.root AS id, count(x.id)::int AS files, coalesce(sum(x.size), 0)::bigint AS bytes
    FROM tree t
    LEFT JOIN "File" x ON x."folderId" = t.id AND x.scope = ${scope} AND x."deletedAt" IS NULL
    GROUP BY t.root
  `;
  return new Map(rows.map((r) => [r.id, { files: Number(r.files), bytes: Number(r.bytes) }]));
}

// ── clients ──────────────────────────────────────────────────────────────────

const clientSelect = { id: true, code: true, firstName: true, lastName: true } as const;

export function liveClients() {
  return prisma.client.findMany({ where: { archivedAt: null }, select: clientSelect });
}

export function findLiveClient(id: string) {
  return prisma.client.findFirst({ where: { id, archivedAt: null }, select: clientSelect });
}

/** Many clients' names at once: a page of search hits reads them in one query, never per row. */
export function clientsByIds(ids: string[]) {
  return prisma.client.findMany({ where: { id: { in: ids } }, select: clientSelect });
}

// ── search (§13) ─────────────────────────────────────────────────────────────

export const SEARCH_PAGE = 50;

/** A page of files, newest first; one more than a page, so the caller knows whether one follows. */
export function searchFiles(where: Prisma.FileWhereInput, page: number) {
  return prisma.file.findMany({
    where,
    select: fileSelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: page * SEARCH_PAGE,
    take: SEARCH_PAGE + 1,
  });
}

/** Folders whose names match, on the first page only and at most twenty. */
export function searchFolders(where: Prisma.FolderWhereInput) {
  return prisma.folder.findMany({
    where,
    select: folderSelect,
    orderBy: { name: "asc" },
    take: 20,
  });
}

// ── folders ──────────────────────────────────────────────────────────────────

const folderSelect = {
  id: true,
  name: true,
  scope: true,
  parentId: true,
  createdAt: true,
  deletedAt: true,
  createdBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.FolderSelect;

export type FolderRecord = Prisma.FolderGetPayload<{ select: typeof folderSelect }>;

export function liveFolders(scope: string) {
  return prisma.folder.findMany({
    where: { scope, deletedAt: null },
    select: folderSelect,
    orderBy: { name: "asc" },
  });
}

export function childFolders(scope: string, parentId: string | null) {
  return prisma.folder.findMany({
    where: { scope, parentId, deletedAt: null },
    select: folderSelect,
    orderBy: { name: "asc" },
  });
}

export function findFolder(id: string) {
  return prisma.folder.findUnique({ where: { id }, select: folderSelect });
}

export function findFolders(ids: string[]) {
  return prisma.folder.findMany({ where: { id: { in: ids } }, select: folderSelect });
}

/** A folder and the folders above it, the one under the fixed level first. */
export async function ancestry(folderId: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; depth: number }[]>`
    WITH RECURSIVE up AS (
      SELECT id, name, "parentId", 0 AS depth FROM "Folder" WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT p.id, p.name, p."parentId", up.depth + 1 FROM "Folder" p JOIN up ON p.id = up."parentId"
    )
    SELECT id, name, depth FROM up ORDER BY depth DESC
  `;
  return rows.map(({ id, name }) => ({ id, name }));
}

/** The same for many folders in one query: each one's chain of names, the top one first. */
export async function ancestries(folderIds: string[]): Promise<Map<string, string[]>> {
  const rows = await prisma.$queryRaw<{ start: string; name: string; depth: number }[]>`
    WITH RECURSIVE up AS (
      SELECT id AS start, id, name, "parentId", 0 AS depth
      FROM "Folder" WHERE id = ANY (${folderIds}::uuid[])
      UNION ALL
      SELECT up.start, p.id, p.name, p."parentId", up.depth + 1
      FROM "Folder" p JOIN up ON p.id = up."parentId"
    )
    SELECT start, name, depth FROM up ORDER BY start, depth DESC
  `;
  const chains = new Map<string, string[]>();
  for (const row of rows) {
    const chain = chains.get(row.start) ?? [];
    chain.push(row.name);
    chains.set(row.start, chain);
  }
  return chains;
}

/** Every folder from these down, trashed ones included, with its path of names from its top. */
export function subtree(folderIds: string[]) {
  return prisma.$queryRaw<{ id: string; top: string; depth: number; path: string[] }[]>`
    WITH RECURSIVE tree AS (
      SELECT id, id AS top, 0 AS depth, ARRAY[name]::text[] AS path
      FROM "Folder" WHERE id = ANY (${folderIds}::uuid[])
      UNION ALL
      SELECT c.id, t.top, t.depth + 1, t.path || c.name
      FROM tree t JOIN "Folder" c ON c."parentId" = t.id
    )
    SELECT id, top, depth, path FROM tree
  `;
}

export async function takenFolderNames(
  scope: string,
  parentId: string | null,
  except?: string,
) {
  const rows = await prisma.folder.findMany({
    where: { scope, parentId, deletedAt: null, ...(except ? { id: { not: except } } : {}) },
    select: { name: true },
  });
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

// ── files ────────────────────────────────────────────────────────────────────

const fileSelect = {
  id: true,
  name: true,
  size: true,
  mime: true,
  detectedMime: true,
  createdAt: true,
  scope: true,
  space: true,
  zone: true,
  folderId: true,
  clientId: true,
  taskId: true,
  deletedAt: true,
  uploadedBy: { select: { firstName: true, lastName: true } },
  task: { select: { id: true, title: true, clientId: true, leadId: true, archivedAt: true } },
} satisfies Prisma.FileSelect;

export type FileRecord = Prisma.FileGetPayload<{ select: typeof fileSelect }>;

export function filesIn(scope: string, folderId: string | null) {
  return prisma.file.findMany({
    where: { scope, folderId, deletedAt: null },
    select: fileSelect,
    orderBy: { name: "asc" },
  });
}

export function findFile(id: string) {
  return prisma.file.findUnique({
    where: { id },
    select: { ...fileSelect, path: true, storage: true, wrappedKey: true, keyVersion: true },
  });
}

export function findFiles(ids: string[]) {
  return prisma.file.findMany({ where: { id: { in: ids } }, select: fileSelect });
}

/** The files sitting in these folders, trashed ones included. */
export function filesUnder(folderIds: string[]) {
  return prisma.file.findMany({ where: { folderId: { in: folderIds } }, select: fileSelect });
}

export async function takenFileNames(scope: string, folderId: string | null, except?: string) {
  const rows = await prisma.file.findMany({
    where: { scope, folderId, deletedAt: null, ...(except ? { id: { not: except } } : {}) },
    select: { name: true },
  });
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export function clientAttachmentFiles(clientId: string) {
  return prisma.file.findMany({
    where: { clientId, taskId: { not: null }, deletedAt: null },
    select: fileSelect,
    orderBy: { createdAt: "desc" },
  });
}

export function internalAttachmentFiles() {
  return prisma.file.findMany({
    where: internalTaskFiles,
    select: fileSelect,
    orderBy: { createdAt: "desc" },
  });
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * **A write into somebody's My files first takes a share lock on their row** (files.md §8.3), and
 * refuses once they are no longer active. Blocking moves My files into Company in the status
 * change's own transaction; an upload racing it waits here and then sees the new status, rather
 * than landing in a space nobody can reach.
 */
async function ownerStillHere(tx: Tx, ownerId: string) {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM "User" WHERE id = ${ownerId}::uuid AND status = 'active' FOR SHARE
  `;
  if (rows.length === 0) throw new ForbiddenError("These personal files are no longer open");
}

export function createFile(
  data: StoredFile & {
    name: string;
    size: number;
    mime: string;
    detectedMime: string | null;
    uploadedById: string;
    scope: string;
    folderId: string | null;
  },
  ownerId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    if (ownerId) await ownerStillHere(tx, ownerId);
    return tx.file.create({ data, select: fileSelect });
  });
}

// ── stage C's backfill: the files stored before types were read (§12.2, §15.1) ──

/** The library's and the cards' files with no type read yet, a page at a time, by id. */
export function untypedFiles(afterId: string | null, take: number) {
  return prisma.file.findMany({
    where: {
      detectedMime: null,
      OR: [{ scope: { not: null } }, { taskId: { not: null } }, { clientId: { not: null } }],
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take,
    select: {
      id: true,
      name: true,
      size: true,
      path: true,
      storage: true,
      wrappedKey: true,
      keyVersion: true,
    },
  });
}

export function setDetectedMime(id: string, detectedMime: string) {
  return prisma.file.update({ where: { id }, data: { detectedMime }, select: { id: true } });
}

export function createFolder(
  data: { name: string; scope: string; parentId: string | null; createdById: string },
  ownerId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    if (ownerId) await ownerStillHere(tx, ownerId);
    return tx.folder.create({ data, select: folderSelect });
  });
}

// ── the system's own moves: a leaver's My files, a lead's files (§8.3, §5.6) ──

/** What a person's My files holds: its live files, the Trash's, and its folders. Never a name. */
export async function personalContents(db: Tx, ownerId: string) {
  const scope = `personal:${ownerId}`;
  const live = await db.file.aggregate({
    where: { scope, deletedAt: null },
    _count: { _all: true },
    _sum: { size: true },
  });
  const trashed = await db.file.count({ where: { scope, deletedAt: { not: null } } });
  const folders = await db.folder.count({ where: { scope } });
  return { files: live._count._all, bytes: Number(live._sum.size ?? 0), trashed, folders };
}

/** The same figures, outside any transaction: the Block dialog's. */
export function personalSummary(ownerId: string) {
  return personalContents(prisma, ownerId);
}

/**
 * **Blocking moves the whole of a person's My files into Company** (§8.3), in the status change's
 * own transaction, after the status has changed: a new folder at Company's root, then the two root
 * levels re-parented into it. Every row below follows through the composite keys' `ON UPDATE
 * CASCADE`, the Trash's included, and the trigger rewrites each row's copied columns. The depth
 * limit does not apply. Nothing to move, nothing made: null.
 */
export async function movePersonalIntoCompany(
  tx: Tx,
  ownerId: string,
  pickName: (taken: ReadonlySet<string>) => string,
  createdById: string,
) {
  const scope = `personal:${ownerId}`;
  const held = await personalContents(tx, ownerId);
  if (held.files + held.trashed + held.folders === 0) return null;
  // among live Company-root folders only: a trashed one of the same name does not count
  const roots = await tx.folder.findMany({
    where: { scope: "company", parentId: null, deletedAt: null },
    select: { name: true },
  });
  const name = pickName(new Set(roots.map((f) => f.name.toLowerCase())));
  // a folder of the same name made at the same moment fails the unique index here, and the whole
  // block with it; the admin presses Block again
  const folder = await tx.folder.create({
    data: { name, scope: "company", parentId: null, createdById },
    select: { id: true, name: true },
  });
  await tx.$executeRaw`
    UPDATE "Folder" SET scope = 'company', "parentId" = ${folder.id}::uuid
    WHERE scope = ${scope} AND "parentId" IS NULL
  `;
  await tx.$executeRaw`
    UPDATE "File" SET scope = 'company', "folderId" = ${folder.id}::uuid
    WHERE scope = ${scope} AND "folderId" IS NULL
  `;
  return { folderId: folder.id, folderName: folder.name, ...held };
}

/**
 * **A lead's task files, filed into its new client's Internal** (§5.6), in the conversion's own
 * transaction: oldest first, a name already taken there becoming `(2)`. `taskId` stays, so they
 * stay on the lead's tasks as well; the trigger gives each row its client.
 */
export async function fileLeadTaskFiles(
  tx: Tx,
  leadId: string,
  clientId: string,
  pickName: (name: string, taken: ReadonlySet<string>) => string,
) {
  const scope = `client:${clientId}:internal`;
  const files = await tx.file.findMany({
    where: { task: { is: { leadId } }, scope: null, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, task: { select: { title: true } } },
  });
  if (files.length === 0) return [];
  const there = await tx.file.findMany({
    where: { scope, folderId: null, deletedAt: null },
    select: { name: true },
  });
  const taken = new Set(there.map((f) => f.name.toLowerCase()));
  const filed: { id: string; name: string; task: string }[] = [];
  for (const f of files) {
    const name = pickName(f.name, taken);
    taken.add(name.toLowerCase());
    await tx.file.update({ where: { id: f.id }, data: { scope, folderId: null, name } });
    filed.push({ id: f.id, name, task: f.task?.title ?? "a task" });
  }
  return filed;
}

// ── the firm's storage, for Settings → System (§4.4) ─────────────────────────

/**
 * **Every stored file, by where it sits in the firm.** Figures only, and firm-wide on purpose: they
 * ignore who may see what, which is why their route is an admin's.
 */
export async function firmStorage() {
  const [all, mine, company, clients, archivedClients, unfiled, trash, branding, byStore] =
    await Promise.all([
      totals({}),
      totals({ space: "personal", deletedAt: null }),
      totals({ space: "company", deletedAt: null }),
      totals({ space: "client", deletedAt: null }),
      totals({
        space: "client",
        deletedAt: null,
        client: { is: { archivedAt: { not: null } } },
      }),
      totals({ scope: null, taskId: { not: null }, deletedAt: null }),
      totals({ deletedAt: { not: null } }),
      totals({
        OR: [
          { avatarOfUser: { isNot: null } },
          { logoOfProfile: { isNot: null } },
          { mailLogoOfProfile: { isNot: null } },
        ],
      }),
      prisma.file.groupBy({ by: ["storage"], _count: { _all: true }, _sum: { size: true } }),
    ]);
  const kept = (storage: "local" | "s3"): FileTotals => {
    const row = byStore.find((r) => r.storage === storage);
    return { files: row?._count._all ?? 0, bytes: Number(row?._sum.size ?? 0) };
  };
  return {
    all,
    parts: { mine, company, clients, archivedClients, unfiled, trash, branding },
    where: { bucket: kept("s3"), disk: kept("local") },
  };
}

export function renameFolder(id: string, name: string) {
  return prisma.folder.update({ where: { id }, data: { name }, select: folderSelect });
}

export function renameFile(id: string, name: string) {
  return prisma.file.update({ where: { id }, data: { name }, select: fileSelect });
}

/** File to folder: the same row gains a place, and keeps its task (files.md §5.3). */
export function fileInto(id: string, scope: string, folderId: string | null, name: string) {
  return prisma.file.update({
    where: { id },
    data: { scope, folderId, name },
    select: fileSelect,
  });
}

export interface MovePlan {
  toScope: string;
  toFolderId: string | null;
  folders: string[];
  files: { id: string; name: string }[];
  /** off their tasks first: these files, and every file sitting in these folders */
  detachFiles: string[];
  detachUnder: string[];
  ownerId: string | null;
}

/**
 * **One transaction for the whole selection** (files.md §7.3). The detaching comes first, because
 * a file on a task may never stand in My files (the CHECK `File_attachment_not_personal`). The
 * folders are one UPDATE of their own rows: the composite keys carry the new scope to every row
 * below them, trashed ones included, and the trigger fixes their copies.
 */
export function applyMove(plan: MovePlan) {
  return prisma.$transaction(
    async (tx) => {
      if (plan.ownerId) await ownerStillHere(tx, plan.ownerId);
      if (plan.detachUnder.length > 0) {
        await tx.file.updateMany({
          where: { folderId: { in: plan.detachUnder }, taskId: { not: null } },
          data: { taskId: null },
        });
      }
      if (plan.detachFiles.length > 0) {
        await tx.file.updateMany({
          where: { id: { in: plan.detachFiles } },
          data: { taskId: null },
        });
      }
      // one statement for every folder: they all take the same new place, and none is renamed,
      // since a folder's name clash is refused before the move rather than given `(2)`
      if (plan.folders.length > 0) {
        await tx.folder.updateMany({
          where: { id: { in: plan.folders } },
          data: { scope: plan.toScope, parentId: plan.toFolderId },
        });
      }
      for (const f of plan.files) {
        await tx.file.update({
          where: { id: f.id },
          data: { scope: plan.toScope, folderId: plan.toFolderId, name: f.name },
        });
      }
    },
    { timeout: 30_000 },
  );
}

// ── the Trash (files.md §9) ──────────────────────────────────────────────────

const trashFileSelect = {
  ...fileSelect,
  trashBatchId: true,
  deletedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.FileSelect;

export type TrashedFileRecord = Prisma.FileGetPayload<{ select: typeof trashFileSelect }>;

const trashFolderSelect = {
  ...folderSelect,
  trashBatchId: true,
  deletedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.FolderSelect;

export type TrashedFolderRecord = Prisma.FolderGetPayload<{ select: typeof trashFolderSelect }>;

/**
 * **Who sees what in the Trash: each item by its place's rule** (§9, §4.3). Their own My files and
 * Company; a client's items and its tasks' files while Clients is open and the client is not
 * archived; a lead's task files, and an internal task's that are not filed, while Tasks is open.
 */
export function trashedFilesSeen(
  ownerId: string,
  clients: boolean,
  tasks: boolean,
): Prisma.FileWhereInput {
  const places: Prisma.FileWhereInput[] = [
    { scope: `personal:${ownerId}` },
    { scope: "company" },
  ];
  if (clients) {
    places.push(
      { space: "client", client: { is: { archivedAt: null } } },
      { scope: null, clientId: { not: null }, client: { is: { archivedAt: null } } },
    );
  }
  if (tasks) {
    places.push(
      { scope: null, clientId: null, task: { is: { leadId: { not: null } } } },
      { scope: null, clientId: null, task: { is: { clientId: null, leadId: null } } },
    );
  }
  return { deletedAt: { not: null }, OR: places };
}

export function trashedFoldersSeen(ownerId: string, clients: boolean): Prisma.FolderWhereInput {
  const places: Prisma.FolderWhereInput[] = [
    { scope: `personal:${ownerId}` },
    { scope: "company" },
  ];
  if (clients) places.push({ space: "client", client: { is: { archivedAt: null } } });
  return { deletedAt: { not: null }, OR: places };
}

/** The newest gestures a reader sees, newest first: the Trash is paged by gesture (§9). */
export async function trashBatches(
  files: Prisma.FileWhereInput,
  folders: Prisma.FolderWhereInput,
  before: Date | undefined,
  take: number,
): Promise<{ batchId: string; at: Date }[]> {
  const older = before ? { deletedAt: { lt: before } } : {};
  const [fromFiles, fromFolders] = await Promise.all([
    prisma.file.groupBy({
      by: ["trashBatchId"],
      where: { AND: [files, older] },
      _max: { deletedAt: true },
      orderBy: { _max: { deletedAt: "desc" } },
      take,
    }),
    prisma.folder.groupBy({
      by: ["trashBatchId"],
      where: { AND: [folders, older] },
      _max: { deletedAt: true },
      orderBy: { _max: { deletedAt: "desc" } },
      take,
    }),
  ]);
  const at = new Map<string, Date>();
  for (const row of [...fromFiles, ...fromFolders]) {
    const when = row._max.deletedAt;
    if (!row.trashBatchId || !when) continue;
    const seen = at.get(row.trashBatchId);
    if (!seen || seen < when) at.set(row.trashBatchId, when);
  }
  return [...at]
    .map(([batchId, when]) => ({ batchId, at: when }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, take);
}

export function trashedFiles(where: Prisma.FileWhereInput) {
  return prisma.file.findMany({ where, select: trashFileSelect });
}

export function trashedFolders(where: Prisma.FolderWhereInput) {
  return prisma.folder.findMany({ where, select: trashFolderSelect });
}

/** Every live folder from these down, themselves included. No live item has a trashed parent. */
export async function liveFoldersUnder(folderIds: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM "Folder" WHERE id = ANY (${folderIds}::uuid[]) AND "deletedAt" IS NULL
      UNION ALL
      SELECT c.id FROM tree t JOIN "Folder" c ON c."parentId" = t.id AND c."deletedAt" IS NULL
    )
    SELECT id FROM tree
  `;
  return rows.map((r) => r.id);
}

export interface TrashPlan {
  batchId: string;
  at: Date;
  by: string;
  /** every live folder of the gesture: the chosen ones and everything live below them */
  folders: string[];
  files: string[];
}

/**
 * **One gesture, one transaction, and nothing else changes** (§9): the three columns are set, and
 * every link, place and name stays, so a restore is clearing them again.
 */
export function applyTrash(plan: TrashPlan) {
  const data = { deletedAt: plan.at, deletedById: plan.by, trashBatchId: plan.batchId };
  return prisma.$transaction(async (tx) => {
    if (plan.folders.length > 0) {
      await tx.folder.updateMany({
        where: { id: { in: plan.folders }, deletedAt: null },
        data,
      });
      await tx.file.updateMany({
        where: { folderId: { in: plan.folders }, deletedAt: null },
        data,
      });
    }
    if (plan.files.length > 0) {
      await tx.file.updateMany({ where: { id: { in: plan.files }, deletedAt: null }, data });
    }
  });
}

/** The live folder a restored item goes back into: its own, or the nearest live one above it. */
export async function nearestLiveFolder(folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const rows = await prisma.$queryRaw<{ id: string; live: boolean; depth: number }[]>`
    WITH RECURSIVE up AS (
      SELECT id, "parentId", "deletedAt" IS NULL AS live, 0 AS depth
      FROM "Folder" WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT p.id, p."parentId", p."deletedAt" IS NULL, up.depth + 1
      FROM "Folder" p JOIN up ON p.id = up."parentId"
    )
    SELECT id, live, depth FROM up ORDER BY depth ASC
  `;
  return rows.find((r) => r.live)?.id ?? null;
}

/** What went into the Trash with these folders, in the same gesture, below them. */
export async function batchMatesUnder(folderIds: string[], batchId: string) {
  if (folderIds.length === 0)
    return { folders: [] as string[], files: [] as TrashedFileRecord[] };
  const tree = (await subtree(folderIds)).map((r) => r.id);
  const [folders, files] = await Promise.all([
    prisma.folder.findMany({
      where: { id: { in: tree, notIn: folderIds }, trashBatchId: batchId },
      select: { id: true },
    }),
    prisma.file.findMany({
      where: { folderId: { in: tree }, trashBatchId: batchId },
      select: trashFileSelect,
    }),
  ]);
  return { folders: folders.map((f) => f.id), files };
}

export function batchFiles(batchId: string) {
  return prisma.file.findMany({ where: { trashBatchId: batchId }, select: trashFileSelect });
}

export function batchFolders(batchId: string) {
  return prisma.folder.findMany({
    where: { trashBatchId: batchId },
    select: trashFolderSelect,
  });
}

export interface RestorePlan {
  folders: { id: string; parentId: string | null; name: string }[];
  files: { id: string; folderId: string | null; name: string }[];
  /** below the restored folders, from the same gesture */
  mates: { folders: string[]; files: string[] };
  ownerId: string | null;
}

/** Folders first, so nothing restored ever stands under a folder still in the Trash (§9). */
export function applyRestore(plan: RestorePlan) {
  const clear = { deletedAt: null, deletedById: null, trashBatchId: null };
  return prisma.$transaction(
    async (tx) => {
      if (plan.ownerId) await ownerStillHere(tx, plan.ownerId);
      for (const f of plan.folders) {
        await tx.folder.update({
          where: { id: f.id },
          data: { ...clear, parentId: f.parentId, name: f.name },
        });
      }
      if (plan.mates.folders.length > 0) {
        await tx.folder.updateMany({ where: { id: { in: plan.mates.folders } }, data: clear });
      }
      for (const f of plan.files) {
        await tx.file.update({
          where: { id: f.id },
          data: { ...clear, folderId: f.folderId, name: f.name },
        });
      }
      if (plan.mates.files.length > 0) {
        await tx.file.updateMany({ where: { id: { in: plan.mates.files } }, data: clear });
      }
    },
    { timeout: 30_000 },
  );
}

// ── the nightly purge ────────────────────────────────────────────────────────

const purgeSelect = {
  ...trashFileSelect,
  path: true,
  storage: true,
} satisfies Prisma.FileSelect;

/** The oldest gestures first, at most `take` files (§9). */
export function dueFiles(cutoff: Date, take: number) {
  return prisma.file.findMany({
    where: { deletedAt: { lt: cutoff } },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take,
    select: purgeSelect,
  });
}

export function countDueFiles(cutoff: Date) {
  return prisma.file.count({ where: { deletedAt: { lt: cutoff } } });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}

/**
 * Due folders that nothing points at any more. Both keys are RESTRICT, so the caller repeats this
 * until it removes none, which takes the deepest first.
 */
export async function purgeEmptyFolders(cutoff: Date): Promise<number> {
  const leaves = await prisma.folder.findMany({
    where: { deletedAt: { lt: cutoff }, children: { none: {} }, files: { none: {} } },
    select: { id: true },
  });
  if (leaves.length === 0) return 0;
  const { count } = await prisma.folder.deleteMany({
    where: { id: { in: leaves.map((l) => l.id) } },
  });
  return count;
}

/** A client's name whether or not it is archived: the purge names what it removes (§9). */
export function findClientAnyState(id: string) {
  return prisma.client.findUnique({ where: { id }, select: clientSelect });
}
