import { describe, expect, it } from "vitest";
import {
  draftTotal,
  emptyLine,
  linesProblem,
  toDraftLines,
  toLineInput,
} from "./invoice-lines-editor";

/** Hours or items (client, 2026-11-02): what the positions editor sends and shows. */
describe("positions counted in hours or in items", () => {
  const items = {
    ...emptyLine(),
    description: "W-2 form",
    quantity: "2",
    rate: "50",
    unit: "item" as const,
  };

  it("adds up a count of items at their price, as hours at a rate", () => {
    const hours = { ...emptyLine(), description: "Consultation", quantity: "1.5", rate: "200" };
    expect(draftTotal([items, hours])).toBe(100_00 + 300_00);
  });

  it("sends the unit beside the quantity, and none without one", () => {
    const flat = {
      ...emptyLine(),
      description: "Filing fee",
      amount: "35",
      unit: "item" as const,
    };
    expect(toLineInput([items, flat])).toEqual([
      { description: "W-2 form", quantity: 200, unitRate: 50_00, amount: 100_00, unit: "item" },
      { description: "Filing fee", quantity: null, unitRate: null, amount: 35_00, unit: null },
    ]);
  });

  it("says before sending that items are counted whole, and lets hours be fractions", () => {
    expect(linesProblem([{ ...items, quantity: "2.5" }])).toBe(
      "Items are counted in whole numbers",
    );
    expect(linesProblem([items, { ...items, quantity: "2.5", unit: "hour" }])).toBeNull();
  });

  it("opens a line from before units as hours", () => {
    const [line] = toDraftLines([
      {
        id: "11111111-1111-4111-8111-111111111111",
        order: 0,
        description: "Consultation",
        quantity: 150,
        unitRate: 200_00,
        amount: 300_00,
        unit: null,
      },
    ]);
    expect(line).toMatchObject({ quantity: "1.5", rate: "200.00", unit: "hour" });
  });
});
