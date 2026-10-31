import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvoiceInput } from "./payment.js";

/**
 * The limit is what makes zod stop at the length instead of reading every element of an oversized
 * array, which cost hundreds of megabytes for one 1 MiB request (GHSA-mrhx-c7xc-m3w5, 2026-10-31).
 * It matches the task forms' own limit on assignees.
 */
describe("a new invoice's assignees", () => {
  const invoice = (count: number) => ({
    clientId: randomUUID(),
    amount: 10000,
    assigneeIds: Array.from({ length: count }, () => randomUUID()),
  });

  it("takes twenty", () => {
    expect(createInvoiceInput.safeParse(invoice(20)).success).toBe(true);
  });

  it("refuses a twenty-first, and only says so once", () => {
    const parsed = createInvoiceInput.safeParse(invoice(21));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0].path).toEqual(["assigneeIds"]);
  });
});
