import type { MailoutStatus } from "@shared/schema/enums";
import { cn } from "@/shared/lib/cn";

/**
 * `skipped` is deliberately not styled as an error — nothing went wrong, the firm was protected
 * from sending a broken or unlawful letter. `queued` is not styled as success either: it means
 * "still in flight", and after a restart it means "we do not know", which is the truth.
 */
const TONES: Record<MailoutStatus, { label: string; className: string }> = {
  sent: { label: "sent", className: "bg-success/12 text-success" },
  queued: { label: "sending", className: "bg-[#eef0f3] text-muted" },
  failed: { label: "failed", className: "bg-danger/12 text-danger-text" },
  skipped: { label: "skipped", className: "bg-warning/15 text-[#8a5a12]" },
};

export function StatusPill({ status, count }: { status: MailoutStatus; count?: number }) {
  const tone = TONES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-(--radius-chip) px-1.5 py-0.5 text-[11px] font-medium",
        tone.className,
      )}
    >
      {count !== undefined && <span className="tabular-nums">{count}</span>}
      <span>{tone.label}</span>
    </span>
  );
}
