import type {
  ChatFile,
  ChatFilesPage,
  ChatFilesQuery,
  ChatUpload,
} from "@shared/schema/chat.js";
import { CHAT_FILES_MAX } from "@shared/schema/chat.js";
import { A_CHAT_FILE } from "@shared/activity.js";
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

/** A page of the Files tab (§6.4). */
const TAB_PAGE = 60;

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
  await mayUpload(user, chatId);
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

/**
 * May this person put a file in this chat at all — asked by the ROUTE before it reads a byte of the
 * body, so 25 MB is not buffered for a chat the caller is not in (security review, 2026-09-20), and
 * again here, so the service does not depend on a caller remembering to.
 */
export async function mayUpload(user: User, chatId: string) {
  requireWriter(await requireMember(chatId, user.id), user);
}

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
  // the preview's OWN question: a file a message names as a preview, never one it carries as the
  // file itself, or this door would be a quiet way to fetch the photo (security review)
  const file = await repo.openableChatPreview(fileId, user.id);
  if (!file) throw new NotFoundError("File not found");
  if (!PREVIEW_TYPES.has(file.detectedMime ?? "")) throw new NotFoundError("File not found");
  return file;
}

// ── the chat's own Files tab (§6.4) ────────────────────────────────────────────

/**
 * **What this chat still carries**, newest first, filtered by a word in the name and by who sent
 * it. Names are plain text in `File.name`, as everywhere else in the CRM (§9), so this is Prisma's
 * `contains` and nothing cleverer: a name is less than a message.
 *
 * A deleted message's files are not here, and neither is one already in the Trash.
 */
export async function listFiles(
  user: User,
  chatId: string,
  query: ChatFilesQuery,
): Promise<ChatFilesPage> {
  await requireMember(chatId, user.id);
  const { rows, more } = await repo.filesOfChat(chatId, { ...query, limit: TAB_PAGE });
  return {
    files: rows.map((row) => ({
      fileId: row.fileId,
      name: row.file.name,
      size: row.file.size,
      detectedMime: row.file.detectedMime,
      view: viewOf(row.file.detectedMime),
      previewFileId: row.previewFileId,
      position: row.position,
      messageId: row.message.id,
      seq: row.message.seq,
      senderId: row.message.authorId,
      at: row.message.createdAt.toISOString(),
    })),
    more,
  };
}

// ── what a delete and a forward do to files (§6.3) ─────────────────────────────

/**
 * **A message deleted takes its files with it, for good** (§6.3, owner 2026-09-20) — unless
 * somebody else's message still carries them. Forwarding reuses a file rather than copying it, so
 * the same photo can hang off three messages in three chats, and the one being deleted is not
 * necessarily the file's last home.
 *
 * **No Trash and no restore** (the owner's call, 2026-09-20). A chat is a conversation, not a
 * document store: a file sent in one lives exactly as long as the message that carries it, which is
 * what everybody already expects of a chat. What is kept instead is the RECORD that it happened —
 * `chat_file.deleted`, long-kept — because a document being destroyed is the thing an audit asks
 * about. A document the firm means to keep belongs in Files, which has the Trash and the 30 days.
 *
 * **The decision is made inside the delete's own transaction**, with the file rows locked. Asked
 * outside it, two deletes of the two messages carrying one forwarded file each saw the other's
 * message still live, and neither disposed of the file: it stayed live with nothing carrying it,
 * reachable by nobody and swept by nothing (2026-09-20, from a test written for the review).
 *
 * Returns what to WRITE IN THE LOG once the caller's own work is done: `record()` never runs inside
 * a transaction, and only the call that actually removed a file may claim its disposal.
 */
export async function onMessageDeleted(messageId: string): Promise<() => void> {
  const empty = { gone: [] as repo.ChatFileRow[], said: [] as string[] };
  const disposed = await repo.transaction(async (tx) => {
    const links = await repo.linksOfMessageTx(tx, messageId);
    if (links.length === 0) return empty;
    const previews = new Set(links.flatMap((l) => (l.previewFileId ? [l.previewFileId] : [])));
    const ids = [...new Set([...links.map((l) => l.fileId), ...previews])];
    // locked, and asked again inside the transaction: whoever commits second sees the other delete
    const held = await repo.carriedElsewhereTx(tx, ids, messageId);
    const letGo = ids.filter((id) => !held.has(id));
    if (letGo.length === 0) return empty;

    const rows = await repo.filesByIdsTx(tx, letGo);
    // the rows go inside the transaction; their bytes after it, because a store is not a database
    // and a refusal there must not undo the row that says the file is gone
    await repo.deleteFileRowsTx(
      tx,
      rows.map((r) => r.id),
    );
    // a preview is a thumbnail the browser drew: its going is not an act anybody looks up
    return { gone: rows, said: rows.filter((r) => !previews.has(r.id)).map((r) => r.id) };
  });

  // outside the transaction, as everything that is not the write itself must be (AGENTS.md)
  for (const file of disposed.gone) await takeBack(file);
  return () => {
    for (const fileId of disposed.said) {
      record("chat_file.deleted", { subjectId: fileId, subjectLabel: A_CHAT_FILE });
    }
  };
}

/**
 * **What a forward carries** (§6.3): the same files, in the same order, without copying a byte —
 * read again here rather than from the batch the forward started with, so a message deleted in
 * between is not copied and a file trashed in between is not attached dead. `null` means the source
 * is gone since.
 */
export const sourceForForward = (messageId: string) => repo.sourceForForward(messageId);

// ── the sweep (§6.1) ───────────────────────────────────────────────────────────

/**
 * **Uploads nobody sent.** A person can pick a file, watch it upload and then close the tab; the
 * row and its bytes would sit in the bucket for ever, reachable by nobody but them and named by no
 * message. A day later this takes them, bytes first, so nothing is left in a store that no row
 * names. Files a message DOES carry are not here at any age.
 */
export async function sweepUnsentUploads(now = new Date()): Promise<number> {
  return (await sweep(now)).gone;
}

/**
 * **What the night puts right** (§6.1, §6.3): the uploads nobody sent, and — as a net under the
 * disposal that happens inside a delete's own transaction — any file left live with no live message
 * carrying it. The second list is empty every night it is asked; the night it is not, something
 * went wrong between a message's delete and its files', and this is what stops a file being kept
 * for ever with nothing able to show it.
 */
export async function sweep(now = new Date()): Promise<{ gone: number; stranded: number }> {
  const gone = await sweepUnsent(now);
  const stranded = await sweepStranded();
  return { gone, stranded };
}

/**
 * A file nothing live carries, removed the way the delete would have removed it, and recorded the
 * same way — except for a photo's preview, whose going is not an act anybody looks up. Nobody is
 * named as its deleter in the row, because nobody deleted it: the job did, on the firm's behalf.
 */
async function sweepStranded(): Promise<number> {
  const stranded = await repo.strandedChatFiles(SWEEP_LIMIT);
  let tidied = 0;
  for (const file of stranded) {
    try {
      if (!(await repo.deleteFileRowIfLive(file.id))) continue;
      await deleteStoredFile(file);
      if (file.previewInChatMessages.length === 0) {
        record("chat_file.deleted", { subjectId: file.id, subjectLabel: A_CHAT_FILE });
      }
      tidied++;
    } catch (error) {
      console.error("chat: could not tidy a file no message carries", file.id, error);
    }
  }
  return tidied;
}

async function sweepUnsent(now: Date): Promise<number> {
  const before = new Date(now.getTime() - UNSENT_HOURS * 60 * 60 * 1000);
  const stale = await repo.staleUploads(before, SWEEP_LIMIT);
  let gone = 0;
  for (const file of stale) {
    try {
      // the ROW first, and only if it is still unsent: the list was read minutes ago, and a send in
      // between would have linked it — deleting it then would take the link with it and leave the
      // message with a hole (review, 2026-09-20). Bytes nothing points at are the pruner's job
      // (`scripts/prune-uploads.ts`), so this order can only ever leave the harmless kind of litter.
      if (!(await repo.deleteIfStillUnsent(file.id))) continue;
      await deleteStoredFile(file);
      gone++;
    } catch (error) {
      console.error("chat: could not sweep an unsent upload", file.id, error);
    }
  }
  return gone;
}
