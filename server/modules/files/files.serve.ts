import type { FastifyReply } from "fastify";
import { readStoredFile, type FileBytes } from "../../core/files.js";
import { ValidationError } from "../../core/errors.js";
import { downloadType, viewHeaders } from "./files.types.js";

/**
 * **How a stored file leaves the server** (files.md §12.2), one place for every route that sends
 * one: the library's, the client card's and the task card's.
 */

type Served = FileBytes & { name: string; detectedMime: string | null };

/** A download: `attachment`, typed as its bytes are, never as the browser claimed at upload. */
export async function sendDownload(reply: FastifyReply, file: Served) {
  reply.header("Content-Type", downloadType(file.detectedMime));
  reply.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  return reply.send(await readStoredFile(file));
}

/**
 * A view: the headers its type calls for. They are set here, in the handler, so the view's
 * `Content-Security-Policy` replaces helmet's whole header instead of merging with it. The service
 * has already refused a file that does not open in the CRM, before logging anything; this refuses
 * it again, before a byte is read.
 */
export async function sendView(reply: FastifyReply, file: Served) {
  const headers = viewHeaders(file);
  if (!headers) throw new ValidationError(NOT_VIEWABLE);
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  return reply.send(await readStoredFile(file));
}

/**
 * **A chat photo's preview** (chat.md §6.2): the small JPEG the sender's browser drew, served to
 * the chat's members. The third door, and the only one that may be cached — a file's bytes never
 * change and its id is unique, so a conversation scrolled up and down does not fetch every
 * thumbnail again. A library file is `no-store` because its access can be taken away between two
 * reads; a preview is refetched on a hard reload, and its access is asked again then.
 *
 * The caller has already checked that this file is a picture and that the reader may see it.
 */
export async function sendPreview(reply: FastifyReply, file: Served) {
  reply.header("Content-Type", file.detectedMime ?? "application/octet-stream");
  reply.header(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "sandbox");
  reply.header("Cache-Control", "private, max-age=604800, immutable");
  return reply.send(await readStoredFile(file));
}

export const NOT_VIEWABLE = "This file does not open in the CRM; download it instead";
