import { describe, expect, it } from "vitest";
import {
  documentDate,
  invoiceDocument,
  invoiceFileName,
  type InvoiceSource,
} from "./invoice-document.js";

const ISSUER = {
  name: "Acme Books",
  address: "1 Main St\n\n  Springfield, IL 62701  ",
  website: "acme.test",
  email: "billing@acme.test",
  phone: "+1 555 0100",
  paymentInfo: "Account name: Acme\n\nReference: your invoice number",
};

const invoice = (over: Partial<InvoiceSource> = {}): InvoiceSource => ({
  number: "INV-2026-0123",
  clientName: "Olena Petrenko",
  companyName: null,
  serviceName: "Bookkeeping",
  periodKey: null,
  description: null,
  taskTitle: "",
  amount: 10000,
  paid: 0,
  balance: 10000,
  status: "unpaid",
  issuedAt: "2026-10-07T00:00:00.000Z",
  dueDate: "2026-10-21T00:00:00.000Z",
  lines: [],
  ...over,
});

const position = (over: Partial<InvoiceSource["lines"][number]> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  order: 0,
  description: "Consultation",
  quantity: null,
  unitRate: null,
  amount: 5000,
  ...over,
});

const rowsOf = (over: Partial<InvoiceSource>) =>
  invoiceDocument(invoice(over), ISSUER, null).rows;

describe("what an invoice says on paper", () => {
  it("prints a one-amount invoice as one row, at its whole amount", () => {
    const [row] = rowsOf({ periodKey: "2026-10" });
    expect(row).toEqual({
      name: "Bookkeeping",
      detail: "Oct 2026",
      rateType: "Item",
      rate: "$100.00",
      qty: "1",
      amount: "$100.00",
    });
  });

  it("writes a range of dates with a plain hyphen", () => {
    expect(rowsOf({ periodKey: "2026-10-H1" })[0].detail).toBe("1-15 Oct 2026");
  });

  it("falls back on the invoice's text, and on a word when it has none", () => {
    expect(rowsOf({ serviceName: null, description: "Tax return" })[0].name).toBe("Tax return");
    expect(rowsOf({ serviceName: null })[0].name).toBe("Services");
  });

  it("prints hours and a rate as an hourly row", () => {
    const lines = [position({ quantity: 350, unitRate: 4000, amount: 14000 })];
    expect(rowsOf({ lines })[0]).toEqual({
      name: "Consultation",
      detail: null,
      rateType: "Hourly",
      rate: "$40.00",
      qty: "3.5",
      amount: "$140.00",
    });
  });

  it("writes a whole hour without decimals", () => {
    const lines = [position({ quantity: 200, unitRate: 4000, amount: 8000 })];
    expect(rowsOf({ lines })[0].qty).toBe("2");
  });

  it("moves hours under the name when no rate explains the amount", () => {
    const [row] = rowsOf({ lines: [position({ quantity: 350 })] });
    expect(row).toMatchObject({ detail: "3.5 h", rateType: "Item", rate: "$50.00", qty: "1" });
  });

  it("prints a position with a rate and no hours at its own amount", () => {
    const [row] = rowsOf({ lines: [position({ unitRate: 4000 })] });
    expect(row).toMatchObject({ rateType: "Item", rate: "$50.00", qty: "1", amount: "$50.00" });
  });

  it("prints every position and keeps Sales tax last, changing no total", () => {
    const lines = [position(), position({ description: "Filing", amount: 5000 })];
    const document = invoiceDocument(invoice({ lines }), ISSUER, null);
    expect(document.rows.map((r) => r.name)).toEqual(["Consultation", "Filing", "Sales tax"]);
    expect(document.rows.at(-1)).toMatchObject({ rate: "$0.00", amount: "$0.00" });
    expect(document).toMatchObject({ subtotal: "$100.00", total: "$100.00" });
  });

  it("addresses a company's invoice to the company", () => {
    const document = invoiceDocument(
      invoice({ companyName: "Petrenko LLC" }),
      ISSUER,
      "a@b.test",
    );
    expect(document.billTo).toEqual({ name: "Petrenko LLC", email: "a@b.test" });
    expect(invoiceDocument(invoice(), ISSUER, null).billTo).toEqual({
      name: "Olena Petrenko",
      email: null,
    });
  });

  it("drops blank address lines and keeps the payment block's paragraphs", () => {
    const document = invoiceDocument(invoice(), ISSUER, null);
    expect(document.from.addressLines).toEqual(["1 Main St", "Springfield, IL 62701"]);
    expect(document.paymentLines).toEqual([
      "Account name: Acme",
      "",
      "Reference: your invoice number",
    ]);
  });

  it("leaves nothing to print when no address and no payment details are set", () => {
    const empty = { ...ISSUER, address: null, paymentInfo: null };
    const document = invoiceDocument(invoice(), empty, null);
    expect(document.from.addressLines).toEqual([]);
    expect(document.paymentLines.some(Boolean)).toBe(false);
  });

  it("stamps a settled or void paper and leaves an open one bare", () => {
    expect(invoiceDocument(invoice(), ISSUER, null).mark).toBeNull();
    expect(invoiceDocument(invoice({ status: "overdue" }), ISSUER, null).mark).toBeNull();
    expect(invoiceDocument(invoice({ status: "paid" }), ISSUER, null).mark).toBe("PAID");
    expect(invoiceDocument(invoice({ status: "cancelled" }), ISSUER, null).mark).toBe(
      "CANCELLED",
    );
  });

  it("shows what came in once money has, and never on a cancelled paper", () => {
    const partial = invoice({ status: "partial", paid: 2500, balance: 7500 });
    expect(invoiceDocument(partial, ISSUER, null)).toMatchObject({
      paid: "$25.00",
      balance: "$75.00",
      mark: null,
    });
    expect(invoiceDocument(invoice(), ISSUER, null)).toMatchObject({
      paid: null,
      balance: null,
    });
    const cancelled = invoice({ status: "cancelled", paid: 2500, balance: 7500 });
    expect(invoiceDocument(cancelled, ISSUER, null)).toMatchObject({
      paid: null,
      balance: null,
    });
  });

  it("prints the invoice's text once, wherever it ended up", () => {
    const note = (over: Partial<InvoiceSource>) =>
      invoiceDocument(invoice(over), ISSUER, null).note;
    // the row's name, then the row's second line: already on the page
    expect(note({ serviceName: null, description: "Tax return" })).toBeNull();
    expect(note({ description: "For the audit" })).toBeNull();
    // beside positions, and beside a period, it has no row to live in
    expect(note({ description: "For the audit", lines: [position()] })).toBe("For the audit");
    expect(note({ description: "For the audit", periodKey: "2026-10" })).toBe("For the audit");
    expect(note({ description: "   " })).toBeNull();
  });

  it("does not print a repeat that differs by case or by a dash", () => {
    const note = (over: Partial<InvoiceSource>) =>
      invoiceDocument(invoice(over), ISSUER, null).note;
    expect(note({ description: "bookkeeping" })).toBeNull();
    expect(note({ description: "Q1 – cleanup" })).toBeNull();
  });

  it("omits a due date the invoice does not have", () => {
    expect(invoiceDocument(invoice({ dueDate: null }), ISSUER, null).dueDate).toBeNull();
  });
});

describe("the paper's small print", () => {
  it("writes a business date on its own day, whatever the server's zone", () => {
    expect(documentDate("2026-10-07T00:00:00.000Z")).toBe("Oct-07-2026");
    expect(documentDate("2026-01-01T00:00:00.000Z")).toBe("Jan-01-2026");
    expect(documentDate("2026-12-31T00:00:00.000Z")).toBe("Dec-31-2026");
  });

  it("names the file after the number, cleaned", () => {
    expect(invoiceFileName("INV-2026-0123")).toBe("invoice_INV-2026-0123.pdf");
    expect(invoiceFileName("A/B ../0123")).toBe("invoice_A_B_0123.pdf");
  });
});
