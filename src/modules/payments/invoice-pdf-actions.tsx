import { useEffect, useRef, useState } from "react";
import { Check, CreditCard, Download, ExternalLink, FolderInput } from "lucide-react";
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
        {invoice.payUrl && <CopyPayLink url={invoice.payUrl} />}
      </div>
      {save.error && <p className="text-[12px] text-danger-text">{save.error.message}</p>}
    </div>
  );
}

/**
 * **Copy pay link** (payments.md §11): the link the client opens to pay the balance by card. Here,
 * beside the paper, because it is handed to the client the way the PDF is. The server sends the link
 * only while Stripe is on and the invoice owes something, so the button is there exactly then.
 *
 * A browser that refuses the clipboard (an embedded one, an http page) shows the link itself
 * instead, selected on a tap, rather than a button that silently did nothing.
 */
function CopyPayLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    if (!navigator.clipboard) return setRefused(true);
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1800);
      },
      () => setRefused(true),
    );
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn(TAP, copied && "text-success-text")}
        onClick={copy}
        title="Copy the link the client opens to pay this invoice by card"
      >
        {copied ? <Check /> : <CreditCard />}
        {copied ? "Copied" : "Copy pay link"}
      </Button>
      {refused && (
        <p className="basis-full text-[12px] text-muted">
          The browser would not copy it. The pay link:{" "}
          <span className="break-all text-ink-700 select-all">{url}</span>
        </p>
      )}
    </>
  );
}
