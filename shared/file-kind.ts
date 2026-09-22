/**
 * **What KIND of thing a file is**, in the four words a person would use — not its media type.
 *
 * It exists for the storage figures: "this chat holds 300 MB" says nothing you can act on, and
 * "280 MB of it is photos" says what to do about it. Telegram's storage screen is built on exactly
 * this split, and it is the part of it worth copying (owner, 2026-09-22).
 *
 * Read from what the BYTES said at upload (`File.detectedMime`), falling back to what the browser
 * claimed, because the browser is shown and never believed (files.md §12.2).
 */

export type FileKind = "photo" | "pdf" | "document" | "archive" | "other";

export const FILE_KINDS: readonly FileKind[] = [
  "photo",
  "pdf",
  "document",
  "archive",
  "other",
] as const;

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  photo: "Photos",
  pdf: "PDFs",
  document: "Documents",
  archive: "Archives",
  other: "Other",
};

const DOCUMENT = [
  "msword",
  "wordprocessing",
  "spreadsheet",
  "ms-excel",
  "presentation",
  "ms-powerpoint",
  "opendocument",
  "rtf",
  "csv",
];
const ARCHIVE = ["zip", "rar", "7z", "gzip", "x-tar", "compressed"];

/** `detected` is the bytes' own word; `claimed` is the browser's, used only when there is none. */
export function fileKind(detected: string | null, claimed?: string | null): FileKind {
  const mime = (detected ?? claimed ?? "").toLowerCase();
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "photo";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "document";
  if (DOCUMENT.some((m) => mime.includes(m))) return "document";
  if (ARCHIVE.some((m) => mime.includes(m))) return "archive";
  return "other";
}
