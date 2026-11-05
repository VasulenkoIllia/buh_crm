import { describe, expect, it } from "vitest";
import type { InvoiceItem } from "@shared/schema/invoice-items";
import {
  addedPosition,
  completedLine,
  settledLine,
  draftTotal,
  emptyLine,
  itemFromRow,
  linesProblem,
  pickableItems,
  pickedPosition,
  toDraftLines,
  toLineInput,
  typedPosition,
} from "./invoice-lines-editor";
import { offersNewItem, suggestions } from "./position-input";

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

  it("fills the empty one of quantity and rate from the amount, rounded", () => {
    const hourly = { ...emptyLine(), description: "Customer support" };
    expect(completedLine({ ...hourly, rate: "66", amount: "132" }).quantity).toBe("2");
    expect(completedLine({ ...hourly, quantity: "1", amount: "88" }).rate).toBe("88.00");
    // the amount is then quantity × rate, and can move a few cents from the one typed
    const third = { ...hourly, quantity: "3", amount: "100" };
    expect(completedLine(third).rate).toBe("33.33");
    expect(toLineInput([third])[0]).toMatchObject({
      quantity: 300,
      unitRate: 33_33,
      amount: 99_99,
    });
    expect(draftTotal([third, { ...hourly, rate: "66", amount: "100" }])).toBe(99_99 + 100_32);
  });

  it("leaves a row alone with nothing to fill, a count of items that is not whole, or a line as issued", () => {
    const both = { ...items, amount: "999" };
    expect(completedLine(both)).toBe(both);
    const onlyAmount = { ...emptyLine(), amount: "100" };
    expect(completedLine(onlyAmount)).toBe(onlyAmount);
    const priced = { ...items, quantity: "", rate: "66" };
    expect(completedLine({ ...priced, amount: "132" }).quantity).toBe("2");
    expect(completedLine({ ...priced, amount: "100" }).quantity).toBe("");
    const [issued] = toDraftLines([
      {
        id: "11111111-1111-4111-8111-111111111111",
        order: 0,
        description: "W-2 form",
        quantity: 300,
        unitRate: null,
        amount: 100_00,
        unit: "item",
        itemId: null,
      },
    ]);
    expect(completedLine(issued)).toBe(issued);
    expect(toLineInput([issued])[0]).toMatchObject({ unitRate: null, amount: 100_00 });
    // a digit typed and deleted leaves it as issued; a quantity that changes is a person's
    expect(completedLine({ ...issued, quantity: "3" })).toEqual(issued);
    expect(completedLine({ ...issued, quantity: "4" }).rate).toBe("25.00");
  });

  it("drops an amount typed earlier once quantity and rate give it, so either can be emptied", () => {
    // rate and amount typed, the quantity shown, then the cursor leaves
    const settled = settledLine({ ...emptyLine(), rate: "66", amount: "132" });
    expect(settled).toMatchObject({ quantity: "2", rate: "66", amount: "" });
    // emptying the rate leaves it empty, and the amount can be typed by hand again
    expect(completedLine({ ...settled, rate: "" })).toMatchObject({ quantity: "2", rate: "" });
    expect(completedLine({ ...settled, rate: "", amount: "150" }).rate).toBe("75.00");
    // both typed over an amount from before: the amount goes too
    expect(settledLine({ ...items, amount: "500" }).amount).toBe("");
    const plain = { ...emptyLine(), amount: "100" };
    expect(settledLine(plain)).toBe(plain);
  });

  it("opens an issued line with a quantity and a rate without an amount of its own", () => {
    const [line] = toDraftLines([
      {
        id: "11111111-1111-4111-8111-111111111111",
        order: 0,
        description: "Consultation",
        quantity: 300,
        unitRate: 33_33,
        amount: 99_99,
        unit: "hour",
        itemId: null,
      },
    ]);
    expect(line).toMatchObject({ quantity: "3", rate: "33.33", amount: "" });
    expect(draftTotal([line])).toBe(99_99);
    expect(completedLine({ ...line, rate: "" }).rate).toBe("");
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

  it("offers every item of a long list in order, and narrows it to what is typed", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...advice,
      id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
      name: `Item ${String(i).padStart(3, "0")}`,
    }));
    expect(suggestions(many, "", null)).toEqual(many);
    expect(suggestions(many, "  ", null)).toHaveLength(100);
    expect(suggestions(many, "item 09", null)).toHaveLength(10);
    expect(suggestions(many, "item 099", null).map((item) => item.name)).toEqual(["Item 099"]);
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

/** A name the Position box did not find, added to the items from its row (owner, 2026-11-04). */
describe("an invoice item added from a row", () => {
  const w2: InvoiceItem = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "W-2 form",
    unit: "item",
    price: 50_00,
    active: true,
  };
  const added: InvoiceItem = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Legal name change",
    unit: "item",
    price: null,
    active: true,
  };

  it("is offered for a name typed by hand that no active item has, case aside", () => {
    expect(offersNewItem([w2], "Legal name change", null)).toBe(true);
    expect(offersNewItem([w2], "w-2 FORM ", null)).toBe(false);
    expect(offersNewItem([w2], "   ", null)).toBe(false);
    // a row picked from an item is that item, whatever is typed after its name
    expect(offersNewItem([w2], "W-2 form, 2025", w2.id)).toBe(false);
    // a part of a name is a name of its own
    expect(offersNewItem([w2], "W-2", null)).toBe(true);
  });

  it("takes the row's unit and the rate it shows, or no price without one", () => {
    const row = { ...emptyLine(), description: "Legal name change", unit: "item" as const };
    expect(itemFromRow({ ...row, quantity: "1", rate: "120" })).toEqual({
      unit: "item",
      price: 120_00,
    });
    expect(itemFromRow(row)).toEqual({ unit: "item", price: null });
    // the share a quantity and an amount give is the rate the row shows
    expect(itemFromRow({ ...row, unit: "hour", quantity: "2", amount: "100" })).toEqual({
      unit: "hour",
      price: 50_00,
    });
  });

  it("takes the name, unit and price the item's form saved, as a pick does", () => {
    const row = { ...emptyLine(), description: "legal name chg", unit: "item" as const };
    expect(
      addedPosition({ ...row, quantity: "2" }, { ...added, unit: "hour", price: 90_00 }),
    ).toEqual({
      description: "Legal name change",
      unit: "hour",
      quantity: "2",
      rate: "90.00",
      amount: "",
      itemId: added.id,
    });
    // an amount typed with no count becomes one at the price
    expect(addedPosition({ ...row, amount: "150" }, { ...added, price: 150_00 })).toMatchObject(
      {
        quantity: "1",
        rate: "150.00",
        amount: "",
      },
    );
  });

  it("keeps the row's numbers when the item has no price, emptying the rate of a new unit", () => {
    const row = { ...emptyLine(), description: "legal name change", unit: "item" as const };
    expect(addedPosition({ ...row, amount: "150" }, added)).toEqual({
      description: "Legal name change",
      itemId: added.id,
      unit: "item",
    });
    expect(
      addedPosition({ ...row, quantity: "2", rate: "40" }, { ...added, unit: "hour" }),
    ).toEqual({ description: "Legal name change", itemId: added.id, unit: "hour", rate: "" });
    expect(addedPosition(undefined, added)).toBeNull();
    expect(addedPosition({ ...row, itemId: w2.id }, added)).toBeNull();
  });
});
