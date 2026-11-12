import { JOB_TONE_COLORS } from "@/shared/lib/colors";
import type { SystemHealthResponse } from "./settings.api";

const MODE_TEXT = {
  sandbox: {
    label: "Sandbox",
    tone: "warn",
    note: "Test cards only, no real money. The PDF prints no pay link, and the pay page says TEST.",
  },
  live: {
    label: "Live",
    tone: "ok",
    note: "Clients pay by card. The PDF carries the pay link while an invoice owes something.",
  },
} as const;

/**
 * **Settings → System → Online payments** (payments.md §11): which Stripe the pay link talks to,
 * read off the server's key. Not shown at all while Stripe is not configured, like every other part
 * of it. The last webhook joins this row with stage B.
 */
export function StripePanel({ stripe }: { stripe: SystemHealthResponse["stripe"] }) {
  if (!stripe) return null;
  const text = MODE_TEXT[stripe.mode];
  const color = JOB_TONE_COLORS[text.tone].fg;
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Online payments</h3>
      <div className="rounded-(--radius-panel) border border-border bg-surface px-3.5 py-3 shadow-(--shadow-card)">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[13px] font-medium">Stripe</span>
          <span
            aria-hidden
            className="inline-block size-1.5 flex-none rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-[12px]" style={{ color }}>
            {text.label}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-muted">{text.note}</p>
      </div>
    </section>
  );
}
