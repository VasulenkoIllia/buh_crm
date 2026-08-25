import type { DeliveryState } from "@shared/delivery";
import { DELIVERY_LABEL } from "@shared/delivery";
import { cn } from "@/shared/lib/cn";

/**
 * What one letter's outcome looks like on screen.
 *
 * The words are the reader's, never the protocol's. Nobody opening this screen wants to know that
 * a letter is `bounced` or that a row is `queued`; they want to know whether the client got it. So
 * the states are **Delivered**, **Not delivered**, **Sent** — and the reason underneath says why,
 * when there is a why.
 *
 * The colours carry the same distinction the words do:
 *
 *   green   it arrived
 *   red     it did not, and somebody has to act
 *   amber   nothing was sent, and that was deliberate — the firm was protected
 *   grey    not known yet, which is an honest answer and not a failure
 *
 * `Sent` is deliberately grey rather than green. It means "handed over, outcome unknown" — either
 * too soon to tell, or nobody reads the mailbox a refusal would arrive in. Colouring it as success
 * would be the same confident lie the delivery log was built to stop telling.
 */
const TONES: Record<DeliveryState, string> = {
  delivered: "bg-success/12 text-success",
  not_delivered: "bg-danger/12 text-danger-text",
  not_sent: "bg-danger/12 text-danger-text",
  skipped: "bg-warning/15 text-[#8a5a12]",
  sent: "bg-[#eef0f3] text-muted",
  sending: "bg-[#eef0f3] text-muted",
};

export function StatusPill({ state, count }: { state: DeliveryState; count?: number }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-(--radius-chip) px-1.5 py-0.5 text-[11px] font-medium",
        TONES[state],
      )}
    >
      {count !== undefined && <span className="tabular-nums">{count}</span>}
      <span>{DELIVERY_LABEL[state]}</span>
    </span>
  );
}

/**
 * How the sentence UNDER a row should read.
 *
 * A skip and a failure both leave a reason behind, but they are not the same news: a skip is the
 * firm being protected from sending something broken, a failure is a letter nobody received.
 * Shared from here because the delivery log and the client card show the same line, and two copies
 * of a rule is how two screens start disagreeing.
 */
export function reasonTone(state: DeliveryState): string {
  if (state === "not_delivered" || state === "not_sent") return "text-danger-text";
  if (state === "skipped") return "text-[#8a5a12]";
  return "text-muted";
}
