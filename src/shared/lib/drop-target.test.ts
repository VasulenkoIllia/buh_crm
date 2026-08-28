import { describe, expect, it } from "vitest";
import { applyDrop, resolveDrop } from "./drop-target";

const board = (cols: Record<string, string[]>) => new Map(Object.entries(cols));

describe("resolveDrop", () => {
  describe("TWO cards — where the bug showed (user, 2026-08-27)", () => {
    const two = () => board({ col1: ["A", "B"], col2: [] });

    it("drags the top card below the bottom one", () => {
      expect(resolveDrop(two(), "A", "B")).toEqual({ listId: "col1", afterId: "B" });
    });

    it("drags the bottom card above the top one", () => {
      expect(resolveDrop(two(), "B", "A")).toEqual({ listId: "col1", afterId: null });
    });

    it("drops on the column's empty space — the end, not a silent no-op", () => {
      // this is the case that did nothing at all: `over` was the column, and arrayMove(-1) on a
      // two-item list returns it unchanged
      expect(resolveDrop(two(), "A", "col1")).toEqual({ listId: "col1", afterId: "B" });
      // and the card already at the end has nowhere to go, so nothing is written
      expect(resolveDrop(two(), "B", "col1")).toBeNull();
    });
  });

  describe("three or more", () => {
    const three = () => board({ col1: ["A", "B", "C"], col2: [] });

    it("moves down onto a lower card", () => {
      expect(resolveDrop(three(), "A", "C")).toEqual({ listId: "col1", afterId: "C" });
    });

    it("moves up onto a higher card", () => {
      expect(resolveDrop(three(), "C", "A")).toEqual({ listId: "col1", afterId: null });
      expect(resolveDrop(three(), "C", "B")).toEqual({ listId: "col1", afterId: "A" });
    });

    it("drops on the column's empty space — the end", () => {
      // the same case threw the card to the end here, which is right by luck, not by rule
      expect(resolveDrop(three(), "A", "col1")).toEqual({ listId: "col1", afterId: "C" });
    });
  });

  describe("across columns", () => {
    const two = () => board({ col1: ["A"], col2: ["X", "Y"] });

    it("takes the place of the card it was dropped on", () => {
      expect(resolveDrop(two(), "A", "X")).toEqual({ listId: "col2", afterId: null });
      expect(resolveDrop(two(), "A", "Y")).toEqual({ listId: "col2", afterId: "X" });
    });

    it("goes to the end when dropped on the column itself", () => {
      expect(resolveDrop(two(), "A", "col2")).toEqual({ listId: "col2", afterId: "Y" });
    });

    it("lands in an empty column", () => {
      const b = board({ col1: ["A"], empty: [] });
      expect(resolveDrop(b, "A", "empty")).toEqual({ listId: "empty", afterId: null });
    });
  });

  describe("drops that must write nothing", () => {
    const b = () => board({ col1: ["A", "B", "C"], col2: [] });

    it("dropped outside every target", () => {
      expect(resolveDrop(b(), "A", null)).toBeNull();
    });

    it("dropped on itself", () => {
      expect(resolveDrop(b(), "A", "A")).toBeNull();
    });

    it("dropped exactly where it already was", () => {
      // the last card dropped on the column's empty space is already at the end
      expect(resolveDrop(b(), "C", "col1")).toBeNull();
      // and a card dropped on the one directly BELOW it while moving down lands after it, which
      // IS a change — the guard must not swallow that
      expect(resolveDrop(b(), "A", "B")).toEqual({ listId: "col1", afterId: "B" });
    });

    it("an unknown card or column", () => {
      expect(resolveDrop(b(), "A", "nope")).toBeNull();
      expect(resolveDrop(b(), "ghost", "B")).toBeNull();
    });
  });
});

describe("applyDrop", () => {
  const list = () => [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (r: { id: string }[]) => r.map((x) => x.id);
  const at = (r: { id: string }) => r.id;

  it("puts an item after its anchor", () => {
    expect(ids(applyDrop(list(), "a", "c", at))).toEqual(["b", "c", "a"]);
    expect(ids(applyDrop(list(), "c", "a", at))).toEqual(["a", "c", "b"]);
  });

  it("a null anchor means first", () => {
    expect(ids(applyDrop(list(), "c", null, at))).toEqual(["c", "a", "b"]);
  });

  it("an anchor that is gone puts the item first — the same as both server paths", () => {
    expect(ids(applyDrop(list(), "b", "ghost", at))).toEqual(["b", "a", "c"]);
  });

  it("an unknown item leaves the list exactly as it was", () => {
    const original = list();
    expect(applyDrop(original, "ghost", "a", at)).toBe(original);
  });

  it("matches what resolveDrop asked for — the two are used together", () => {
    const board = new Map([["one", ["a", "b", "c"]]]);
    const target = resolveDrop(board, "a", "c");
    expect(target).not.toBeNull();
    expect(ids(applyDrop(list(), "a", target!.afterId, at))).toEqual(["b", "c", "a"]);
  });
});
