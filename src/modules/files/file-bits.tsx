import { Folder } from "lucide-react";
import type { FileTotals, FolderNode } from "@shared/schema/files";
import { extensionOf, type FileZone } from "@shared/library";
import { plural } from "@shared/text";
import { cn } from "@/shared/lib/cn";
import { fmtBytes } from "@/shared/lib/format";

/** Small pieces every part of the library draws with. */

const EXT_TONE: [RegExp, string][] = [
  [/^pdf$/, "bg-[#fdebea] text-danger-text"],
  [/^(jpe?g|png|gif|webp|heic|tiff?)$/, "bg-[#e5f5f2] text-[#0b6b5f]"],
  [/^(xlsx?|csv|ods|numbers)$/, "bg-success-soft text-[#1f7a36]"],
  [/^(docx?|rtf|odt|pages)$/, "bg-[#e8eefc] text-primary-link"],
  [/^(qb[wbox]|qbm|iif|tlg)$/, "bg-[#f0ebfb] text-[#6b3fc2]"],
];

/** A file's type at a glance: its extension, in the colour of its kind. */
export function ExtBadge({ name }: { name: string }) {
  const ext = extensionOf(name);
  const tone = EXT_TONE.find(([kind]) => kind.test(ext))?.[1] ?? "bg-divider text-muted";
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-[30px] w-[30px] flex-none place-items-center rounded-[7px] text-[9.5px] font-bold uppercase tracking-[0.02em]",
        tone,
      )}
    >
      {(ext || "file").slice(0, 4)}
    </span>
  );
}

export function FolderBadge() {
  return (
    <span
      aria-hidden
      className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[7px] bg-[#fff3d6] text-[#b07800]"
    >
      <Folder size={17} />
    </span>
  );
}

const ZONE_DOT: Record<FileZone, string> = {
  internal: "bg-[#64748b]",
  shared: "bg-primary",
  from_client: "bg-[#0e8a7a]",
};

/** A zone's colour, in the 15px slot an icon would take. */
export function ZoneDot({ zone }: { zone: FileZone }) {
  return (
    <span aria-hidden className="grid w-[15px] flex-none place-items-center">
      <span className={cn("h-2 w-2 rounded-full", ZONE_DOT[zone])} />
    </span>
  );
}

export const totalsText = (t: FileTotals) =>
  `${plural(t.files, "file")} · ${fmtBytes(t.bytes)}`;

export const addTotals = (list: FileTotals[]): FileTotals => ({
  files: list.reduce((sum, t) => sum + t.files, 0),
  bytes: list.reduce((sum, t) => sum + t.bytes, 0),
});

export const sumSizes = (rows: { size: number }[]): FileTotals => ({
  files: rows.length,
  bytes: rows.reduce((sum, r) => sum + r.size, 0),
});

/** A place's folders, parent → children, each level in name order (2 before 10). */
export function childrenOf(tree: FolderNode[]): Map<string | null, FolderNode[]> {
  const out = new Map<string | null, FolderNode[]>();
  for (const folder of tree) {
    const siblings = out.get(folder.parentId);
    if (siblings) siblings.push(folder);
    else out.set(folder.parentId, [folder]);
  }
  for (const siblings of out.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  }
  return out;
}

/** These folders and every folder under them: where a folder being moved may not go. */
export function subtreeOf(tree: FolderNode[], roots: string[]): Set<string> {
  const kids = childrenOf(tree);
  const out = new Set<string>(roots);
  const next = [...roots];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    for (const child of kids.get(id) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      next.push(child.id);
    }
  }
  return out;
}

/**
 * A download without leaving the page: every route answers `attachment`, so the browser saves
 * the file and stays where it is. Several go a moment apart, or the browser takes the burst for a
 * page misbehaving and keeps only the first.
 */
export function download(urls: string[]) {
  urls.forEach((url, i) => {
    window.setTimeout(() => {
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
}

export function errorText(error: unknown, fallback = "Something went wrong"): string {
  return error instanceof Error ? error.message : fallback;
}

/** What a restore says about names taken while the items were away (§9). */
export function renamedNote(renamed: { name: string }[]): string {
  const [first] = renamed;
  if (!first) return "";
  return renamed.length === 1
    ? ` — one came back as “${first.name}”, its name was taken`
    : ` — ${renamed.length} came back renamed, their names were taken`;
}
