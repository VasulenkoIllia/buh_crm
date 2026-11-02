import { describe, expect, it } from "vitest";
import type { InvoiceItem } from "@shared/schema/invoice-items";
import {
  draftTotal,
  emptyLine,
  linesProblem,
  pickableItems,
  pickedPosition,
  toDraftLines,
  toLineInput,
  typedPosition,
} from "./invoice-lines-editor";
import { suggestions } from "./position-input";

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
      {
        description: "W-2 form",
        quantity: 200,
        unitRate: 50_00,
        amount: 100_00,
        unit: "item",
        itemId: null,
      },
      {
        description: "Filing fee",
        quantity: null,
        unitRate: null,
        amount: 35_00,
        unit: null,
        itemId: null,
      },
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
        itemId: null,
      },
    ]);
    expect(line).toMatchObject({ quantity: "1.5", rate: "200.00", unit: "hour" });
  });
});

/** Invoice items (client, 2026-11-02): picking one fills the row, typing stays free. */
describe("a position picked from the invoice items", () => {
  const w2: InvoiceItem = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "W-2 form",
    unit: "item",
    price: 50_00,
    active: true,
  };
  const advice: InvoiceItem = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Tax advice",
    unit: "hour",
    price: null,
    active: true,
  };
  const retired = {
    ...w2,
    id: "44444444-4444-4444-8444-444444444444",
    name: "Old",
    active: false,
  };

  it("offers the active items only, by what is typed, case aside", () => {
    const offered = pickableItems([w2, retired, advice]);
    expect(offered).toEqual([w2, advice]);
    expect(pickableItems(undefined)).toEqual([]);
    expect(suggestions(offered, "", null)).toEqual([w2, advice]);
    expect(suggestions(offered, "w-2", null)).toEqual([w2]);
    expect(suggestions(offered, "old", null)).toEqual([]);
  });

  it("does not offer the row's own item again, but does offer its name typed by hand", () => {
    expect(suggestions([w2, advice], "W-2 form", w2.id)).toEqual([]);
    expect(suggestions([w2, advice], "W-2 form", null)).toEqual([w2]);
  });

  it("fills the name, the unit and the price, and counts one", () => {
    const row = { ...emptyLine(), description: "W-2", amount: "100" };
    const picked = { ...row, ...pickedPosition(row, w2) };
    expect(picked).toMatchObject({
      description: "W-2 form",
      unit: "item",
      quantity: "1",
      rate: "50.00",
      amount: "",
      itemId: w2.id,
    });
    expect(toLineInput([picked])[0]).toMatchObject({ amount: 50_00, itemId: w2.id });
  });

  it("keeps a count and an hourly rate already typed for an hourly item with no price", () => {
    const row = { ...emptyLine(), quantity: "3", rate: "80" };
    expect(pickedPosition(row, advice)).toMatchObject({
      unit: "hour",
      quantity: "3",
      rate: "80",
      itemId: advice.id,
    });
    expect(pickedPosition({ ...row, unit: "item" }, advice).rate).toBe("");
    // a rate an earlier pick filled in is that item's price, not this one's
    expect(pickedPosition({ ...row, itemId: w2.id }, advice).rate).toBe("");
  });

  it("keeps the link while the text holds the item's name, and lets go otherwise", () => {
    const picked = { ...emptyLine(), description: "W-2 form", itemId: w2.id };
    expect(typedPosition(picked, "W-2 form, 2025", [w2])).toEqual({
      description: "W-2 form, 2025",
      itemId: w2.id,
    });
    expect(typedPosition(picked, "Filing fee", [w2]).itemId).toBeNull();
    expect(typedPosition(picked, "", [w2]).itemId).toBeNull();
    // the items did not load: nothing to compare with, so only an empty box lets go
    expect(typedPosition(picked, "Filing fee", undefined).itemId).toBe(w2.id);
  });

  it("leaves typed text a position by hand, even when it spells an item's name", () => {
    expect(typedPosition(emptyLine(), "W-2 form", [w2])).toEqual({
      description: "W-2 form",
      itemId: null,
    });
  });
});
