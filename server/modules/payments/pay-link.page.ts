import { escapeHtml } from "../../core/html.js";
import type { PayPageKind } from "./pay-link.service.js";

/**
 * **The pay link's own pages** (payments.md §11): what the link answers when it does not send the
 * payer to Stripe, and where Stripe sends them back. Server-rendered, like the unsubscribe page: the
 * person has no account, and a plain page works in any mail app's browser without JavaScript.
 *
 * The client's words, in English, plain, with no long dashes. In the sandbox every page says TEST,
 * so a client of the firm who somehow meets one knows nothing real happened.
 */

interface PageText {
  title: string;
  lines: string[];
  /** a button back to the link, for the pages a second try can fix */
  retry?: string;
}

function textOf(kind: PayPageKind, invoice: string, firm: string): PageText {
  switch (kind) {
    case "unknown":
      return {
        title: "This link is not valid",
        lines: [`Check the link on your invoice, or contact ${firm}.`],
      };
    case "cancelled":
      return {
        title: "This invoice was cancelled",
        lines: [`Invoice ${invoice} was cancelled, so there is nothing to pay.`],
      };
    case "settled":
      return {
        title: "This invoice is paid",
        lines: [`Invoice ${invoice} has no balance due. Thank you.`],
      };
    case "unavailable":
      return {
        title: "Online payment is not available",
        lines: [
          `Invoice ${invoice} cannot be paid online right now.`,
          `Please use the payment details on the invoice, or contact ${firm}.`,
        ],
      };
    case "failed":
      return {
        title: "The payment page did not open",
        lines: ["Nothing was charged. Please try again in a few minutes."],
        retry: "Try again",
      };
    case "returned_paid":
      return {
        title: "Thank you for your payment",
        lines: [
          `Your payment for invoice ${invoice} was made through Stripe.`,
          `It will show on the invoice once it reaches ${firm}.`,
        ],
      };
    case "returned_cancelled":
      return {
        title: "Payment not completed",
        lines: [`Nothing was charged for invoice ${invoice}. You can try again.`],
        retry: "Pay invoice",
      };
  }
}

export function payLinkPage(opts: {
  kind: PayPageKind;
  invoiceNumber: string | null;
  firmName: string;
  isSandbox: boolean;
  /** the link itself, for the retry button */
  retryUrl: string;
}): string {
  const brand = "#37544F";
  const text = textOf(opts.kind, opts.invoiceNumber ?? "", opts.firmName);
  // the number in one piece: a phone would otherwise break it at its first hyphen
  const number = opts.invoiceNumber ? escapeHtml(opts.invoiceNumber) : null;
  const unbroken = (html: string) =>
    number
      ? html.replaceAll(number, `<span style="white-space:nowrap;">${number}</span>`)
      : html;
  const lines = text.lines.map(
    (line) => `<p style="margin:0 0 10px;">${unbroken(escapeHtml(line))}</p>`,
  );
  const retry = text.retry
    ? `<a href="${escapeHtml(opts.retryUrl)}" style="display:inline-block;margin-top:8px;background:${brand};color:#fff;text-decoration:none;border-radius:8px;padding:11px 20px;font-size:15px;">${escapeHtml(text.retry)}</a>`
    : "";
  const sandbox = opts.isSandbox
    ? `<div style="background:#fff4d6;color:#7a5200;border:1px solid #f0d58a;border-radius:6px;padding:6px 10px;font-size:13px;font-weight:600;margin-bottom:16px;">TEST: Stripe sandbox, no real money moves</div>`
    : "";
  const title = `${opts.isSandbox ? "TEST: " : ""}${text.title}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:56px auto;padding:0 16px;">
<div style="background:#fff;border:1px solid #dfe5e3;border-radius:10px;padding:32px;">
  ${sandbox}
  <div style="height:3px;width:44px;background:${brand};border-radius:2px;"></div>
  <h1 style="font-size:20px;color:${brand};margin:16px 0 14px;">${escapeHtml(text.title)}</h1>
  <div style="font-size:15px;line-height:1.6;color:#1f2a28;">${lines.join("")}${retry}</div>
  <p style="margin:22px 0 0;font-size:13px;color:#6b7a77;">${escapeHtml(opts.firmName)}</p>
</div>
</div>
</body></html>`;
}
