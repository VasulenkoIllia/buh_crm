import { useState } from "react";
import type { Task } from "@shared/schema/task";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { TaskDetailsModal, TaskFormModal, type Target } from "./task-modals";
import { fmtDuration } from "./timer";
import { useAssignees, useTasksFor } from "./tasks.api";

const isOverdue = (t: Task) => !t.done && !!t.deadline && new Date(t.deadline) < new Date();
const fmtDue = (iso: string) => new Date(iso).toLocaleDateString("en-GB");

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
        overdue && "border-2 border-[#d63c3c]",
        task.done && "opacity-70",
      )}
    >
      {task.done && <span className="text-[#1f8f3a]">✓</span>}
      <span className={cn("min-w-0 truncate font-medium", task.done && "text-[#6b7280] line-through")}>
        {task.title}
      </span>
      {serviceName && <ServiceChip name={serviceName.name} color={serviceName.color} />}
      {task.kind === "sub" && (
        <span className="rounded-[5px] bg-[#eef1fb] px-[6px] py-[1px] text-[11px] text-[#2f4fd6]">📅 auto</span>
      )}
      {task.invoice && (
        <span className="rounded-[5px] bg-[#eef1fb] px-[6px] py-[1px] text-[11px] font-medium text-[#2f4fd6]">
          💰 {task.invoice.number}
        </span>
      )}
      {task.kind === "free" && task.clientId && (
        <span className="rounded-[5px] bg-[#e2f4f0] px-[6px] py-[1px] text-[11px] text-[#0e7a6b]">included</span>
      )}
      <span className="ml-auto flex-none text-[12px] text-muted">
        {assigneeNames || "unassigned"}
      </span>
      {task.trackedSeconds > 0 && (
        <span className="flex-none text-[12px] tabular-nums text-muted">{fmtDuration(task.trackedSeconds)}</span>
      )}
      <span
        className={cn(
          "flex-none text-[12px]",
          overdue ? "font-semibold text-[#d63c3c]" : "text-muted-400",
        )}
      >
        {task.deadline ? fmtDue(task.deadline) : "—"}
      </span>
    </button>
  );
}
