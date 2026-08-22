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

/**
 * How the sentence UNDER a row should read.
 *
 * A skip and a failure both leave a reason behind, but they are not the same news: a skip is the
 * firm being protected from sending something broken, a failure is a letter that did not go and
 * somebody has to act. Rendering both in the same grey said they were equivalent. Shared from
 * here because the delivery log and the client card show the same line, and two copies of a rule
 * is how the two screens start disagreeing.
 */
export function reasonTone(status: MailoutStatus): string {
  if (status === "failed") return "text-danger-text";
  if (status === "skipped") return "text-[#8a5a12]";
  return "text-muted";
}
