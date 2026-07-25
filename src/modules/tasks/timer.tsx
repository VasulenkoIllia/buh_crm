import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useActiveTimer, useStartTimer, useStopTimer, type ActiveTimer } from "./tasks.api";

export function fmtDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Live seconds since `startedAt` (ticks every second). */
export function useElapsed(startedAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

/**
 * Closing an interval ALWAYS asks what was done (decision 2026-07-23).
 * mode "stop" just closes; mode "switch" closes the old interval with the
 * comment and starts `nextTaskId` atomically. Cancel = the old timer keeps running.
 */
export function TimerCommentModal({
  timer,
  next,
  onClose,
}: {
  timer: ActiveTimer;
  next?: { taskId: string; title: string };
  onClose: () => void;
}) {
  const stop = useStopTimer();
  const start = useStartTimer();
  const [comment, setComment] = useState("");
  const elapsed = useElapsed(timer.startedAt);
  const mutation = next ? start : stop;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  const save = async () => {
    if (!comment.trim()) return;
    try {
      if (next) await start.mutateAsync({ taskId: next.taskId, closeComment: comment.trim() });
      else await stop.mutateAsync({ comment: comment.trim() });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  return (
    <Modal
      title={next ? "Switch task — close the current timer" : "Stop timer"}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!comment.trim() || mutation.isPending} onClick={() => void save()}>
            {mutation.isPending ? "Saving…" : next ? "Save & start next" : "Save & stop"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="text-[13px] text-muted">{timer.taskTitle}</div>
          <div className="mt-0.5 text-[22px] font-bold tabular-nums">{fmtDuration(elapsed)}</div>
          {next && (
            <div className="mt-1 text-[12px] text-muted">
              Next up: <span className="font-medium text-ink-700">{next.title}</span>
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-ink-700">
            What did you do? <span className="text-danger-text">*</span>
          </div>
          <Textarea
            className="h-[74px]"
            value={comment}
            autoFocus
            onChange={(e) => setComment(e.target.value)}
            placeholder="e.g. Reconciled the bank feed, sent the report"
          />
          <p className="mt-1 text-[12px] text-faint">
            The interval is saved only with a comment — it becomes the work log.
          </p>
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** Always-visible running timer in the app header (any page). */
export function TimerBar() {
  const { data: timer } = useActiveTimer();
  const navigate = useNavigate();
  const [stopOpen, setStopOpen] = useState(false);
  const elapsed = useElapsed(timer?.startedAt);

  if (!timer) return null;

  return (
    <div className="flex items-center gap-2 rounded-(--radius-field) border border-[#cdd7f7] bg-[#eef1fb] px-3 py-1.5 text-[13px]">
      <span className="animate-pulse font-bold text-[#3355dd]">⏱</span>
      {/* click the running task to open it (works from any page) */}
      <button
        type="button"
        className="max-w-44 truncate font-medium text-ink-700 hover:text-primary-link hover:underline"
        title={`Open “${timer.taskTitle}”`}
        onClick={() => navigate(`/tasks?task=${timer.taskId}`)}
      >
        {timer.taskTitle}
      </button>
      <span className="font-bold tabular-nums text-[#3355dd]">{fmtDuration(elapsed)}</span>
      <button
        type="button"
        className="text-[12px] font-semibold text-danger-text hover:underline"
        onClick={() => setStopOpen(true)}
      >
        Stop
      </button>
      {stopOpen && <TimerCommentModal timer={timer} onClose={() => setStopOpen(false)} />}
    </div>
  );
}
