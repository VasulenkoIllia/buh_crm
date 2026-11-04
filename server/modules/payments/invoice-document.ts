import { MONTHS } from "@shared/billing-periods.js";
import { invoiceDetail, invoiceSubject } from "@shared/invoice-subject.js";
import { fmtMoney } from "@shared/money.js";
import { isItemLine } from "@shared/schema/payment.js";
import type { InvoiceIssuer } from "../../core/firm.js";
import type { InvoiceDto } from "./payments.service.js";

/**
 * **What an invoice says on paper**, with nothing about how it is drawn (payments.md §10).
 *
 * Pure, so every shape an invoice comes in is tested here: a subscription's or a job's one amount,
 * and a manual invoice's positions, with hours or without. There is no invoice type to switch on,
 * by design: an invoice with positions prints them, and one without prints itself as one row.
 */

export interface DocumentRow {
  name: string;
  /** the smaller line under the name: the period, the job */
  detail: string | null;
  rateType: string;
  rate: string;
  qty: string;
  amount: string;
}

/**
 * Who the paper is from, which is live, and how to pay it, which is the invoice's own copy of its
 * payment details (`invoicePaper`). Null prints an empty block.
 */
export type PaperIssuer = Omit<InvoiceIssuer, "logoFile"> & { paymentInfo: string | null };

export interface InvoiceDocument {
  from: Omit<InvoiceIssuer, "logoFile" | "address"> & {
    addressLines: string[];
  };
  billTo: { name: string; email: string | null };
  number: string;
  date: string;
  dueDate: string | null;
  /** stamped beside the title: a paper that is settled or void has to say so */
  mark: "PAID" | "CANCELLED" | null;
  rows: DocumentRow[];
  subtotal: string;
  total: string;
  /** both set once money has come in, and not on a cancelled invoice */
  paid: string | null;
  balance: string | null;
  note: string | null;
  paymentLines: string[];
}

export type InvoiceSource = Pick<
  InvoiceDto,
  | "number"
  | "clientName"
  | "companyName"
  | "serviceName"
  | "periodKey"
  | "description"
  | "taskTitle"
  | "amount"
  | "paid"
  | "balance"
  | "status"
  | "issuedAt"
  | "dueDate"
  | "lines"
>;

/** "Oct-07-2026". The stored value is a business date, so its UTC fields ARE the firm's day. */
export function documentDate(iso: string): string {
  const day = new Date(iso);
  const dd = String(day.getUTCDate()).padStart(2, "0");
  return `${MONTHS[day.getUTCMonth()]}-${dd}-${day.getUTCFullYear()}`;
}

/** 350 hundredths → "3.5". A whole count reads "2", not "2.00", beside the "1" of a flat row. */
const count = (quantity: number) => String(quantity / 100);

const nonBlankLines = (text: string | null) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** A client's paper carries no long dash, and a range of dates comes with one. */
const plainDashes = (text: string) => text.replaceAll("–", "-");

/** The one row of an invoice with no positions: what it is for, once, at its whole amount. */
function wholeRow(invoice: InvoiceSource): DocumentRow {
  const detail = invoiceDetail(invoice);
  return {
    name: invoiceSubject(invoice) ?? "Services",
    detail: detail && plainDashes(detail),
    rateType: "Item",
    rate: fmtMoney(invoice.amount),
    qty: "1",
    amount: fmtMoney(invoice.amount),
  };
}

/**
 * A quantity AND a rate fill the Rate and Qty columns: hours make an hourly row, items an item row
 * at their price. A quantity alone carries a typed amount, which the rate column cannot explain, so
 * it goes under the name and the row prints as one item. A line from before units counted hours.
 */
function positionRow(line: InvoiceSource["lines"][number]): DocumentRow {
  const { quantity, unitRate, amount } = line;
  const isItems = isItemLine(line);
  const isPriced = quantity != null && unitRate != null;
  return {
    name: line.description,
    detail:
      quantity != null && !isPriced ? `${count(quantity)} ${isItems ? "pcs" : "h"}` : null,
    rateType: isPriced && !isItems ? "Hourly" : "Item",
    rate: fmtMoney(isPriced ? unitRate : amount),
    qty: isPriced ? count(quantity) : "1",
    amount: fmtMoney(amount),
  };
}

/**
 * The invoice's own text, unless a row already says it. It is the row's name or detail on an
 * invoice with one amount, and the note its form calls it on one with positions. Compared the way
 * `invoiceDetail` compares, without case, or a line it dropped as a repeat would come back here.
 */
function noteOf(invoice: InvoiceSource, rows: DocumentRow[]): string | null {
  const text = invoice.description?.trim();
  if (!text) return null;
  const said = (line: string | null) => line?.toLowerCase() === plainDashes(text).toLowerCase();
  return rows.some((r) => said(r.name) || said(r.detail)) ? null : text;
}

const MARKS = { paid: "PAID", cancelled: "CANCELLED" } as const;

export function invoiceDocument(
  invoice: InvoiceSource,
  issuer: PaperIssuer,
  billToEmail: string | null,
): InvoiceDocument {
  // no Sales tax row: the firm charges none, and a $0.00 line on every paper was noise (owner,
  // 2026-11-04)
  const rows = invoice.lines.length > 0 ? invoice.lines.map(positionRow) : [wholeRow(invoice)];
  const isCancelled = invoice.status === "cancelled";
  const showsPayments = invoice.paid > 0 && !isCancelled;
  return {
    from: {
      name: issuer.name,
      addressLines: nonBlankLines(issuer.address),
      website: issuer.website,
      email: issuer.email,
      phone: issuer.phone,
    },
    billTo: { name: invoice.companyName ?? invoice.clientName, email: billToEmail },
    number: invoice.number,
    date: documentDate(invoice.issuedAt),
    dueDate: invoice.dueDate ? documentDate(invoice.dueDate) : null,
    mark:
      invoice.status === "paid" || invoice.status === "cancelled"
        ? MARKS[invoice.status]
        : null,
    rows,
    subtotal: fmtMoney(invoice.amount),
    total: fmtMoney(invoice.amount),
    paid: showsPayments ? fmtMoney(invoice.paid) : null,
    balance: showsPayments ? fmtMoney(invoice.balance) : null,
    note: noteOf(invoice, rows),
    paymentLines: (issuer.paymentInfo ?? "").split(/\r?\n/).map((line) => line.trimEnd()),
  };
}

/** Longer than this, a name stops being read in a folder's column anyway. */
const FILE_NAME_BILL_TO_MAX = 80;

/**
 * `invoice_INV-2026-0123 Acme LLC.pdf`: the number, and who the paper is addressed to (owner,
 * 2026-11-03), so a folder of them reads without opening each. The number is the firm's prefix and
 * the name is typed by people, so both are cleaned, not trusted: what a file system refuses in a
 * name becomes a space. Cut by characters, not UTF-16 units: half an emoji makes the header's
 * `encodeURIComponent` throw. A trailing dot goes, or `Acme Inc.` would end `..pdf`.
 */
export function invoiceFileName(number: string, billTo: string) {
  const cleaned = billTo
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = Array.from(cleaned)
    .slice(0, FILE_NAME_BILL_TO_MAX)
    .join("")
    .replace(/[.\s]+$/, "");
  return `invoice_${number.replace(/[^\w-]+/g, "_")}${name ? ` ${name}` : ""}.pdf`;
}
