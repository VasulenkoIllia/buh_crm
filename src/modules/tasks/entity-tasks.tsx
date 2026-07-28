import { useState } from "react";
import type { Task } from "@shared/schema/task";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { fmtBizDate } from "@/shared/lib/format";
import { isOverdue, TaskKindChip } from "./lib";
import { TaskDetailsModal, TaskFormModal, type Target } from "./task-modals";
import { TrackedTime } from "./timer";
import { useAssignees, useTasksFor } from "./tasks.api";

/**
 * A client's or lead's tasks — the rollup list on their card. Read + open
 * details + toggle done live here; "+ New task" opens the form pre-targeted.
 */
export function EntityTasks({ target }: { target: Target }) {
  const filter = target.kind === "client" ? { clientId: target.id } : { leadId: target.id };
  const { data, isLoading, error } = useTasksFor(filter);
  const { data: services } = useCatalog();
  const { data: settings } = useSettings();
  const { data: team } = useAssignees();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tasks = data?.items ?? [];
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">
          Tasks{tasks.length > 0 && <span className="ml-1.5 text-[13px] text-muted">{tasks.length}</span>}
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setFormOpen(true)}>
          + New task
        </Button>
      </div>

      {isLoading && <p className="text-[13px] text-muted">Loading…</p>}
      {error && <p className="text-[13px] text-danger-text">Failed to load tasks.</p>}
      {data && tasks.length === 0 && (
        <p className="text-[13px] text-muted">
          No tasks yet — add one, or subscription tasks will land here as they generate.
        </p>
      )}

      {open.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          serviceName={services?.find((s) => s.id === t.serviceId)}
          priorityColor={settings?.priorities.find((p) => p.id === t.priorityId)?.color}
          assigneeNames={t.assignees
            .map((id) => team?.find((u) => u.id === id))
            .map((u) => (u ? `${u.firstName} ${u.lastName}` : null))
            .filter(Boolean)
            .join(", ")}
          onOpen={() => setSelectedId(t.id)}
        />
      ))}

      {done.length > 0 && (
        <>
          <div className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
            Done ({done.length})
          </div>
          {done.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              serviceName={services?.find((s) => s.id === t.serviceId)}
              priorityColor={settings?.priorities.find((p) => p.id === t.priorityId)?.color}
              assigneeNames=""
              onOpen={() => setSelectedId(t.id)}
            />
          ))}
        </>
      )}

      {formOpen && <TaskFormModal preset={target} onClose={() => setFormOpen(false)} />}
      {selected && <TaskDetailsModal task={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function TaskRow({
  task,
  serviceName,
  priorityColor,
  assigneeNames,
  onOpen,
}: {
  task: Task;
  serviceName?: { name: string; color: string };
  priorityColor?: string;
  assigneeNames: string;
  onOpen: () => void;
}) {
  const overdue = isOverdue(task);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={!overdue && priorityColor ? { borderLeft: `3px solid ${priorityColor}` } : undefined}
      className={cn(
        "mb-1.5 flex w-full items-center gap-2 rounded-[8px] border border-border bg-surface px-3 py-2 text-left text-[13px] hover:bg-divider/30",
        overdue && "border-2 border-danger",
        task.done && "opacity-70",
      )}
    >
      {task.done && <span className="text-success">✓</span>}
      <span className={cn("min-w-0 truncate font-medium", task.done && "text-muted line-through")}>
        {task.title}
      </span>
      {serviceName && <ServiceChip name={serviceName.name} color={serviceName.color} />}
      {task.kind === "sub" && (
        <Chip tone="blue" size="sm">
          📅 auto
        </Chip>
      )}
      {task.invoice && (
        <InvoiceStatusPill status={task.invoice.status} prefix="💰" size="sm" />
      )}
      <TaskKindChip task={task} size="sm" />
      <span className="ml-auto flex-none text-[12px] text-muted">
        {assigneeNames || "unassigned"}
      </span>
      <TrackedTime seconds={task.trackedSeconds} className="flex-none text-[12px]" />
      <span
        className={cn(
          "flex-none text-[12px]",
          overdue ? "font-semibold text-danger" : "text-muted-400",
        )}
      >
        {task.deadline ? fmtBizDate(task.deadline) : "—"}
      </span>
    </button>
  );
}
