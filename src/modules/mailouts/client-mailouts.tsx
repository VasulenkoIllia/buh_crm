import { useState } from "react";
import { BellOff, CalendarClock, CalendarPlus, Mail, Repeat, Send } from "lucide-react";
import { RHYTHM_LABELS } from "@shared/campaigns";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { FilterChips } from "@/shared/ui/tabs";
import { CampaignModal } from "./campaign-modal";
import { ComposeModal } from "./compose-modal";
import { ClientMailoutModal } from "./client-mailout-modal";
import { StatusPill } from "./status-pill";
import { useClientMailState, useSetSubscription } from "./mailouts.api";

/**
 * The client card's Mailouts tab — three questions, and now only one of them on screen at a time.
 *
 *   *Are they still willing to hear from us?*  the consent panel, always on top: it is the state
 *                                              everything else is conditional on.
 *   *What have we sent them?*                  Sent.
 *   *What are we about to?*                    Scheduled.
 *
 * The last two used to be stacked, so a client on three campaigns pushed their letter history
 * below the fold and the tab read as a wall. Chips rather than a second underline row: the card
 * already owns the underline, and two of them stacked stop meaning "you are here".
 *
 * The subscription control is worded carefully. It governs COMMERCIAL mail only, and the card
 * says so, because "unsubscribed" reading as "we can't contact them" would be wrong and would
 * eventually stop somebody sending an invoice.
 */
const HISTORY_GRID = "grid-cols-[minmax(180px,1fr)_150px_140px_150px_90px]";
const HISTORY_MIN = "min-w-[760px]";
const SCHEDULED_GRID = "grid-cols-[minmax(180px,1fr)_150px_130px]";
const SCHEDULED_MIN = "min-w-[490px]";

type View = "sent" | "scheduled";

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
  const [scheduling, setScheduling] = useState(false);
  const [openLetter, setOpenLetter] = useState<string | null>(null);
  const [view, setView] = useState<View>("sent");
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !data) return <p className="text-[13px] text-muted">Loading…</p>;

  // Every inbox on file that a letter could actually leave for — the client's own and their
  // companies'. A client with no email of their own is still writable if one of their companies
  // has one, so "can we send anything at all" is this, not `hasEmail`.
  const reachable = data.targets.filter((t) => t.email);

  return (
    <div className="space-y-4">
      {/* the global handler only acts on 401 — anything else needs a place to be said */}
      {error && (
        <p className="rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}
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
            {/* Only what the two lists below cannot say. "Receives commercial mailouts as well as
                invoices" was boilerplate on every subscribed client, and a count of addresses
                repeated what the Sent and Scheduled columns already name one by one. */}
            {!data.subscribed && (
              <p className="text-[12px] leading-relaxed text-muted">
                {data.unsubscribedByName
                  ? `Unsubscribed by ${data.unsubscribedByName}${data.unsubscribedAt ? ` on ${fmtDateTime(data.unsubscribedAt)}` : ""}. Invoices and account letters still reach them.`
                  : `Unsubscribed themselves${data.unsubscribedAt ? ` on ${fmtDateTime(data.unsubscribedAt)}` : ""}. Invoices and account letters still reach them.`}
              </p>
            )}
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
            {/* The one case worth a line: it is why "Send a letter" is disabled. */}
            {reachable.length === 0 && (
              <p className="mt-1 text-[12px] text-danger-text">
                No address anywhere — nothing can be sent to them or their companies.
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setError(null);
              setSubscription
                .mutateAsync(!data.subscribed)
                .catch((e) =>
                  setError(e instanceof Error ? e.message : "Could not change the subscription"),
                );
            }}
            disabled={setSubscription.isPending}
          >
            {data.subscribed ? "Unsubscribe" : "Re-subscribe"}
          </Button>
          {/* Two halves of the same act — write to this client now, or on a date. Scheduling from
              here rather than from the Campaigns tab is the difference between "set a reminder for
              Olena" and "make a campaign, then find Olena in a list of everyone". */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setScheduling(true)}
            disabled={reachable.length === 0}
          >
            <CalendarPlus size={13} /> Schedule
          </Button>
          <Button size="sm" onClick={() => setComposing(true)} disabled={reachable.length === 0}>
            <Send size={13} /> Send a letter
          </Button>
        </div>
      </div>

      <FilterChips
        value={view}
        onChange={setView}
        options={[
          { value: "sent" as const, label: "Sent", count: data.history.length },
          { value: "scheduled" as const, label: "Scheduled", count: data.campaigns.length },
        ]}
      />

      {view === "sent" ? (
        data.history.length === 0 ? (
          <Empty
            title="Nothing sent to this client yet"
            hint="Every letter — and every one that was skipped, with the reason — appears here."
          />
        ) : (
          <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
            <div
              className={cn(
                "grid items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
                HISTORY_MIN,
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
                  "grid cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
                  HISTORY_MIN,
                  HISTORY_GRID,
                )}
              >
                <div className="min-w-0">
                  <div className="truncate">{h.subject}</div>
                  {/* the reason a letter was skipped belongs beside it, not in a detail nobody opens */}
                  {h.reason && <p className="truncate text-[12px] text-muted">{h.reason}</p>}
                </div>
                <div className="truncate text-muted">
                  {h.companyName ?? "Client\u2019s own address"}
                </div>
                <div className="truncate text-muted">{h.templateName ?? "One-off letter"}</div>
                <div className="whitespace-nowrap text-muted">
                  {fmtDateTime(h.sentAt ?? h.createdAt)}
                </div>
                <div className="text-right">
                  <StatusPill status={h.status} />
                </div>
              </div>
            ))}
          </div>
        )
      ) : data.campaigns.length === 0 ? (
        <Empty
          title="Nothing scheduled for them"
          hint="Use Schedule above to set a reminder for this client — once, on set dates, or on a rhythm."
        />
      ) : (
        <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
          <div
            className={cn(
              "grid items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
              SCHEDULED_MIN,
              SCHEDULED_GRID,
            )}
          >
            <div>Campaign</div>
            <div>Rhythm</div>
            <div className="text-right">Next</div>
          </div>

          {data.campaigns.map((c) => (
            <div
              key={`${c.id}:${c.companyId ?? ""}`}
              className={cn(
                "grid items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0",
                SCHEDULED_MIN,
                SCHEDULED_GRID,
              )}
            >
              <div className="min-w-0">
                <div className="truncate">
                  {c.name}
                  {c.companyName && <span className="text-muted"> · {c.companyName}</span>}
                </div>
                {/* said here rather than only at send time: a client queued for a letter they will
                    never receive is what somebody wants to know BEFORE the date, not after */}
                {c.blockedReason && (
                  <p className="truncate text-[12px] text-[#8a5a12]">
                    Would be skipped — {c.blockedReason.toLowerCase()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 whitespace-nowrap text-muted">
                {c.rhythm !== "once" && c.rhythm !== "dates" && (
                  <Repeat size={11} className="shrink-0" />
                )}
                {RHYTHM_LABELS[c.rhythm]}
              </div>
              <div className="flex items-center justify-end gap-1 whitespace-nowrap text-muted">
                <CalendarClock size={11} className="shrink-0" />
                {c.status !== "scheduled" ? "Stopped" : c.nextRunOn ? fmtDate(c.nextRunOn) : "—"}
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
      <CampaignModal
        open={scheduling}
        campaign={null}
        onClose={() => setScheduling(false)}
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

/** The project's empty state: dashed, roomy, one line of what to do about it. */
function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
      <div className="text-[15px] font-semibold">{title}</div>
      <p className="mt-1 text-[13px] text-muted">{hint}</p>
    </div>
  );
}
