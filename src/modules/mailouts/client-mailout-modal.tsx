import { fmtDateTime } from "@/shared/lib/format";
import { Modal } from "@/shared/ui/modal";
import { StatusPill } from "./status-pill";
import { useClientLetter } from "./mailouts.api";

/**
 * One letter, as THIS client received it.
 *
 * Deliberately not the mailout-level detail. That one lists every recipient, which is right in the
 * Mailouts log and a leak on a client's card — opening a letter from Olena's card used to show
 * Petro's name, address and skip reason.
 *
 * The body is the rendered one too: the stored snapshot keeps its `{{vars}}`, which answers "what
 * did we send everybody" rather than "what did they get".
 */
export function ClientMailoutModal({
  letterId,
  clientId,
  clientName,
  onClose,
}: {
  /** the RECIPIENT row — one mailout can reach this client at several of their addresses */
  letterId: string | null;
  clientId: string;
  clientName: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useClientLetter(letterId, clientId);

  return (
    <Modal
      open={!!letterId}
      onClose={onClose}
      size="lg"
      title={data?.subject ?? "Letter"}
    >
      {isLoading || !data ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>{data.templateName ?? "One-off letter"}</span>
            <span>{data.kind === "commercial" ? "Commercial" : "Transactional"}</span>
            {data.senderName && <span>From {data.senderName}</span>}
            <span>Sent by {data.sentByName ?? "—"}</span>
            <span>{fmtDateTime(data.sentAt ?? data.createdAt)}</span>
          </div>

          <div className="mb-4 flex items-center gap-2">
            <StatusPill status={data.status} />
            <span className="text-[12px] text-muted">
              to {data.email || "no address"}
              {data.companyName && <> · {data.companyName}</>}
            </span>
          </div>

          {data.reason && (
            <p className="mb-4 rounded-(--radius-field) bg-warning/15 px-3 py-2 text-[12px] text-[#8a5a12]">
              {data.reason}
            </p>
          )}

          <div className="rounded-(--radius-field) border border-border bg-surface p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              The letter {data.companyName ?? clientName} received
            </p>
            {data.heading && <p className="mb-1 text-[14px] font-medium">{data.heading}</p>}
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-700">
              {data.body}
            </p>
          </div>
        </>
      )}
    </Modal>
  );
}
