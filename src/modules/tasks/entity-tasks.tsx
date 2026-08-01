import { useState } from "react";
import type { Task } from "@shared/schema/task";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { userLabel } from "@/shared/ui/avatar";
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

  // The rollup asks for this client's WHOLE history (no status filter), so cancelled work comes
  // back with the rest — and must not sit in the open list looking live (2026-08-01 audit).
  const tasks = data?.items ?? [];
  const open = tasks.filter((t) => !t.done && !t.cancelledAt);
  const done = tasks.filter((t) => t.done && !t.cancelledAt);
  const cancelled = tasks.filter((t) => t.cancelledAt);
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;

  // ONE way to name a task's people, for both the open and the done rows. The done rows used to
  // pass a hardcoded "" here, so every finished task on a client's card read "unassigned" — which
  // is what "the assignee disappears when I close a task" was (user report, 2026-08-01).
  const namesOf = (t: Task) =>
    t.assignees
      .map((id) => team?.find((u) => u.id === id))
      .map((u) => (u ? userLabel(u) : null))
      .filter(Boolean)
      .join(", ");

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
          assigneeNames={namesOf(t)}
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
              assigneeNames={namesOf(t)}
              onOpen={() => setSelectedId(t.id)}
            />
          ))}
        </>
      )}

      {cancelled.length > 0 && (
        <>
          <div className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
            Cancelled ({cancelled.length})
          </div>
          {cancelled.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              serviceName={services?.find((s) => s.id === t.serviceId)}
              priorityColor={settings?.priorities.find((p) => p.id === t.priorityId)?.color}
              assigneeNames={namesOf(t)}
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
        (task.done || task.cancelledAt) && "opacity-70",
      )}
    >
      {task.cancelledAt ? (
        <span className="text-[#b5651d]">⊘</span>
      ) : (
        task.done && <span className="text-success">✓</span>
      )}
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          (task.done || task.cancelledAt) && "text-muted line-through",
        )}
      >
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
