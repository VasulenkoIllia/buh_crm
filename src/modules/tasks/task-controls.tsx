import { useState } from "react";
import { Check } from "lucide-react";
import type { Task } from "@shared/schema/task";
import { cn } from "@/shared/lib/cn";
import { useActiveTimer, useStartTimer, useUpdateTask } from "./tasks.api";
import { TimerCommentModal, fmtDuration, useElapsed } from "./timer";

/**
 * Toggle a task's `done` flag. Green, rounded, check-marked in both sizes so the
 * action reads the same everywhere. `compact` = a small pill for the board mini-card;
 * otherwise a big solid-green pill for the details modal. Any authenticated user.
 */
export function DoneToggle({
  task,
  compact,
  disabled,
}: {
  task: Task;
  compact?: boolean;
  /** block the toggle while a sibling patch is in flight (e.g. an unsaved job price) */
  disabled?: boolean;
}) {
  const update = useUpdateTask();
  const toggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    update.mutate({ id: task.id, input: { done: !task.done } });
  };
  const busy = update.isPending || disabled;

  if (compact) {
    return (
      <button
        type="button"
        aria-label={task.done ? "Mark not done" : "Mark done"}
        title={task.done ? "Done — click to reopen" : "Mark done"}
        disabled={busy}
        onClick={toggle}
        className={cn(
          "flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none transition-colors",
          task.done
            ? "bg-[#1f8f3a] text-white hover:bg-[#17742e]"
            : "border border-[#bfe3c9] bg-[#eaf6ee] text-[#1f8f3a] hover:bg-[#1f8f3a] hover:text-white",
        )}
      >
        <Check size={13} strokeWidth={3} />
        Done
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => toggle()}
      className={cn(
        "flex flex-none items-center gap-1.5 rounded-full px-5 py-2 text-[13px] font-semibold text-white transition-colors disabled:opacity-60",
        task.done ? "bg-[#17742e] hover:bg-[#0f5e24]" : "bg-[#1f8f3a] hover:bg-[#17742e]",
      )}
    >
      <Check size={16} strokeWidth={3} />
      {task.done ? "Done" : "Mark done"}
    </button>
  );
}

/**
 * Start/stop THIS task's timer, honoring one-running-per-user. If another task is
 * running, starting opens the comment modal (close old → start new). `compact` = a
 * small pill for the board card; otherwise the labelled row for the details modal.
 */
export function TaskTimerButton({ task, compact }: { task: Task; compact?: boolean }) {
  const { data: timer } = useActiveTimer();
  const start = useStartTimer();
  const [modal, setModal] = useState<"stop" | "switch" | null>(null);
  const mine = timer?.taskId === task.id;
  const elapsed = useElapsed(mine ? timer?.startedAt : undefined);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mine) setModal("stop");
    else if (timer) setModal("switch"); // close the other interval with a comment first
    else start.mutate({ taskId: task.id });
  };

  if (compact) {
    return (
      <>
        <button
          type="button"
          onClick={onClick}
          title={mine ? "Stop timer" : "Start timer"}
          className={cn(
            "flex flex-none items-center gap-1 rounded-[6px] border px-2 py-[3px] text-[11px] font-semibold",
            mine
              ? "animate-pulse border-[#cdd7f7] bg-[#eef1fb] text-[#3355dd]"
              : "border-[#cdd7f7] bg-[#eef1fb] text-[#2f4fd6] hover:bg-[#e2e8fb]",
          )}
        >
          {mine ? `⏱ ${fmtDuration(elapsed)} ⏹` : "▶ Track"}
        </button>
        {modal && timer && (
          <TimerCommentModal
            timer={timer}
            next={modal === "switch" ? { taskId: task.id, title: task.title } : undefined}
            onClose={() => setModal(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2.5">
      {mine ? (
        <>
          <span className="animate-pulse text-[13px] font-bold text-[#3355dd]">
            ⏱ {fmtDuration(elapsed)}
          </span>
          <button
            type="button"
            onClick={onClick}
            className="rounded-(--radius-btn-sm) border border-border bg-surface px-3 py-1 text-[13px] font-medium hover:bg-divider"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          <span className="text-[13px] text-muted">
            {timer ? `Timer runs on “${timer.taskTitle}”` : "No timer running"}
          </span>
          <button
            type="button"
            onClick={onClick}
            className="rounded-(--radius-btn-sm) bg-primary px-3 py-1 text-[13px] font-medium text-white hover:opacity-90"
          >
            ▶ Start
          </button>
        </>
      )}
      {modal && timer && (
        <TimerCommentModal
          timer={timer}
          next={modal === "switch" ? { taskId: task.id, title: task.title } : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
