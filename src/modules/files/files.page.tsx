import { Library } from "./library";
import type { LibraryMode } from "./library-context";

const FIRM: LibraryMode = { kind: "firm" };

/**
 * **Files** (files.md §18): the whole library the reader may open — My files, Company, every
 * client's zones and Attachments, and the Trash — one tree, one open place.
 */
export function FilesPage() {
  return <Library mode={FIRM} />;
}
