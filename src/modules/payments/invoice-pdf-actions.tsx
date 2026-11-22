import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, CreditCard, Download, ExternalLink, FolderInput, Mail } from "lucide-react";
import type { Invoice } from "@shared/schema/payment";
import { useCanEdit } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { Button, buttonVariants, IconButton } from "@/shared/ui/button";
import { useToast } from "@/shared/ui/toast";
import { useSaveInvoicePdf } from "./payments.api";

/** 28px at a desk, 44px under a thumb. */
const TAP = "max-md:h-11 max-md:px-3.5";
const LINK = cn(buttonVariants({ variant: "secondary", size: "sm" }), TAP);

/**
 * On demand: it carries Mailouts' letter frame, and most cards are opened without sending. The
 * Billing list opens the same window from a row.
 */
export const InvoiceEmailModal = lazy(() =>
  import("./invoice-email-modal").then((m) => ({ default: m.InvoiceEmailModal })),
);

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
  const [isEmailing, setIsEmailing] = useState(false);
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
        {/* Billing open, as Mark as sent: the letter stamps the same mark. Not on a cancelled
            invoice, which nobody hands over */}
        {canEdit && !invoice.cancelledAt && (
          <Button
            variant="secondary"
            size="sm"
            className={TAP}
            onClick={() => setIsEmailing(true)}
          >
            <Mail />
            Send by email
          </Button>
        )}
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
      {isEmailing && (
        <Suspense fallback={null}>
          <InvoiceEmailModal invoice={invoice} onClose={() => setIsEmailing(false)} />
        </Suspense>
      )}
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
  const { copied, refused, copy } = usePayLinkCopy(url);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn(TAP, copied && "text-success-text")}
        onClick={() => void copy()}
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

/**
 * The copy behind both pay-link buttons: "Copied" for a moment, or `refused` for good. `copy`
 * also answers whether it copied, for a button with no room to show the link.
 */
function usePayLinkCopy(url: string) {
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<boolean> => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
    } catch {
      // the answer is the link shown instead, by whichever button asked
      setRefused(true);
      return false;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
    return true;
  };

  return { copied, refused, copy };
}

/** 28px at a desk, 44px under a thumb: the Billing column is sized for two of the larger. */
const ROW_TAP = "max-md:h-11 max-md:w-11";

/**
 * **Send by email** and **Copy pay link** on a row of the Billing list (owner, 2026-11-22), so an
 * invoice goes out without opening its card. The same rules as on the card: Send by email for
 * Billing open and not on a cancelled invoice, the pay link exactly when the server sends one.
 *
 * The window itself is the page's, not the row's (`onEmail`): `Modal` draws in place, so inside a row
 * it would take on the row's pointer cursor, and a Settled row's `opacity-60` would fade it and let
 * the rows below paint over it. Each button is named with its invoice, because a screen reader
 * lists 25 rows of them.
 */
export function InvoiceRowActions({
  invoice,
  onEmail,
}: {
  invoice: Invoice;
  onEmail: () => void;
}) {
  const canEdit = useCanEdit("billing");

  return (
    <div className="flex items-center gap-1">
      {canEdit && !invoice.cancelledAt && (
        <IconButton
          label={`Send ${invoice.number} by email`}
          className={ROW_TAP}
          onClick={onEmail}
        >
          <Mail />
        </IconButton>
      )}
      {invoice.payUrl && <RowPayLink url={invoice.payUrl} number={invoice.number} />}
    </div>
  );
}

/**
 * The row's pay link: an icon, so there is no line under it for the link when the browser refuses
 * the clipboard. The browser's own prompt shows the link instead, selected and ready to copy. A copy
 * is also said in a toast, which a screen reader announces and an icon swap is not.
 */
function RowPayLink({ url, number }: { url: string; number: string }) {
  const { copied, copy } = usePayLinkCopy(url);
  const toast = useToast();

  const copyOrShow = async () => {
    if (await copy()) toast({ text: `Pay link for ${number} copied` });
    else window.prompt("The browser would not copy it. The pay link:", url);
  };

  return (
    <IconButton
      label={`Copy pay link for ${number}`}
      className={cn(ROW_TAP, copied && "text-success-text")}
      onClick={() => void copyOrShow()}
    >
      {copied ? <Check /> : <CreditCard />}
    </IconButton>
  );
}
