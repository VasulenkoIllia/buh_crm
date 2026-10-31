import { Download, ExternalLink, FolderInput } from "lucide-react";
import type { Invoice } from "@shared/schema/payment";
import { useCanEdit } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { Button, buttonVariants } from "@/shared/ui/button";
import { useSaveInvoicePdf } from "./payments.api";

/** 28px at a desk, 44px under a thumb. */
const TAP = "max-md:h-11 max-md:px-3.5";
const LINK = cn(buttonVariants({ variant: "secondary", size: "sm" }), TAP);

/**
 * The paper version of this card (payments.md §10).
 *
 * Open is a new tab rather than a frame in the card, because a phone's browser has no viewer to put
 * in one. Both are plain links: the session cookie goes with them, and the server's attachment
 * header is what makes the second a download. Keeping a copy writes, so it asks for Billing open.
 */
export function InvoicePdfActions({ invoice }: { invoice: Invoice }) {
  const canEdit = useCanEdit("billing");
  const save = useSaveInvoicePdf();
  const pdfUrl = `/api/invoices/${invoice.id}/pdf`;

  function keepCopy() {
    if (window.confirm("Save this PDF to the client's files, under Shared with client?")) {
      save.mutate(invoice.id);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <a className={LINK} href={pdfUrl} target="_blank" rel="noreferrer">
          <ExternalLink />
          Open PDF
        </a>
        {/* `download`: a failed request must not replace the whole app with its JSON */}
        <a className={LINK} href={`${pdfUrl}?download=1`} download>
          <Download />
          Download
        </a>
        {canEdit && (
          <Button
            variant="secondary"
            size="sm"
            className={TAP}
            disabled={save.isPending}
            onClick={keepCopy}
          >
            <FolderInput />
            Save to client files
          </Button>
        )}
      </div>
      {save.error && <p className="text-[12px] text-danger-text">{save.error.message}</p>}
    </div>
  );
}
