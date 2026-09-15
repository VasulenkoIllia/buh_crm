import { z } from "zod";
import { uuid } from "./common.js";

/**
 * The library's shapes (files.md §4–§7). Inputs are zod, validated at the route; outputs are
 * types, read by the Files screen and the client card.
 */

export const fileZone = z.enum(["internal", "shared", "from_client"]);
export type FileZone = z.infer<typeof fileZone>;

export const ZONE_LABEL: Record<FileZone, string> = {
  internal: "Internal",
  shared: "Shared with client",
  from_client: "From client",
};

/** The two zones a client will see once the portal opens (files.md §4.2). */
export const CLIENT_VISIBLE_ZONES: readonly FileZone[] = ["shared", "from_client"];

/** Where an item may be put: the caller's own My files, Company, or one of a client's zones. */
export const placeInput = z.discriminatedUnion("space", [
  z.object({ space: z.literal("personal") }),
  z.object({ space: z.literal("company") }),
  z.object({ space: z.literal("client"), clientId: uuid, zone: fileZone }),
]);
export type PlaceInput = z.infer<typeof placeInput>;

/** An open folder, or the root of its place when absent. */
export const folderQuery = z.object({ folderId: uuid.optional() });

// the lengths are checked by the service, which cleans a name before it counts it
export const createFolderInput = z.object({
  name: z.string().max(1000),
  parentId: uuid.nullable().default(null),
});
export const renameInput = z.object({ name: z.string().max(1000) });

/** One selection, from one place (files.md §7.3), to one folder. */
export const moveInput = z
  .object({
    folderIds: z.array(uuid).max(500).default([]),
    fileIds: z.array(uuid).max(2000).default([]),
    to: placeInput,
    toFolderId: uuid.nullable().default(null),
  })
  .refine((v) => v.folderIds.length + v.fileIds.length > 0, {
    message: "Choose something to move",
  });
export type MoveInput = z.infer<typeof moveInput>;

/** File to folder (files.md §5.3). `zone` is required for a client's attachment. */
export const fileToFolderInput = z.object({
  zone: fileZone.optional(),
  folderId: uuid.nullable().default(null),
});

// ── what the routes return ───────────────────────────────────────────────────

export interface FileTotals {
  files: number;
  bytes: number;
}

/** The fixed nodes of the tree, each with what the reader can see in it (files.md §4.4). */
export interface FilesOverview {
  /** everything the reader can see, each file once */
  all: FileTotals;
  mine: FileTotals;
  company: FileTotals;
  /** files on the firm's internal tasks; null when Tasks is closed for the reader */
  companyAttachments: FileTotals | null;
  /** every live client's files together; null when Clients is closed for the reader */
  clients: FileTotals | null;
}

export interface ClientFilesNode {
  id: string;
  label: string;
  code: number;
  totals: FileTotals;
}

export interface ClientFilesDetail extends ClientFilesNode {
  zones: Record<FileZone, FileTotals>;
  /** files on the client's tasks; `filed` of them also sit in a folder */
  attachments: FileTotals & { filed: number };
}

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  totals: FileTotals;
}

export interface FolderRow {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string | null;
  totals: FileTotals;
}

export interface FileRow {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  uploadedBy: string;
  /** the task it is attached to as well, when the reader may see that task */
  task: { id: string; title: string } | null;
}

export interface FolderListing {
  folder: { id: string; name: string } | null;
  /** from the fixed level down, the open folder last */
  crumbs: { id: string; name: string }[];
  folders: FolderRow[];
  files: FileRow[];
  /** the open folder's, or the place's, subfolders included */
  totals: FileTotals;
}

export interface AttachmentRow extends FileRow {
  /** where it is filed as well, in words; null while it is only on its task */
  filedIn: string | null;
}

export interface AttachmentGroup {
  task: { id: string; title: string; archived: boolean };
  files: AttachmentRow[];
}

export interface MoveResult {
  moved: number;
  /** files that took `(2)` in their new folder */
  renamed: { id: string; name: string }[];
  /** files that left their task on the way */
  detached: number;
}

// ── the Trash (files.md §9) ──────────────────────────────────────────────────

/** A selection to put in the Trash, from one place (§7.3). */
export const trashInput = z
  .object({
    folderIds: z.array(uuid).max(500).default([]),
    fileIds: z.array(uuid).max(2000).default([]),
  })
  .refine((v) => v.folderIds.length + v.fileIds.length > 0, {
    message: "Choose something to delete",
  });
export type TrashInput = z.infer<typeof trashInput>;

/** A card's Undo names the gesture it takes back. */
export const undoInput = z.object({ batchId: uuid });

/** The Trash is read a page of gestures at a time, the newest first. */
export const trashQuery = z.object({ before: z.coerce.date().optional() });

export interface TrashResult {
  /** the gesture, which a card's Undo takes back */
  batchId: string;
  files: number;
  bytes: number;
}

export interface TrashItem {
  kind: "file" | "folder";
  id: string;
  name: string;
  /** where it was, in words */
  from: string;
  /** a file's size; for a folder, everything that went into the Trash with it */
  totals: FileTotals;
}

/** One gesture: "Olena · 12 Sep 14:02 · 60 files", with the items at its top. */
export interface TrashBatch {
  batchId: string;
  deletedAt: string;
  deletedBy: string;
  /** days before the nightly purge removes it for good */
  daysLeft: number;
  totals: FileTotals;
  items: TrashItem[];
}

export interface TrashPage {
  batches: TrashBatch[];
  /** pass back as `before` for the next page; null on the last one */
  nextBefore: string | null;
  /** everything in the Trash this reader can see */
  totals: FileTotals;
}

export interface RestoreResult {
  restored: number;
  /** items that took `(2)` because the name was taken meanwhile */
  renamed: { id: string; name: string }[];
}
