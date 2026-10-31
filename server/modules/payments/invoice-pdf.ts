import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { DocumentRow, InvoiceDocument } from "./invoice-document.js";
import { isDamagedPng } from "./invoice-logo.js";

/**
 * **The invoice on paper**, laid out after the firm's own (payments.md §10): A4, Source Sans, the
 * sender top right, one table, totals under it, the payment block last.
 *
 * Every position is a number on the page, and `y` is carried by hand, because nothing here may
 * trigger pdfkit's own page break: the margins are 0 and `ensureRoom` decides. It is what lets a
 * long invoice repeat its header row and keep its totals in one piece.
 */

const FONTS = {
  regular: "SourceSans3-Regular.ttf",
  semibold: "SourceSans3-Semibold.ttf",
  bold: "SourceSans3-Bold.ttf",
} as const;
type Font = keyof typeof FONTS;

const fontPath = (file: string) =>
  fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url));

const COLOR = {
  ink: "#16211e",
  brand: "#37544f",
  muted: "#6b7672",
  rule: "#e8ecea",
  band: "#f5f7f6",
  danger: "#b3261e",
  success: "#2e7d4f",
};

const SIZE = { body: 10, detail: 8.5, title: 20, mark: 12, pageNumber: 11 };
const LINE = 12;

/** Horizontal positions, in points from the left edge of an A4 page. */
const X = {
  page: 595.28,
  bandLeft: 55,
  bandRight: 563,
  text: 64,
  /** the right half: the sender, the number and the date, the rate type */
  column: 337,
  value: 445,
  name: 63,
  nameWidth: 262,
  rateType: 334,
  rateEnd: 449,
  qtyEnd: 485,
  amountEnd: 555,
  totalsLeft: 412,
  totalsLabel: 419,
};

const Y = { top: 40, tableBottom: 770, nextPageTop: 48, pageNumber: 797 };
const HEADER_ROW = 28;
const ROW_PADDING = 9;
const TOTAL_ROW = 29;
const LOGO_BOX: [number, number] = [120, 50];

type Doc = InstanceType<typeof PDFDocument>;

function write(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  opts: { font?: Font; size?: number; color?: string; width?: number } = {},
) {
  doc
    .font(opts.font ?? "regular")
    .fontSize(opts.size ?? SIZE.body)
    .fillColor(opts.color ?? COLOR.ink)
    .text(text, x, y, { width: opts.width, lineBreak: opts.width !== undefined });
}

/** Text ending at `end`: an amount's right edge is what lines the column up. */
function writeRight(
  doc: Doc,
  text: string,
  end: number,
  y: number,
  opts: { font?: Font; color?: string } = {},
) {
  doc.font(opts.font ?? "regular").fontSize(SIZE.body);
  const x = end - doc.widthOfString(text);
  write(doc, text, x, y, opts);
}

function rule(doc: Doc, left: number, right: number, y: number) {
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(COLOR.rule).stroke();
}

/** A logo that cannot be read costs the logo, never the invoice. */
function drawLogo(doc: Doc, logo: Buffer | null) {
  if (!logo) return;
  if (isDamagedPng(logo)) {
    console.error("[invoice-pdf] the letter logo is a damaged PNG; printing without it");
    return;
  }
  try {
    doc.image(logo, X.text, Y.top, { fit: LOGO_BOX });
  } catch (error) {
    console.error(
      "[invoice-pdf] the letter logo could not be drawn; printing without it",
      error,
    );
  }
}

function drawSender(doc: Doc, from: InvoiceDocument["from"]) {
  let y = Y.top;
  write(doc, from.name, X.column, y, { font: "semibold", width: X.bandRight - X.column });
  y = doc.y + 3;
  for (const line of from.addressLines) {
    write(doc, line, X.column, y, { width: X.bandRight - X.column });
    y = doc.y;
  }
  for (const line of [from.website, from.email, from.phone]) {
    if (!line) continue;
    y += 4;
    write(doc, line, X.column, y, { width: X.bandRight - X.column });
    y = doc.y;
  }
  return y;
}

function drawTitle(doc: Doc, document: InvoiceDocument, y: number) {
  write(doc, "Invoice", X.text, y, { font: "semibold", size: SIZE.title, color: COLOR.brand });
  if (document.mark) {
    write(doc, document.mark, X.column, y + 6, {
      font: "bold",
      size: SIZE.mark,
      color: document.mark === "PAID" ? COLOR.success : COLOR.danger,
    });
  }
}

function drawParties(doc: Doc, document: InvoiceDocument, top: number) {
  const { billTo, number, date, dueDate } = document;
  write(doc, billTo.name, X.text, top, { font: "semibold", width: X.column - X.text - 16 });
  let left = doc.y + 4;
  if (billTo.email) {
    write(doc, billTo.email, X.text, left, { width: X.column - X.text - 16 });
    left = doc.y;
  }
  const facts: [string, string | null][] = [
    ["Invoice number:", number],
    ["Date:", date],
    ["Due date:", dueDate],
  ];
  let right = top;
  for (const [label, value] of facts) {
    if (!value) continue;
    write(doc, label, X.column, right, { font: "semibold" });
    write(doc, value, X.value, right);
    right += LINE + 4;
  }
  return Math.max(left, right);
}

function drawTableHeader(doc: Doc, y: number) {
  doc.rect(X.bandLeft, y, X.bandRight - X.bandLeft, HEADER_ROW).fill(COLOR.band);
  const text = y + ROW_PADDING;
  write(doc, "Product or service", X.name, text, { font: "semibold" });
  write(doc, "Rate Type", X.rateType, text, { font: "semibold" });
  writeRight(doc, "Rate ($)", X.rateEnd, text, { font: "semibold" });
  writeRight(doc, "Qty", X.qtyEnd, text, { font: "semibold" });
  writeRight(doc, "Amount", X.amountEnd, text, { font: "semibold" });
  return y + HEADER_ROW;
}

function rowHeight(doc: Doc, row: DocumentRow) {
  const name = doc
    .font("semibold")
    .fontSize(SIZE.body)
    .heightOfString(row.name, { width: X.nameWidth });
  const detail = row.detail
    ? doc
        .font("regular")
        .fontSize(SIZE.detail)
        .heightOfString(row.detail, { width: X.nameWidth })
    : 0;
  return ROW_PADDING * 2 + name + detail + (row.detail ? 2 : 0);
}

function drawRow(doc: Doc, row: DocumentRow, y: number, height: number) {
  const text = y + ROW_PADDING;
  write(doc, row.name, X.name, text, { font: "semibold", width: X.nameWidth });
  if (row.detail) {
    write(doc, row.detail, X.name, doc.y + 2, {
      size: SIZE.detail,
      color: COLOR.muted,
      width: X.nameWidth,
    });
  }
  write(doc, row.rateType, X.rateType, text);
  writeRight(doc, row.rate, X.rateEnd, text);
  writeRight(doc, row.qty, X.qtyEnd, text);
  writeRight(doc, row.amount, X.amountEnd, text);
  rule(doc, X.bandLeft, X.bandRight, y + height);
}

function drawTotal(doc: Doc, label: string, value: string, y: number, font: Font = "regular") {
  const text = y + ROW_PADDING;
  write(doc, label, X.totalsLabel, text, { font });
  writeRight(doc, value, X.amountEnd, text, { font });
  rule(doc, X.totalsLeft, X.bandRight, y + TOTAL_ROW);
  return y + TOTAL_ROW;
}

/** The page's next free line, on a fresh page when `height` no longer fits on this one. */
function ensureRoom(doc: Doc, y: number, height: number, repeatHeader: boolean) {
  if (y + height <= Y.tableBottom) return y;
  doc.addPage();
  return repeatHeader ? drawTableHeader(doc, Y.nextPageTop) : Y.nextPageTop;
}

function drawRows(doc: Doc, rows: DocumentRow[], top: number) {
  let y = drawTableHeader(doc, top);
  for (const row of rows) {
    const height = rowHeight(doc, row);
    y = ensureRoom(doc, y, height, true);
    drawRow(doc, row, y, height);
    y += height;
  }
  return y;
}

function drawTotals(doc: Doc, document: InvoiceDocument, top: number) {
  const { subtotal, total, paid, balance } = document;
  const rows = 2 + (paid ? 2 : 0);
  let y = ensureRoom(doc, top, rows * TOTAL_ROW, false);
  y = drawTotal(doc, "Subtotal", subtotal, y);
  y = drawTotal(doc, "Total", total, y, "bold");
  if (paid && balance) {
    y = drawTotal(doc, "Paid", paid, y);
    y = drawTotal(doc, "Balance due", balance, y, "bold");
  }
  return y;
}

/**
 * A titled block of free text, kept on one page when it fits on one. Line by line, because a block
 * taller than a page has to turn it here: left to pdfkit it runs through the page number.
 */
function drawBlock(doc: Doc, title: string, lines: string[], top: number) {
  const width = X.bandRight - X.text;
  const heightOf = (text: string) =>
    doc.font("regular").fontSize(SIZE.body).heightOfString(text, { width });
  let y = ensureRoom(doc, top, heightOf(lines.join("\n")) + LINE, false);
  write(doc, title, X.text, y, { font: "semibold" });
  y += LINE + 1;
  for (const line of lines) {
    const text = line || " ";
    y = ensureRoom(doc, y, heightOf(text), false);
    write(doc, text, X.text, y, { width });
    y = doc.y;
  }
  return y;
}

function drawPageNumbers(doc: Doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const label = `${i - start + 1}/${count}`;
    doc.font("regular").fontSize(SIZE.pageNumber);
    write(doc, label, X.bandRight - doc.widthOfString(label), Y.pageNumber, {
      size: SIZE.pageNumber,
    });
  }
}

export function renderInvoicePdf(
  document: InvoiceDocument,
  logo: Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      bufferPages: true,
      info: { Title: `Invoice ${document.number}`, Author: document.from.name },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, fontPath(file));

    drawLogo(doc, logo);
    const senderEnd = drawSender(doc, document.from);
    const titleY = Math.max(senderEnd, Y.top + LOGO_BOX[1]) + 22;
    drawTitle(doc, document, titleY);
    const partiesEnd = drawParties(doc, document, titleY + 36);
    const rowsEnd = drawRows(doc, document.rows, partiesEnd + 20);
    let y = drawTotals(doc, document, rowsEnd) + 26;
    if (document.note) y = drawBlock(doc, "Note:", [document.note], y) + 14;
    if (document.paymentLines.some(Boolean)) {
      drawBlock(doc, "Payment Information:", document.paymentLines, y);
    }
    drawPageNumbers(doc);
    doc.end();
  });
}
