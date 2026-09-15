/**
 * **A folder upload** (files.md §7.2): what was dropped or picked, as files with the directories
 * between the drop and each of them, and the plan that makes each directory once, parents first,
 * before any file is sent into it.
 */

/** A file, and the directories from where it was dropped down to it: [] means right there. */
export interface PathedFile {
  file: File;
  dirs: string[];
}

export interface UploadBatch {
  files: PathedFile[];
  /** directories with nothing inside, kept so the structure arrives whole */
  emptyDirs: string[][];
}

/** What an operating system leaves in a folder, never a person's document: left out quietly. */
const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized"]);
const JUNK_DIRS = new Set(["__macosx"]);

export function isJunk(name: string): boolean {
  const lower = name.toLowerCase();
  // `._x` is a Mac's shadow of x on a foreign disk; `~$x` is an open Office document's lock
  return JUNK_NAMES.has(lower) || lower.startsWith("._") || lower.startsWith("~$");
}

const inJunkDir = (dirs: string[]) => dirs.some((d) => JUNK_DIRS.has(d.toLowerCase()));

/** One directory's key: the path as JSON, so no name can be mistaken for two. */
export const dirKey = (dirs: string[]) => JSON.stringify(dirs);

export interface FolderPlan {
  /** every distinct directory, each once, parents before their children */
  dirs: string[][];
  /** the files by the directory they go into; [] is where they were dropped */
  groups: { dirs: string[]; files: File[] }[];
  /** how many files were the system's, not the person's */
  skipped: number;
}

export function planFolderUpload(batch: UploadBatch): FolderPlan {
  const dirs = new Map<string, string[]>();
  const groups = new Map<string, { dirs: string[]; files: File[] }>();
  let skipped = 0;
  const note = (path: string[]) => {
    for (let depth = 1; depth <= path.length; depth++) {
      const sub = path.slice(0, depth);
      dirs.set(dirKey(sub), sub);
    }
  };
  for (const { file, dirs: path } of batch.files) {
    if (isJunk(file.name) || inJunkDir(path)) {
      skipped++;
      continue;
    }
    note(path);
    const key = dirKey(path);
    const group = groups.get(key);
    if (group) group.files.push(file);
    else groups.set(key, { dirs: path, files: [file] });
  }
  for (const path of batch.emptyDirs) if (!inJunkDir(path)) note(path);
  return {
    dirs: [...dirs.values()].sort((a, b) => a.length - b.length),
    groups: [...groups.values()],
    skipped,
  };
}

/** A folder chosen with the folder picker: each file names its path from the folder chosen. */
export function pickedFolder(list: FileList | null): UploadBatch {
  return {
    files: Array.from(list ?? []).map((file) => ({
      file,
      dirs: file.webkitRelativePath.split("/").slice(0, -1),
    })),
    emptyDirs: [],
  };
}

/**
 * What was dropped, read NOW: the browser empties a drop's `dataTransfer` once the event is over,
 * so the entries are taken while it lasts and walked afterwards. Null: a browser without entries,
 * which gets the plain list of files, as before.
 */
export function droppedEntries(data: DataTransfer): FileSystemEntry[] | null {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (items.length === 0 || typeof items[0]?.webkitGetAsEntry !== "function") return null;
  return items.flatMap((item) => {
    const entry = item.webkitGetAsEntry();
    return entry ? [entry] : [];
  });
}

/** A directory reader hands its entries out a batch at a time, until it hands out none. */
async function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** The dropped entries walked: every file with its directories, and the directories left empty. */
export async function walkEntries(entries: FileSystemEntry[]): Promise<UploadBatch> {
  const batch: UploadBatch = { files: [], emptyDirs: [] };
  async function walk(entry: FileSystemEntry, dirs: string[]): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      batch.files.push({ file, dirs });
    } else if (entry.isDirectory) {
      const path = [...dirs, entry.name];
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      if (children.length === 0) batch.emptyDirs.push(path);
      for (const child of children) await walk(child, path);
    }
  }
  for (const entry of entries) await walk(entry, []);
  return batch;
}
