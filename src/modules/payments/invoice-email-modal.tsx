import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Invoice } from "@shared/schema/payment";
import { LetterFrame } from "@/modules/mailouts";
import { ApiError } from "@/shared/lib/api";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { useToast } from "@/shared/ui/toast";
import { useEmailInvoice, useInvoiceEmailPreview } from "./payments.api";

/**
 * **Send by email** (payments.md §12): what is about to go, shown before it goes. The address, the
 * mailbox and the letter come from the server, read the way the send reads them, so Send cannot do
 * something this window did not show. Mounted only while open, so every opening reads afresh.
 */
export function InvoiceEmailModal({
  invoice,
  onClose,
}: {
  invoice: Invoice;
  onClose: () => void;
}) {
  const preview = useInvoiceEmailPreview(invoice.id);
  const send = useEmailInvoice();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  /** the letter went but its mark did not save: a second Send would mail the client twice */
  const [isLetterGone, setIsLetterGone] = useState(false);
  const data = preview.data;

  async function submit() {
    setError(null);
    try {
      await send.mutateAsync(invoice.id);
      toast({ text: `Invoice ${invoice.number} sent to ${data?.to ?? "the client"}` });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "sent_mark_failed") setIsLetterGone(true);
      setError(e instanceof Error ? e.message : "Could not send the invoice");
    }
  }

  const rows: [string, string][] = data
    ? [
        ["To", data.to ?? "No address"],
        ["From", data.mailbox?.from ?? "No mailbox"],
        ["Subject", data.subject ?? "None"],
        ["Attached", data.fileName],
      ]
    : [];
  const refusal = error ?? data?.blockedReason ?? null;

  return (
    <Modal
      open
      // not while it is sending: a failure after the window closed would be said to nobody
      onClose={send.isPending ? () => {} : onClose}
      size="lg"
      title={`Email invoice ${invoice.number}`}
      footer={
        <div className="space-y-2">
          {/* beside the buttons, so a refusal is seen however far the letter was scrolled */}
          {refusal && (
            <p
              role="alert"
              className="flex gap-2 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {refusal}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={send.isPending}>
              {isLetterGone ? "Close" : "Cancel"}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={!data || !!data.blockedReason || send.isPending || isLetterGone}
            >
              {send.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      }
    >
      {preview.isPending && (
        <p role="status" className="text-[13px] text-muted">
          Loading…
        </p>
      )}
      {preview.error && <p className="text-[13px] text-danger-text">{preview.error.message}</p>}
      {data && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {invoice.sentAt && (
            <p className="text-[12px] text-muted">
              Marked sent {fmtDate(invoice.sentAt)}. Sending again keeps that date.
            </p>
          )}
          {data.html && <LetterFrame html={data.html} min={360} />}
        </div>
      )}
    </Modal>
  );
}
