import { useState } from "react";
import { Check, Play } from "lucide-react";
import type { Task } from "@shared/schema/task";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { AssigneeAvatars, userLabel } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Chip, ChipButton } from "@/shared/ui/chip";
import { IconAdd } from "@/shared/ui/icons";
import { Menu, type MenuItem } from "@/shared/ui/menu";
import { useToast } from "@/shared/ui/toast";
import { useActiveTimer, useStartTimer, useUpdateTask, type AssigneeInfo } from "./tasks.api";
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
 * **Who is on this job, set without opening it.**
 *
 * Fifteen of the thirty-seven open tasks in production had nobody on them, and the only way to put
 * a name on one was to open it, find Assignees and press a pill (owner, 2026-10-03). This is that
 * act where somebody actually notices the gap: on the board card and in the table row, from the
 * same `PATCH /api/tasks/:id` the editor already sends, so the server's own rules — only an active
 * teammate may be given work, the `task.assigned` entry, the notification — all still apply.
 *
 * ONE person, replacing whoever is there. Several remain the task editor's business, and a task
 * that already HAS several is left exactly as it was: a quick menu that silently dropped two of
 * three names would be worse than no quick menu. A finished or called-off task is a locked
 * snapshot, the same rule the details modal follows.
 *
 * `Menu` is what makes this safe on a card that drags. It stops pointer events at the trigger, so
 * opening the list neither lifts the card nor opens the task; it draws the list in a portal, which
 * a card carrying a `transform` would otherwise have anchored to itself; and the board's keyboard
 * sensor already ignores a key whose target is not the card, so Space on a name does not start a
 * drag.
 */
export function AssignMenu({
  task,
  team,
  look,
}: {
  task: Task;
  team: AssigneeInfo[];
  /** `faces` = the board card's row of facts; `name` = the table's Assignee column */
  look: "faces" | "name";
}) {
  const update = useUpdateTask();
  const toast = useToast();
  const first = team.find((u) => u.id === task.assignees[0]);
  const none = task.assignees.length === 0;
  const hint = first ? `Assigned to ${userLabel(first)}` : "Assign somebody";
  // the accessible name carries the task: a board of thirty cards otherwise reads as thirty
  // buttons called "Assign somebody" (audit, 2026-10-03)
  const name = `${hint}: ${task.title}`;

  /** exactly what the card and the row showed before this existed */
  const plain =
    look === "faces" ? (
      <AssigneeAvatars
        ids={task.assignees}
        team={team}
        empty={
          <Chip tone="amber" strong>
            Unassigned
          </Chip>
        }
      />
    ) : (
      <>
        {first ? userLabel(first) : "—"}
        {task.assignees.length > 1 && ` +${task.assignees.length - 1}`}
      </>
    );

  if (task.done || task.cancelledAt || task.assignees.length > 1) {
    return look === "faces" ? (
      plain
    ) : (
      // `block`: the cell wraps this now, so it is no longer the grid item that would have
      // blockified it, and `truncate` does nothing to an inline box (audit, 2026-10-03)
      <span className="block min-w-0 truncate text-muted">{plain}</span>
    );
  }

  /**
   * Picking the one already ticked sends nothing. The server would have taken it — the diff is
   * empty, so no `task.assigned` entry and no second notification — but it would still have cost
   * a request and a bare "Admin sent PATCH /api/tasks/:id" line in the activity log, which is a
   * row somebody reads one day and learns nothing from.
   */
  const pick = (assignees: string[], already: boolean) => () => {
    // `already` is read off `task`, which a PATCH in flight is about to rewrite: A → B → A before
    // the refetch lands would otherwise see A still ticked, send nothing, and leave the job on B
    if (already && !update.isPending) return;
    update.mutate(
      { id: task.id, input: { assignees } },
      {
        /*
          The one place in this file that says a thing failed, and it has to be the toast.
          An error belongs beside what it happened to, but a card in a column has no beside:
          the chip simply stays as it was, which is indistinguishable from not having pressed it.
          The team list is five minutes stale, so "that person was just blocked" is the refusal
          this will actually carry (audit, 2026-10-03).
        */
        // `e.message` falls back to the status text, which is empty for some answers: an empty
        // toast is a black bar that says nothing, so the sentence is the floor
        onError: (e) =>
          toast({
            text:
              (e instanceof ApiError && e.message) || "The assignee did not change. Try again.",
          }),
      },
    );
  };

  const items: (MenuItem | "divider")[] = [
    { label: "Unassigned", checked: none, onSelect: pick([], none) },
    "divider",
    // the task editor's rule: only an active teammate can be given work, but whoever is already
    // on the task stays listed so they can be taken off
    ...team
      .filter((u) => u.status === "active" || task.assignees.includes(u.id))
      .map((u) => {
        const already = task.assignees.includes(u.id);
        return {
          label: `${userLabel(u)}${u.status === "blocked" ? " ⛔" : ""}`,
          checked: already,
          onSelect: pick([u.id], already),
        };
      }),
  ];

  return (
    <Menu
      label={`Assignee for ${task.title}`}
      items={items}
      button={(props) => (
        <ChipButton
          {...props}
          tone={none ? "amber" : undefined}
          strong={none}
          size={look === "faces" && !none ? "sm" : "md"}
          /*
            NOT disabled while the PATCH is in flight, unlike the editor's picker. That one
            TOGGLES against `task.assignees`, so a second press before the refetch lands reads a
            stale list and clobbers it; each pick here SETS the list outright, so a second pick
            simply wins. Disabling would also have cost the keyboard its place: `Menu` hands the
            focus back to the trigger as it closes, and a trigger that disables on the next render
            drops it to the body.
          */
          // the faces look has no words of its own, so the name is said rather than drawn
          aria-label={name}
          title={hint}
          /*
            In the table the chip must not change the row. A chip's own `py-[2px]` made the
            Assignee cell 24px against the 21px of the Priority and Status chips beside it, so
            every row grew 3px — about three quarters of a row lost down a 13-inch screen, which
            is the thing the September fitting work was about. `py-0` leaves the line box, and the
            negative margin pays back the padding so the name still starts under its own heading
            rather than 8px to the right of it (audit, 2026-10-03).
          */
          className={look === "name" ? "-mx-1.5 min-w-0 px-1.5 py-0 text-[13px]" : undefined}
        >
          {none ? (
            <>
              <IconAdd size={11} strokeWidth={3} />
              Assign
            </>
          ) : look === "faces" ? (
            plain
          ) : (
            <span className="min-w-0 truncate">{plain}</span>
          )}
        </ChipButton>
      )}
    />
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
    else if (timer)
      setModal("switch"); // close the other interval with a comment first
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
              ? "border-[#cdd7f7] bg-[#eef1fb] text-[#3355dd]"
              : "border-[#cdd7f7] bg-[#eef1fb] text-[#2f4fd6] hover:bg-[#e2e8fb]",
          )}
        >
          {mine ? (
            <>
              {/* only the small dot pulses ("recording") — the ticking time stays steady/readable */}
              <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-[#3355dd]" />
              <span className="tabular-nums">{fmtDuration(elapsed)}</span>
              <span aria-hidden>■</span>
            </>
          ) : (
            "▶ Track"
          )}
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
          <span className="flex items-center gap-1.5 text-[13px] font-bold text-[#3355dd]">
            {/* steady time + a small pulsing "recording" dot (no whole-element blink) */}
            <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-[#3355dd]" />
            <span className="tabular-nums">{fmtDuration(elapsed)}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={onClick}>
            Stop
          </Button>
        </>
      ) : (
        <>
          <span className="text-[13px] text-muted">
            {timer ? `Timer runs on “${timer.taskTitle}”` : "No timer running"}
          </span>
          <Button size="sm" onClick={onClick}>
            <Play />
            Start
          </Button>
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
