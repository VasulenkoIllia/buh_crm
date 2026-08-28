import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { Task, TaskColumn } from "@shared/schema/task";
import { useAuth } from "@/app/auth";
import { resolveDrop } from "@/shared/lib/drop-target";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { SearchSelect } from "@/shared/ui/search-select";
import { FilterChips } from "@/shared/ui/tabs";
import { Segmented } from "@/shared/ui/segmented";
import { fmtBizDay, fmtDate } from "@/shared/lib/format";
import { AssigneeAvatars, userLabel } from "@/shared/ui/avatar";
import { isOverdue, TaskKindChip } from "./lib";
import { DoneToggle, TaskTimerButton } from "./task-controls";
import { TrackedTime } from "./timer";
import { TaskDetailsModal, TaskFormModal } from "./task-modals";
import {
  TABLE_PAGE_SIZE,
  useAddColumn,
  useAssignees,
  useDeleteColumn,
  useTaskTargets,
  useTask,
  useBulkArchiveTasks,
  useTaskColumns,
  useTasks,
  useUpdateColumn,
  useMoveColumn,
  useMoveTask,
  type AssigneeInfo,
} from "./tasks.api";

type FilterPill = "all" | "mine" | "overdue";
type Layout = "board" | "table";
type ViewTab = "active" | "done" | "cancelled";

/**
 * Completed work only accumulates, so the Done view shows a window of it and says which.
 * A week is what people actually look back over; "All" is there when you're hunting something old.
 */
const DONE_PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;
type DonePeriod = (typeof DONE_PERIODS)[number]["value"];

export function TasksPage() {
  const { user } = useAuth();
  const [view, setView] = useState<ViewTab>("active");
  const [pill, setPill] = useState<FilterPill>("all");
  // one picker for both kinds of target — a task belongs to a client OR a lead, never both.
  // Encoded "<kind>:<id>" so the value alone says which filter the server gets.
  const [targetFilter, setTargetFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  /**
   * The date window on a closed view. Done defaults to a week because finished work piles up
   * forever; **Cancelled defaults to everything**, because there is far less of it and hunting for
   * one called off by mistake must not depend on remembering when (user, 2026-08-08).
   */
  const [donePeriod, setDonePeriod] = useState<DonePeriod>("7");
  const [cancelledPeriod, setCancelledPeriod] = useState<DonePeriod>("all");
  const [serviceFilter, setServiceFilter] = useState("");
  /** ticked rows in a closed view — `selected` is taken: that is the task open in the modal */
  const [ticked, setTicked] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const [targetKind, targetId] = targetFilter ? targetFilter.split(":") : [undefined, undefined];

  // The state chips belong to the Active view; Done shows period chips instead. A chip left
  // selected in one view must not keep filtering invisibly in the other — "Overdue" carried
  // into Done would ask for work that is both open and finished.
  const done = view === "done";
  const cancelled = view === "cancelled";
  // both closed views are read-only lists, not a working board
  const closed = done || cancelled;
  const mineOnly = !closed && pill === "mine";

  // Every filter is a SERVER filter: a chip has to search all the work, not just the rows this
  // page loaded. "Mine" is just an assignee filter with the signed-in user in it.
  const { data, isLoading, error, refetch } = useTasks({
    status: cancelled ? "cancelled" : done ? "done" : "open",
    view: layout,
    overdue: !closed && pill === "overdue",
    withinDays: (() => {
      const p = done ? donePeriod : cancelled ? cancelledPeriod : "all";
      return closed && p !== "all" ? Number(p) : undefined;
    })(),
    serviceId: serviceFilter || undefined,
    assigneeId: mineOnly ? user?.id : assigneeFilter || undefined,
    clientId: targetKind === "client" ? targetId : undefined,
    leadId: targetKind === "lead" ? targetId : undefined,
    page,
    pageSize: TABLE_PAGE_SIZE,
  });
  const { data: columns } = useTaskColumns();
  const { data: team } = useAssignees();
  const { data: taskTargets } = useTaskTargets();
  const { data: catalog } = useCatalog();
  const bulkArchive = useBulkArchiveTasks();
  const [bulkNote, setBulkNote] = useState<{ text: string; hint?: string } | null>(null);

  // a tick belongs to the rows that were on screen when it was made; anything that changes the
  // list must drop it, or Archive would act on rows the person can no longer see
  useEffect(() => {
    setTicked([]);
  }, [view, layout, pill, targetFilter, assigneeFilter, donePeriod, cancelledPeriod, serviceFilter, page]);

  // any filter change starts the table back at page 1 — page 7 of the old result set is nonsense
  useEffect(() => {
    setPage(1);
  }, [view, layout, pill, targetFilter, assigneeFilter, donePeriod, cancelledPeriod, serviceFilter]);
  const [formOpen, setFormOpen] = useState(false);
  const [formColumnId, setFormColumnId] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // ?task=<id> (e.g. from the header timer bar) opens that task's details
  const [searchParams, setSearchParams] = useSearchParams();
  const taskParam = searchParams.get("task");
  useEffect(() => {
    if (taskParam) setSelectedId(taskParam);
  }, [taskParam]);
  const closeDetails = () => {
    setSelectedId(null);
    if (taskParam) setSearchParams({}, { replace: true });
  };

  // The loaded page answers for anything on screen; the open task is ALSO fetched by id so the
  // modal owns a copy of it. Without that, marking a task done from inside the modal made it
  // vanish mid-action: it leaves the Active list on the refetch, and with nothing to fall back on
  // `selected` went null and unmounted the dialog before the user saw the result (2026-08-01).
  // The header timer bar can point at a completed task too — marking done doesn't stop its timer.
  const fromList = selectedId ? (data?.items ?? []).find((t) => t.id === selectedId) : undefined;
  const linked = useTask(selectedId);
  const selected = fromList ?? linked.data ?? null;

  // …and a link that resolves to nothing (deleted, archived, bad id) gets cleared, so the page is
  // never stuck on a dead parameter it can't open
  useEffect(() => {
    if (!linked.error) return;
    setSelectedId(null);
    if (taskParam) setSearchParams({}, { replace: true });
  }, [linked.error, taskParam, setSearchParams]);

  const openNewTask = (columnId?: string) => {
    setFormColumnId(columnId);
    setFormOpen(true);
  };

  // the server already applied every filter — this is exactly the page it returned
  const tasks = data?.items ?? [];
  const targetOptions = taskTargets ?? [];
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / TABLE_PAGE_SIZE));



  return (
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      {/*
        Header bar. The view switch and "+ New task" live in their OWN non-shrinking group, and the
        filters wrap INSIDE the left group rather than pushing that group onto a second line — the
        Done view's period chips are much wider than the Active view's state chips, so with one flat
        wrap the whole right-hand side dropped a row and the board jumped down with it every time
        you switched view (user, 2026-08-01).
      */}
      <div className="flex flex-none items-start justify-between gap-3 border-b border-border bg-surface px-6 pb-3 pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="text-[18px] font-semibold">Tasks</h1>
        {/* Both closed views take a PERIOD, not a state — "mine"/"overdue" mean nothing for work
            that is finished or called off. They differ only in where they start: Done at a week
            because it piles up, Cancelled at everything because it does not, and the one you are
            hunting for is usually the one you called off by mistake (user, 2026-08-08). */}
        {closed ? (
          <FilterChips
            value={done ? donePeriod : cancelledPeriod}
            onChange={done ? setDonePeriod : setCancelledPeriod}
            options={DONE_PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          />
        ) : (
          <FilterChips
            value={pill}
            onChange={setPill}
            options={[
              { value: "all", label: "All" },
              { value: "mine", label: "Mine" },
              { value: "overdue", label: "Overdue" },
            ]}
          />
        )}
        {/* searchable: this lists every client AND lead with live work — a plain dropdown
            stops being usable long before the firm does */}
        {/* the catalog service the work goes through. "Internal" is not a service — it is the
            absence of one, and without the option every internal task is unreachable here. */}
        <div className="w-44">
          <SearchSelect
            value={serviceFilter}
            onChange={setServiceFilter}
            placeholder="All services"
            emptyLabel="All services"
            ariaLabel="Filter by service"
            options={[
              { value: "none", label: "Internal — no service" },
              ...(catalog ?? [])
                .filter((sv) => sv.active)
                .map((sv) => ({ value: sv.id, label: sv.name })),
            ]}
          />
        </div>
        <div className="w-44">
          <SearchSelect
            value={targetFilter}
            onChange={setTargetFilter}
            placeholder="All clients & leads"
            emptyLabel="All clients & leads"
            options={targetOptions.map((t) => ({
              value: `${t.kind}:${t.id}`,
              label: t.kind === "lead" ? `${t.name} · lead` : t.name,
            }))}
          />
        </div>
        <div className={cn("w-44", mineOnly && "pointer-events-none opacity-50")}>
          {/* "Mine" already IS an assignee filter — the picker goes quiet rather than fighting it */}
          <SearchSelect
            value={mineOnly ? "" : assigneeFilter}
            onChange={setAssigneeFilter}
            placeholder="All assignees"
            emptyLabel="All assignees"
            options={(team ?? []).map((u) => ({
              value: u.id,
              label: userLabel(u),
            }))}
          />
        </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Segmented
            value={layout}
            onChange={setLayout}
            options={[
              { value: "board", label: "Board" },
              { value: "table", label: "Table" },
            ]}
          />
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "active", label: "Active" },
              { value: "done", label: "Done" },
              // work that was called off — its own answer, never mixed in with "finished"
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
          <Button onClick={() => openNewTask()}>+ New task</Button>
        </div>
      </div>

      {data?.truncated && (
        <p className="flex-none bg-[#f7ede2] px-6 py-2 text-[12px] text-[#b5651d]">
          Showing the {data.items.length} most recent of {data.total} matching tasks — narrow by
          client or assignee, or switch to the Table view, which pages through all of them.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => setLayout("table")}
          >
            Open the table
          </button>
        </p>
      )}
      {isLoading && <p className="p-6 text-[13px] text-muted">Loading…</p>}
      {error && (
        <div className="m-6 rounded-[10px] border border-[#f0c9c9] bg-surface p-11 text-center">
          <div className="text-[28px]">⚠</div>
          <div className="text-[15px] font-semibold text-danger-text">Couldn&apos;t load data</div>
          <p className="mb-3 text-[13px] text-muted">Something went wrong while loading this list.</p>
          <Button onClick={() => void refetch()}>Retry</Button>
        </div>
      )}

      {data && columns && layout === "board" && !closed && (
        <Board
          columns={columns}
          tasks={tasks}
          team={team ?? []}
          onOpen={(t) => setSelectedId(t.id)}
          onAddInColumn={openNewTask}
        />
      )}
      {/* Bulk archive. It reports what it ACTUALLY did — a run that tidies 3 of the 5 you ticked
          and says nothing is worse than one that refuses, so the count of skipped rows and the
          reason for them are part of the answer, not an afterthought. */}
      {closed && ticked.length > 0 && (
        <div className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-(--radius-card) border border-border bg-surface px-4 py-2.5 text-[13px]">
          <span className="font-medium">{ticked.length} selected</span>
          <Button
            size="sm"
            disabled={bulkArchive.isPending}
            onClick={async () => {
              setBulkNote(null);
              try {
                const { changed, skipped } = await bulkArchive.mutateAsync(ticked);
                setTicked([]);
                setBulkNote({
                  text:
                    changed > 0
                      ? `Archived ${changed} task${changed === 1 ? "" : "s"}.`
                      : "Nothing to do — none of those could be archived.",
                  hint:
                    skipped > 0
                      ? `${skipped} skipped — already archived, or belonging to an archived client.`
                      : undefined,
                });
              } catch (e) {
                setBulkNote({ text: (e as Error).message });
              }
            }}
          >
            📦 Archive
          </Button>
          <button
            type="button"
            className="text-[12px] text-muted hover:underline"
            onClick={() => setTicked([])}
          >
            clear selection
          </button>
        </div>
      )}
      {bulkNote && (
        <p className="mx-6 mt-2 text-[13px] text-muted">
          {bulkNote.text}
          {bulkNote.hint && <span className="ml-1 text-faint">{bulkNote.hint}</span>}
        </p>
      )}

      {data && layout === "board" && closed && (
        <DoneGrid
          tasks={tasks}
          team={team ?? []}
          // Cancelled isn't windowed by date: there is far less of it, and hunting for the one
          // you called off by mistake shouldn't depend on remembering when
          period={done ? donePeriod : cancelledPeriod}
          cancelled={cancelled}
          ticked={ticked}
          onTick={(id) =>
            setTicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
          }
          onWiden={() => (done ? setDonePeriod("all") : setCancelledPeriod("all"))}
          onOpen={(t) => setSelectedId(t.id)}
        />
      )}
      {data && columns && layout === "table" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskTable
            columns={columns}
            tasks={tasks}
            team={team ?? []}
            onOpen={(t) => setSelectedId(t.id)}
            ticked={closed ? ticked : undefined}
            onTick={
              closed
                ? (id) => setTicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
                : undefined
            }
          />
          <Pager page={data.page} pageCount={pageCount} total={data.total} onPage={setPage} />
        </div>
      )}

      {formOpen && (
        <TaskFormModal
          presetColumnId={formColumnId}
          onClose={() => {
            setFormOpen(false);
            setFormColumnId(undefined);
          }}
        />
      )}
      {selected && <TaskDetailsModal task={selected} onClose={closeDetails} />}
    </div>
  );
}

// ── board ────────────────────────────────────────────────────────────────────

function Board({
  columns,
  tasks,
  team,
  onOpen,
  onAddInColumn,
}: {
  columns: TaskColumn[];
  tasks: Task[];
  team: AssigneeInfo[];
  onOpen: (task: Task) => void;
  onAddInColumn: (columnId: string) => void;
}) {
  const { user } = useAuth();
  const move = useMoveTask(); // dropping a card is its own action — it carries a position
  const moveColumn = useMoveColumn();
  /** the card currently in hand, drawn by `DragOverlay` — see `DraggedCard` */
  const [carried, setCarried] = useState<Task | null>(null);
  // Same as the catalog: the card is focusable, so without this it was a tab stop that answered
  // nothing. Space lifts, arrows move within and across columns, Space drops.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byColumn = useMemo(() => {
    const map = new Map<string, Task[]>(columns.map((c) => [c.id, []]));
    for (const task of tasks) map.get(task.statusColumnId)?.push(task);
    return map;
  }, [columns, tasks]);

  /**
   * A card is dropped ON another card, or on the empty space of a column — dnd-kit reports either.
   * Working out what that means is `resolveDrop`, on its own and under test: the first version was
   * inline here and silently mishandled the column case (2026-08-27).
   */
  const onDragEnd = (event: DragEndEvent) => {
    setCarried(null);
    // TWO kinds of thing are dragged on this board, and they resolve differently: a card asks
    // which column and which neighbour, a column asks only which neighbour. Each sortable says
    // what it is, rather than this guessing from whether the id happens to be a column's.
    if (event.active.data.current?.type === "column") return onColumnDragEnd(event);

    const taskId = String(event.active.id);
    const task = tasks.find((t) => t.id === taskId);
    const ids = new Map([...byColumn].map(([column, list]) => [column, list.map((t) => t.id)]));
    const target = resolveDrop(ids, taskId, event.over ? String(event.over.id) : null);
    if (!target || !task) return;

    move.mutate(
      // the shared resolver speaks of lists and neighbours; a board calls them columns and cards
      { id: taskId, input: { statusColumnId: target.listId, afterTaskId: target.afterId } },
      {
        // the optimistic move rolls back on failure, and a card sliding back to where it came from
        // with nothing said is indistinguishable from a drag that never took
        onError: (err) =>
          window.alert(
            `Could not move \u201c${task.title}\u201d.\n\n` +
              (err instanceof Error ? err.message : "Please try again."),
          ),
      },
    );
  };

  /**
   * Dragging a column: the movable ones are one plain list, so the shared resolver answers it with
   * the single-list call the service catalog already makes. The fixed column is in the list as a
   * TARGET — dropped on it, a column lands as early as one may go — but never as the thing moved.
   */
  const onColumnDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    const target = resolveDrop(
      new Map([["board", columns.map((c) => c.id)]]),
      id,
      event.over ? String(event.over.id) : null,
    );
    if (!target) return;
    // an anchor that is the fixed column means the same as no anchor: first among the movable
    const anchor = columns.find((c) => c.id === target.afterId)?.isFixed ? null : target.afterId;
    moveColumn.mutate(
      { id, input: { afterColumnId: anchor } },
      {
        onError: (err) =>
          window.alert(
            `Could not move the column.\n\n` +
              (err instanceof Error ? err.message : "Please try again."),
          ),
      },
    );
  };

  /**
   * Cards win over the column they sit in.
   *
   * Both are droppable — the column so a card can land on the empty space below, and in a column
   * that holds none. With `closestCenter` alone the column's centre can be nearer than a card's,
   * and a SHORT column is mostly empty space: with two cards the column kept winning while the
   * pointer was plainly on a card, which is what "it lags with two cards" was.
   */
  const collisionDetection: CollisionDetection = (args) => {
    // A COLUMN being dragged may only land beside another column. Without this the cards are
    // candidates too, and a column dropped over a card resolves to nothing at all.
    if (args.active.data.current?.type === "column") {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => byColumn.has(String(c.id))),
      });
    }
    const within = pointerWithin(args);
    const onCard = within.filter((c) => !byColumn.has(String(c.id)));
    if (onCard.length > 0) return onCard;
    return within.length > 0 ? within : closestCenter(args);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={({ active }) => {
        // only cards are carried: the columns move visibly on their own, and a 230px block
        // following the cursor would be the opposite of calm
        if (active.data.current?.type !== "column") {
          setCarried(tasks.find((t) => t.id === String(active.id)) ?? null);
        }
      }}
      onDragCancel={() => setCarried(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex flex-1 items-start gap-3 overflow-auto p-3.5">
        {/**
         * Horizontal — this board's columns run left to right, unlike every other sortable here.
         *
         * The MOVABLE columns only. The fixed "New" column is deliberately not a slot: left in,
         * dnd-kit counts it as one, and while dragging it shows your column taking position 0 and
         * New sliding right — a place the server will never allow. Then the drop lands one along
         * from the preview, `newIndex !== index`, and dnd-kit animates the correction. That
         * animation IS the twitch (user, 2026-08-28); the preview lying is the cause of it.
         *
         * It keeps its `useSortable` and stays a drop TARGET — cards still land in it, and a
         * column dropped on it still means "as early as a column may go". Only the sorted set
         * shrinks, so what is previewed is what will happen.
         */}
        <SortableContext
          items={columns.filter((c) => !c.isFixed).map((c) => c.id)}
          strategy={horizontalListSortingStrategy}
        >
          {columns.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              tasks={byColumn.get(column.id) ?? []}
              team={team}
              onOpen={onOpen}
              onAdd={() => onAddInColumn(column.id)}
            />
          ))}
        </SortableContext>
        {user?.role === "admin" && <AddColumnTile />}
      </div>
      {/**
       * `dropAnimation={null}` on purpose. The default flies the overlay to where the card ended
       * up, which is the very travel that was taken out of the settle a moment ago — it would put
       * the jumping straight back. Released, the overlay simply goes and the card is already there.
       */}
      <DragOverlay dropAnimation={null}>
        {carried && <DraggedCard task={carried} team={team} />}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  column,
  tasks,
  team,
  onOpen,
  onAdd,
}: {
  column: TaskColumn;
  tasks: Task[];
  team: AssigneeInfo[];
  onOpen: (task: Task) => void;
  onAdd: () => void;
}) {
  const { user } = useAuth();
  /**
   * Sortable rather than merely droppable: the column is still where a card lands when dropped on
   * empty space, and is now itself something to drag. One id serves both.
   *
   * The fixed "New" column is `disabled` — it cannot be picked up (the server refuses to move it)
   * but stays a drop TARGET, so a column dropped on it means "as early as a column may go".
   */
  const { attributes, listeners, setNodeRef, transform, transition, isOver, isDragging } =
    useSortable({
      id: column.id,
      data: { type: "column" },
      disabled: column.isFixed,
      /**
       * The reorder lands instantly; nothing slides into place.
       *
       * `useDerivedTransform` runs for EVERY sortable whose index changed — not only the one being
       * dragged — measuring where it was, where it now is, and animating the difference. On cards
       * that is the pleasant "they step aside" effect. On columns it is two or three 230px blocks
       * travelling across the board at once, which reads as jumping (user, 2026-08-28, twice: it
       * was removed on the strength of an incomplete reading of the library and had to come back).
       *
       * This is separate from the fixed column being out of `items` below. That one stops the drag
       * PREVIEW promising a position the server will refuse; this one stops the settle being
       * animated at all. Both are needed — the first for honesty, the second for calm.
       */
      animateLayoutChanges: () => false,
    });
  const rename = useUpdateColumn();
  const remove = useDeleteColumn();
  const [name, setName] = useState(column.name);
  const isAdmin = user?.role === "admin";

  return (
    <div
      ref={setNodeRef}
      // Translate, not the raw transform — same reason as the cards: the columns that move ASIDE
      // are animated too, and a scale on a whole column reads as the board flexing
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "min-h-[120px] min-w-[230px] flex-[1_0_230px] rounded-[10px] bg-[#f4f6f8] p-[10px_9px]",
        isOver && "outline-1 outline-dashed outline-[#b9c1cc]",
        isDragging && "z-10 opacity-60",
      )}
    >
      {/* header + add button stay put at the top of the column: adding tasks must never push
          the primary action down, and it stays reachable while the cards scroll past */}
      <div
        className={cn(
          "sticky top-0 z-10 -mx-[9px] -mt-[10px] bg-[#f4f6f8] px-[9px] pb-2 pt-[10px]",
          // a sticky box is already positioned, so the ::before anchors to it — no `relative`
          // (that would override position:sticky). It masks the board's own top padding, where a
          // card would otherwise slide through the gap above the pinned header.
          "before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-[#f4f6f8]",
        )}
      >
      <div className="flex items-center gap-1.5 px-1 pb-2">
        {/**
         * A HANDLE, not the whole column. The header holds a rename field and the body holds
         * cards that are themselves draggable — a column that dragged from anywhere would fight
         * both, exactly as the service catalog's row would have.
         *
         * Admin-only and never on the fixed column, matching what the server will accept.
         */}
        {isAdmin && !column.isFixed && (
          <button
            type="button"
            aria-label={`Reorder ${column.name}`}
            className="-ml-0.5 flex-none cursor-grab touch-none text-[#b6bcc5] hover:text-muted active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={13} />
          </button>
        )}
        {isAdmin && !column.isFixed ? (
          <input
            className="w-full min-w-0 bg-transparent text-[12px] font-bold uppercase tracking-[.6px] text-ink-700 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (trimmed && trimmed !== column.name) {
                rename.mutate(
                  { id: column.id, input: { name: trimmed } },
                  {
                    onError: (err) => {
                      setName(column.name); // put the field back to what is actually stored
                      window.alert(
                        `Could not rename the column.\n\n` +
                          (err instanceof Error ? err.message : "Please try again."),
                      );
                    },
                  },
                );
              } else setName(column.name);
            }}
          />
        ) : (
          <span
            className={cn(
              "text-[12px] font-bold uppercase tracking-[.6px]",
              column.isFixed ? "text-[#8b929c]" : "text-ink-700",
            )}
          >
            {column.name}
          </span>
        )}
        {column.isFixed && <span className="text-[10px] text-[#b6bcc5]">🔒</span>}
        <span className="rounded-[10px] bg-[#e7eaef] px-[7px] py-px text-[11px] font-semibold text-[#8b929c]">
          {tasks.length}
        </span>
        {/* No small "+" here. It called exactly the same `onAdd` as the green button three
            centimetres below it — the same action, into the same column, twice. It arrived first
            (da5099a) and the green one was added later without the older control being taken away
            (user, 2026-08-28). */}
        <div className="ml-auto flex items-center gap-1">
          {isAdmin && !column.isFixed && tasks.length === 0 && (
            <button
              type="button"
              aria-label="Delete column"
              className="text-[15px] text-[#b6bcc5] hover:text-danger"
              // `tasks.length` is what the FILTERS left in this column, not what it holds: with a
              // filter on, an empty-looking column can still have work in it and the server
              // refuses the delete. Saying so beats a button that does nothing (2026-08-27 audit).
              onClick={() =>
                remove.mutate(column.id, {
                  onError: (err) =>
                    window.alert(
                      `Could not delete “${column.name}”.\n\n` +
                        (err instanceof Error
                          ? err.message
                          : "It may still hold tasks that the current filters hide."),
                    ),
                })
              }
            >
              ×
            </button>
          )}
        </div>
      </div>
        {/* the primary way to create a task in this column */}
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-[#b7e0c5] bg-[#eef8f1] py-2.5 text-[13px] font-semibold text-[#1f8f3a] transition-colors hover:border-[#8fd0a6] hover:bg-[#e2f2e8]"
        >
          <span className="text-[16px] leading-none">+</span> New task
        </button>
      </div>
      {/* the column's cards, in the firm's own order — dragging one within this list is what
          `SortableContext` makes possible; the column itself stays droppable so a card can be
          dropped on the empty space below, and into a column that has none */}
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[8px] flex-col gap-2">
          {tasks.map((task) => (
            <BoardCard key={task.id} task={task} team={team} onOpen={() => onOpen(task)} />
          ))}
          {tasks.length === 0 && (
            <p className="py-6 text-center text-[12px] text-[#9aa1ab]">No tasks here yet</p>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function AddColumnTile() {
  const add = useAddColumn();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-[180px] rounded-[10px] border border-dashed border-[#c7ccd3] bg-[#fafbfc] px-3.5 py-[13px] text-center text-[13px] font-semibold text-[#6b7280] hover:bg-divider/40"
      >
        + Add column
      </button>
    );
  }
  const save = () => {
    const trimmed = name.trim();
    if (trimmed) add.mutate({ name: trimmed });
    setEditing(false);
    setName("");
  };
  return (
    <div className="min-w-[180px] rounded-[10px] border border-dashed border-[#c7ccd3] bg-[#fafbfc] p-2.5">
      <input
        autoFocus
        className="w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary"
        placeholder="Column name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        onBlur={save}
      />
    </div>
  );
}

/** Priority visuals: colored left bar + chip when ≠ default. */
function usePriority(priorityId: string) {
  const { data: settings } = useSettings();
  return settings?.priorities.find((p) => p.id === priorityId);
}

/** Priority chip — tinted from the priority's own hex (10% bg). */
function PriorityTag({ priority }: { priority: { name: string; color: string } }) {
  return (
    <span
      className="inline-flex items-center rounded-(--radius-chip) px-2 py-[2px] text-[11px] font-semibold"
      style={{ color: priority.color, backgroundColor: `${priority.color}1a` }}
    >
      {priority.name}
    </span>
  );
}

function BoardCard({
  task,
  team,
  onOpen,
}: {
  task: Task;
  team: AssigneeInfo[];
  onOpen: () => void;
}) {
  // sortable, not merely draggable: the card is also a DROP TARGET, which is what lets another
  // card be placed above or below it rather than only somewhere in the column
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    // the board now drags TWO kinds of thing; `onDragEnd` and the collision detection both ask
    data: { type: "card" },
    /**
     * Same as the columns: the SETTLE is instant, the step-aside is not.
     *
     * `useDerivedTransform` fires for every sortable whose index changed, measuring where it was
     * and animating it to where it now is. That runs AFTER the drop, when the optimistic reorder
     * changes `items` — the cards travelling to their new places is what reads as jumping
     * (user, 2026-08-28).
     *
     * It does NOT touch the cards moving aside while you drag: that transform comes from the
     * sorting strategy during `isSorting`, when `items` has not changed yet and no derived
     * transform exists. The pleasant half stays; only the post-drop travel goes.
     */
    animateLayoutChanges: () => false,
  });

  return (
    <CardFace
      task={task}
      team={team}
      nodeRef={setNodeRef}
      wiring={{ ...attributes, ...listeners, onClick: () => !isDragging && onOpen() }}
      style={{
        // CSS.Translate, not the raw transform: sortable also animates the cards that move ASIDE,
        // and `transition` is what makes that readable instead of a jump
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      // barely there while it is in your hand: the DragOverlay is drawing the real one, and two
      // solid copies of the same card is worse than none
      className={isDragging ? "opacity-25" : undefined}
    />
  );
}

/**
 * The card as it looks IN YOUR HAND, drawn by `DragOverlay` in a portal that follows the pointer.
 *
 * Without it a drag between columns showed nothing at all: each column is its own
 * `SortableContext`, so a card leaving column A is not in column B's `items` and neither list has
 * anything to shift — the board sat still and the card appeared in its new place on release
 * (user, 2026-08-28). This is the same face, so what you carry is what you dropped.
 */
function DraggedCard({ task, team }: { task: Task; team: AssigneeInfo[] }) {
  return <CardFace task={task} team={team} className="rotate-1 shadow-lg" />;
}

/** One card's appearance. Shared so the overlay cannot drift from the board. */
function CardFace({
  task,
  team,
  nodeRef,
  wiring,
  style,
  className,
}: {
  task: Task;
  team: AssigneeInfo[];
  nodeRef?: (node: HTMLElement | null) => void;
  wiring?: Record<string, unknown>;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { data: services } = useCatalog();
  const priority = usePriority(task.priorityId);
  const overdue = isOverdue(task);
  const service = services?.find((s) => s.id === task.serviceId);
  const doneSubtasks = task.subtasks.filter((s) => s.done).length;

  return (
    <div
      ref={nodeRef}
      {...wiring}
      style={{
        ...style,
        ...(!overdue && priority ? { borderLeft: `3px solid ${priority.color}` } : {}),
      }}
      className={cn(
        "cursor-pointer rounded-[9px] border border-border bg-surface px-3 py-[11px] shadow-[0_1px_2px_rgba(0,0,0,.04)]",
        overdue && "border-2 border-danger shadow-[0_0_0_3px_rgba(214,60,60,.09)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-semibold leading-[1.3]">
          {overdue && <span className="mr-1 text-danger-text">⚠</span>}
          {task.title}
        </div>
        <DoneToggle task={task} compact />
      </div>
      {(task.clientId || task.leadId || service) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <TargetName task={task} />
          {service && <ServiceChip name={service.name} color={service.color} />}
        </div>
      )}
      <div className={cn("mt-[5px] text-[12px]", overdue ? "font-semibold text-danger" : "text-muted")}>
        {task.deadline ? `Due: ${fmtBizDay(task.deadline)}` : "No deadline"}
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-[5px]">
        <AssigneeAvatars
          ids={task.assignees}
          team={team}
          empty={
            <Chip tone="amber" strong>
              Unassigned
            </Chip>
          }
        />
        {priority && !priority.isDefault && <PriorityTag priority={priority} />}
        {task.subtasks.length > 0 && (
          <Chip tone="gray">
            ☑ {doneSubtasks}/{task.subtasks.length}
          </Chip>
        )}
        <TaskKindChip task={task} />
        {task.invoice && (
          <InvoiceStatusPill status={task.invoice.status} prefix="💰" size="sm" />
        )}
        {/* a voided invoice is not a bill — the job is unbilled again and the board should say so */}
        {task.kind === "once" && (!task.invoice || task.invoice.status === "cancelled") && (
          <Chip tone="amber">⏳ unbilled</Chip>
        )}
        {task.kind === "sub" && <Chip tone="blue">📅 auto</Chip>}
      </div>
      {/* start/stop the timer straight from the board, with what's already on the clock */}
      <div className="mt-2 flex items-center justify-end gap-2">
        <TrackedTime seconds={task.trackedSeconds} className="text-[11px]" />
        <TaskTimerButton task={task} compact />
      </div>
    </div>
  );
}

/** The task carries its own target label (server-side) — no clients page to look it up in. */
function TargetName({ task }: { task: Task }) {
  const name = task.clientName ?? task.leadName;
  return name ? <span>{name}</span> : null;
}

// ── done grid ────────────────────────────────────────────────────────────────

function DoneGrid({
  tasks,
  team,
  period,
  cancelled = false,
  onWiden,
  onOpen,
  ticked,
  onTick,
}: {
  tasks: Task[];
  team: { id: string; firstName: string; lastName: string; avatarFileId: string | null }[];
  period: DonePeriod;
  /** rendering the called-off list rather than the finished one */
  cancelled?: boolean;
  onWiden: () => void;
  onOpen: (t: Task) => void;
  ticked: string[];
  onTick: (id: string) => void;
}) {
  if (tasks.length === 0) {
    /**
     * One empty state for both views, because the rule is the same and having two meant only one
     * of them followed it: an empty list with a WINDOW on says nothing about work outside that
     * window. Cancelled used to answer "Nothing has been cancelled" flat out — and it kept saying
     * that after it gained date chips, so picking "Last 7 days" claimed there were none at all
     * (found 2026-08-08, in the same change that added the chips).
     */
    const word = cancelled ? "cancelled" : "completed";
    return period === "all" ? (
      <p className="p-6 text-[13px] text-muted">
        {cancelled ? "Nothing has been cancelled." : "No completed tasks yet."}
      </p>
    ) : (
      <p className="p-6 text-[13px] text-muted">
        Nothing {word} in this period.{" "}
        <button type="button" className="text-primary-link hover:underline" onClick={onWiden}>
          Look at all time
        </button>
      </p>
    );
  }
  return (
    // four across on a wide screen, fewer as it narrows — at a fixed 4 the cards got so tight
    // that the client's name truncated to a single letter
    <div className="grid flex-1 auto-rows-min grid-cols-1 gap-2.5 overflow-auto p-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tasks.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rounded-[9px] border bg-surface px-3 py-[11px] text-left opacity-85 shadow-[0_1px_2px_rgba(0,0,0,.04)] hover:opacity-100",
            ticked.includes(t.id) ? "border-primary opacity-100" : "border-border",
          )}
        >
          <div className="flex items-start gap-2 text-[13px] font-semibold">
            {/* the tick is its own control, not part of opening the card — clicking a card to read
                it must never be the same gesture as choosing it for a bulk action */}
            <input
              type="checkbox"
              className="mt-0.5"
              aria-label={`Select ${t.title}`}
              checked={ticked.includes(t.id)}
              onChange={() => onTick(t.id)}
            />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(t)}>
              <span className={cn("mr-1", cancelled ? "text-[#b5651d]" : "text-success")}>
                {cancelled ? "⊘" : "✓"}
              </span>
              <span className="text-muted line-through">{t.title}</span>
            </button>
          </div>
          {/* WHO did it and for WHOM — a finished task is a record of work done, and this card
              used to show neither, which read as "the assignee disappeared when I closed it"
              (user report, 2026-08-01). The data was always there; the card just dropped it. */}
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
            <AssigneeAvatars
              ids={t.assignees}
              team={team}
              empty={<span className="text-faint">Unassigned</span>}
            />
            <span className="min-w-0 truncate">
              <TargetName task={t} />
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
            <span>
              {cancelled
                ? `Cancelled${t.cancelledAt ? ` ${fmtDate(t.cancelledAt)}` : ""}`
                : t.completedAt
                  ? `Done ${fmtDate(t.completedAt)}`
                  : "Done"}
            </span>
            {t.trackedSeconds > 0 && <TrackedTime seconds={t.trackedSeconds} />}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

/** Table paging. The board takes one capped slice; the table walks the whole result set. */
function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-none items-center justify-between border-t border-border bg-surface px-6 py-2.5 text-[12px] text-muted">
      <span>
        Page {page} of {pageCount} · {total} task{total === 1 ? "" : "s"}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

function TaskTable({
  columns,
  tasks,
  team,
  onOpen,
  ticked = [],
  onTick,
}: {
  columns: TaskColumn[];
  tasks: Task[];
  team: AssigneeInfo[];
  onOpen: (t: Task) => void;
  /**
   * Ticking is only offered on the closed views, where a bulk archive is the point. When it is
   * off the row stays one big button, exactly as it was — the Active table did not need changing
   * and a redesign it did not ask for is a regression waiting to happen.
   */
  ticked?: string[];
  onTick?: (id: string) => void;
}) {
  const { data: settings } = useSettings();
  const selectable = !!onTick;
  const grid = "grid grid-cols-[26px_1fr_150px_130px_96px_110px_88px_70px] items-center";

  return (
    <div className="flex-1 overflow-auto p-3.5">
      <div className="overflow-hidden rounded-[10px] bg-surface">
        <div className={cn(grid, "border-b border-[#f2f4f6] px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[.4px] text-muted-400")}>
          <span />
          <span>Task</span>
          <span>Client / Lead</span>
          <span>Assignee</span>
          <span>Priority</span>
          <span>Status</span>
          <span className="text-right">Due</span>
          <span className="text-right">Tracked</span>
        </div>
        {tasks.length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">No tasks for this status.</p>
        )}
        {tasks.map((t) => {
          const overdue = isOverdue(t);
          const priority = settings?.priorities.find((p) => p.id === t.priorityId);
          const column = columns.find((c) => c.id === t.statusColumnId);
          const assignee = team.find((u) => u.id === t.assignees[0]);
          const Row = selectable ? "div" : "button";
          return (
            <Row
              key={t.id}
              {...(selectable ? {} : { type: "button" as const, onClick: () => onOpen(t) })}
              className={cn(
                grid,
                "w-full border-b border-[#f2f4f6] px-3.5 py-[11px] text-left text-[13px] last:border-0 hover:bg-divider/30",
                overdue && "bg-[#fdf5f5]",
                ticked.includes(t.id) && "bg-[#eef1fb]",
              )}
            >
              {selectable ? (
                // the tick takes the dot's cell: on finished or called-off work a priority colour
                // says almost nothing, and choosing rows is what this view is for
                <input
                  type="checkbox"
                  aria-label={`Select ${t.title}`}
                  checked={ticked.includes(t.id)}
                  onChange={() => onTick?.(t.id)}
                />
              ) : (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: overdue ? "#d63c3c" : (priority?.color ?? "#c7ccd3") }}
                />
              )}
              {selectable ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-left font-medium hover:underline"
                  onClick={() => onOpen(t)}
                >
                  {t.title}
                </button>
              ) : (
                <span className="min-w-0 truncate font-medium">{t.title}</span>
              )}
              <span className="min-w-0 truncate text-muted">
                <TargetName task={t} />
              </span>
              <span className="min-w-0 truncate text-muted">
                {assignee ? userLabel(assignee) : "—"}
                {t.assignees.length > 1 && ` +${t.assignees.length - 1}`}
              </span>
              <span>{priority && <PriorityTag priority={priority} />}</span>
              <span>
                <Chip tone="gray" className="capitalize">
                  {t.done ? "done" : (column?.name ?? "—")}
                </Chip>
              </span>
              <span className={cn("text-right tabular-nums", overdue && "font-semibold text-danger")}>
                {t.deadline ? fmtBizDay(t.deadline) : "—"}
              </span>
              <span className="text-right">
                <TrackedTime seconds={t.trackedSeconds} emptyAs="dash" />
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
