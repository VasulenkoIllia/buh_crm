import { describe, expect, it } from "vitest";
import { invoiceDetail, invoiceSubject } from "./row-detail";

const base = { serviceName: null, description: null, periodKey: null, taskTitle: null };

describe("a Billing row's Service cell", () => {
  it("leads with the service, then the invoice's own text", () => {
    expect(invoiceSubject({ ...base, serviceName: "Payroll", description: "x" })).toBe(
      "Payroll",
    );
    expect(invoiceSubject({ ...base, description: "Consultation" })).toBe("Consultation");
    expect(invoiceSubject(base)).toBeNull();
  });

  it("names the period of a subscription's invoice, as dates", () => {
    expect(
      invoiceDetail({ ...base, serviceName: "Payroll", periodKey: "2026-10", taskTitle: "x" }),
    ).toBe("Oct 2026");
    expect(invoiceDetail({ ...base, serviceName: "Payroll", periodKey: "2026-10-H1" })).toBe(
      "1–15 Oct 2026",
    );
    // a blank period says nothing, so the job still gets its line
    expect(
      invoiceDetail({
        ...base,
        serviceName: "Payroll",
        periodKey: "  ",
        taskTitle: "March run",
      }),
    ).toBe("March run");
  });

  it("names the job of a one-off, so two invoices for one service differ", () => {
    expect(
      invoiceDetail({ ...base, serviceName: "Customer support", taskTitle: "Call to Texas" }),
    ).toBe("Call to Texas");
  });

  it("falls back to the description when there is no period and no job", () => {
    expect(
      invoiceDetail({
        ...base,
        serviceName: "Customer support",
        description: "Sales tax filing",
      }),
    ).toBe("Sales tax filing");
  });

  it("drops a line that only repeats the first", () => {
    // a job opened from "+ New invoice" is titled after the description or the service
    expect(
      invoiceDetail({
        ...base,
        serviceName: "Customer support",
        taskTitle: "customer support ",
      }),
    ).toBeNull();
    expect(
      invoiceDetail({ ...base, description: "Consultation", taskTitle: "Consultation" }),
    ).toBeNull();
    expect(invoiceDetail({ ...base, serviceName: "Payroll", description: "  " })).toBeNull();
  });

  it("names the job of an invoice with neither a service nor a description", () => {
    expect(invoiceDetail({ ...base, taskTitle: "Bookkeeping catch-up" })).toBe(
      "Bookkeeping catch-up",
    );
  });
});
