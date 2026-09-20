import { describe, expect, it } from "vitest";
import { blocksOf, wrapSelection } from "./rich-text";

/**
 * The composer's marks (chat.md §5.1, decision 13). The rendering itself is React nodes rather than
 * markup — the one thing that matters about it is that it never builds HTML, which is a fact about
 * `rich-text.tsx` having no `dangerouslySetInnerHTML` at all.
 */

describe("blocks", () => {
  it("keeps a fenced block whole, quotes together, and the rest as text", () => {
    const text = [
      "before",
      "```",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "> quoted",
      "> still",
      "after",
    ].join("\n");
    expect(blocksOf(text)).toEqual([
      { kind: "text", lines: ["before"] },
      { kind: "code", lines: ["const a = 1;", "", "const b = 2;"] },
      { kind: "quote", lines: ["quoted", "still"] },
      { kind: "text", lines: ["after"] },
    ]);
  });

  it("treats a fence nobody closed as code rather than as three back ticks", () => {
    expect(blocksOf("```\nunfinished")).toEqual([{ kind: "code", lines: ["unfinished"] }]);
  });
});

describe("Ctrl+B and Ctrl+I", () => {
  it("wraps the selection and moves the caret with it", () => {
    expect(wrapSelection("the 1040 is ready", 4, 8, "**")).toEqual({
      text: "the **1040** is ready",
      start: 6,
      end: 10,
    });
  });

  it("takes the marks off again when they are already there", () => {
    expect(wrapSelection("the **1040** is ready", 6, 10, "**")).toEqual({
      text: "the 1040 is ready",
      start: 4,
      end: 8,
    });
  });

  it("opens a pair for the next words when nothing is selected", () => {
    expect(wrapSelection("say ", 4, 4, "_")).toEqual({ text: "say __", start: 5, end: 5 });
  });
});
