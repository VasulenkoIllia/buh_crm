import { BellOff, CalendarClock, Repeat } from "lucide-react";
import { Link } from "react-router-dom";
import { RHYTHM_LABELS } from "@shared/campaigns";
import { fmtBizDate, fmtDateTime } from "@/shared/lib/format";
import { Modal } from "@/shared/ui/modal";
import { CampaignStatus } from "./campaigns";
import { useCampaign } from "./mailouts.api";

/**
 * One campaign: who is queued up, what has gone out so far, and who left because of it.
 *
 * The opt-out list is the part worth having. Unsubscribing is global — one click stops all
 * commercial mail — so without naming what prompted it, a firm can see that people are leaving and
 * never learn which letter is costing them.
 */
export function CampaignDetailModal({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useCampaign(id);

  return (
    <Modal open={!!id} onClose={onClose} size="lg" title={data?.name ?? "Campaign"}>
      {isLoading || !data ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <CampaignStatus campaign={data} />
            <span className="flex items-center gap-1">
              {data.rhythm !== "once" && data.rhythm !== "dates" && <Repeat size={11} />}
              {RHYTHM_LABELS[data.rhythm]}
            </span>
            {data.nextRunOn && (
              <span className="flex items-center gap-1">
                <CalendarClock size={11} /> Next {fmtBizDate(data.nextRunOn)} at {data.sendAt}
              </span>
            )}
            {data.endsOn && <span>Stops after {fmtBizDate(data.endsOn)}</span>}
            {data.rhythm === "dates" && (
              <span>
                {data.dates.length} date{data.dates.length === 1 ? "" : "s"}:{" "}
                {data.dates.map(fmtBizDate).join(" · ")}
              </span>
            )}
            <span>{data.templateName}</span>
            {data.senderAccountName && <span>From {data.senderAccountName}</span>}
            <span>{data.kind === "commercial" ? "Commercial" : "Transactional"}</span>
          </div>

          <div className="mb-4 rounded-(--radius-field) border border-border bg-surface p-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
              The letter
            </p>
            <p className="mb-2 text-[13px] font-medium text-ink">{data.subject}</p>
            <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-700">
              {data.body}
            </p>
          </div>

          <Section title={`Recipients (${data.recipients.length})`}>
            {data.recipients.map((r) => (
              <div
                key={`${r.clientId}:${r.companyId ?? ""}`}
                className="border-b border-divider px-3 py-2 last:border-0"
              >
                <p className="truncate text-[13px] text-ink">
                  <Link
                    to={`/clients/${r.clientId}`}
                    className="text-primary-link hover:underline"
                  >
                    {r.companyName ?? r.clientName}
                  </Link>
                  {r.companyName && <span className="text-muted"> · {r.clientName}</span>}
                </p>
                <p
                  className={`truncate text-[12px] ${r.blockedReason ? "text-[#8a5a12]" : "text-muted"}`}
                >
                  {r.blockedReason ?? r.email ?? "no address"}
                </p>
              </div>
            ))}
          </Section>

          {data.runs.length > 0 && (
            <Section title={`Sent so far (${data.runs.length})`}>
              {data.runs.map((run) => (
                <div
                  key={run.mailoutId}
                  className="flex items-center justify-between border-b border-divider px-3 py-2 last:border-0"
                >
                  <span className="text-[13px] text-ink">{fmtDateTime(run.createdAt)}</span>
                  <span className="text-[12px] text-muted">
                    {run.delivered > 0 && `${run.delivered} delivered`}
                    {run.sent > 0 && `${run.delivered > 0 ? " · " : ""}${run.sent} sent`}
                    {run.notDelivered > 0 && ` · ${run.notDelivered} not delivered`}
                    {run.notSent > 0 && ` · ${run.notSent} not sent`}
                    {run.skipped > 0 && ` · ${run.skipped} skipped`}
                    {run.sending > 0 && ` · ${run.sending} sending`}
                  </span>
                </div>
              ))}
            </Section>
          )}

          <Section
            title={`Unsubscribed through this campaign (${data.optOuts.length})`}
            hint="Unsubscribing stops all commercial mail, whichever letter prompted it. This is which letter did."
          >
            {data.optOuts.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-muted">
                Nobody has left because of this.
              </p>
            ) : (
              data.optOuts.map((o) => (
                <div
                  key={o.clientId}
                  className="flex items-center gap-2 border-b border-divider px-3 py-2 last:border-0"
                >
                  <BellOff size={13} className="shrink-0 text-faint" />
                  <Link
                    to={`/clients/${o.clientId}`}
                    className="text-[13px] text-primary-link hover:underline"
                  >
                    {o.clientName}
                  </Link>
                  <span className="ml-auto text-[12px] text-muted">
                    {fmtDateTime(o.unsubscribedAt)}
                    {o.periodKey && ` · ${fmtBizDate(o.periodKey)} letter`}
                  </span>
                </div>
              ))
            )}
          </Section>
        </>
      )}
    </Modal>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[12px] font-medium text-ink-700">{title}</p>
      {hint && <p className="mb-1.5 text-[12px] leading-relaxed text-muted">{hint}</p>}
      <div className="max-h-[220px] overflow-y-auto rounded-(--radius-field) border border-border">
        {children}
      </div>
    </div>
  );
}
