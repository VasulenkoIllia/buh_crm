import { fileTypeFromBuffer } from "file-type";
import type { FileView } from "@shared/schema/files.js";
import { REFUSED_EXTENSIONS } from "@shared/library.js";
import { ValidationError } from "../../core/errors.js";
import { extensionOf } from "./files.names.js";

/**
 * **What a file really is, read from its bytes** (files.md §12.2, §14.3), stored as `detectedMime`
 * at upload. The name a browser sends and the type it claims are never believed for anything that
 * could open or run.
 *
 * - `file-type` reads the magic bytes. It is pinned to 21: 22 needs Node 22, and the laptops run 20
 *   beside the servers' 24.
 * - Text has no magic bytes. A `.txt` or `.csv` whose first 64 KB is valid UTF-8 with no NUL byte
 *   is stored as `text/plain` or `text/csv`, and is only ever rendered by the CRM, escaped.
 * - HTML, SVG and XML are never shown inline, whatever their extension: nothing below maps them to
 *   a viewer. Legacy `.doc` and `.xls` look like any compound file and stay downloads.
 */

/** Programs the bytes give away, whatever the name says: a renamed one is refused as well. */
const PROGRAMS: ReadonlySet<string> = new Set([
  ...REFUSED_EXTENSIONS,
  "elf",
  "macho",
  "apk",
  "xar",
]);

const TEXT_TYPES: Record<string, string> = { txt: "text/plain", csv: "text/csv" };
const TEXT_SNIFF = 64 * 1024;

function isUtf8Text(bytes: Buffer): boolean {
  const head = bytes.subarray(0, TEXT_SNIFF);
  if (head.includes(0)) return false;
  try {
    // `stream`, so a character cut in two at the 64 KB mark is not taken for broken text
    new TextDecoder("utf-8", { fatal: true }).decode(head, {
      stream: bytes.length > TEXT_SNIFF,
    });
    return true;
  } catch {
    return false;
  }
}

/** What the bytes are, and whether they are a program. Nothing is refused here. */
export async function sniff(
  bytes: Buffer,
  name: string,
): Promise<{ mime: string | null; program: boolean }> {
  const found = await fileTypeFromBuffer(bytes);
  if (found) return { mime: found.mime, program: PROGRAMS.has(found.ext) };
  const text = TEXT_TYPES[extensionOf(name)];
  return { mime: text && isUtf8Text(bytes) ? text : null, program: false };
}

/** An upload's type from its bytes; null when they name nothing the CRM shows or refuses. */
export async function detectType(bytes: Buffer, name: string): Promise<string | null> {
  const { mime, program } = await sniff(bytes, name);
  if (program) {
    throw new ValidationError(
      `“${name}” is a program, whatever its name says, and files like that are not accepted here`,
    );
  }
  return mime;
}

const IMAGES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Which of the CRM's viewers opens a file, from its detected type alone (§12.1). */
export function viewOf(detectedMime: string | null): FileView {
  if (detectedMime === "application/pdf") return "pdf";
  if (detectedMime && IMAGES.has(detectedMime)) return "image";
  if (detectedMime === "text/plain") return "text";
  if (detectedMime === "text/csv") return "csv";
  return null;
}

/** A download says what the bytes are, or nothing: never the browser's claim at upload. */
export function downloadType(detectedMime: string | null): string {
  return detectedMime ?? "application/octet-stream";
}

/**
 * **The headers a view sends** (§12.2), or null when the file does not open in the CRM.
 *
 * Every view is `private, no-store`: Cloudflare caches by extension, and a tax document must not
 * stay in a shared office browser's cache after sign-out. The route sends no `Accept-Ranges`, so
 * one open is one request and one logged view.
 * - **A PDF** never carries `sandbox`, in any form: Safari shows an empty frame for it, and Chrome
 *   and Firefox drop it anyway. Its policy's real work is `frame-ancestors 'self'`: no other site
 *   can frame it.
 * - **Images and text** carry `sandbox` with no allowances, so the response is a document of no
 *   origin that can run nothing. Text goes out as plain UTF-8 text; the CRM renders it, escaped.
 */
export function viewHeaders(file: {
  name: string;
  detectedMime: string | null;
}): Record<string, string> | null {
  const view = viewOf(file.detectedMime);
  if (!view) return null;
  const common = {
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
  if (view === "pdf") {
    return {
      ...common,
      "Content-Type": "application/pdf",
      "Content-Security-Policy":
        "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    };
  }
  return {
    ...common,
    "Content-Type":
      view === "image" ? (file.detectedMime as string) : "text/plain; charset=utf-8",
    "Content-Security-Policy": "sandbox",
  };
}
