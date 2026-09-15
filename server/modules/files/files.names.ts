import { REFUSED_EXTENSIONS } from "@shared/library.js";
import { ValidationError } from "../../core/errors.js";

/**
 * **What a name may hold, and the `(2)` rule** (files.md §6.1, §6.3, §14.3).
 *
 * A name reaches response headers, the search and the activity log, so it is cleaned on the way
 * in: normalised to NFC (a Mac sends "й" as two code points, and two spellings of one name would
 * dodge the unique index), control characters and path separators out, trimmed.
 */

export const FOLDER_NAME_MAX = 120;
export const FILE_NAME_MAX = 255;
/** Folder levels below a fixed level. The system's own move of a leaver's files is exempt. */
export const MAX_DEPTH = 8;

/**
 * **Programs and scripts are refused on upload** (files.md §14.3). The list is
 * `shared/library.ts`, which the browser reads too, to say so before it sends anything.
 */
const REFUSED: ReadonlySet<string> = new Set(REFUSED_EXTENSIONS);

function strip(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || ch === "/" || ch === "\\") continue;
    out += ch;
  }
  return out.trim();
}

const empty = (name: string) => name === "" || name === "." || name === "..";

function split(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Past the cap, the end of the base goes and the extension stays. */
function fit(name: string, max: number): string {
  if (name.length <= max) return name;
  const [base, ext] = split(name);
  if (ext.length >= max) return name.slice(0, max);
  return base.slice(0, max - ext.length).trimEnd() + ext;
}

/** An uploaded file's name. A browser can send an empty or an odd one, and the file still lands. */
export function uploadedFileName(raw: string): string {
  const name = strip(raw);
  return fit(empty(name) ? "file" : name, FILE_NAME_MAX);
}

/** A name a person typed for a file: refused, with the reason, when nothing usable is left. */
export function typedFileName(raw: string): string {
  const name = strip(raw);
  if (empty(name)) throw new ValidationError("A file needs a name");
  if (name.length > FILE_NAME_MAX) {
    throw new ValidationError(`A file name is at most ${FILE_NAME_MAX} characters`);
  }
  return name;
}

export function folderName(raw: string): string {
  const name = strip(raw);
  if (empty(name)) throw new ValidationError("A folder needs a name");
  if (name.length > FOLDER_NAME_MAX) {
    throw new ValidationError(`A folder name is at most ${FOLDER_NAME_MAX} characters`);
  }
  return name;
}

export function refuseProgram(name: string) {
  if (REFUSED.has(extensionOf(name))) {
    throw new ValidationError(
      `“${name}” is a program or a script, and files like that are not accepted here`,
    );
  }
}

/**
 * `name (2).ext`, then `(3)`: the first name no live item in the folder has, case-insensitively.
 * Nothing is ever overwritten; there are no versions in v1 (files.md §6.3).
 */
export function firstFreeName(
  name: string,
  taken: ReadonlySet<string>,
  max = FILE_NAME_MAX,
): string {
  if (!taken.has(name.toLowerCase())) return name;
  const [base, ext] = split(name);
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate =
      base.slice(0, Math.max(1, max - ext.length - suffix.length)) + suffix + ext;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * `name (2)`, then `(3)`, for a folder. A folder has no extension, so the number goes at the end
 * even when the name holds a dot: "2024.Q1 (2)", not "2024 (2).Q1".
 */
export function firstFreeFolderName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, FOLDER_NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const PERSONAL = " (personal)";

/**
 * **The Company folder a blocked person's My files move into**: "Olena Petrenko (personal)"
 * (files.md §8.3). Cleaned like any folder name, and the person's part shortened so that
 * " (personal) (99)" still fits in 120 characters.
 */
export function personalFolderName(person: string): string {
  const cleaned = strip(person);
  const who = empty(cleaned) ? "Someone" : cleaned;
  const room = FOLDER_NAME_MAX - PERSONAL.length - " (99)".length;
  return `${who.slice(0, room).trimEnd()}${PERSONAL}`;
}
