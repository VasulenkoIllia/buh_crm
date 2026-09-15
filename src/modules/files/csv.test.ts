import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("the viewer's CSV (files.md §12.1)", () => {
  it("reads a bank export: quotes, doubled quotes, commas and line breaks inside them", () => {
    const text =
      'Date,Payee,Amount\r\n2025-01-02,"Smith, J.",100.00\n2025-01-03,"He said ""paid""\nin full",-5\n';
    expect(parseCsv(text, 10)).toEqual([
      ["Date", "Payee", "Amount"],
      ["2025-01-02", "Smith, J.", "100.00"],
      ["2025-01-03", 'He said "paid"\nin full', "-5"],
    ]);
  });

  it("stops at the rows it will show, and keeps a last line with no line break", () => {
    expect(parseCsv("a\nb\nc\nd", 2)).toEqual([["a"], ["b"]]);
    expect(parseCsv("x,y", 5)).toEqual([["x", "y"]]);
    expect(parseCsv("", 5)).toEqual([]);
  });
});
