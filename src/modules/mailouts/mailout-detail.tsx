import { Link } from "react-router-dom";
import { fmtDateTime } from "@/shared/lib/format";
import { Modal } from "@/shared/ui/modal";
import { StatusPill } from "./status-pill";
import { useMailoutDetail } from "./mailouts.api";

/**
 * What happened to one send.
 *
 * The list is the whole point: it names every recipient AND the reason beside anyone who was not
 * reached. While rows are still `queued` the query polls, so the counts settle in front of you
 * rather than needing a refresh.
 */
export function MailoutDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useMailoutDetail(id);

  return (
    <Modal open={!!id} onClose={onClose} size="lg" title={data?.subject ?? "Mailout"}>
      {isLoading || !data ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>{data.templateName ?? "One-off letter"}</span>
            <span>{data.kind === "commercial" ? "Commercial" : "Transactional"}</span>
            <span>Sent by {data.createdByName ?? "—"}</span>
            <span>{fmtDateTime(data.createdAt)}</span>
          </div>

          <div className="mb-4 flex gap-1.5">
            {data.counts.sent > 0 && <StatusPill status="sent" count={data.counts.sent} />}
            {data.counts.queued > 0 && <StatusPill status="queued" count={data.counts.queued} />}
            {data.counts.failed > 0 && <StatusPill status="failed" count={data.counts.failed} />}
            {data.counts.skipped > 0 && <StatusPill status="skipped" count={data.counts.skipped} />}
          </div>

          <div className="mb-4 rounded-(--radius-field) border border-border bg-surface p-3">
            <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">
              The letter, as saved when it was sent
            </p>
            {data.heading && <p className="mb-1 text-[13px] font-medium text-ink">{data.heading}</p>}
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-700">
              {data.body}
            </p>
          </div>

          <div className="max-h-[300px] overflow-y-auto rounded-(--radius-field) border border-border">
            {data.recipients.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-3 border-b border-divider px-3 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/clients/${r.clientId}`}
                    className="text-[13px] text-primary-link hover:underline"
                  >
                    {r.clientName}
                  </Link>
                  {/* the same client can appear several times over — once per inbox — so the row
                      has to say WHICH of their addresses this letter went to */}
                  {r.companyName && (
                    <span className="ml-1.5 text-[12px] text-muted">· {r.companyName}</span>
                  )}
                  <p className="truncate text-[12px] text-muted">{r.email || "no address"}</p>
                  {r.reason && <p className="mt-0.5 text-[11px] text-ink-700">{r.reason}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <StatusPill status={r.status} />
                  {r.sentAt && <span className="text-[12px] text-muted">{fmtDateTime(r.sentAt)}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
