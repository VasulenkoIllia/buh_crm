import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Building2,
  Download,
  Eye,
  FolderInput,
  FolderOpen,
  Info,
  Lock,
  Paperclip,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { FileRow, FolderRow } from "@shared/schema/files";
import { ZONE_LABEL, ZONE_NOTE } from "@shared/library";
import { plural } from "@shared/text";
import { cn } from "@/shared/lib/cn";
import { fmtBytes, fmtDate } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { ClientCode } from "@/shared/ui/client-code";
import { Menu, type MenuItem } from "@/shared/ui/menu";
import { CopyLink } from "@/shared/ui/copy-link";
import { ExtBadge, FolderBadge, download, errorText } from "./file-bits";
import { useCreateFolder, useListing, useRename } from "./files.api";
import {
  folderNodeKey,
  pickedFacts,
  useLibrary,
  type Picked,
  type Target,
} from "./library-context";
import {
  CHECK_CELL,
  CrumbTrail,
  EmptyState,
  Loading,
  MENU_CELL,
  Note,
  PaneError,
  PaneFrame,
  ROW,
  TD,
  TH,
  type Crumb,
} from "./pane-parts";
import { downloadUrl, placeKey, placeLabel, textUrl, viewUrl, type UiPlace } from "./places";

/**
 * **The open folder** (files.md §7): what is in it, sortable; a selection by checkbox, Shift and
 * Ctrl; each row's own menu; a name changed where it stands; a folder made in place; files dropped
 * in from the computer; and rows dragged onto a folder, here or in the tree, to move them.
 */

type Item =
  { key: string; kind: "folder"; row: FolderRow } | { key: string; kind: "file"; row: FileRow };

type SortKey = "name" | "size" | "at" | "by";
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size", numeric: true },
  { key: "at", label: "Added" },
  { key: "by", label: "Uploaded by" },
];

function valueOf(item: Item, key: SortKey): string | number {
  if (key === "size") return item.kind === "folder" ? item.row.totals.bytes : item.row.size;
  if (key === "at") return Date.parse(item.row.createdAt);
  if (key === "by")
    return item.kind === "folder" ? (item.row.createdBy ?? "") : item.row.uploadedBy;
  return item.row.name;
}

/** Folders first, always; then by the column, names compared the way people count (2 before 10). */
function sortItems(items: Item[], sort: Sort): Item[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const x = valueOf(a, sort.key);
    const y = valueOf(b, sort.key);
    const order =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), "en", { numeric: true });
    return order * sort.dir;
  });
}

function pickOf(place: UiPlace, parentId: string | null, items: Item[]): Picked {
  return {
    place,
    parentId,
    folders: items.flatMap((i) => (i.kind === "folder" ? [i.row] : [])),
    files: items.flatMap((i) => (i.kind === "file" ? [i.row] : [])),
  };
}

const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
/** a click on the row's own checkbox, menu or name field is not a click on the row */
const onControl = (e: MouseEvent) =>
  (e.target as HTMLElement).closest("input, button, a") !== null;

export function FolderPane({
  place,
  folderId,
  focus,
  tools,
}: {
  place: UiPlace;
  folderId: string | null;
  /** the row to mark once the folder is open, coming from a search result */
  focus?: string;
  tools?: ReactNode;
}) {
  const lib = useLibrary();
  const { expand, epoch } = lib;
  const listing = useListing(place, folderId);
  const data = listing.data;
  const create = useCreateFolder();
  const rename = useRename();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: "name", dir: 1 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const writable = lib.canWrite(place);

  // the tree follows the folder that is open
  useEffect(() => {
    if (data) expand([placeKey(place), ...data.crumbs.map((c) => folderNodeKey(c.id))]);
  }, [data, expand, place]);

  // after a move or a delete, what was chosen is somewhere else
  useEffect(() => {
    setSelected(new Set<string>());
  }, [epoch]);

  const items = useMemo(
    () =>
      sortItems(
        [
          ...(data?.folders ?? []).map((row): Item => ({
            key: `folder:${row.id}`,
            kind: "folder",
            row,
          })),
          ...(data?.files ?? []).map((row): Item => ({
            key: `file:${row.id}`,
            kind: "file",
            row,
          })),
        ],
        sort,
      ),
    [data, sort],
  );
  const chosen = items.filter((i) => selected.has(i.key));
  const selection = pickOf(place, folderId, chosen);
  const clientLabel = place.kind === "client" ? lib.client(place.clientId).label : undefined;
  const here: Target = {
    place,
    folderId,
    label: data?.folder?.name ?? placeLabel(place, clientLabel),
  };

  // from a search result (§13): the row it named is chosen and brought into view, once. The search
  // pane stands in this one's place, so every arrival from a hit is a fresh mount.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || focused.current === focus || !items.some((i) => i.key === focus)) return;
    focused.current = focus;
    setSelected(new Set<string>([focus]));
    setAnchor(focus);
    document
      .querySelector(`[data-row="${CSS.escape(focus)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focus, items]);

  // Escape lets go of the selection; Delete puts it in the Trash, as the menu does
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lib.busy) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))
        return;
      if (e.key === "Escape") setSelected(new Set<string>());
      else if ((e.key === "Delete" || e.key === "Backspace") && chosen.length > 0 && writable) {
        e.preventDefault();
        lib.askDelete(selection);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function choose(key: string, e: MouseEvent) {
    const order = items.map((i) => i.key);
    const adding = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchor && order.includes(anchor)) {
      const a = order.indexOf(anchor);
      const b = order.indexOf(key);
      const next = new Set<string>(adding ? selected : []);
      for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k);
      setSelected(next);
      return;
    }
    if (adding) {
      const next = new Set<string>(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelected(next);
    } else {
      setSelected(new Set<string>([key]));
    }
    setAnchor(key);
  }

  function toggle(key: string) {
    const next = new Set<string>(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    setAnchor(key);
  }

  function open(item: Item) {
    if (item.kind === "folder") {
      lib.go({ type: "place", place, folderId: item.row.id });
      return;
    }
    // what opens in the CRM opens in the viewer, stepping through this folder's files in the
    // order shown; the rest download, as they always did (files.md §12)
    if (!item.row.view) {
      download([downloadUrl(place, item.row.id)]);
      return;
    }
    const files = items.flatMap((i) => (i.kind === "file" ? [i.row] : []));
    lib.openViewer(
      files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        createdAt: f.createdAt,
        uploadedBy: f.uploadedBy,
        view: f.view,
        viewUrl: viewUrl(place, f.id),
        downloadUrl: downloadUrl(place, f.id),
        updatedAt: f.updatedAt,
        // text is edited where its reader may write (§7.4); everything else opens as it did
        saveUrl:
          writable && (f.view === "text" || f.view === "csv")
            ? textUrl(place, f.id)
            : undefined,
      })),
      files.findIndex((f) => f.id === item.row.id),
    );
  }

  async function submitRename(item: Item, value: string) {
    const name = value.trim();
    if (!name || name === item.row.name) {
      setRenaming(null);
      setRenameError(null);
      return;
    }
    try {
      await rename.mutateAsync({ place, kind: item.kind, id: item.row.id, name });
      setRenaming(null);
      setRenameError(null);
    } catch (error) {
      setRenameError(errorText(error));
    }
  }

  async function submitCreate(value: string) {
    const name = value.trim();
    if (!name) {
      lib.setCreating(false);
      setCreateError(null);
      return;
    }
    try {
      await create.mutateAsync({ place, parentId: folderId, name });
      lib.setCreating(false);
      setCreateError(null);
    } catch (error) {
      setCreateError(errorText(error));
    }
  }

  // ── where you are ──
  const crumbs: Crumb[] = [];
  if (place.kind === "client" && lib.mode.kind === "firm") {
    const c = lib.client(place.clientId);
    crumbs.push(
      { key: "clients", label: "Clients", view: { type: "clients" } },
      {
        key: "client",
        label: (
          <>
            {c.label}
            {c.code !== null && <ClientCode code={c.code} className="ml-1.5 min-w-0" />}
          </>
        ),
        view: { type: "client", clientId: place.clientId },
      },
    );
  }
  const trail = data?.crumbs ?? [];
  crumbs.push({
    key: "root",
    label: place.kind === "client" ? ZONE_LABEL[place.zone] : placeLabel(place),
    view: trail.length > 0 ? { type: "place", place, folderId: null } : undefined,
  });
  trail.forEach((c, i) =>
    crumbs.push({
      key: c.id,
      label: c.name,
      view: i < trail.length - 1 ? { type: "place", place, folderId: c.id } : undefined,
    }),
  );

  // ── the bar: what is chosen, or what is here ──
  let bar: ReactNode = null;
  if (chosen.length > 0) {
    const f = pickedFacts(selection);
    const urls = selection.files.map((r) => downloadUrl(place, r.id));
    bar = (
      <>
        <span className="text-[13px] font-semibold tabular-nums text-primary-link">
          {plural(f.items, "item")} selected{" "}
          <span className="text-[12.5px] font-normal text-muted">
            · {plural(f.files, "file")} · {fmtBytes(f.bytes)}
            {f.inFolders > 0 && ` — ${plural(f.inFolders, "file")} inside folders`}
          </span>
        </span>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          disabled={urls.length === 0}
          title={
            selection.folders.length > 0
              ? "Downloads the files you chose; open a folder to download what is in it"
              : undefined
          }
          onClick={() => download(urls)}
        >
          <Download size={14} />
          Download
        </Button>
        {writable && (
          <>
            <Button variant="secondary" size="sm" onClick={() => lib.askMove(selection)}>
              <FolderInput size={14} />
              Move
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="text-danger-text"
              onClick={() => lib.askDelete(selection)}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          </>
        )}
        <IconButton label="Clear the selection" onClick={() => setSelected(new Set<string>())}>
          <X size={15} />
        </IconButton>
      </>
    );
  } else if (data) {
    const folders = data.folders.length;
    bar = (
      <>
        <span className="text-[12.5px] tabular-nums text-muted">
          {folders > 0 && `${plural(folders, "folder")} · `}
          {plural(data.files.length, "file")} here · {fmtBytes(data.totals.bytes)} in all
        </span>
        <span className="flex-1" />
        <span className="hidden text-[12px] text-faint xl:inline">
          {writable
            ? "Shift or Ctrl to select several · drag onto a folder to move · drop files here to upload"
            : "You can open and download here; changes are not yours to make"}
        </span>
        {/* a folder is a record like any other: the link to it is this screen opened at it
            (chat.md §5.6) */}
        {folderId && (
          <CopyLink href={`/files?folder=${folderId}`} label="Copy link to this folder" />
        )}
      </>
    );
  }

  // ── the list ──
  let body: ReactNode;
  if (listing.error) {
    body = <PaneError error={listing.error} />;
  } else if (!data) {
    body = <Loading />;
  } else if (items.length === 0 && !lib.creating) {
    body = (
      <EmptyState icon={<Upload size={20} />} title="Nothing here yet">
        {writable &&
          `Drop files here to upload them into ${here.label}, or make a folder first.`}
      </EmptyState>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH, CHECK_CELL)}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={items.length > 0 && chosen.length === items.length}
                  onChange={(e) =>
                    setSelected(
                      new Set<string>(e.target.checked ? items.map((i) => i.key) : []),
                    )
                  }
                />
              </th>
              {COLUMNS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={cn(TH, c.numeric && "text-right")}
                    aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 uppercase hover:text-ink-700"
                      onClick={() =>
                        setSort({
                          key: c.key,
                          // sizes and dates start with the biggest and newest
                          dir: on
                            ? sort.dir === 1
                              ? -1
                              : 1
                            : c.numeric || c.key === "at"
                              ? -1
                              : 1,
                        })
                      }
                    >
                      {c.label}
                      {on && (
                        <span className="text-primary-link">{sort.dir > 0 ? "↑" : "↓"}</span>
                      )}
                    </button>
                  </th>
                );
              })}
              <th className={cn(TH, MENU_CELL)} />
            </tr>
          </thead>
          <tbody>
            {lib.creating && (
              <tr className={ROW}>
                <td className={cn(TD, CHECK_CELL)} />
                <td className={cn(TD, "whitespace-normal")} colSpan={5}>
                  <div className="flex items-center gap-2.5">
                    <FolderBadge />
                    <NameInput
                      label="New folder name"
                      placeholder="Folder name"
                      error={createError}
                      busy={create.isPending}
                      onSubmit={(v) => void submitCreate(v)}
                      onCancel={() => {
                        lib.setCreating(false);
                        setCreateError(null);
                      }}
                    />
                  </div>
                </td>
              </tr>
            )}
            {items.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                place={place}
                picked={selected.has(item.key) ? selection : pickOf(place, folderId, [item])}
                checked={selected.has(item.key)}
                writable={writable}
                renaming={renaming === item.row.id}
                renameError={renaming === item.row.id ? renameError : null}
                renameBusy={rename.isPending}
                onChoose={(e) => choose(item.key, e)}
                onToggle={() => toggle(item.key)}
                onOpen={() => open(item)}
                onRename={() => {
                  lib.setCreating(false);
                  setRenameError(null);
                  setRenaming(item.row.id);
                }}
                onRenamed={(v) => void submitRename(item, v)}
                onRenameCancel={() => {
                  setRenaming(null);
                  setRenameError(null);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <PaneFrame
      label="Open folder"
      crumbs={<CrumbTrail parts={crumbs} />}
      tools={tools}
      note={<PlaceNote place={place} atRoot={folderId === null} />}
      bar={bar}
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = writable ? "copy" : "none";
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        if (writable) lib.uploadDropped(e.dataTransfer, here);
      }}
    >
      {body}
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-[5] grid place-items-center rounded-(--radius-panel) border-2 border-dashed border-primary bg-[#eef1fd]/95 p-6 text-center text-[15px] font-semibold text-primary-link">
          <div>
            {writable ? `Drop to upload into ${here.label}` : "You cannot upload here"}
            <small className="mt-1 block text-[12.5px] font-normal text-[#4c62c4]">
              {writable
                ? "Files or whole folders, up to 25 MB a file"
                : "This place is read-only for you"}
            </small>
          </div>
        </div>
      )}
    </PaneFrame>
  );
}

/** What the place is, above its list: always for what the client sees, at the top for the rest. */
function PlaceNote({ place, atRoot }: { place: UiPlace; atRoot: boolean }) {
  if (place.kind === "client") {
    if (place.zone === "shared") {
      return (
        <Note tone="shared" icon={<Eye size={15} />}>
          {ZONE_NOTE.shared}
        </Note>
      );
    }
    if (place.zone === "from_client") {
      return (
        <Note tone="from" icon={<Info size={15} />}>
          {ZONE_NOTE.from_client}
        </Note>
      );
    }
    return atRoot ? <Note icon={<Lock size={15} />}>{ZONE_NOTE.internal}</Note> : null;
  }
  if (!atRoot) return null;
  return place.kind === "my" ? (
    <Note icon={<Lock size={15} />}>Only you see My files — not colleagues, not admins.</Note>
  ) : (
    <Note icon={<Building2 size={15} />}>
      {"The firm's own documents. Everyone who can open Files sees them."}
    </Note>
  );
}

function ItemRow({
  item,
  place,
  picked,
  checked,
  writable,
  renaming,
  renameError,
  renameBusy,
  onChoose,
  onToggle,
  onOpen,
  onRename,
  onRenamed,
  onRenameCancel,
}: {
  item: Item;
  place: UiPlace;
  /** what a drag or the menu takes: the whole selection when this row is in it */
  picked: Picked;
  checked: boolean;
  writable: boolean;
  renaming: boolean;
  renameError: string | null;
  renameBusy: boolean;
  onChoose: (e: MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
  onRename: () => void;
  onRenamed: (name: string) => void;
  onRenameCancel: () => void;
}) {
  const lib = useLibrary();
  const into: Target | undefined =
    item.kind === "folder" ? { place, folderId: item.row.id, label: item.row.name } : undefined;
  const drag = useDraggable({
    id: `row:${item.key}`,
    data: { picked },
    disabled: !writable || renaming,
  });
  const drop = useDroppable({
    id: `into:${item.key}`,
    data: into,
    // a folder being dragged, or one under it, is no place to drop it
    disabled: !into || !writable || lib.noDrop.has(item.row.id),
  });

  const actions: (MenuItem | "divider")[] =
    item.kind === "folder"
      ? [{ label: "Open", icon: <FolderOpen size={15} />, onSelect: onOpen }]
      : item.row.view
        ? [
            { label: "Open", icon: <Eye size={15} />, onSelect: onOpen },
            {
              label: "Download",
              icon: <Download size={15} />,
              onSelect: () => download([downloadUrl(place, item.row.id)]),
            },
          ]
        : [{ label: "Download", icon: <Download size={15} />, onSelect: onOpen }];
  if (writable) {
    actions.push(
      { label: "Rename", icon: <Pencil size={15} />, onSelect: onRename },
      { label: "Move…", icon: <FolderInput size={15} />, onSelect: () => lib.askMove(picked) },
      "divider",
      {
        label: "Delete",
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => lib.askDelete(picked),
      },
    );
  }
  const size = item.kind === "folder" ? item.row.totals.bytes : item.row.size;
  const by = item.kind === "folder" ? (item.row.createdBy ?? "—") : item.row.uploadedBy;

  return (
    <tr
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      data-row={item.key}
      aria-selected={checked}
      onClick={(e) => {
        if (!onControl(e)) onChoose(e);
      }}
      onDoubleClick={(e) => {
        if (!onControl(e)) onOpen();
      }}
      className={cn(
        ROW,
        "select-none",
        checked ? "[&>td]:bg-[#eef1fd]" : "hover:[&>td]:bg-[#f7f8fa]",
        drag.isDragging && "opacity-40",
        drop.isOver &&
          "[&>td]:bg-[#eef1fd] [&>td]:shadow-[inset_0_2px_0_var(--color-primary),inset_0_-2px_0_var(--color-primary)]",
      )}
    >
      <td className={cn(TD, CHECK_CELL)}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${item.row.name}`}
        />
      </td>
      <td className={cn(TD, "w-[55%] whitespace-normal")}>
        <div className="flex min-w-0 items-center gap-2.5">
          {item.kind === "folder" ? <FolderBadge /> : <ExtBadge name={item.row.name} />}
          {renaming ? (
            <NameInput
              label="New name"
              initial={item.row.name}
              selectStem={item.kind === "file"}
              error={renameError}
              busy={renameBusy}
              onSubmit={onRenamed}
              onCancel={onRenameCancel}
            />
          ) : (
            <div className="min-w-0">
              <span className="font-medium text-ink [overflow-wrap:anywhere]">
                {item.row.name}
              </span>
              {item.kind === "file" && item.row.task && (
                <Chip
                  tone="blue"
                  size="sm"
                  className="ml-1.5 gap-1 align-[1px]"
                  title="Also attached to this task"
                >
                  <Paperclip size={11} />
                  {item.row.task.title}
                </Chip>
              )}
              {item.kind === "folder" && (
                <span className="block text-[11.5px] text-muted-400">
                  {plural(item.row.totals.files, "file")}
                </span>
              )}
            </div>
          )}
        </div>
      </td>
      <td className={cn(TD, "text-right tabular-nums")}>{fmtBytes(size)}</td>
      <td className={TD}>{fmtDate(item.row.createdAt)}</td>
      <td className={TD}>{by}</td>
      <td className={cn(TD, MENU_CELL)}>
        <Menu label={`Actions for ${item.row.name}`} items={actions} />
      </td>
    </tr>
  );
}

/**
 * A name typed where it stands: a new folder's, or a rename. Enter saves, Escape cancels, and
 * leaving the field saves what is in it. A file's name is chosen up to its extension, so typing
 * replaces the name and keeps the type.
 */
function NameInput({
  label,
  initial = "",
  placeholder,
  selectStem = false,
  error,
  busy = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  selectStem?: boolean;
  error: string | null;
  /** the name is on its way to the server: Enter and Escape wait for the answer */
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  // once Enter or Escape has spoken, the blur that follows must not save a second time
  const settled = useRef(false);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    const dot = selectStem ? el.value.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, [selectStem]);

  // a refusal hands the field back
  useEffect(() => {
    settled.current = false;
  }, [error]);

  return (
    <div className="min-w-0 flex-1">
      <input
        ref={field}
        defaultValue={initial}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        maxLength={255}
        readOnly={busy}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // while the name is on its way, neither a second Enter nor an Escape may speak: the row
          // would look cancelled, and the save land all the same
          if (busy && (e.key === "Enter" || e.key === "Escape")) {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            settled.current = true;
            onSubmit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            settled.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => {
          if (!settled.current && !busy) onSubmit(e.currentTarget.value);
        }}
        className="h-[30px] w-full max-w-[380px] rounded-(--radius-btn-sm) border border-primary px-2 text-[13px] shadow-[0_0_0_3px_#eef1fd] outline-none"
      />
      <span
        className={cn(
          "mt-0.5 block text-[11.5px]",
          error ? "text-danger-text" : "text-muted-400",
        )}
      >
        {error ?? "Enter to save · Esc to cancel"}
      </span>
    </div>
  );
}
