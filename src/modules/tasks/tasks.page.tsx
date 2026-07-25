import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Task, TaskColumn } from "@shared/schema/task";
import { useAuth } from "@/app/auth";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { useClients } from "@/modules/clients";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Segmented } from "@/shared/ui/segmented";
import { isOverdue, fmtDay, initials } from "./lib";
import { DoneToggle, TaskTimerButton } from "./task-controls";
import { TaskDetailsModal, TaskFormModal } from "./task-modals";
import {
  useAddColumn,
  useAssignees,
  useDeleteColumn,
  useTaskColumns,
  useTasks,
  useUpdateColumn,
  useUpdateTask,
  type AssigneeInfo,
} from "./tasks.api";

type FilterPill = "all" | "mine" | "overdue";
type Layout = "board" | "table";
type ViewTab = "active" | "done";

export function TasksPage() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useTasks();
  const { data: columns } = useTaskColumns();
  const { data: team } = useAssignees();
  const { data: clientsResp } = useClients({ tab: "all", pageSize: 100 });

  const [pill, setPill] = useState<FilterPill>("all");
  const [clientFilter, setClientFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [view, setView] = useState<ViewTab>("active");
  const [formOpen, setFormOpen] = useState(false);
  const [formColumnId, setFormColumnId] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // ?task=<id> (e.g. from the header timer bar) opens that task's details
  const [searchParams, setSearchParams] = useSearchParams();
  const taskParam = searchParams.get("task");
  useEffect(() => {
    if (taskParam) setSelectedId(taskParam);
  }, [taskParam]);
  // a ?task= that matches no loaded task (deleted/archived/bad id) can never be
  // closed via the modal (it never opens) — drop the dead param once data is in
  useEffect(() => {
    if (taskParam && data && !data.items.some((t) => t.id === taskParam)) {
      setSearchParams({}, { replace: true });
      setSelectedId((cur) => (cur === taskParam ? null : cur));
    }
  }, [taskParam, data, setSearchParams]);
  const closeDetails = () => {
    setSelectedId(null);
    if (taskParam) setSearchParams({}, { replace: true });
  };

  const openNewTask = (columnId?: string) => {
    setFormColumnId(columnId);
    setFormOpen(true);
  };

  const tasks = useMemo(() => {
    let list = data?.items ?? [];
    list = list.filter((t) => (view === "done" ? t.done : !t.done));
    if (pill === "mine" && user) list = list.filter((t) => t.assignees.includes(user.id));
    if (pill === "overdue") list = list.filter(isOverdue);
    if (clientFilter) list = list.filter((t) => t.clientId === clientFilter);
    if (assigneeFilter) list = list.filter((t) => t.assignees.includes(assigneeFilter));
    return list;
  }, [data, view, pill, user, clientFilter, assigneeFilter]);

  const selected = selectedId ? (data?.items ?? []).find((t) => t.id === selectedId) : null;

  const selectCls =
    "rounded-[7px] border border-border bg-surface px-2.5 py-[7px] text-[13px] text-ink-700";

  return (
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      {/* header bar */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-border bg-surface px-6 pb-3 pt-4">
        <h1 className="text-[18px] font-semibold">Tasks</h1>
        <div className="flex gap-1.5">
          {(["all", "mine", "overdue"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPill(p)}
              className={cn(
                "rounded-[6px] px-[11px] py-[5px] text-[12px] font-medium capitalize",
                pill === p
                  ? "bg-ink text-white"
                  : "border border-border bg-surface text-muted",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <select className={selectCls} value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
          <option value="">All clients</option>
          {(clientsResp?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
        <select className={selectCls} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
          <option value="">All assignees</option>
          {(team ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.firstName} {u.lastName}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
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
            ]}
          />
          <Button onClick={() => openNewTask()}>+ New task</Button>
        </div>
      </div>

      {isLoading && <p className="p-6 text-[13px] text-muted">Loading…</p>}
      {error && (
        <div className="m-6 rounded-[10px] border border-[#f0c9c9] bg-surface p-11 text-center">
          <div className="text-[28px]">⚠</div>
          <div className="text-[15px] font-semibold text-danger-text">Couldn&apos;t load data</div>
          <p className="mb-3 text-[13px] text-muted">Something went wrong while loading this list.</p>
          <Button onClick={() => void refetch()}>Retry</Button>
        </div>
      )}

      {data && columns && layout === "board" && view === "active" && (
        <Board
          columns={columns}
          tasks={tasks}
          team={team ?? []}
          onOpen={(t) => setSelectedId(t.id)}
          onAddInColumn={openNewTask}
        />
      )}
      {data && layout === "board" && view === "done" && (
        <DoneGrid tasks={tasks} onOpen={(t) => setSelectedId(t.id)} />
      )}
      {data && columns && layout === "table" && (
        <TaskTable columns={columns} tasks={tasks} team={team ?? []} onOpen={(t) => setSelectedId(t.id)} />
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
  const update = useUpdateTask(); // moving a card is just a task PATCH
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byColumn = useMemo(() => {
    const map = new Map<string, Task[]>(columns.map((c) => [c.id, []]));
    for (const task of tasks) map.get(task.statusColumnId)?.push(task);
    return map;
  }, [columns, tasks]);

  const onDragEnd = (event: DragEndEvent) => {
    const taskId = String(event.active.id);
    const columnId = event.over?.id as string | undefined;
    const task = tasks.find((t) => t.id === taskId);
    if (!columnId || !task || task.statusColumnId === columnId) return;
    update.mutate({ id: taskId, input: { statusColumnId: columnId } });
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex flex-1 items-start gap-3 overflow-auto p-3.5">
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
        {user?.role === "admin" && <AddColumnTile />}
      </div>
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
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const rename = useUpdateColumn();
  const remove = useDeleteColumn();
  const [name, setName] = useState(column.name);
  const isAdmin = user?.role === "admin";

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-[120px] min-w-[230px] flex-[1_0_230px] rounded-[10px] bg-[#f4f6f8] p-[10px_9px]",
        isOver && "outline-1 outline-dashed outline-[#b9c1cc]",
      )}
    >
      <div className="flex items-center gap-1.5 px-1 pb-2">
        {isAdmin && !column.isFixed ? (
          <input
            className="w-full min-w-0 bg-transparent text-[12px] font-bold uppercase tracking-[.6px] text-ink-700 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (trimmed && trimmed !== column.name) {
                rename.mutate({ id: column.id, input: { name: trimmed } });
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
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label={`Add task in ${column.name}`}
            title="New task in this column"
            className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-[15px] leading-none text-[#8b929c] hover:bg-[#e7eaef] hover:text-ink-700"
            onClick={onAdd}
          >
            +
          </button>
          {isAdmin && !column.isFixed && tasks.length === 0 && (
            <button
              type="button"
              aria-label="Delete column"
              className="text-[15px] text-[#b6bcc5] hover:text-danger"
              onClick={() => remove.mutate(column.id)}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <BoardCard key={task.id} task={task} team={team} onOpen={() => onOpen(task)} />
        ))}
        {/* prominent add button — the primary way to create a task in this column */}
        <button
          type="button"
          onClick={onAdd}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-[#b7e0c5] bg-[#eef8f1] font-semibold text-[#1f8f3a] transition-colors hover:border-[#8fd0a6] hover:bg-[#e2f2e8]",
            tasks.length === 0 ? "py-[22px] text-[14px]" : "py-2.5 text-[13px]",
          )}
        >
          <span className="text-[16px] leading-none">+</span> New task
        </button>
      </div>
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
  const { data: services } = useCatalog();
  const priority = usePriority(task.priorityId);
  const overdue = isOverdue(task);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });

  const service = services?.find((s) => s.id === task.serviceId);
  const doneSubtasks = task.subtasks.filter((s) => s.done).length;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => !isDragging && onOpen()}
      style={{
        ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : {}),
        ...(!overdue && priority ? { borderLeft: `3px solid ${priority.color}` } : {}),
      }}
      className={cn(
        "cursor-pointer rounded-[9px] border border-border bg-surface px-3 py-[11px] shadow-[0_1px_2px_rgba(0,0,0,.04)]",
        isDragging && "z-10 opacity-80",
        overdue && "border-2 border-danger shadow-[0_0_0_3px_rgba(214,60,60,.09)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-semibold leading-[1.3]">
          {overdue && <span className="mr-1 text-danger-text">⚠</span>}
          {task.title}
        </div>
        <DoneToggle task={task} compact />
      </div>
      {(task.clientId || service) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <ClientName clientId={task.clientId} />
          {service && <ServiceChip name={service.name} color={service.color} />}
        </div>
      )}
      <div className={cn("mt-[5px] text-[12px]", overdue ? "font-semibold text-danger" : "text-muted")}>
        {task.deadline ? `Due: ${fmtDay(task.deadline)}` : "No deadline"}
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-[5px]">
        {task.assignees.length === 0 ? (
          <Chip tone="amber" strong>
            Unassigned
          </Chip>
        ) : (
          <span className="flex items-center gap-1">
            {task.assignees.slice(0, 3).map((id) => {
              const u = team.find((x) => x.id === id);
              return (
                <span
                  key={id}
                  title={u ? `${u.firstName} ${u.lastName}${u.status === "blocked" ? " (blocked)" : ""}` : id}
                  className={cn(
                    "flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#dfe4ec] text-[10px] font-semibold text-ink-700",
                    u?.status === "blocked" && "bg-danger-soft text-danger-text",
                  )}
                >
                  {initials(u)}
                </span>
              );
            })}
            {task.assignees.length > 3 && (
              <span className="text-[11px] text-muted">+{task.assignees.length - 3}</span>
            )}
          </span>
        )}
        {priority && !priority.isDefault && <PriorityTag priority={priority} />}
        {task.subtasks.length > 0 && (
          <Chip tone="gray">
            ☑ {doneSubtasks}/{task.subtasks.length}
          </Chip>
        )}
        {task.kind === "free" && !task.clientId && <Chip tone="amber">internal</Chip>}
        {task.kind === "free" && task.clientId && <Chip tone="teal">included</Chip>}
        {task.invoice && (
          <Chip tone="blue" strong>
            💰 {task.invoice.number}
          </Chip>
        )}
        {task.kind === "once" && !task.invoice && <Chip tone="amber">⏳ unbilled</Chip>}
        {task.kind === "sub" && <Chip tone="blue">📅 auto</Chip>}
      </div>
      {/* start/stop the timer straight from the board */}
      <div className="mt-2 flex justify-end">
        <TaskTimerButton task={task} compact />
      </div>
    </div>
  );
}

function ClientName({ clientId }: { clientId: string | null }) {
  const { data: clientsResp } = useClients({ tab: "all", pageSize: 100 });
  if (!clientId) return null;
  const name = clientsResp?.items.find((c) => c.id === clientId)?.displayName;
  return name ? <span>{name}</span> : null;
}

// ── done grid ────────────────────────────────────────────────────────────────

function DoneGrid({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  if (tasks.length === 0) {
    return <p className="p-6 text-[13px] text-muted">No completed tasks yet.</p>;
  }
  return (
    <div className="grid flex-1 auto-rows-min grid-cols-4 gap-2.5 overflow-auto p-3.5">
      {tasks.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onOpen(t)}
          className="rounded-[9px] border border-border bg-surface px-3 py-[11px] text-left opacity-85 shadow-[0_1px_2px_rgba(0,0,0,.04)] hover:opacity-100"
        >
          <div className="text-[13px] font-semibold">
            <span className="mr-1 text-success">✓</span>
            <span className="text-muted line-through">{t.title}</span>
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {t.deadline ? `Due was: ${fmtDay(t.deadline)}` : "No deadline"}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

function TaskTable({
  columns,
  tasks,
  team,
  onOpen,
}: {
  columns: TaskColumn[];
  tasks: Task[];
  team: AssigneeInfo[];
  onOpen: (t: Task) => void;
}) {
  const { data: settings } = useSettings();
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
          <span className="text-right">Hours</span>
        </div>
        {tasks.length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">No tasks for this status.</p>
        )}
        {tasks.map((t) => {
          const overdue = isOverdue(t);
          const priority = settings?.priorities.find((p) => p.id === t.priorityId);
          const column = columns.find((c) => c.id === t.statusColumnId);
          const assignee = team.find((u) => u.id === t.assignees[0]);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen(t)}
              className={cn(
                grid,
                "w-full border-b border-[#f2f4f6] px-3.5 py-[11px] text-left text-[13px] last:border-0 hover:bg-divider/30",
                overdue && "bg-[#fdf5f5]",
              )}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: overdue ? "#d63c3c" : (priority?.color ?? "#c7ccd3") }}
              />
              <span className="min-w-0 truncate font-medium">{t.title}</span>
              <span className="min-w-0 truncate text-muted">
                <ClientName clientId={t.clientId} />
              </span>
              <span className="min-w-0 truncate text-muted">
                {assignee ? `${assignee.firstName} ${assignee.lastName}` : "—"}
                {t.assignees.length > 1 && ` +${t.assignees.length - 1}`}
              </span>
              <span>{priority && <PriorityTag priority={priority} />}</span>
              <span>
                <Chip tone="gray" className="capitalize">
                  {t.done ? "done" : (column?.name ?? "—")}
                </Chip>
              </span>
              <span className={cn("text-right tabular-nums", overdue && "font-semibold text-danger")}>
                {t.deadline ? fmtDay(t.deadline) : "—"}
              </span>
              <span className="text-right tabular-nums text-muted">
                {(t.trackedSeconds / 3600).toFixed(1)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
