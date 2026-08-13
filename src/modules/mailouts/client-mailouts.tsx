import { useState } from "react";
import { BellOff, CalendarClock, Mail, Repeat, Send } from "lucide-react";
import { RHYTHM_LABELS } from "@shared/campaigns";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { ComposeModal } from "./compose-modal";
import { ClientMailoutModal } from "./client-mailout-modal";
import { StatusPill } from "./status-pill";
import { useClientMailState, useSetSubscription } from "./mailouts.api";

/**
 * The client card's Mailouts tab — the two questions the firm actually asks about a client:
 * *what have we sent them?* and *are they still willing to hear from us?*
 *
 * The subscription control is worded carefully. It governs COMMERCIAL mail only, and the card
 * says so, because "unsubscribed" reading as "we can't contact them" would be wrong and would
 * eventually stop somebody sending an invoice.
 */
const HISTORY_GRID = "grid-cols-[minmax(180px,1fr)_150px_130px_130px_auto]";

export function ClientMailouts({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const { data, isLoading } = useClientMailState(clientId);
  const setSubscription = useSetSubscription(clientId);
  const [composing, setComposing] = useState(false);
  const [openLetter, setOpenLetter] = useState<string | null>(null);

  if (isLoading || !data) return <p className="text-[13px] text-muted">Loading…</p>;

  // Every inbox on file that a letter could actually leave for — the client's own and their
  // companies'. A client with no email of their own is still writable if one of their companies
  // has one, so "can we send anything at all" is this, not `hasEmail`.
  const reachable = data.targets.filter((t) => t.email);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-panel) border border-border bg-surface p-4 shadow-(--shadow-card)">
        <div className="flex items-start gap-2.5">
          {data.subscribed ? (
            <Mail size={16} className="mt-0.5 text-success" />
          ) : (
            <BellOff size={16} className="mt-0.5 text-faint" />
          )}
          <div>
            <p className="text-[14px] font-medium">
              {data.subscribed ? "Subscribed to news and updates" : "Unsubscribed from news and updates"}
            </p>
            <p className="text-[12px] leading-relaxed text-muted">
              {data.subscribed
                ? "Receives commercial mailouts as well as invoices and account letters."
                : data.unsubscribedByName
                  ? `Unsubscribed by ${data.unsubscribedByName}${data.unsubscribedAt ? ` on ${fmtDateTime(data.unsubscribedAt)}` : ""}. Invoices and account letters still reach them.`
                  : `Unsubscribed themselves${data.unsubscribedAt ? ` on ${fmtDateTime(data.unsubscribedAt)}` : ""}. Invoices and account letters still reach them.`}
            </p>
            {/* which letter's link they clicked — the opt-out is global whatever prompted it, but
                knowing WHICH letter costs subscribers is the only way to change anything */}
            {!data.subscribed && data.unsubscribedFrom && (
              <p className="mt-1 text-[12px] text-muted">
                After the letter “{data.unsubscribedFrom.subject}”
                {data.unsubscribedFrom.campaignName && (
                  <> · campaign “{data.unsubscribedFrom.campaignName}”</>
                )}
              </p>
            )}
            {!data.hasEmail && (
              <p className="mt-1 text-[12px] text-danger-text">
                {reachable.length > 0
                  ? `No email on the client card — only their ${reachable.length === 1 ? "company" : "companies"} can be written to.`
                  : "This client has no email address — nothing can be sent to them at all."}
              </p>
            )}
            {data.targets.length > 1 && (
              <p className="mt-1 text-[12px] text-muted">
                {data.targets.length} addresses on file — theirs and{" "}
                {data.targets.length - 1 === 1 ? "one company" : `${data.targets.length - 1} companies`}.
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSubscription.mutate(!data.subscribed)}
            disabled={setSubscription.isPending}
          >
            {data.subscribed ? "Unsubscribe" : "Re-subscribe"}
          </Button>
          <Button size="sm" onClick={() => setComposing(true)} disabled={reachable.length === 0}>
            <Send size={13} /> Send a letter
          </Button>
        </div>
      </div>

      {data.campaigns.length > 0 && (
        <div className="rounded-(--radius-panel) border border-border bg-surface">
          <div className="border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            Scheduled for them
          </div>
          {data.campaigns.map((c) => (
            <div
              key={`${c.id}:${c.companyId ?? ""}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[13px] last:border-0"
            >
              <span className="min-w-0 flex-1 truncate">
                {c.name}
                {c.companyName && <span className="text-muted"> · {c.companyName}</span>}
              </span>
              <span className="flex items-center gap-1 text-[12px] text-muted">
                {c.rhythm !== "once" && <Repeat size={11} />}
                {RHYTHM_LABELS[c.rhythm]}
              </span>
              <span className="flex items-center gap-1 text-[12px] text-muted">
                <CalendarClock size={11} />
                {c.status !== "scheduled"
                  ? "Stopped"
                  : c.nextRunOn
                    ? fmtDate(c.nextRunOn)
                    : "—"}
              </span>
              {/* said here rather than only at send time: a client queued for a letter they will
                  never receive is exactly what somebody wants to know before the date, not after */}
              {c.blockedReason && (
                <span className="w-full text-[12px] text-[#8a5a12]">
                  Would be skipped — {c.blockedReason.toLowerCase()}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {data.history.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          <div className="text-[15px] font-semibold">Nothing sent to this client yet</div>
          <p className="mt-1 text-[13px] text-muted">
            Every letter — and every one that was skipped, with the reason — appears here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
          <div
            className={cn(
              "grid min-w-[700px] items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
              HISTORY_GRID,
            )}
          >
            <div>Subject</div>
            <div>To</div>
            <div>Template</div>
            <div>When</div>
            <div className="text-right">Status</div>
          </div>

          {data.history.map((h) => (
            <div
              key={h.id}
              onClick={() => setOpenLetter(h.id)}
              className={cn(
                "grid min-w-[700px] cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
                HISTORY_GRID,
              )}
            >
              <div className="min-w-0">
                <div className="truncate">{h.subject}</div>
                {/* the reason a letter was skipped belongs beside it, not in a detail nobody opens */}
                {h.reason && <p className="truncate text-[12px] text-muted">{h.reason}</p>}
              </div>
              <div className="truncate text-muted">{h.companyName ?? "Client\u2019s own address"}</div>
              <div className="truncate text-muted">{h.templateName ?? "One-off letter"}</div>
              <div className="text-muted">{fmtDateTime(h.sentAt ?? h.createdAt)}</div>
              <div className="text-right">
                <StatusPill status={h.status} />
              </div>
            </div>
          ))}
        </div>
      )}

      <ComposeModal
        open={composing}
        onClose={() => setComposing(false)}
        // the composer reports the MAILOUT it created; this tab lists recipient rows, so the
        // freshly sent letter is found by refetching rather than opened by an id of another kind
        onSent={() => setComposing(false)}
        presetClientId={clientId}
        presetTargets={data.targets}
      />
      {/* the CLIENT-scoped modal, never the mailout-level one — see its own comment */}
      <ClientMailoutModal
        letterId={openLetter}
        clientId={clientId}
        clientName={clientName}
        onClose={() => setOpenLetter(null)}
      />
    </div>
  );
}
