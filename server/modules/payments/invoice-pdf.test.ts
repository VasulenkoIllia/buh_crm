import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentRow, InvoiceDocument } from "./invoice-document.js";
import { png, smallPng } from "../../test/png.js";
import { renderInvoicePdf } from "./invoice-pdf.js";

const row = (name: string): DocumentRow => ({
  name,
  detail: null,
  rateType: "Item",
  rate: "$50.00",
  qty: "1",
  amount: "$50.00",
});

const document = (over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  from: {
    name: "Acme Books",
    addressLines: ["1 Main St"],
    website: "acme.test",
    email: "billing@acme.test",
    phone: null,
  },
  billTo: { name: "Olena Petrenko", email: null },
  number: "INV-2026-0123",
  date: "Oct-07-2026",
  dueDate: "Oct-21-2026",
  mark: null,
  rows: [row("Bookkeeping")],
  subtotal: "$50.00",
  total: "$50.00",
  paid: null,
  balance: null,
  note: null,
  paymentLines: ["Account name: Acme"],
  payOnline: null,
  ...over,
});

/** pdfkit leaves the page objects outside its compressed streams, so they can be counted. */
const pagesOf = (pdf: Buffer) => pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the invoice on paper", () => {
  it("draws a one-page PDF", async () => {
    const pdf = await renderInvoicePdf(document(), null);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pagesOf(pdf)).toBe(1);
  });

  it("turns the page itself on the largest invoice the API allows", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(`Position ${i + 1}`));
    const pdf = await renderInvoicePdf(document({ rows }), null);
    // the table ends at 770 of 842, so a page holds what pdfkit left alone would fit more of
    expect(pagesOf(pdf)).toBe(3);
  });

  it("runs a payment block taller than a page onto the next one", async () => {
    const paymentLines = Array.from({ length: 90 }, (_, i) => `Line ${i + 1}`);
    const pdf = await renderInvoicePdf(document({ paymentLines }), null);
    expect(pagesOf(pdf)).toBe(3);
  });

  it("makes the pay link a link a reader can click, and prints none without one", async () => {
    const url = "https://crm.example.test/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
    const linked = await renderInvoicePdf(document({ payOnline: url }), null);
    expect(linked.toString("latin1")).toContain(`/URI (${url})`);
    expect((await renderInvoicePdf(document(), null)).toString("latin1")).not.toContain("/URI");
  });

  it("draws Cyrillic names and long free text", async () => {
    const pdf = await renderInvoicePdf(
      document({
        billTo: { name: "Олена Петренко", email: "o@example.test" },
        rows: [row("Бухгалтерський супровід ".repeat(12))],
        note: "Примітка ".repeat(100),
        paymentLines: Array.from({ length: 40 }, (_, i) => `Рядок ${i + 1}`),
      }),
      null,
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("draws a sound PNG logo, transparency and all", async () => {
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    const pdf = await renderInvoicePdf(document(), smallPng());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(complaint).not.toHaveBeenCalled();
  });

  /** Reaching pdfkit, this one throws inside a zlib callback and ends the process. */
  it("leaves out a damaged PNG before pdfkit can take the server down with it", async () => {
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    const pdf = await renderInvoicePdf(document(), png({ idat: Buffer.from("garbage") }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(complaint).toHaveBeenCalledOnce();
  });

  it("gives up the logo, never the invoice, when it cannot be read", async () => {
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    const pdf = await renderInvoicePdf(document(), Buffer.from("not an image"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(complaint).toHaveBeenCalledOnce();
  });
});
