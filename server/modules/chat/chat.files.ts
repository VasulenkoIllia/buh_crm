import type { ChatFile, ChatUpload } from "@shared/schema/chat.js";
import { CHAT_FILES_MAX } from "@shared/schema/chat.js";
import type { User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { MAX_FILE_SIZE, deleteStoredFile, storeFile } from "../../core/files.js";
import {
  NOT_VIEWABLE,
  detectType,
  refuseProgram,
  uploadedFileName,
  viewOf,
} from "../files/index.js";
import * as repo from "./chat.repository.js";
import { requireMember, requireWriter } from "./chat.service.js";

/**
 * **Files in chats** (chat.md §6): the upload, who may open one, and the sweep for uploads nobody
 * ever sent.
 *
 * A chat file goes through `core/files.ts` like every other file in the CRM — its own AES key,
 * wrapped with `SECRETS_KEY`, its bytes in the bucket — and the library's own rules come with it:
 * the name cleaned, a program refused by its name AND by its bytes, 25 MB at most, and only what
 * the CRM can show opening in the CRM. What is different is where it belongs: nowhere. It has no
 * place in the library, no task, no client and no secret (a CHECK holds that), so it appears in no
 * list and no search but the chat's own.
 *
 * **Who may open it is the messages that carry it** (§6.3), never the chat it was uploaded into: a
 * forward puts one file in several chats without copying a byte, and a member of any chat holding a
 * live message that carries it may open it. Its uploader may open it while nothing carries it yet,
 * which is the composer drawing what is about to be sent.
 *
 * **A photo's preview is a file of its own** (§6.2): the sender's browser draws a small JPEG and
 * uploads it beside the photo, in the same request. The server stores it and never decodes an
 * image. Serving one is the single read here that writes no log row, which is what makes a chat
 * readable — so a preview must be an image and small, and the pair is made here, not by the caller.
 */

export interface Incoming {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

/** A preview the browser drew: 320 px on its longest side, so this is room to spare (§6.2). */
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
/** What a preview can be drawn FROM; the rest show as cards. */
const PHOTO_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** How long an upload nobody sent is kept before the sweep takes it (§6.1). */
const UNSENT_HOURS = 24;
const SWEEP_LIMIT = 500;

type Row = repo.ChatFileRow;

const uploadOf = (row: Row, previewFileId: string | null): ChatUpload => ({
  fileId: row.id,
  name: row.name,
  size: row.size,
  detectedMime: row.detectedMime,
  view: viewOf(row.detectedMime),
  previewFileId,
});

/** Bytes nothing points at: taken back now rather than left for the sweep. */
const takeBack = (stored: { path: string; storage: "local" | "s3" }) =>
  deleteStoredFile(stored).catch((e) =>
    console.error("chat: could not remove the bytes of a refused file", e),
  );

async function store(chatId: string, user: User, incoming: Incoming): Promise<Row> {
  const name = uploadedFileName(incoming.filename);
  refuseProgram(name);
  if (incoming.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError("A file must be 25 MB or smaller");
  }
  if (incoming.buffer.byteLength === 0) throw new ValidationError("That file is empty");
  // what the bytes say it is: a renamed program is refused here too
  const detectedMime = await detectType(incoming.buffer, name);

  const stored = await storeFile(incoming.buffer);
  try {
    return await repo.insertChatFile({
      ...stored,
      chatId,
      name,
      size: incoming.buffer.byteLength,
      mime: incoming.mimetype,
      detectedMime,
      uploadedById: user.id,
    });
  } catch (error) {
    await takeBack(stored);
    throw error;
  }
}

/**
 * **One file into a chat**, before the message that carries it is sent (§6.1). Whoever may write
 * in the chat may put a file in it: the channel's admins-only rule and a blocked colleague's
 * read-only direct chat both hold here, since a file with no words is still a message.
 */
export async function upload(
  user: User,
  chatId: string,
  incoming: Incoming,
  preview?: Incoming,
): Promise<ChatUpload> {
  const m = await requireMember(chatId, user.id);
  requireWriter(m, user);

  const row = await store(chatId, user, incoming);
  let previewRow: Row | null = null;
  if (preview) {
    try {
      if (!PHOTO_TYPES.has(row.detectedMime ?? "")) {
        throw new ValidationError("Only a photo has a preview");
      }
      if (preview.buffer.byteLength > PREVIEW_MAX_BYTES) {
        throw new ValidationError("That preview is too large");
      }
      previewRow = await store(chatId, user, {
        ...preview,
        filename: `preview-${row.name}`,
      });
      if (!PREVIEW_TYPES.has(previewRow.detectedMime ?? "")) {
        await repo.deleteFileRow(previewRow.id);
        await takeBack(previewRow);
        throw new ValidationError("A preview is a picture");
      }
    } catch (error) {
      // the photo goes back with it: half a pair would be an upload the composer cannot draw
      await repo.deleteFileRow(row.id);
      await takeBack(row);
      throw error;
    }
  }

  record("chat_file.uploaded", {
    subjectId: row.id,
    // never the name and never the chat: the activity screen is read outside the chat (§12.1)
    subjectLabel: A_CHAT_FILE,
    changes: { size: row.size },
  });
  return uploadOf(row, previewRow?.id ?? null);
}

/** What the log calls a file sent in a chat — as My files does, with no name at all (§12.1). */
const A_CHAT_FILE = "a chat file";

/**
 * **The files a send names** (§6.1), in the order they were given: each one an upload of this
 * sender, into this chat, that no message carries yet. Anything else — somebody else's upload, one
 * already sent, a file from another chat, a preview named as a file — is simply not found, and the
 * send is refused rather than posting a message with a hole in it.
 */
export async function forSend(
  chatId: string,
  user: User,
  wanted: readonly { fileId: string; previewFileId?: string | null }[],
): Promise<{ fileId: string; previewFileId: string | null; position: number }[]> {
  if (wanted.length === 0) return [];
  if (wanted.length > CHAT_FILES_MAX) {
    throw new ValidationError(`A message carries at most ${CHAT_FILES_MAX} files`);
  }
  const ids = [...new Set(wanted.flatMap((f) => [f.fileId, f.previewFileId ?? []].flat()))];
  if (ids.length !== wanted.length + wanted.filter((f) => f.previewFileId).length) {
    throw new ValidationError("A file cannot be sent twice in one message");
  }
  const rows = await repo.unsentUploads(chatId, user.id, ids);
  const found = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!found.has(id)) throw new ValidationError("That file is not ready to send");
  }
  return wanted.map((f, position) => ({
    fileId: f.fileId,
    previewFileId: f.previewFileId ?? null,
    position,
  }));
}

/** The files of a message, as the conversation draws them. */
export function filesOf(
  links: readonly {
    fileId: string;
    previewFileId: string | null;
    position: number;
    file: { name: string; size: number; detectedMime: string | null };
  }[],
): ChatFile[] {
  return links.map((link) => ({
    fileId: link.fileId,
    name: link.file.name,
    size: link.file.size,
    detectedMime: link.file.detectedMime,
    view: viewOf(link.file.detectedMime),
    previewFileId: link.previewFileId,
    position: link.position,
  }));
}

// ── opening one (§6.2) ─────────────────────────────────────────────────────────

/**
 * **A file opened or downloaded**, and the row that says it happened. Both are the same act, as in
 * Files: the document reached the reader either way, and each row says which. A file the CRM cannot
 * show is refused as a view before anything is logged.
 */
export async function open(user: User, fileId: string, via: "view" | "download") {
  const file = await repo.openableChatFile(fileId, user.id);
  if (!file) throw new NotFoundError("File not found");
  if (via === "view" && !viewOf(file.detectedMime)) throw new ValidationError(NOT_VIEWABLE);

  record("chat_file.downloaded", {
    subjectId: file.id,
    subjectLabel: A_CHAT_FILE,
    changes: { via },
  });
  return file;
}

/**
 * **A photo's preview**, the one read here that is never logged (§6.2): it is what makes a chat
 * readable, and a line of the log per thumbnail drawn while scrolling would say nothing. It is
 * still a member's read — the same question is asked — and it serves pictures alone, so it cannot
 * become a quiet way to fetch a document.
 */
export async function openPreview(user: User, fileId: string) {
  const file = await repo.openableChatFile(fileId, user.id);
  if (!file) throw new NotFoundError("File not found");
  if (!PREVIEW_TYPES.has(file.detectedMime ?? "")) throw new NotFoundError("File not found");
  return file;
}

// ── the sweep (§6.1) ───────────────────────────────────────────────────────────

/**
 * **Uploads nobody sent.** A person can pick a file, watch it upload and then close the tab; the
 * row and its bytes would sit in the bucket for ever, reachable by nobody but them and named by no
 * message. A day later this takes them, bytes first, so nothing is left in a store that no row
 * names. Files a message DOES carry are not here at any age.
 */
export async function sweepUnsentUploads(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - UNSENT_HOURS * 60 * 60 * 1000);
  const stale = await repo.staleUploads(before, SWEEP_LIMIT);
  let gone = 0;
  for (const file of stale) {
    try {
      await deleteStoredFile(file);
      await repo.deleteFileRow(file.id);
      gone++;
    } catch (error) {
      console.error("chat: could not sweep an unsent upload", file.id, error);
    }
  }
  return gone;
}
