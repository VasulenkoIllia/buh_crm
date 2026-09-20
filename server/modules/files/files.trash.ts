import { randomUUID } from "node:crypto";
import type { User } from "../../generated/prisma/client.js";
import { plural } from "@shared/text.js";
import {
  ZONE_LABEL,
  type FileZone,
  type RestoreResult,
  type TrashBatch,
  type TrashInput,
  type TrashItem,
  type TrashPage,
  type TrashResult,
} from "@shared/schema/files.js";
import { record } from "../../core/activity.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { deleteStoredFile } from "../../core/files.js";
import { clientLabel, personName } from "../../core/names.js";
import { opens, readerOf } from "./files.access.js";
import * as names from "./files.names.js";
import * as repo from "./files.repository.js";
import {
  COMPANY,
  MY_FILES,
  PERSONAL_FILE,
  PERSONAL_FOLDER,
  asNameConflict,
  clientSees,
  inArea,
  placeOfScope,
  type Area,
  type Place,
} from "./files.service.js";

/**
 * **The Trash** (files.md §9). Every delete, one file or a thousand, in the library or on a card,
 * sets three columns and changes nothing else. Restoring clears them, back where the item was or
 * under the nearest live folder above it. A nightly purge removes for good what has waited 30 days.
 */

const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * At most this many files a night (§9). The backup mirror's `--max-delete` lets N deletions
 * through, and a missed night puts two purges into one copy: k × P + other deletions ≤ N, with
 * N = 1,000. `server/backup-scripts.test.ts` holds N ≥ 3 × P.
 */
export const PURGE_PER_NIGHT = 300;
const PAGE = 30;

type Card = { clientId: string } | { taskId: string };

// ── words ────────────────────────────────────────────────────────────────────

/**
 * The places of these scopes, with each client's name whether or not the client is archived: the
 * purge names what it removes, and the lists never reach an archived client's items anyway.
 */
async function placesOf(scopes: (string | null)[]): Promise<Map<string, Place>> {
  const places = new Map<string, Place>();
  for (const scope of new Set(scopes.filter((s): s is string => !!s))) {
    if (scope === "company") {
      places.set(scope, COMPANY);
      continue;
    }
    const [space, id, zone] = scope.split(":");
    if (space === "personal") {
      places.set(scope, { space: "personal", ownerId: id });
      continue;
    }
    const client = await repo.findClientAnyState(id);
    places.set(scope, {
      space: "client",
      clientId: id,
      zone: zone as FileZone,
      clientName: client ? clientLabel(client) : "a client",
    });
  }
  return places;
}

/** A place in words from chains read in one query (`repo.ancestries`). My files is never deeper. */
function spoken(place: Place, folderId: string | null, chains: Map<string, string[]>): string {
  if (place.space === "personal") return MY_FILES;
  const chain = folderId ? (chains.get(folderId) ?? []) : [];
  const head =
    place.space === "company" ? ["Company"] : [place.clientName, ZONE_LABEL[place.zone]];
  return [...head, ...chain].join(" › ");
}

const present = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => !!x))];

async function chainsOf(ids: (string | null)[]) {
  const wanted = present(ids);
  return wanted.length > 0 ? repo.ancestries(wanted) : new Map<string, string[]>();
}

// ── what the log says ────────────────────────────────────────────────────────

type Named = {
  id: string;
  name: string;
  clientId: string | null;
  task?: { clientId: string | null; leadId: string | null } | null;
};

/**
 * A file on one of the firm's internal tasks, not filed. The log files it under the Files gate,
 * where Company's Attachments shows it (files.md §10.3, decision 26), not under Clients, which has
 * nothing to do with it (owner, 2026-09-15).
 */
const onInternalTask = (f: Named) =>
  !!f.task && f.task.clientId === null && f.task.leadId === null;

/** A client task's or a lead task's file that is not filed is logged, as ever, under `file`. */
function recordFileTrashed(f: Named, place: Place | null, where: string) {
  if (!place && onInternalTask(f)) {
    record("firm_file.deleted", {
      subjectId: f.id,
      subjectLabel: f.name,
      changes: { name: f.name, place: `Task: ${where}` },
    });
  } else if (!place || place.space === "client") {
    // `long`, since this is where a disposal starts; `attachedTo` names the place or the task
    record("file.deleted", {
      subjectId: f.id,
      subjectLabel: f.name,
      clientId: f.clientId,
      changes: { name: f.name, attachedTo: where },
    });
  } else if (place.space === "company") {
    record("firm_file.deleted", {
      subjectId: f.id,
      subjectLabel: f.name,
      changes: { name: f.name, place: where },
    });
  } else {
    record("firm_file.deleted", {
      subjectId: f.id,
      subjectLabel: PERSONAL_FILE,
      changes: { place: MY_FILES },
    });
  }
}

function recordFolderTrashed(
  folder: { id: string; name: string },
  place: Place,
  where: string,
  files: number,
) {
  if (place.space === "client") {
    record("folder.deleted", {
      subjectId: folder.id,
      subjectLabel: folder.name,
      clientId: place.clientId,
      changes: { place: where, files },
    });
  } else {
    record("firm_folder.deleted", {
      subjectId: folder.id,
      subjectLabel: place.space === "personal" ? PERSONAL_FOLDER : folder.name,
      changes: { place: where, files },
    });
  }
}

/**
 * A restore into Shared with client or From client always starts the client seeing the file: a
 * trashed file is not visible under the portal rule (§9), so it writes that too.
 */
function recordFileRestored(f: Named, place: Place | null, to: string) {
  if (!place && onInternalTask(f)) {
    record("firm_file.restored", {
      subjectId: f.id,
      subjectLabel: f.name,
      changes: { to: `Task: ${to}` },
    });
  } else if (!place || place.space === "client") {
    record("file.restored", {
      subjectId: f.id,
      subjectLabel: f.name,
      clientId: f.clientId,
      changes: { to },
    });
    if (place && place.space === "client" && clientSees(place)) {
      record("file.shared_with_client", {
        subjectId: f.id,
        subjectLabel: f.name,
        clientId: place.clientId,
        changes: { place: to },
      });
    }
  } else if (place.space === "company") {
    record("firm_file.restored", { subjectId: f.id, subjectLabel: f.name, changes: { to } });
  } else {
    record("firm_file.restored", {
      subjectId: f.id,
      subjectLabel: PERSONAL_FILE,
      changes: { to: MY_FILES },
    });
  }
}

function recordFolderRestored(
  folder: { id: string; name: string },
  place: Place,
  to: string,
  files: number,
) {
  if (place.space === "client") {
    record("folder.restored", {
      subjectId: folder.id,
      subjectLabel: folder.name,
      clientId: place.clientId,
      changes: { to, files },
    });
  } else {
    record("firm_folder.restored", {
      subjectId: folder.id,
      subjectLabel: place.space === "personal" ? PERSONAL_FOLDER : folder.name,
      changes: { to, files },
    });
  }
}

// ── deleting ─────────────────────────────────────────────────────────────────

/**
 * **One selection, from one place, into the Trash** (§9, §7.3). A folder takes everything live
 * below it under the same gesture; what was already in the Trash keeps its own.
 */
export async function trash(area: Area, input: TrashInput, user: User): Promise<TrashResult> {
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
  if (scopes.size !== 1) throw new ValidationError("Delete items from one place at a time");
  // a client route also answers "not found" for an archived client
  const place = await placeOfScope([...scopes][0] as string);

  const tree = await repo.liveFoldersUnder(folders.map((f) => f.id));
  const inTree = new Set(tree);
  const tops = folders.filter((f) => !(f.parentId && inTree.has(f.parentId)));
  const direct = files.filter((f) => !(f.folderId && inTree.has(f.folderId)));
  const under =
    tree.length > 0 ? (await repo.filesUnder(tree)).filter((f) => !f.deletedAt) : [];

  const batchId = randomUUID();
  await repo.applyTrash({
    batchId,
    at: new Date(),
    by: user.id,
    folders: tree,
    files: direct.map((f) => f.id),
  });

  const chains = await chainsOf([
    ...tops.map((f) => f.parentId),
    ...direct.map((f) => f.folderId),
    ...under.map((f) => f.folderId),
  ]);
  const topOf = new Map(
    tops.length > 0
      ? (await repo.subtree(tops.map((f) => f.id)))
          .filter((row) => inTree.has(row.id))
          .map((row) => [row.id, row.top])
      : [],
  );
  for (const folder of tops) {
    const inside = under.filter((f) => topOf.get(f.folderId as string) === folder.id).length;
    recordFolderTrashed(folder, place, spoken(place, folder.parentId, chains), inside);
  }
  // one row per document, so the disposal record names every one (§10.2)
  for (const f of [...direct, ...under]) {
    recordFileTrashed(f, place, spoken(place, f.folderId, chains));
  }
  const all = [...direct, ...under];
  return { batchId, files: all.length, bytes: all.reduce((sum, f) => sum + f.size, 0) };
}

/**
 * **A card's delete** (§9, §5.4): this one file into the Trash, and the gesture its Undo takes
 * back. A file on a task leaves the task's list while it is in the Trash, and comes back with it.
 */
export async function trashCardFile(
  fileId: string,
  card: Card,
  user: User,
): Promise<TrashResult> {
  const [file] = await repo.findFiles([fileId]);
  const belongs =
    file &&
    !file.deletedAt &&
    ("clientId" in card ? file.clientId === card.clientId : file.taskId === card.taskId);
  if (!file || !belongs) throw new NotFoundError("File not found");

  const batchId = randomUUID();
  await repo.applyTrash({
    batchId,
    at: new Date(),
    by: user.id,
    folders: [],
    files: [file.id],
  });
  const place = file.scope ? ((await placesOf([file.scope])).get(file.scope) ?? null) : null;
  const where = place
    ? spoken(place, file.folderId, await chainsOf([file.folderId]))
    : (file.task?.title ?? "a task");
  recordFileTrashed(file, place, where);
  return { batchId, files: 1, bytes: file.size };
}

// ── restoring ────────────────────────────────────────────────────────────────

/**
 * **Back where it was** (§9). If its folder is in the Trash, or gone, it goes under the nearest
 * live folder above it, or to the root of its place: no live item ever has a trashed parent. If
 * the name was taken meanwhile, `(2)`. Folders come back first, with what went into the Trash with
 * them in the same gesture.
 */
async function restore(
  topFolders: repo.TrashedFolderRecord[],
  topFiles: repo.TrashedFileRecord[],
  batchId: string,
  user: User,
): Promise<RestoreResult> {
  const scopes = [...topFolders.map((f) => f.scope), ...topFiles.map((f) => f.scope)];
  const places = await placesOf(scopes);
  const renamed: { id: string; name: string }[] = [];

  // names already taken where each item lands, and those this restore hands out
  const taken = new Map<string, Set<string>>();
  const takenAt = async (kind: "file" | "folder", scope: string, parent: string | null) => {
    const key = `${kind}|${scope}|${parent}`;
    if (!taken.has(key)) {
      taken.set(
        key,
        kind === "file"
          ? await repo.takenFileNames(scope, parent)
          : await repo.takenFolderNames(scope, parent),
      );
    }
    return taken.get(key) as Set<string>;
  };

  const folderPlan: { id: string; parentId: string | null; name: string }[] = [];
  for (const folder of topFolders) {
    const parentId = await repo.nearestLiveFolder(folder.parentId);
    const names_ = await takenAt("folder", folder.scope, parentId);
    const name = names.firstFreeFolderName(folder.name, names_);
    names_.add(name.toLowerCase());
    if (name !== folder.name) renamed.push({ id: folder.id, name });
    folderPlan.push({ id: folder.id, parentId, name });
  }

  const filePlan: { id: string; folderId: string | null; name: string }[] = [];
  for (const file of topFiles) {
    // a task's file that is not filed stands outside the library and its names
    if (!file.scope) {
      filePlan.push({ id: file.id, folderId: null, name: file.name });
      continue;
    }
    const folderId = await repo.nearestLiveFolder(file.folderId);
    const names_ = await takenAt("file", file.scope, folderId);
    const name = names.firstFreeName(file.name, names_);
    names_.add(name.toLowerCase());
    if (name !== file.name) renamed.push({ id: file.id, name });
    filePlan.push({ id: file.id, folderId, name });
  }

  const mates = await repo.batchMatesUnder(
    topFolders.map((f) => f.id),
    batchId,
  );
  const personal = scopes.find((s) => s?.startsWith("personal:"));
  const ownerId = personal ? personal.split(":")[1] : null;
  // belt and braces: whatever filter found it, My files is only ever its owner's to restore
  if (ownerId && ownerId !== user.id) throw new NotFoundError("Nothing to restore here");
  try {
    await repo.applyRestore({
      folders: folderPlan,
      files: filePlan,
      mates: { folders: mates.folders, files: mates.files.map((f) => f.id) },
      ownerId,
    });
  } catch (error) {
    throw asNameConflict(error, "Something with the same name came back at the same moment");
  }

  // ── what the log says, read after the restore so the paths are the new ones ──
  const chains = await chainsOf([
    ...folderPlan.map((f) => f.parentId),
    ...filePlan.map((f) => f.folderId),
    ...mates.files.map((f) => f.folderId),
  ]);
  const topOf = new Map(
    topFolders.length > 0
      ? (await repo.subtree(topFolders.map((f) => f.id))).map((row) => [row.id, row.top])
      : [],
  );
  for (const [i, folder] of topFolders.entries()) {
    const place = places.get(folder.scope) as Place;
    const plan = folderPlan[i];
    const inside = mates.files.filter((f) => topOf.get(f.folderId as string) === folder.id);
    recordFolderRestored(
      { id: folder.id, name: plan.name },
      place,
      spoken(place, plan.parentId, chains),
      inside.length,
    );
  }
  for (const [i, file] of topFiles.entries()) {
    const plan = filePlan[i];
    const place = file.scope ? (places.get(file.scope) ?? null) : null;
    const to = place ? spoken(place, plan.folderId, chains) : (file.task?.title ?? "a task");
    recordFileRestored({ ...file, name: plan.name }, place, to);
  }
  for (const file of mates.files) {
    const place = file.scope ? (places.get(file.scope) ?? null) : null;
    if (place) recordFileRestored(file, place, spoken(place, file.folderId, chains));
  }

  return {
    restored: topFolders.length + topFiles.length + mates.folders.length + mates.files.length,
    renamed,
  };
}

async function seenFilter(user: User) {
  const reader = await readerOf(user);
  const clients = opens(reader, "clients");
  return {
    files: repo.trashedFilesSeen(user.id, clients, opens(reader, "tasks")),
    folders: repo.trashedFoldersSeen(user.id, clients),
  };
}

/**
 * **Restore on a group restores the gesture** (§9). Anyone who sees an item in the Trash may
 * restore it; a gesture is restored whole or not at all, so one the reader cannot see all of
 * answers "not found".
 */
export async function restoreBatch(batchId: string, user: User): Promise<RestoreResult> {
  const seen = await seenFilter(user);
  const [files, folders, seenFiles, seenFolders] = await Promise.all([
    repo.batchFiles(batchId),
    repo.batchFolders(batchId),
    repo.trashedFiles({ AND: [seen.files, { trashBatchId: batchId }] }),
    repo.trashedFolders({ AND: [seen.folders, { trashBatchId: batchId }] }),
  ]);
  if (
    files.length + folders.length === 0 ||
    seenFiles.length !== files.length ||
    seenFolders.length !== folders.length
  ) {
    throw new NotFoundError("Nothing to restore here");
  }
  const inBatch = new Set(folders.map((f) => f.id));
  return restore(
    folders.filter((f) => !(f.parentId && inBatch.has(f.parentId))),
    files.filter((f) => !(f.folderId && inBatch.has(f.folderId))),
    batchId,
    user,
  );
}

/** Restore on one item: the file alone, out of a gesture of sixty (§9). */
export async function restoreFile(fileId: string, user: User): Promise<RestoreResult> {
  const seen = await seenFilter(user);
  const [file] = await repo.trashedFiles({ AND: [seen.files, { id: fileId }] });
  if (!file?.trashBatchId) throw new NotFoundError("File not found in the Trash");
  return restore([], [file], file.trashBatchId, user);
}

/** A folder, and what went into the Trash with it in the same gesture. */
export async function restoreFolder(folderId: string, user: User): Promise<RestoreResult> {
  const seen = await seenFilter(user);
  const [folder] = await repo.trashedFolders({ AND: [seen.folders, { id: folderId }] });
  if (!folder?.trashBatchId) throw new NotFoundError("Folder not found in the Trash");
  return restore([folder], [], folder.trashBatchId, user);
}

/**
 * **A card's Undo** (§9, decision 18). On the card's own gate, so a person whose Files is closed
 * can take back their own mistake; it restores only a gesture of that card's files.
 */
export async function undoCardTrash(
  batchId: string,
  card: Card,
  user: User,
): Promise<RestoreResult> {
  const [files, folders] = await Promise.all([
    repo.batchFiles(batchId),
    repo.batchFolders(batchId),
  ]);
  const fitsFile = (f: repo.TrashedFileRecord) =>
    "clientId" in card ? f.clientId === card.clientId : f.taskId === card.taskId;
  // the client card deletes folders too, through its Files tab; a task card only ever one file
  const fitsFolder = (f: repo.TrashedFolderRecord) =>
    "clientId" in card && f.scope.startsWith(`client:${card.clientId}:`);
  if (
    files.length + folders.length === 0 ||
    !files.every(fitsFile) ||
    !folders.every(fitsFolder)
  ) {
    throw new NotFoundError("Nothing to undo here");
  }
  const inBatch = new Set(folders.map((f) => f.id));
  return restore(
    folders.filter((f) => !(f.parentId && inBatch.has(f.parentId))),
    files.filter((f) => !(f.folderId && inBatch.has(f.folderId))),
    batchId,
    user,
  );
}

// ── the Trash's list ─────────────────────────────────────────────────────────

/**
 * **Gestures, newest first, each with its items at the top** (§9): "Olena · 12 Sep 14:02 · 60
 * files", and a page at a time.
 */
export async function trashList(user: User, before?: Date): Promise<TrashPage> {
  const seen = await seenFilter(user);
  const [batches, totals] = await Promise.all([
    repo.trashBatches(seen.files, seen.folders, before, PAGE),
    repo.totals(seen.files),
  ]);
  const ids = batches.map((b) => b.batchId);
  const [files, folders] =
    ids.length > 0
      ? await Promise.all([
          repo.trashedFiles({ AND: [seen.files, { trashBatchId: { in: ids } }] }),
          repo.trashedFolders({ AND: [seen.folders, { trashBatchId: { in: ids } }] }),
        ])
      : [[], []];

  const places = await placesOf([...files.map((f) => f.scope), ...folders.map((f) => f.scope)]);
  const batchOf = new Map(folders.map((f) => [f.id, f.trashBatchId]));
  const topFolders = folders.filter(
    (f) => !(f.parentId && batchOf.get(f.parentId) === f.trashBatchId),
  );
  const topFiles = files.filter(
    (f) => !(f.folderId && batchOf.get(f.folderId) === f.trashBatchId),
  );
  const topOf = new Map(
    topFolders.length > 0
      ? (await repo.subtree(topFolders.map((f) => f.id))).map((row) => [row.id, row.top])
      : [],
  );
  const chains = await chainsOf([
    ...topFolders.map((f) => f.parentId),
    ...topFiles.map((f) => f.folderId),
  ]);
  const now = Date.now();

  const out: TrashBatch[] = batches.map(({ batchId, at }) => {
    const inBatch = files.filter((f) => f.trashBatchId === batchId);
    const first = inBatch[0] ?? folders.find((f) => f.trashBatchId === batchId);
    const items: TrashItem[] = [
      ...topFolders
        .filter((f) => f.trashBatchId === batchId)
        .map((f): TrashItem => {
          const inside = inBatch.filter((x) => topOf.get(x.folderId as string) === f.id);
          return {
            kind: "folder",
            id: f.id,
            name: f.name,
            from: spoken(places.get(f.scope) as Place, f.parentId, chains),
            totals: { files: inside.length, bytes: inside.reduce((s, x) => s + x.size, 0) },
          };
        }),
      ...topFiles
        .filter((f) => f.trashBatchId === batchId)
        .map((f): TrashItem => {
          const place = f.scope ? places.get(f.scope) : undefined;
          return {
            kind: "file",
            id: f.id,
            name: f.name,
            from: place
              ? spoken(place, f.folderId, chains)
              : `Task: ${f.task?.title ?? "a task"}`,
            totals: { files: 1, bytes: f.size },
          };
        }),
    ];
    return {
      batchId,
      deletedAt: at.toISOString(),
      deletedBy: personName(first?.deletedBy ?? null),
      daysLeft: Math.max(0, TRASH_DAYS - Math.floor((now - at.getTime()) / DAY_MS)),
      totals: { files: inBatch.length, bytes: inBatch.reduce((s, f) => s + f.size, 0) },
      items,
    };
  });

  return {
    batches: out,
    nextBefore: batches.length === PAGE ? batches[batches.length - 1].at.toISOString() : null,
    totals,
  };
}

// ── the nightly purge ────────────────────────────────────────────────────────

/**
 * **What has waited 30 days is removed for good** (§9): the bytes through `core/files.ts` first,
 * then the row, and a `file.purged` row each, the disposal record. The oldest gestures first, at
 * most `PURGE_PER_NIGHT` files; then the folders nothing points at any more, deepest first. What
 * is still due goes in the note and is not counted as skipped, or a backlog would turn the System
 * row amber every night of it. A file whose bytes the store refused is skipped, and tried again.
 *
 * The purge ignores archiving: an archived client's trashed files go on schedule (§9).
 */
export async function purgeTrash(options: { limit?: number; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - TRASH_DAYS * DAY_MS);
  const due = await repo.dueFiles(cutoff, options.limit ?? PURGE_PER_NIGHT);
  const places = await placesOf(due.map((f) => f.scope));
  const chains = await chainsOf(due.map((f) => f.folderId));

  let purged = 0;
  let failed = 0;
  for (const f of due) {
    const place = f.scope ? (places.get(f.scope) ?? null) : null;
    const from = place ? spoken(place, f.folderId, chains) : (f.task?.title ?? "a task");
    try {
      // the bytes first: if the store refuses, nothing has changed and the next night tries again
      await deleteStoredFile(f);
      await repo.deleteFileRow(f.id);
    } catch (error) {
      failed++;
      console.error(`files: the purge could not remove ${f.id}`, error);
      continue;
    }
    purged++;
    if (!place && onInternalTask(f)) {
      record("firm_file.purged", {
        subjectId: f.id,
        subjectLabel: f.name,
        changes: { name: f.name, from: `Task: ${from}` },
      });
    } else if (!place || place.space === "client") {
      record("file.purged", {
        subjectId: f.id,
        subjectLabel: f.name,
        clientId: f.clientId,
        changes: { name: f.name, from },
      });
    } else if (place.space === "company") {
      record("firm_file.purged", {
        subjectId: f.id,
        subjectLabel: f.name,
        changes: { name: f.name, from },
      });
    } else {
      record("firm_file.purged", {
        subjectId: f.id,
        subjectLabel: PERSONAL_FILE,
        changes: { from: MY_FILES },
      });
    }
  }

  let folders = 0;
  for (let pass = 0; pass < 2 * names.MAX_DEPTH + 4; pass++) {
    const removed = await repo.purgeEmptyFolders(cutoff);
    if (removed === 0) break;
    folders += removed;
  }

  const still = await repo.countDueFiles(cutoff);
  const note = [
    `${plural(purged, "file")} removed for good`,
    ...(folders > 0 ? [`${plural(folders, "empty folder")} with them`] : []),
    ...(still > 0 ? [`${still} more due, for the nights ahead`] : []),
  ].join("; ");
  return { note, skipped: failed };
}
