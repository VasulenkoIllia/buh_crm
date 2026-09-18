/**
 * **A file attached to a free-form secret** (secrets.md §21, the owner's ask of 2026-09-17).
 *
 * It works the way the secret does. Its name, size and kind are open, like the title; its bytes are
 * stored and sealed by `core/files.ts` exactly as every other file's (a key of its own, sealed with
 * `SECRETS_KEY`), and they open only behind the vault's five minutes, each open or download written
 * to the journal as a reveal is. Adding and removing need what editing needs: the secret's place.
 *
 * The library's rules come with it: the name cleaned, a program refused by its name and by its
 * bytes, 25 MB at most, the CRM opening only what it can show (`modules/files`).
 */
import { SECRET_FILES_MAX, type SecretFileRow } from "@shared/schema/secrets.js";
import type { User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { MAX_FILE_SIZE, deleteStoredFile, storeFile } from "../../core/files.js";
import {
  NOT_VIEWABLE,
  detectType,
  refuseProgram,
  uploadedFileName,
  viewOf,
} from "../files/index.js";
import { fileRowOf } from "./secrets.file-row.js";
import * as repo from "./secrets.repository.js";
import type { Place } from "./secrets.repository.js";
import { visibleTo } from "./secrets.search.js";
import { activeGrant, clientPlace } from "./secrets.service.js";

export interface Incoming {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

const placeOf = (row: {
  space: string;
  ownerId: string | null;
  clientId: string | null;
}): Place =>
  row.space === "personal"
    ? { space: "personal", ownerId: row.ownerId ?? "" }
    : row.space === "company"
      ? { space: "company" }
      : { space: "client", clientId: row.clientId ?? "" };

const clientOf = (place: Place) => (place.space === "client" ? place.clientId : undefined);
const personal = (place: Place) => place.space === "personal";
/** My secrets are logged by the act, never by their words (§3.2, §11): a file's name included. */
const labelIn = (place: Place, label: string) =>
  personal(place) ? "a personal secret" : label;
const fileIn = (place: Place, name: string) => (personal(place) ? "a file" : name);
/** The journal's snapshot names the secret and the file: "Tax portal › W-9 2025.pdf". */
const journalLabel = (secretLabel: string, fileName: string) => `${secretLabel} › ${fileName}`;

async function ownFiles(secretId: string) {
  return (await repo.filesOf(secretId)).map(fileRowOf);
}

/** Bytes nothing points at: taken back now rather than left for the pruner. */
const takeBack = (stored: { path: string; storage: "local" | "s3" }) =>
  deleteStoredFile(stored).catch((e) =>
    console.error("secrets: could not remove the bytes of a refused file", e),
  );

/**
 * **A file onto a secret.** Only a free-form one takes files (the owner's rule), at most five, each
 * at most 25 MB. Writing into a client's list needs Clients open, as any write there does.
 */
export async function attachFile(
  user: User,
  secretId: string,
  incoming: Incoming,
  ip: string | null,
): Promise<SecretFileRow[]> {
  const secret = await repo.findVisibleSecret(await visibleTo(user), secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  const place = placeOf(secret);
  if (place.space === "client") await clientPlace(user, place.clientId, "write");
  if (secret.template !== "free_form") {
    throw new ValidationError("Only a free-form secret takes files");
  }

  const name = uploadedFileName(incoming.filename);
  refuseProgram(name);
  if (incoming.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError("A file must be 25 MB or smaller");
  }
  // what the bytes say it is: a renamed program is refused here too
  const detectedMime = await detectType(incoming.buffer, name);

  const stored = await storeFile(incoming.buffer);
  let attached: Awaited<ReturnType<typeof repo.attachFile>>;
  try {
    attached = await repo.attachFile(secretId, repo.ownerOf(place), SECRET_FILES_MAX, {
      ...stored,
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
  if ("refused" in attached) {
    await takeBack(stored);
    throw attached.refused === "full"
      ? new ValidationError(`A secret holds at most ${SECRET_FILES_MAX} files`)
      : new NotFoundError("Secret not found");
  }

  await repo.writeAudit({
    secretId,
    clientId: clientOf(place) ?? null,
    byUserId: user.id,
    action: "file_added",
    label: journalLabel(secret.label, name),
    ip,
  });
  record("secret.file_added", {
    subjectId: secretId,
    subjectLabel: labelIn(place, secret.label),
    clientId: clientOf(place),
    changes: { file: fileIn(place, name), size: incoming.buffer.byteLength },
  });
  return ownFiles(secretId);
}

/**
 * **Opening or downloading a file is a look at the secret** (§6, §21): it needs the vault's five
 * minutes, and it is journalled once per person, per file, per minute, as a reveal is. A file the
 * CRM does not show is refused as a view before anything is logged.
 */
export async function openFile(
  sessionId: string | null,
  user: User,
  fileId: string,
  via: "view" | "download",
  ip: string | null,
) {
  if (!activeGrant(sessionId)) throw new ForbiddenError("Enter your password to open files");
  const file = await repo.findSecretFile(await visibleTo(user), fileId);
  if (!file?.secret) throw new NotFoundError("File not found");
  if (via === "view" && !viewOf(file.detectedMime)) throw new ValidationError(NOT_VIEWABLE);

  const place = placeOf(file.secret);
  const label = journalLabel(file.secret.label, file.name);
  const justLooked = await repo.recentFileOpen(
    file.secret.id,
    user.id,
    label,
    new Date(Date.now() - 60_000),
  );
  if (!justLooked) {
    await repo.writeAudit({
      secretId: file.secret.id,
      clientId: clientOf(place) ?? null,
      byUserId: user.id,
      action: "file_opened",
      label,
      ip,
    });
    record("secret.file_opened", {
      subjectId: file.secret.id,
      subjectLabel: labelIn(place, file.secret.label),
      clientId: clientOf(place),
      changes: { file: fileIn(place, file.name), via },
    });
  }
  return file;
}

/**
 * **Removing a file is final** (§21, decision 4): the Trash stays at the secret's level. The row
 * goes first, behind the same guard as every write into a place, and then the bytes; bytes a store
 * refused are left to the pruner, sealed and named by nothing.
 */
export async function removeFile(
  user: User,
  fileId: string,
  ip: string | null,
): Promise<SecretFileRow[]> {
  const file = await repo.findSecretFile(await visibleTo(user), fileId);
  if (!file?.secret) throw new NotFoundError("File not found");
  const place = placeOf(file.secret);
  if (place.space === "client") await clientPlace(user, place.clientId, "write");

  await repo.removeFileRow(file.id, file.secret.id, repo.ownerOf(place));
  await deleteStoredFile(file).catch((e) =>
    console.error(`secrets: the bytes of removed file ${file.id} could not be deleted`, e),
  );

  await repo.writeAudit({
    secretId: file.secret.id,
    clientId: clientOf(place) ?? null,
    byUserId: user.id,
    action: "file_removed",
    label: journalLabel(file.secret.label, file.name),
    ip,
  });
  record("secret.file_removed", {
    subjectId: file.secret.id,
    subjectLabel: labelIn(place, file.secret.label),
    clientId: clientOf(place),
    changes: { file: fileIn(place, file.name) },
  });
  return ownFiles(file.secret.id);
}
