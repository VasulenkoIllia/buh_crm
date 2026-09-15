import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, FolderPlus, FolderUp, Upload } from "lucide-react";
import type { FolderNode } from "@shared/schema/files";
import { plural } from "@shared/text";
import { useAuth, useCanEdit, useCanOpen } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { FILES_KEY } from "@/shared/lib/query-keys";
import { Button } from "@/shared/ui/button";
import { useDebounced } from "@/shared/lib/use-debounced";
import { Menu } from "@/shared/ui/menu";
import { SearchInput } from "@/shared/ui/search-input";
import { useToast } from "@/shared/ui/toast";
import { DeleteDialog, FileToFolderDialog, MoveDialog, UploadConfirmDialog } from "./dialogs";
import { ExtBadge, FolderBadge, errorText, renamedNote, subtreeOf } from "./file-bits";
import {
  ensureFolder,
  refreshLibrary,
  useClientNodes,
  useListing,
  useMove,
  useRestore,
  useTrashItems,
} from "./files.api";
import { FolderPane } from "./folder-pane";
import {
  dirKey,
  droppedEntries,
  pickedFolder,
  planFolderUpload,
  walkEntries,
  type UploadBatch,
} from "./folder-upload";
import {
  LibraryContext,
  clientNodeKey,
  pickedFacts,
  type LibraryApi,
  type LibraryMode,
  type Picked,
  type Target,
} from "./library-context";
import { checkMove } from "./move-rules";
import { AttachmentsPane, ClientPane, ClientsPane, TrashPane } from "./other-panes";
import {
  COMPANY,
  clientSees,
  placeInput,
  placeKey,
  placeLabel,
  samePlace,
  type View,
} from "./places";
import { ClientTree, FirmTree } from "./tree";
import { UploadQueuePanel, useUploadQueue } from "./upload-queue";
import { Viewer, type Viewable } from "./viewer";
import { SearchPane, type SearchFilters } from "./search-pane";

/**
 * **The library's browser** (files.md §18): the tree on the left, the open place on the right,
 * and everything that acts across the two: the dialogs, the upload queue, the Undo after a
 * delete, and the drag that carries rows from the list onto the tree.
 */

type Dialog =
  | { kind: "move"; picked: Picked; target?: Target }
  | { kind: "delete"; picked: Picked }
  | { kind: "file"; file: { id: string; name: string }; clientId: string | null }
  | { kind: "upload"; batch: UploadBatch; count: number; target: Target };

/** The tree nodes a view needs open to be seen. */
function keysFor(view: View): string[] {
  switch (view.type) {
    case "place":
      return view.place.kind === "client"
        ? ["clients", clientNodeKey(view.place.clientId), placeKey(view.place)]
        : [placeKey(view.place)];
    case "clients":
      return ["clients"];
    case "client":
      return ["clients", clientNodeKey(view.clientId)];
    case "attachments":
      return view.clientId ? ["clients", clientNodeKey(view.clientId)] : ["company"];
    case "trash":
    case "search":
      return [];
  }
}

function startView(mode: LibraryMode): View {
  return mode.kind === "firm"
    ? { type: "place", place: COMPANY, folderId: null }
    : {
        type: "place",
        place: { kind: "client", clientId: mode.clientId, zone: "internal" },
        folderId: null,
      };
}

/** What is being dragged rides beside the pointer, not where the row began. */
const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  const at = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!at || !draggingNodeRect) return transform;
  return {
    ...transform,
    x: transform.x + at.x - draggingNodeRect.left + 14,
    y: transform.y + at.y - draggingNodeRect.top + 10,
  };
};

const pickedIn = (data: unknown): Picked | null =>
  (data as { picked?: Picked } | undefined)?.picked ?? null;

export function Library({ mode }: { mode: LibraryMode }) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const editFiles = useCanEdit("files");
  const editClients = useCanEdit("clients");
  const clientsOpen = useCanOpen("clients");
  const toast = useToast();
  const queryClient = useQueryClient();
  const queue = useUploadQueue();
  const move = useMove();
  const trash = useTrashItems();
  const restore = useRestore();
  const nodes = useClientNodes(mode.kind === "firm" && clientsOpen);

  const [view, setView] = useState<View>(() => startView(mode));
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set<string>(keysFor(startView(mode))),
  );
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dragged, setDragged] = useState<Picked | null>(null);
  const [noDrop, setNoDrop] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [epoch, setEpoch] = useState(0);
  const [viewing, setViewing] = useState<{ items: Viewable[]; index: number } | null>(null);
  // folder uploads still making their folders, for the guard on leaving the page
  const [preparing, setPreparing] = useState(0);
  // the search box (§13), the Files screen's alone: clearing it goes back to what was open
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({});
  const [beforeSearch, setBeforeSearch] = useState<View | null>(null);
  const searched = useDebounced(query.trim(), 300);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const expand = useCallback(
    (keys: string[]) =>
      setOpen((prev) => (keys.every((k) => prev.has(k)) ? prev : new Set([...prev, ...keys]))),
    [],
  );
  const toggle = useCallback(
    (key: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const go = useCallback(
    (next: View) => {
      setView(next);
      setCreating(false);
      // the viewer steps through what was open; somewhere else, it has nothing to step through
      setViewing(null);
      // going somewhere, from the results or the tree, leaves the search behind
      setQuery("");
      setBeforeSearch(null);
      expand(keysFor(next));
    },
    [expand],
  );

  const names = useMemo(() => new Map((nodes.data ?? []).map((c) => [c.id, c])), [nodes.data]);
  const client = (id: string) =>
    mode.kind === "client"
      ? { label: mode.clientName, code: null }
      : { label: names.get(id)?.label ?? "The client", code: names.get(id)?.code ?? null };
  const canWrite: LibraryApi["canWrite"] = (place) =>
    place.kind === "client" ? editClients : editFiles;

  // the open folder, for the Upload button and the queue's words (the pane reads the same query)
  const placeView = view.type === "place" ? view : null;
  const listing = useListing(placeView?.place ?? null, placeView?.folderId ?? null);
  const here: Target | null = placeView
    ? {
        place: placeView.place,
        folderId: placeView.folderId,
        label:
          listing.data?.folder?.name ??
          placeLabel(
            placeView.place,
            placeView.place.kind === "client"
              ? client(placeView.place.clientId).label
              : undefined,
          ),
      }
    : null;

  // a file let go outside the open folder must not open in the tab, which would leave the CRM
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files") || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);

  // the folder picker (§7.2): React does not know the attribute, so it is set on the element
  useEffect(() => {
    folderPicker.current?.setAttribute("webkitdirectory", "");
  }, []);

  // closing or reloading the tab while files are on their way would cut them off, so the browser
  // asks first; moving elsewhere in the CRM lets them finish, and the folder shows them after
  const sending =
    preparing > 0 || queue.items.some((i) => i.state === "waiting" || i.state === "sending");
  useEffect(() => {
    if (!sending) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [sending]);

  // ── acts ──

  async function runMove(picked: Picked, target: Target, url: string) {
    try {
      const r = await move.mutateAsync({
        url,
        input: {
          folderIds: picked.folders.map((f) => f.id),
          fileIds: picked.files.map((f) => f.id),
          to: placeInput(target.place),
          toFolderId: target.folderId,
        },
      });
      setEpoch((n) => n + 1);
      const notes = [
        r.renamed.length > 0
          ? `${plural(r.renamed.length, "file")} renamed, the name was taken there`
          : "",
        r.detached > 0
          ? `${plural(r.detached, "file")} left ${r.detached === 1 ? "its task" : "their tasks"}`
          : "",
      ].filter(Boolean);
      toast({
        text: [
          `Moved ${plural(pickedFacts(picked).items, "item")} to ${target.label}`,
          ...notes,
        ].join(" · "),
      });
      return true;
    } catch (error) {
      toast({ text: errorText(error, "The move did not go through") });
      return false;
    }
  }

  async function undo(batchId: string) {
    try {
      const r = await restore.mutateAsync(
        mode.kind === "client"
          ? { kind: "client-card", clientId: mode.clientId, batchId }
          : { kind: "batch", batchId },
      );
      toast({ text: `Undone — everything is back where it was${renamedNote(r.renamed)}` });
    } catch (error) {
      toast({ text: errorText(error, "It could not be undone; it is still in the Trash") });
    }
  }

  async function runTrash(picked: Picked) {
    try {
      const r = await trash.mutateAsync({
        place: picked.place,
        folderIds: picked.folders.map((f) => f.id),
        fileIds: picked.files.map((f) => f.id),
      });
      setDialog(null);
      setEpoch((n) => n + 1);
      const [only] = picked.files;
      const one = picked.folders.length === 0 && picked.files.length === 1 ? only : undefined;
      toast({
        text: one
          ? `“${one.name}” moved to the Trash${one.task ? " — and off its task" : ""}`
          : `${plural(pickedFacts(picked).items, "item")} moved to the Trash`,
        action: { label: "Undo", run: () => undo(r.batchId) },
      });
    } catch (error) {
      toast({ text: errorText(error, "The delete did not go through") });
    }
  }

  // one file goes straight to the Trash, with its Undo; anything more is asked about first
  function askDelete(picked: Picked) {
    if (picked.folders.length === 0 && picked.files.length === 1) void runTrash(picked);
    else setDialog({ kind: "delete", picked });
  }

  // ── uploads (files.md §7.1, §7.2) ──

  /** What was left out before sending, in one toast; nothing when nothing was. */
  function leftOut(
    refused: string[],
    tooBig: string[],
    unmade: { files: number; why: string } | null,
  ) {
    const [big] = tooBig;
    const [program] = refused;
    const left = [
      big
        ? tooBig.length === 1
          ? `“${big}” is over 25 MB`
          : `${tooBig.length} files are over 25 MB`
        : "",
      program
        ? refused.length === 1
          ? `“${program}” is a program or a script`
          : `${refused.length} files are programs or scripts`
        : "",
      unmade
        ? unmade.files > 0
          ? `${plural(unmade.files, "file")} whose folder could not be made (${unmade.why})`
          : `a folder that could not be made (${unmade.why})`
        : "",
    ].filter(Boolean);
    if (left.length > 0) toast({ text: `${left.join("; ")} — left out` });
  }

  /**
   * One drop or pick, folders included (§7.2): each directory made once, parents first, and its
   * files queued as soon as it stands, so the first ones are on their way while the rest are
   * made. A directory that cannot be made (too deep) leaves out what was meant for it, and the
   * rest carry on.
   */
  async function runUpload(batch: UploadBatch, target: Target) {
    const plan = planFolderUpload(batch);
    const groups = new Map(plan.groups.map((g) => [dirKey(g.dirs), g]));
    const made = new Map<string, string | null>([[dirKey([]), target.folderId]]);
    const refused: string[] = [];
    const tooBig: string[] = [];
    const send = (dirs: string[], folderId: string | null) => {
      const group = groups.get(dirKey(dirs));
      if (!group) return;
      const label = dirs.length > 0 ? dirs[dirs.length - 1] : target.label;
      const r = queue.enqueue(group.files, { place: target.place, folderId, label });
      refused.push(...r.refused);
      tooBig.push(...r.tooBig);
    };

    send([], target.folderId);
    let why = "";
    setPreparing((n) => n + 1);
    for (const dirs of plan.dirs) {
      const name = dirs[dirs.length - 1];
      const parentId = made.get(dirKey(dirs.slice(0, -1)));
      // a directory whose parent could not be made cannot be made either
      if (name === undefined || parentId === undefined) continue;
      try {
        const folder = await ensureFolder(target.place, parentId, name);
        made.set(dirKey(dirs), folder.id);
        send(dirs, folder.id);
      } catch (error) {
        why ||= errorText(error, "the server refused it");
      }
    }
    setPreparing((n) => n - 1);
    if (plan.dirs.length > 0) void refreshLibrary(queryClient);
    const unmadeFiles = plan.groups
      .filter((g) => !made.has(dirKey(g.dirs)))
      .reduce((n, g) => n + g.files.length, 0);
    leftOut(refused, tooBig, why ? { files: unmadeFiles, why } : null);
  }

  // putting a file where the client will look is showing it to them, so that is asked once
  function upload(batch: UploadBatch, target: Target) {
    const plan = planFolderUpload(batch);
    const count = plan.groups.reduce((n, g) => n + g.files.length, 0);
    if (count === 0 && plan.dirs.length === 0) return;
    if (clientSees(target.place) && count > 0) {
      setDialog({ kind: "upload", batch, count, target });
    } else void runUpload(batch, target);
  }

  /** A drop: its folders are read while the drop lasts, then walked (§7.2). */
  function uploadDropped(data: DataTransfer, target: Target) {
    const entries = droppedEntries(data);
    if (!entries) {
      const files = Array.from(data.files).map((file) => ({ file, dirs: [] }));
      upload({ files, emptyDirs: [] }, target);
      return;
    }
    walkEntries(entries).then(
      (batch) => upload(batch, target),
      (error: unknown) =>
        toast({ text: errorText(error, "What was dropped could not be read") }),
    );
  }

  function onDragStart(e: DragStartEvent) {
    const picked = pickedIn(e.active.data.current);
    setDragged(picked);
    // a folder cannot go inside itself: while it moves, it and everything under it take no drop.
    // The tree of its place is in the cache, since the tree shows the place that is open.
    const tree = picked
      ? queryClient.getQueryData<FolderNode[]>([
          ...FILES_KEY,
          "folders",
          placeKey(picked.place),
        ])
      : undefined;
    setNoDrop(
      subtreeOf(
        tree ?? [],
        (picked?.folders ?? []).map((f) => f.id),
      ),
    );
  }

  function endDrag() {
    setDragged(null);
    setNoDrop(new Set<string>());
  }

  function onDragEnd(e: DragEndEvent) {
    endDrag();
    const picked = pickedIn(e.active.data.current);
    const target = e.over?.data.current as Target | undefined;
    if (!picked || !target) return;
    if (samePlace(picked.place, target.place) && picked.parentId === target.folderId) return;
    // the same guard as the drop targets', in case the tree was not in the cache
    if (target.folderId && noDrop.has(target.folderId)) return;
    if (target.folderId && picked.folders.some((f) => f.id === target.folderId)) return;
    const f = pickedFacts(picked);
    const check = checkMove({
      from: picked.place,
      to: target.place,
      files: f.files,
      onTasks: f.onTasks,
      admin,
      clientName: (id) => client(id).label,
    });
    if (!check.allowed) {
      toast({ text: check.reason ?? "That move is not allowed" });
      return;
    }
    // anything the person should hear before the move goes through the dialog, already aimed
    if (check.lines.length > 0) setDialog({ kind: "move", picked, target });
    else void runMove(picked, target, check.url);
  }

  const api: LibraryApi = {
    mode,
    view,
    go,
    isOpen: (key) => open.has(key),
    toggle,
    expand,
    admin,
    clientsOpen,
    canWrite,
    client,
    creating,
    setCreating,
    busy: dialog !== null || viewing !== null,
    epoch,
    uploadDropped,
    askMove: (picked) => setDialog({ kind: "move", picked }),
    askDelete,
    askFile: (file, clientId) => setDialog({ kind: "file", file, clientId }),
    runMove,
    movePending: move.isPending,
    noDrop,
    openViewer: (items, index) => setViewing({ items, index }),
  };

  const writableHere = here !== null && canWrite(here.place);
  const tools = (small: boolean) => (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        variant="secondary"
        size={small ? "sm" : "md"}
        disabled={!writableHere}
        title={
          here ? undefined : "Open a folder first: new folders go into the one that is open"
        }
        onClick={() => setCreating(true)}
      >
        <FolderPlus size={15} />
        New folder
      </Button>
      <Menu
        label="Upload"
        items={[
          {
            label: "Files",
            icon: <FileUp size={15} />,
            onSelect: () => picker.current?.click(),
          },
          {
            label: "A whole folder",
            icon: <FolderUp size={15} />,
            onSelect: () => folderPicker.current?.click(),
          },
        ]}
        button={(props) => (
          <Button
            {...props}
            size={small ? "sm" : "md"}
            disabled={!writableHere}
            title={here ? undefined : "Open a folder first: files land in the one that is open"}
          >
            <Upload size={15} />
            Upload
          </Button>
        )}
      />
    </div>
  );

  // typing opens the results; emptying the box goes back to where the reader was
  function onQuery(next: string) {
    setQuery(next);
    const typed = next.trim().length > 0;
    if (typed && view.type !== "search") {
      setBeforeSearch(view);
      setView({ type: "search" });
      setViewing(null);
    } else if (!typed && view.type === "search") {
      setView(beforeSearch ?? startView(mode));
      setBeforeSearch(null);
    }
  }

  let pane: ReactNode;
  switch (view.type) {
    case "search":
      pane = <SearchPane q={searched} filters={filters} onFilters={setFilters} />;
      break;
    case "place":
      pane = (
        <FolderPane
          key={`${placeKey(view.place)}|${view.folderId ?? ""}`}
          place={view.place}
          folderId={view.folderId}
          tools={mode.kind === "client" ? tools(true) : undefined}
        />
      );
      break;
    case "clients":
      pane = <ClientsPane />;
      break;
    case "client":
      pane = <ClientPane key={view.clientId} clientId={view.clientId} />;
      break;
    case "attachments":
      pane = <AttachmentsPane key={view.clientId ?? "company"} clientId={view.clientId} />;
      break;
    case "trash":
      pane = <TrashPane />;
      break;
  }

  return (
    <LibraryContext.Provider value={api}>
      {mode.kind === "firm" && (
        <div className="mb-3.5 flex min-h-9 flex-wrap items-center gap-3.5">
          <h1 className="text-[20px] font-semibold">Files</h1>
          <span className="text-[13px] text-muted-400">
            {"Everything the firm keeps — yours, the firm's, and each client's."}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SearchInput
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search names and details"
              aria-label="Search file names and details"
              className="w-64"
            />
            {tools(false)}
          </div>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div
          className={cn(
            "grid items-start gap-4",
            mode.kind === "firm"
              ? "grid-cols-[284px_minmax(0,1fr)]"
              : "grid-cols-[220px_minmax(0,1fr)]",
          )}
        >
          {mode.kind === "firm" ? <FirmTree /> : <ClientTree clientId={mode.clientId} />}
          {pane}
        </div>
        <DragOverlay dropAnimation={null} modifiers={[besidePointer]}>
          {dragged && <DragChip picked={dragged} />}
        </DragOverlay>
      </DndContext>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).map((file) => ({ file, dirs: [] }));
          e.target.value = ""; // so choosing the same file twice still fires
          if (here) upload({ files, emptyDirs: [] }, here);
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        hidden
        onChange={(e) => {
          const batch = pickedFolder(e.target.files);
          e.target.value = "";
          if (here) upload(batch, here);
        }}
      />
      <UploadQueuePanel queue={queue} />
      {viewing && (
        <Viewer
          items={viewing.items}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewing(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          picked={dialog.picked}
          pending={trash.isPending}
          onConfirm={() => void runTrash(dialog.picked)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog
          picked={dialog.picked}
          initial={dialog.target}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "file" && (
        <FileToFolderDialog
          file={dialog.file}
          clientId={dialog.clientId}
          clientName={dialog.clientId ? client(dialog.clientId).label : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "upload" && (
        <UploadConfirmDialog
          count={dialog.count}
          target={dialog.target}
          clientName={
            dialog.target.place.kind === "client"
              ? client(dialog.target.place.clientId).label
              : "The client"
          }
          onConfirm={() => {
            void runUpload(dialog.batch, dialog.target);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </LibraryContext.Provider>
  );
}

/** The rows in your hand: one by its name, several by their number. */
function DragChip({ picked }: { picked: Picked }) {
  const f = pickedFacts(picked);
  const [folder] = picked.folders;
  const [file] = picked.files;
  return (
    <div className="inline-flex max-w-[320px] items-center gap-2 rounded-(--radius-card) border border-border bg-surface px-3 py-2 text-[13px] font-medium text-ink shadow-(--shadow-modal)">
      {folder ? <FolderBadge /> : <ExtBadge name={file?.name ?? ""} />}
      <span className="truncate">
        {f.items === 1 ? (folder?.name ?? file?.name) : plural(f.items, "item")}
      </span>
    </div>
  );
}
