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

export const NOT_VIEWABLE = "This file does not open in the CRM; download it instead";
