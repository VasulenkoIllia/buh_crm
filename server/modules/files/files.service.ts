import { Prisma, type User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import {
  clientText,
  clientWord,
  codeOf,
  containing,
  wordsOf,
} from "../../core/client-search.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { MAX_FILE_SIZE, deleteStoredFile, storeFile } from "../../core/files.js";
import { clientLabel, personName } from "../../core/names.js";
import { MAX_TEXT_BYTES } from "@shared/library.js";
import {
  CLIENT_VISIBLE_ZONES,
  ZONE_LABEL,
  type AttachmentGroup,
  type ClientFilesDetail,
  type ClientFilesNode,
  type EnsuredFolder,
  type FileRow,
  type FileTotals,
  type FileZone,
  type FilesOverview,
  type FolderListing,
  type FolderNode,
  type FolderRow,
  type MoveInput,
  type MoveResult,
  type SearchCrumb,
  type SearchHit,
  type SearchPage,
  type SearchQuery,
  type SearchWhere,
} from "@shared/schema/files.js";
import { opens, readerOf, requireOpen, requireReadable } from "./files.access.js";
import * as names from "./files.names.js";
import * as repo from "./files.repository.js";
import { NOT_VIEWABLE } from "./files.serve.js";
import { detectType, viewOf } from "./files.types.js";

/**
 * **The library** (files.md §4–§7): places, folders, uploads, names, moves and File to folder.
 * The Trash is `files.trash.ts`, which builds on the helpers exported here.
 */

const ZERO: FileTotals = { files: 0, bytes: 0 };
/** How a My files item is named in the log: never by its name (files.md §10.3). */
export const PERSONAL_FILE = "a personal file";
export const PERSONAL_FOLDER = "a personal folder";
export const MY_FILES = "My files";

// ── places ───────────────────────────────────────────────────────────────────

export type Place =
  | { space: "personal"; ownerId: string }
  | { space: "company" }
  | { space: "client"; clientId: string; zone: FileZone; clientName: string };

export const COMPANY: Place = { space: "company" };

export function myPlace(user: Pick<User, "id">): Place {
  return { space: "personal", ownerId: user.id };
}

/** The part of the library a route stands in: a person's My files, Company, or one client. */
export type Area =
  { kind: "mine"; userId: string } | { kind: "company" } | { kind: "client"; clientId: string };

export const COMPANY_AREA: Area = { kind: "company" };

export function myArea(user: Pick<User, "id">): Area {
  return { kind: "mine", userId: user.id };
}

export function clientArea(clientId: string): Area {
  return { kind: "client", clientId };
}

function scopeOf(place: Place): string {
  switch (place.space) {
    case "personal":
      return `personal:${place.ownerId}`;
    case "company":
      return "company";
    case "client":
      return `client:${place.clientId}:${place.zone}`;
  }
}

/** Another person's My files and an archived client's folders answer "not found" (§11.1). */
export function inArea(scope: string | null, area: Area): scope is string {
  if (!scope) return false;
  switch (area.kind) {
    case "mine":
      return scope === `personal:${area.userId}`;
    case "company":
      return scope === "company";
    case "client":
      return scope.startsWith(`client:${area.clientId}:`);
  }
}

async function liveClient(clientId: string) {
  const client = await repo.findLiveClient(clientId);
  // an archived client's files go dark with the client (decision 8)
  if (!client) throw new NotFoundError("Client not found");
  return client;
}

export async function clientPlace(clientId: string, zone: FileZone): Promise<Place> {
  const client = await liveClient(clientId);
  return { space: "client", clientId, zone, clientName: clientLabel(client) };
}

export async function placeOfScope(scope: string): Promise<Place> {
  if (scope === "company") return COMPANY;
  const [space, id, zone] = scope.split(":");
  if (space === "personal") return { space: "personal", ownerId: id };
  return clientPlace(id, zone as FileZone);
}

const sameClient = (a: Place, b: Place) =>
  a.space === "client" && b.space === "client" && a.clientId === b.clientId;

/** Putting a file here is showing it to the client, once the portal opens (§4.2). */
export const clientSees = (p: Place) =>
  p.space === "client" && CLIENT_VISIBLE_ZONES.includes(p.zone);

/** A place in the words the log and the screen use. My files is never named deeper. */
async function words(
  place: Place,
  folderId: string | null,
  withClient = true,
): Promise<string> {
  if (place.space === "personal") return MY_FILES;
  const chain = folderId ? (await repo.ancestry(folderId)).map((f) => f.name) : [];
  const head =
    place.space === "company"
      ? ["Company"]
      : withClient
        ? [place.clientName, ZONE_LABEL[place.zone]]
        : [ZONE_LABEL[place.zone]];
  return [...head, ...chain].join(" › ");
}

async function liveFolderIn(place: Place, folderId: string | null | undefined) {
  if (!folderId) return null;
  const folder = await repo.findFolder(folderId);
  if (!folder || folder.deletedAt || folder.scope !== scopeOf(place)) {
    throw new NotFoundError("Folder not found");
  }
  return folder;
}

export function asNameConflict(error: unknown, message: string): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    ? new ConflictError(message)
    : error;
}

function fileRow(f: repo.FileRecord, showTask: boolean): FileRow {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt?.toISOString() ?? null,
    uploadedBy: personName(f.uploadedBy),
    task: showTask && f.task ? { id: f.task.id, title: f.task.title } : null,
    view: viewOf(f.detectedMime),
  };
}

// ── search (files.md §13) ────────────────────────────────────────────────────

const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];
const TEXT_TYPES = ["text/plain", "text/csv"];
const SHOWN_TYPES = ["application/pdf", ...IMAGE_TYPES, ...TEXT_TYPES];

// How a person names a client, and a code as they type it, now shared with the vault:
// `core/client-search.ts` (files.md §13, secrets.md §10, §20.4).

/**
 * A file with every word somewhere in its details, each in any of them: its name, its folder's,
 * the uploader's, the client's name or code, the task's title. So "Olena Petrenko" finds her files
 * and "Petrenko W-2" her W-2.
 */
function fileText(q: string): Prisma.FileWhereInput {
  const code = codeOf(q);
  const word = (w: string): Prisma.FileWhereInput => ({
    OR: [
      { name: containing(w) },
      {
        uploadedBy: { is: { OR: [{ firstName: containing(w) }, { lastName: containing(w) }] } },
      },
      { client: { is: clientWord(w) } },
      { task: { is: { title: containing(w) } } },
      { folder: { is: { name: containing(w) } } },
    ],
  });
  return {
    OR: [{ AND: wordsOf(q).map(word) }, ...(code ? [{ client: { is: { code } } }] : [])],
  };
}

/** The first ten live clients a query names, each with what its folders hold (files.md §13). */
async function clientMatches(q: string): Promise<ClientFilesNode[]> {
  const rows = await repo.searchClients(clientText(q));
  if (rows.length === 0) return [];
  return nodesOf(rows, await repo.totalsByClient(rows.map((c) => c.id)));
}

function fileType(type: NonNullable<SearchQuery["type"]>): Prisma.FileWhereInput {
  switch (type) {
    case "pdf":
      return { detectedMime: "application/pdf" };
    case "image":
      return { detectedMime: { in: IMAGE_TYPES } };
    case "text":
      return { detectedMime: { in: TEXT_TYPES } };
    case "other":
      return { OR: [{ detectedMime: null }, { detectedMime: { notIn: SHOWN_TYPES } }] };
  }
}

function whereOf(
  scope: string | null,
  folderId: string | null,
  task: { clientId: string | null; leadId: string | null } | null,
): SearchWhere {
  if (!scope) {
    if (task?.clientId) return { kind: "attachments", clientId: task.clientId };
    return task?.leadId ? { kind: "task" } : { kind: "attachments", clientId: null };
  }
  if (scope === "company") return { kind: "place", place: { space: "company" }, folderId };
  if (scope.startsWith("personal:")) {
    return { kind: "place", place: { space: "personal" }, folderId };
  }
  const [, clientId, zone] = scope.split(":");
  return {
    kind: "place",
    place: { space: "client", clientId, zone: zone as FileZone },
    folderId,
  };
}

/**
 * **One box over names and details, never inside a file** (§13.1). What the reader may see sits
 * inside the query (§11.3), so a page and its "more" are right, and the Trash is never searched:
 * their own My files and Company; with Clients open, every live client's zones and its tasks'
 * files; with Tasks open, the internal and lead tasks' files in no folder. Paths are read in one
 * batch per page, never per row.
 */
export async function search(user: User, query: SearchQuery): Promise<SearchPage> {
  const reader = await readerOf(user);
  const clientsOpen = opens(reader, "clients");
  const tasksOpen = opens(reader, "tasks");
  const mine = `personal:${user.id}`;
  const liveClient = { is: { archivedAt: null } };

  const seen: Prisma.FileWhereInput[] = [{ scope: mine }, { scope: "company" }];
  if (clientsOpen) {
    seen.push({ space: "client", client: liveClient });
    seen.push({ scope: null, task: { is: { clientId: { not: null } } }, client: liveClient });
  }
  if (tasksOpen) seen.push({ scope: null, task: { is: { clientId: null } } });

  const inSpace: Record<NonNullable<SearchQuery["space"]>, Prisma.FileWhereInput> = {
    my: { scope: mine },
    company: { scope: "company" },
    clients: {
      OR: [{ space: "client" }, { scope: null, task: { is: { clientId: { not: null } } } }],
    },
  };
  const q = query.q;
  const rows = await repo.searchFiles(
    {
      AND: [
        { deletedAt: null },
        { OR: seen },
        ...(q ? [fileText(q)] : []),
        ...(query.space ? [inSpace[query.space]] : []),
        ...(query.type ? [fileType(query.type)] : []),
      ],
    },
    query.page,
  );
  const files = rows.slice(0, repo.SEARCH_PAGE);

  // folders by name, on the first page, when no file type narrows the search
  const folderSeen: Prisma.FolderWhereInput[] = [{ scope: mine }, { scope: "company" }];
  if (clientsOpen) folderSeen.push({ space: "client", client: liveClient });
  const folderSpace: Record<NonNullable<SearchQuery["space"]>, Prisma.FolderWhereInput> = {
    my: { scope: mine },
    company: { scope: "company" },
    clients: { space: "client" },
  };
  const folders =
    q && !query.type && query.page === 0
      ? await repo.searchFolders({
          AND: [
            { deletedAt: null },
            { OR: folderSeen },
            { AND: wordsOf(q).map((w) => ({ name: containing(w) })) },
            ...(query.space ? [folderSpace[query.space]] : []),
          ],
        })
      : [];

  // clients by a name or a code, on the first page, with Clients open (§13): the way to a client
  // whose files are few, or none
  const clients =
    q &&
    clientsOpen &&
    !query.type &&
    query.page === 0 &&
    (!query.space || query.space === "clients")
      ? await clientMatches(q)
      : [];

  // every path on the page in two queries: the folder chains, and the clients' names
  const chainIds = [
    ...new Set([
      ...files.flatMap((f) => (f.scope && f.folderId ? [f.folderId] : [])),
      ...folders.flatMap((f) => (f.parentId ? [f.parentId] : [])),
    ]),
  ];
  const chains =
    chainIds.length > 0
      ? await repo.folderChains(chainIds)
      : new Map<string, { id: string; name: string }[]>();
  const clientIds = [
    ...new Set([
      ...files.flatMap((f) => (f.clientId ? [f.clientId] : [])),
      ...folders.flatMap((f) => (f.scope.startsWith("client:") ? [f.scope.split(":")[1]] : [])),
    ]),
  ];
  const clientNames = new Map(
    (clientIds.length > 0 ? await repo.clientsByIds(clientIds) : []).map((c) => [
      c.id,
      clientLabel(c),
    ]),
  );

  // each step of a path with where it leads (§13): the place, the client, each folder down to it
  const crumbsOf = (
    where: SearchWhere,
    parentId: string | null,
    taskTitle?: string,
  ): SearchCrumb[] => {
    if (where.kind === "task") {
      return [
        { label: "A lead's task", to: null },
        { label: taskTitle ?? "a task", to: null },
      ];
    }
    if (where.kind === "attachments") {
      return where.clientId
        ? [
            { label: "Clients", to: { type: "clients" } },
            {
              label: clientNames.get(where.clientId) ?? "a client",
              to: { type: "client", clientId: where.clientId },
            },
            { label: "Attachments", to: { type: "attachments", clientId: where.clientId } },
          ]
        : [
            {
              label: "Company",
              to: { type: "place", place: { space: "company" }, folderId: null },
            },
            { label: "Attachments", to: { type: "attachments", clientId: null } },
          ];
    }
    const place = where.place;
    const root: SearchCrumb["to"] = { type: "place", place, folderId: null };
    let head: SearchCrumb[];
    if (place.space === "personal") head = [{ label: MY_FILES, to: root }];
    else if (place.space === "company") head = [{ label: "Company", to: root }];
    else {
      head = [
        { label: "Clients", to: { type: "clients" } },
        {
          label: clientNames.get(place.clientId) ?? "a client",
          to: { type: "client", clientId: place.clientId },
        },
        { label: ZONE_LABEL[place.zone], to: root },
      ];
    }
    const chain = parentId ? (chains.get(parentId) ?? []) : [];
    return [
      ...head,
      ...chain.map((f): SearchCrumb => ({
        label: f.name,
        to: { type: "place", place, folderId: f.id },
      })),
    ];
  };
  const pathOf = (crumbs: SearchCrumb[]) => crumbs.map((c) => c.label).join(" › ");

  const hits: SearchHit[] = [
    ...folders.map((f): SearchHit => {
      const at = whereOf(f.scope, f.parentId, null);
      const crumbs = crumbsOf(at, f.parentId);
      return {
        kind: "folder",
        id: f.id,
        name: f.name,
        where: at.kind === "place" ? { ...at, folderId: f.id } : at,
        path: pathOf(crumbs),
        crumbs,
        size: 0,
        updatedAt: null,
        createdAt: f.createdAt.toISOString(),
        uploadedBy: f.createdBy ? personName(f.createdBy) : "",
        view: null,
        task: null,
      };
    }),
    ...files.map((f): SearchHit => {
      const at = whereOf(f.scope, f.folderId, f.task);
      const crumbs = crumbsOf(at, f.scope ? f.folderId : null, f.task?.title);
      return {
        kind: "file",
        id: f.id,
        name: f.name,
        where: at,
        path: pathOf(crumbs),
        crumbs,
        size: f.size,
        updatedAt: f.updatedAt?.toISOString() ?? null,
        createdAt: f.createdAt.toISOString(),
        uploadedBy: personName(f.uploadedBy),
        view: viewOf(f.detectedMime),
        task: tasksOpen && f.task ? { id: f.task.id, title: f.task.title } : null,
      };
    }),
  ];
  return { hits, more: rows.length > repo.SEARCH_PAGE, clients };
}

// ── the tree ─────────────────────────────────────────────────────────────────

/** The fixed nodes' totals, and "All files" at the top: what this reader can see (§4.4). */
export async function overview(user: User): Promise<FilesOverview> {
  const reader = await readerOf(user);
  const tasks = opens(reader, "tasks");
  const clients = opens(reader, "clients");
  const mine = repo.inScope(`personal:${user.id}`);
  const company = repo.inScope("company");
  const [mineTotals, companyTotals, companyAttachments, clientTotals, all, trash] =
    await Promise.all([
      repo.totals(mine),
      repo.totals(company),
      tasks ? repo.totals(repo.internalTaskFiles) : null,
      clients ? repo.totals(repo.clientFiles()) : null,
      repo.totals({
        OR: [
          mine,
          company,
          ...(tasks ? [repo.internalTaskFiles] : []),
          ...(clients ? [repo.clientFiles()] : []),
        ],
      }),
      // the Trash's own total, by the same rule as its list; it counts in no folder's (§4.4)
      repo.totals(repo.trashedFilesSeen(user.id, clients, tasks)),
    ]);
  return {
    all,
    mine: mineTotals,
    company: companyTotals,
    companyAttachments,
    clients: clientTotals,
    trash,
  };
}

/** Clients as the library lists them, by name, each with what its folders hold. */
function nodesOf(
  clients: Awaited<ReturnType<typeof repo.liveClients>>,
  byClient: Map<string, FileTotals>,
): ClientFilesNode[] {
  return clients
    .map((c) => ({
      id: c.id,
      label: clientLabel(c),
      code: c.code,
      totals: byClient.get(c.id) ?? ZERO,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function clientNodes(): Promise<ClientFilesNode[]> {
  const [clients, byClient] = await Promise.all([repo.liveClients(), repo.totalsByClient()]);
  return nodesOf(clients, byClient);
}

export async function clientDetail(clientId: string): Promise<ClientFilesDetail> {
  const client = await liveClient(clientId);
  const [byZone, total, attachments, filed] = await Promise.all([
    repo.totalsByZone(clientId),
    repo.totals(repo.clientFiles(clientId)),
    repo.totals({ clientId, taskId: { not: null }, deletedAt: null }),
    repo.countFiledAttachments(clientId),
  ]);
  return {
    id: client.id,
    label: clientLabel(client),
    code: client.code,
    totals: total,
    zones: {
      internal: byZone.get("internal") ?? ZERO,
      shared: byZone.get("shared") ?? ZERO,
      from_client: byZone.get("from_client") ?? ZERO,
    },
    attachments: { ...attachments, filed },
  };
}

/** Every live folder of a place, flat, each with its total (§18). */
export async function folderTree(place: Place): Promise<FolderNode[]> {
  const scope = scopeOf(place);
  const [folders, sums] = await Promise.all([
    repo.liveFolders(scope),
    repo.folderTotals(scope),
  ]);
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    parentId: f.parentId,
    totals: sums.get(f.id) ?? ZERO,
  }));
}

function folderRow(f: repo.FolderRecord, sums: Map<string, FileTotals>): FolderRow {
  return {
    id: f.id,
    name: f.name,
    createdAt: f.createdAt.toISOString(),
    createdBy: f.createdBy ? personName(f.createdBy) : null,
    totals: sums.get(f.id) ?? ZERO,
  };
}

/** The open folder: its subfolders with their totals, its files, and the path down to it. */
export async function list(
  place: Place,
  folderId: string | undefined,
  user: User,
): Promise<FolderListing> {
  const scope = scopeOf(place);
  const folder = await liveFolderIn(place, folderId);
  const at = folder?.id ?? null;
  const [crumbs, folders, files, sums, placeTotals] = await Promise.all([
    folder ? repo.ancestry(folder.id) : Promise.resolve([]),
    repo.childFolders(scope, at),
    repo.filesIn(scope, at),
    repo.folderTotals(scope),
    folder ? Promise.resolve(null) : repo.totals(repo.inScope(scope)),
  ]);
  // a filed internal task's file names its task only to a reader who may open Tasks
  const showTask = place.space !== "company" || opens(await readerOf(user), "tasks");
  return {
    folder: folder ? { id: folder.id, name: folder.name } : null,
    crumbs,
    folders: folders.map((f) => folderRow(f, sums)),
    files: files.map((f) => fileRow(f, showTask)),
    totals: folder ? (sums.get(folder.id) ?? ZERO) : (placeTotals ?? ZERO),
  };
}

// ── uploads (files.md §7.1, §14.3) ───────────────────────────────────────────

export interface Incoming {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

/** A file lands where it is dropped. A taken name becomes `(2)`; nothing is overwritten. */
export async function upload(
  place: Place,
  folderId: string | undefined,
  user: User,
  file: Incoming,
): Promise<FileRow> {
  const folder = await liveFolderIn(place, folderId);
  const name = names.uploadedFileName(file.filename);
  names.refuseProgram(name);
  if (file.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError("File must be 25 MB or smaller");
  }
  // what the bytes say it is: a renamed program is refused here too (§12.2, §14.3)
  const detectedMime = await detectType(file.buffer, name);
  const scope = scopeOf(place);
  const at = folder?.id ?? null;
  const finalName = names.firstFreeName(name, await repo.takenFileNames(scope, at));
  const stored = await storeFile(file.buffer);
  let row: repo.FileRecord;
  try {
    row = await repo.createFile(
      {
        ...stored,
        name: finalName,
        size: file.buffer.byteLength,
        mime: file.mimetype,
        detectedMime,
        uploadedById: user.id,
        scope,
        folderId: at,
      },
      place.space === "personal" ? place.ownerId : null,
    );
  } catch (error) {
    // nothing points at the bytes: take them back rather than leave them for the pruner
    await deleteStoredFile(stored).catch((e) =>
      console.error("files: could not remove the bytes of a refused upload", e),
    );
    // a race for the name (§6.3): the queue sends it again and gets the next `(n)`
    throw asNameConflict(
      error,
      `“${finalName}” arrived here at the same moment; send it again`,
    );
  }

  const where = await words(place, at);
  if (place.space === "client") {
    record("file.uploaded", {
      subjectId: row.id,
      subjectLabel: row.name,
      clientId: place.clientId,
      changes: { name: row.name, size: row.size, attachedTo: where },
    });
    if (clientSees(place)) {
      record("file.shared_with_client", {
        subjectId: row.id,
        subjectLabel: row.name,
        clientId: place.clientId,
        changes: { place: where },
      });
    }
  } else if (place.space === "company") {
    record("firm_file.uploaded", {
      subjectId: row.id,
      subjectLabel: row.name,
      changes: { name: row.name, size: row.size, place: where },
    });
  } else {
    record("firm_file.uploaded", {
      subjectId: row.id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  }
  return fileRow(row, false);
}

/**
 * A My files or Company file, for its download or view route. A client's go through the client
 * card's. A view of a file that does not open in the CRM is refused before anything is logged.
 */
export async function download(area: Area, fileId: string, via?: "view") {
  const file = await repo.findFile(fileId);
  if (!file || file.deletedAt || !inArea(file.scope, area)) {
    throw new NotFoundError("File not found");
  }
  if (via && !viewOf(file.detectedMime)) throw new ValidationError(NOT_VIEWABLE);
  // a read, recorded — for this one the read IS the act (activity-log.md §3.2). Every row says how:
  // a row with no change would be dropped as an empty diff, and a download must never be
  record("firm_file.downloaded", {
    subjectId: file.id,
    subjectLabel: area.kind === "mine" ? PERSONAL_FILE : file.name,
    changes: { via: via ?? "download" },
  });
  return file;
}

// ── folders and names (files.md §6.1, §6.3) ──────────────────────────────────

/**
 * **A folder upload's call for one directory** (files.md §7.2): the folder of that name under the
 * parent, made only when it is not there yet. The same answer however often it is asked, so the
 * browser sends one per directory and never asks first; two at the same moment get one folder.
 * Too deep is refused with the reason, as for a folder made by hand.
 */
export async function ensureFolder(
  place: Place,
  parentId: string | null,
  rawName: string,
  user: User,
): Promise<EnsuredFolder> {
  const name = names.folderName(rawName);
  const parent = await liveFolderIn(place, parentId);
  const find = async () =>
    (await repo.childFolders(scopeOf(place), parent?.id ?? null)).find(
      (f) => f.name.toLowerCase() === name.toLowerCase(),
    );
  const there = await find();
  if (there) return { id: there.id, name: there.name, created: false };
  try {
    const made = await createFolder(place, parentId, name, user);
    return { id: made.id, name: made.name, created: true };
  } catch (error) {
    // the same directory asked for twice at one moment: the other call made it
    if (error instanceof ConflictError) {
      const raced = await find();
      if (raced) return { id: raced.id, name: raced.name, created: false };
    }
    throw error;
  }
}

export async function createFolder(
  place: Place,
  parentId: string | null,
  rawName: string,
  user: User,
): Promise<FolderRow> {
  const name = names.folderName(rawName);
  const parent = await liveFolderIn(place, parentId);
  if (parent && (await repo.ancestry(parent.id)).length + 1 > names.MAX_DEPTH) {
    throw new ValidationError(`Folders go at most ${names.MAX_DEPTH} levels deep`);
  }
  const scope = scopeOf(place);
  const at = parent?.id ?? null;
  const taken = `A folder named “${name}” is already here`;
  if ((await repo.takenFolderNames(scope, at)).has(name.toLowerCase())) {
    throw new ConflictError(taken);
  }
  let folder: repo.FolderRecord;
  try {
    folder = await repo.createFolder(
      { name, scope, parentId: at, createdById: user.id },
      place.space === "personal" ? place.ownerId : null,
    );
  } catch (error) {
    throw asNameConflict(error, taken);
  }

  const where = await words(place, at);
  if (place.space === "client") {
    record("folder.created", {
      subjectId: folder.id,
      subjectLabel: folder.name,
      clientId: place.clientId,
      changes: { place: where },
    });
  } else {
    record("firm_folder.created", {
      subjectId: folder.id,
      subjectLabel: place.space === "personal" ? PERSONAL_FOLDER : folder.name,
      changes: { place: where },
    });
  }
  return folderRow(folder, new Map());
}

export async function renameFolder(area: Area, folderId: string, rawName: string) {
  const folder = await repo.findFolder(folderId);
  if (!folder || folder.deletedAt || !inArea(folder.scope, area)) {
    throw new NotFoundError("Folder not found");
  }
  const place = await placeOfScope(folder.scope);
  const name = names.folderName(rawName);
  if (name === folder.name) return { id: folder.id, name };
  // a folder renamed onto a name that is taken is refused, with the reason (§6.3)
  const taken = `A folder named “${name}” is already here`;
  if (
    (await repo.takenFolderNames(folder.scope, folder.parentId, folder.id)).has(
      name.toLowerCase(),
    )
  ) {
    throw new ConflictError(taken);
  }
  try {
    await repo.renameFolder(folder.id, name);
  } catch (error) {
    throw asNameConflict(error, taken);
  }
  const changes = { name: { from: folder.name, to: name } };
  if (place.space === "client") {
    record("folder.renamed", {
      subjectId: folder.id,
      subjectLabel: name,
      clientId: place.clientId,
      changes,
    });
  } else if (place.space === "company") {
    record("firm_folder.renamed", { subjectId: folder.id, subjectLabel: name, changes });
  } else {
    record("firm_folder.renamed", {
      subjectId: folder.id,
      subjectLabel: PERSONAL_FOLDER,
      changes: { place: MY_FILES },
    });
  }
  return { id: folder.id, name };
}

/**
 * A file renamed onto a name its folder already has is refused rather than given `(2)`: the person
 * typed the name, and silently changing it would not be what they asked for.
 */
export async function renameFile(area: Area, fileId: string, rawName: string) {
  const file = await repo.findFile(fileId);
  if (!file || file.deletedAt || !inArea(file.scope, area)) {
    throw new NotFoundError("File not found");
  }
  const place = await placeOfScope(file.scope);
  const name = names.typedFileName(rawName);
  names.refuseProgram(name);
  if (name === file.name) return { id: file.id, name };
  const taken = `A file named “${name}” is already here`;
  if ((await repo.takenFileNames(file.scope, file.folderId, file.id)).has(name.toLowerCase())) {
    throw new ConflictError(taken);
  }
  try {
    await repo.renameFile(file.id, name);
  } catch (error) {
    throw asNameConflict(error, taken);
  }
  const changes = { name: { from: file.name, to: name } };
  if (place.space === "client") {
    record("file.renamed", {
      subjectId: file.id,
      subjectLabel: name,
      clientId: place.clientId,
      changes,
    });
  } else if (place.space === "company") {
    record("firm_file.renamed", { subjectId: file.id, subjectLabel: name, changes });
  } else {
    record("firm_file.renamed", {
      subjectId: file.id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  }
  return { id: file.id, name };
}

// ── a text file made in the CRM (files.md §7.4) ──────────────────────────────

/** What the CRM makes and edits as text: what it can also show as text (§12.1). */
const TEXT_MIMES = ["text/plain", "text/csv"];

function textBytes(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    throw new ValidationError("A text file made here must be 1 MB or smaller");
  }
  return bytes;
}

/**
 * **A `.txt` made here, filled in and kept like any other file** (§7.4, decision 27). It goes
 * through the same store, so it is encrypted under its own key, and through the same names, so a
 * taken name gets "(2)". The bytes still decide the type (§12.2): text whose first bytes say it is
 * some other format is refused, rather than kept as a file that would never open.
 */
export async function createText(
  place: Place,
  folderId: string | undefined,
  user: User,
  input: { name: string; text: string },
): Promise<FileRow> {
  const folder = await liveFolderIn(place, folderId);
  const typed = names.typedFileName(input.name);
  const name = names.extensionOf(typed) === "txt" ? typed : `${typed}.txt`;
  const bytes = textBytes(input.text);
  const detectedMime = await detectType(bytes, name);
  if (detectedMime !== "text/plain") {
    throw new ValidationError("This text cannot be kept as a plain text file");
  }
  const scope = scopeOf(place);
  const at = folder?.id ?? null;
  const finalName = names.firstFreeName(name, await repo.takenFileNames(scope, at));
  const stored = await storeFile(bytes);
  let row: repo.FileRecord;
  try {
    row = await repo.createFile(
      {
        ...stored,
        name: finalName,
        size: bytes.byteLength,
        mime: detectedMime,
        detectedMime,
        uploadedById: user.id,
        scope,
        folderId: at,
      },
      place.space === "personal" ? place.ownerId : null,
    );
  } catch (error) {
    // nothing points at the bytes: take them back rather than leave them for the pruner
    await deleteStoredFile(stored).catch((e) =>
      console.error("files: could not remove the bytes of a refused text file", e),
    );
    throw asNameConflict(error, `“${finalName}” arrived here at the same moment; try again`);
  }

  const where = await words(place, at);
  if (place.space === "client") {
    record("file.created", {
      subjectId: row.id,
      subjectLabel: row.name,
      clientId: place.clientId,
      changes: { name: row.name, size: row.size, attachedTo: where },
    });
    if (clientSees(place)) {
      record("file.shared_with_client", {
        subjectId: row.id,
        subjectLabel: row.name,
        clientId: place.clientId,
        changes: { place: where },
      });
    }
  } else if (place.space === "company") {
    record("firm_file.created", {
      subjectId: row.id,
      subjectLabel: row.name,
      changes: { name: row.name, size: row.size, place: where },
    });
  } else {
    record("firm_file.created", {
      subjectId: row.id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  }
  return fileRow(row, false);
}

/**
 * **The text of a file that is already here, saved again** (§7.4, decision 28): any text file in
 * the library, uploaded or made here, where the reader may write.
 *
 * The save carries the version the editor opened. A row that has moved on since is refused rather
 * than overwritten, so two people editing cannot lose one another's work (decision 29). The new
 * bytes are stored first and the row is pointed at them; only then do the old bytes go, so a
 * failure in the middle leaves the file readable as it was.
 */
export async function saveText(
  area: Area,
  fileId: string,
  input: { text: string; updatedAt: string | null },
): Promise<FileRow> {
  const file = await repo.findFile(fileId);
  if (!file || file.deletedAt || !inArea(file.scope, area)) {
    throw new NotFoundError("File not found");
  }
  if (!TEXT_MIMES.includes(file.detectedMime ?? "")) {
    throw new ValidationError("Only a text file can be edited here");
  }
  // what the editor opened against what is here now: somebody else's save is not laid over
  const stale = new ConflictError(
    "Somebody saved this file a moment ago. Open it again and put your changes back in.",
  );
  if (input.updatedAt !== (file.updatedAt?.toISOString() ?? null)) throw stale;
  const bytes = textBytes(input.text);
  const detectedMime = await detectType(bytes, file.name);
  if (detectedMime !== file.detectedMime) {
    throw new ValidationError("This text cannot be kept as a plain text file");
  }
  // sealed under the row's own id, since that is what opens it again (§14.4)
  const stored = await storeFile(bytes, file.id);
  // and the write itself only lands while the row still points at the bytes just read, so two
  // saves at the same moment cannot both win
  const saved = await repo.replaceFileBytes(file.id, file.path, {
    ...stored,
    size: bytes.byteLength,
    detectedMime,
  });
  if (!saved) {
    await deleteStoredFile(stored).catch((e) =>
      console.error("files: could not remove the bytes of a save that was refused", e),
    );
    throw stale;
  }
  // the row points at the new bytes now, so the old ones are nobody's
  await deleteStoredFile(file).catch((e) =>
    console.error("files: could not remove the bytes a save replaced", e),
  );

  const place = await placeOfScope(file.scope);
  const changes = { name: saved.name, size: { from: file.size, to: saved.size } };
  if (place.space === "client") {
    record("file.edited", {
      subjectId: saved.id,
      subjectLabel: saved.name,
      clientId: place.clientId,
      changes,
    });
  } else if (place.space === "company") {
    record("firm_file.edited", { subjectId: saved.id, subjectLabel: saved.name, changes });
  } else {
    record("firm_file.edited", {
      subjectId: saved.id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  }
  return fileRow(saved, false);
}

// ── moves (files.md §6.2, §7.3) ──────────────────────────────────────────────

/**
 * **One selection, from one place, into one folder.**
 *
 * `within` is the ordinary move: inside a space, between a client's zones, My files ↔ Company, and
 * from My files or Company into a client. `out` is an admin's, on a route of its own: out of a
 * client's folders, for a misfiled document. What only an admin may do needs a declaration of its
 * own, since no per-action rule exists yet (§11.1).
 *
 * A file on a task never leaves its task's place: a client task's file sits in that client, an
 * internal task's in Company. Moved anywhere else it is taken off its task first, in the same
 * transaction, and the log says so.
 */
export async function move(
  area: Area,
  input: MoveInput,
  user: User,
  mode: "within" | "out" = "within",
): Promise<MoveResult> {
  const [folders, files] = await Promise.all([
    input.folderIds.length ? repo.findFolders(input.folderIds) : Promise.resolve([]),
    input.fileIds.length ? repo.findFiles(input.fileIds) : Promise.resolve([]),
  ]);
  const found = [...folders, ...files];
  if (
    folders.length !== new Set(input.folderIds).size ||
    files.length !== new Set(input.fileIds).size ||
    found.some((item) => item.deletedAt || !inArea(item.scope, area))
  ) {
    throw new NotFoundError("Some of these are not here any more");
  }
  const scopes = new Set(found.map((item) => item.scope));
  if (scopes.size !== 1) throw new ValidationError("Move items from one place at a time");
  const fromScope = [...scopes][0] as string;
  const source = await placeOfScope(fromScope);

  const target: Place =
    input.to.space === "personal"
      ? myPlace(user)
      : input.to.space === "company"
        ? COMPANY
        : await clientPlace(input.to.clientId, input.to.zone);

  const reader = await readerOf(user);
  if (area.kind === "client") {
    const staying = sameClient(source, target);
    if (mode === "within" && !staying) {
      throw new ValidationError(
        "Moving files out of a client is an admin's act, and has a route of its own",
      );
    }
    if (mode === "out" && staying) throw new ValidationError("These stay with the same client");
    if (mode === "out" && target.space !== "client") requireOpen(reader, "files");
  } else if (target.space === "client") {
    requireOpen(reader, "clients");
  }

  const toScope = scopeOf(target);
  const toFolder = await liveFolderIn(target, input.toFolderId);
  const toFolderId = toFolder?.id ?? null;

  // what sits inside a selected folder moves with it, and is not moved again on its own
  const tree = folders.length ? await repo.subtree(folders.map((f) => f.id)) : [];
  const nested = new Set(tree.filter((row) => row.depth > 0).map((row) => row.id));
  const inTree = new Set(tree.map((row) => row.id));
  const already = (scope: string | null, parent: string | null) =>
    scope === toScope && parent === toFolderId;
  const movingFolders = folders.filter(
    (f) => !nested.has(f.id) && !already(f.scope, f.parentId),
  );
  const movingFiles = files.filter(
    (f) => !(f.folderId && inTree.has(f.folderId)) && !already(f.scope, f.folderId),
  );
  if (movingFolders.length === 0 && movingFiles.length === 0) {
    return { moved: 0, renamed: [], detached: 0 };
  }

  // folders: not into themselves, not too deep, not onto a taken name (§6.1, §6.3)
  const movingTops = new Set(movingFolders.map((f) => f.id));
  const subtreeOfMoving = tree.filter((row) => movingTops.has(row.top));
  if (toFolderId && subtreeOfMoving.some((row) => row.id === toFolderId)) {
    throw new ValidationError("A folder cannot go inside itself");
  }
  const targetDepth = toFolderId ? (await repo.ancestry(toFolderId)).length : 0;
  for (const f of movingFolders) {
    const height = Math.max(
      0,
      ...subtreeOfMoving.filter((r) => r.top === f.id).map((r) => r.depth),
    );
    if (targetDepth + 1 + height > names.MAX_DEPTH) {
      throw new ValidationError(
        `“${f.name}” would sit more than ${names.MAX_DEPTH} folders deep there`,
      );
    }
  }
  const takenFolders = await repo.takenFolderNames(toScope, toFolderId);
  for (const f of movingFolders) {
    if (takenFolders.has(f.name.toLowerCase())) {
      throw new ConflictError(
        `A folder named “${f.name}” is already there. Rename one of them first.`,
      );
    }
    takenFolders.add(f.name.toLowerCase());
  }

  // files: a taken name becomes `(2)` (§6.3)
  const takenFiles = await repo.takenFileNames(toScope, toFolderId);
  const newNames = new Map<string, string>();
  for (const f of movingFiles) {
    const name = names.firstFreeName(f.name, takenFiles);
    takenFiles.add(name.toLowerCase());
    newNames.set(f.id, name);
  }

  const leavesHome =
    source.space !== target.space ||
    (source.space === "client" && target.space === "client" && !sameClient(source, target));
  const underIds = subtreeOfMoving.map((row) => row.id);
  const under = underIds.length ? await repo.filesUnder(underIds) : [];
  const detachFiles = leavesHome ? movingFiles.filter((f) => f.taskId).map((f) => f.id) : [];

  try {
    await repo.applyMove({
      toScope,
      toFolderId,
      folders: movingFolders.map((f) => f.id),
      files: movingFiles.map((f) => ({ id: f.id, name: newNames.get(f.id) as string })),
      detachFiles,
      detachUnder: leavesHome ? underIds : [],
      ownerId: target.space === "personal" ? target.ownerId : null,
    });
  } catch (error) {
    throw asNameConflict(
      error,
      "Something with the same name arrived there at the same moment",
    );
  }

  // ── what the log says, one row per document (§10.2) ──
  const toWords = await words(target, toFolderId);
  const fromWordsCache = new Map<string | null, string>();
  const fromWords = async (parent: string | null) => {
    if (!fromWordsCache.has(parent)) fromWordsCache.set(parent, await words(source, parent));
    return fromWordsCache.get(parent) as string;
  };
  const beneath = (base: string, path: string[], place: Place) =>
    place.space === "personal" ? MY_FILES : [base, ...path].join(" › ");

  let detached = 0;
  for (const f of movingFiles) {
    const name = newNames.get(f.id) as string;
    const from = await fromWords(f.folderId);
    if (!f.deletedAt) recordFileMove(f.id, name, source, target, from, toWords);
    if (!f.deletedAt) recordVisibility(f.id, name, source, target, from, toWords);
    if (f.taskId && leavesHome) {
      detached++;
      if (!f.deletedAt) recordDetached(f.id, name, source, f.task?.title ?? "a task");
    }
  }

  const pathOf = new Map(subtreeOfMoving.map((row) => [row.id, row]));
  for (const folder of movingFolders) {
    const from = await fromWords(folder.parentId);
    const inside = under.filter((f) => pathOf.get(f.folderId as string)?.top === folder.id);
    if (!folder.deletedAt) {
      recordFolderMove(
        folder,
        source,
        target,
        from,
        toWords,
        inside.filter((f) => !f.deletedAt).length,
      );
    }
    for (const f of inside) {
      const path = pathOf.get(f.folderId as string)?.path ?? [];
      const fileFrom = beneath(from, path, source);
      const fileTo = beneath(toWords, path, target);
      if (!f.deletedAt && source.space === "client" && !sameClient(source, target)) {
        record("file.refiled", {
          subjectId: f.id,
          subjectLabel: f.name,
          clientId: source.clientId,
          changes: { from: fileFrom, to: fileTo },
        });
      }
      if (!f.deletedAt) recordVisibility(f.id, f.name, source, target, fileFrom, fileTo);
      if (f.taskId && leavesHome) {
        detached++;
        if (!f.deletedAt) recordDetached(f.id, f.name, source, f.task?.title ?? "a task");
      }
    }
  }

  return {
    moved: movingFolders.length + movingFiles.length,
    renamed: movingFiles
      .filter((f) => newNames.get(f.id) !== f.name)
      .map((f) => ({ id: f.id, name: newNames.get(f.id) as string })),
    detached,
  };
}

/**
 * Logged under the subject of the move's non-personal end, with the file's name; any path inside
 * My files is written as "My files". Only an act that stays inside My files is neutral (§10.3).
 */
function recordFileMove(
  id: string,
  name: string,
  source: Place,
  target: Place,
  from: string,
  to: string,
) {
  const changes = { from, to };
  if (sameClient(source, target) && source.space === "client") {
    record("file.moved", {
      subjectId: id,
      subjectLabel: name,
      clientId: source.clientId,
      changes,
    });
  } else if (source.space === "client") {
    // an admin's re-file: long-kept, under the client it left; and its arrival under the next one
    record("file.refiled", {
      subjectId: id,
      subjectLabel: name,
      clientId: source.clientId,
      changes,
    });
    if (target.space === "client") {
      record("file.moved", {
        subjectId: id,
        subjectLabel: name,
        clientId: target.clientId,
        changes,
      });
    }
  } else if (target.space === "client") {
    record("file.moved", {
      subjectId: id,
      subjectLabel: name,
      clientId: target.clientId,
      changes,
    });
  } else if (source.space === "personal" && target.space === "personal") {
    record("firm_file.moved", {
      subjectId: id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  } else {
    record("firm_file.moved", { subjectId: id, subjectLabel: name, changes });
  }
}

function recordFolderMove(
  folder: { id: string; name: string },
  source: Place,
  target: Place,
  from: string,
  to: string,
  files: number,
) {
  const changes = { from, to, files };
  if (source.space === "client" || target.space === "client") {
    const clientId =
      target.space === "client"
        ? target.clientId
        : source.space === "client"
          ? source.clientId
          : null;
    record("folder.moved", {
      subjectId: folder.id,
      subjectLabel: folder.name,
      clientId,
      changes,
    });
  } else if (source.space === "personal" && target.space === "personal") {
    record("firm_folder.moved", {
      subjectId: folder.id,
      subjectLabel: PERSONAL_FOLDER,
      changes: { place: MY_FILES },
    });
  } else {
    record("firm_folder.moved", { subjectId: folder.id, subjectLabel: folder.name, changes });
  }
}

/** A document entering or leaving what a client will see: long-kept, both ways (§10.1). */
function recordVisibility(
  id: string,
  name: string,
  source: Place,
  target: Place,
  from: string,
  to: string,
) {
  const stillSeen = clientSees(source) && clientSees(target) && sameClient(source, target);
  if (clientSees(source) && !stillSeen && source.space === "client") {
    record("file.unshared", {
      subjectId: id,
      subjectLabel: name,
      clientId: source.clientId,
      changes: { from, to },
    });
  }
  if (clientSees(target) && !stillSeen && target.space === "client") {
    record("file.shared_with_client", {
      subjectId: id,
      subjectLabel: name,
      clientId: target.clientId,
      changes: { place: to },
    });
  }
}

function recordDetached(id: string, name: string, source: Place, task: string) {
  if (source.space === "client") {
    record("file.detached", {
      subjectId: id,
      subjectLabel: name,
      clientId: source.clientId,
      changes: { task },
    });
  } else {
    record("firm_file.detached", { subjectId: id, subjectLabel: name, changes: { task } });
  }
}

// ── attachments and File to folder (files.md §5.2, §5.3) ─────────────────────

function filedWords(
  f: repo.FileRecord,
  company: boolean,
  chains: Map<string, string[]>,
): string | null {
  if (!f.scope) return null;
  const chain = f.folderId ? (chains.get(f.folderId) ?? []) : [];
  const head = company ? "Company" : ZONE_LABEL[f.zone as FileZone];
  return [head, ...chain].join(" › ");
}

/**
 * Grouped by task, newest first; filed ones included, with where they are filed. The paths are read
 * in one query for the whole list, never one per row (§13.1; code review, 2026-09-14).
 */
async function groupByTask(
  files: repo.FileRecord[],
  company: boolean,
): Promise<AttachmentGroup[]> {
  const folderIds = [
    ...new Set(files.flatMap((f) => (f.scope && f.folderId ? [f.folderId] : []))),
  ];
  const chains =
    folderIds.length > 0 ? await repo.ancestries(folderIds) : new Map<string, string[]>();
  const groups = new Map<string, AttachmentGroup>();
  for (const f of files) {
    if (!f.task) continue;
    let group = groups.get(f.task.id);
    if (!group) {
      group = {
        task: { id: f.task.id, title: f.task.title, archived: f.task.archivedAt !== null },
        files: [],
      };
      groups.set(f.task.id, group);
    }
    group.files.push({ ...fileRow(f, false), filedIn: filedWords(f, company, chains) });
  }
  return [...groups.values()];
}

/** A client's Attachments node: every live file on the client's tasks (§5.2). */
export async function clientAttachments(clientId: string): Promise<AttachmentGroup[]> {
  await liveClient(clientId);
  return groupByTask(await repo.clientAttachmentFiles(clientId), false);
}

/**
 * Company's Attachments node: files on the firm's internal tasks, with neither a client nor a lead
 * (owner, 2026-09-14). It names tasks, so it needs Tasks as well as Files.
 */
export async function companyAttachments(user: User): Promise<AttachmentGroup[]> {
  requireReadable(await readerOf(user), "tasks");
  return groupByTask(await repo.internalAttachmentFiles(), true);
}

/**
 * **File to folder: the same row gains a place and keeps its task** (§5.3). No bytes are copied, so
 * the task shows the new name too when the folder already has the old one.
 */
async function fileInto(
  file: NonNullable<Awaited<ReturnType<typeof repo.findFile>>>,
  target: Place,
  folderId: string | null,
) {
  const folder = await liveFolderIn(target, folderId);
  const scope = scopeOf(target);
  const at = folder?.id ?? null;
  const name = names.firstFreeName(file.name, await repo.takenFileNames(scope, at));
  try {
    await repo.fileInto(file.id, scope, at, name);
  } catch (error) {
    throw asNameConflict(error, "A file with the same name arrived there at the same moment");
  }
  return { name, to: await words(target, at), task: file.task?.title ?? "a task" };
}

export async function fileClientAttachment(
  clientId: string,
  fileId: string,
  zone: FileZone | undefined,
  folderId: string | null,
) {
  const file = await repo.findFile(fileId);
  // an attachment is filed only into its own task's client (§5.3)
  if (
    !file ||
    file.deletedAt ||
    file.clientId !== clientId ||
    file.task?.clientId !== clientId
  ) {
    throw new NotFoundError("File not found");
  }
  if (file.scope) throw new ConflictError("This file is already in a folder");
  if (!zone) throw new ValidationError("Choose one of the client's zones");
  const target = await clientPlace(clientId, zone);
  const done = await fileInto(file, target, folderId);
  record("file.filed", {
    subjectId: file.id,
    subjectLabel: done.name,
    clientId,
    changes: { to: done.to, task: done.task },
  });
  if (clientSees(target)) {
    record("file.shared_with_client", {
      subjectId: file.id,
      subjectLabel: done.name,
      clientId,
      changes: { place: done.to },
    });
  }
  return { id: file.id, name: done.name };
}

export async function fileCompanyAttachment(
  fileId: string,
  folderId: string | null,
  user: User,
) {
  requireOpen(await readerOf(user), "tasks");
  const file = await repo.findFile(fileId);
  const internal = file?.task && file.task.clientId === null && file.task.leadId === null;
  if (!file || file.deletedAt || !internal) throw new NotFoundError("File not found");
  if (file.scope) throw new ConflictError("This file is already in a folder");
  const done = await fileInto(file, COMPANY, folderId);
  record("firm_file.filed", {
    subjectId: file.id,
    subjectLabel: done.name,
    changes: { to: done.to, task: done.task },
  });
  return { id: file.id, name: done.name };
}
