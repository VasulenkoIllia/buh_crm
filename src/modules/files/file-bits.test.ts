import { describe, expect, it } from "vitest";
import type { FolderNode } from "@shared/schema/files";
import { subtreeOf } from "./file-bits";

const folder = (id: string, parentId: string | null): FolderNode => ({
  id,
  name: id,
  parentId,
  totals: { files: 0, bytes: 0 },
});

describe("a folder cannot go inside itself (files.md §6.2)", () => {
  const tree = [
    folder("2024", null),
    folder("returns", "2024"),
    folder("signed", "returns"),
    folder("2025", null),
    folder("q1", "2025"),
  ];

  it("refuses the folders being dragged and everything under them, and nothing else", () => {
    expect([...subtreeOf(tree, ["2024"])].sort()).toEqual(["2024", "returns", "signed"]);
    expect([...subtreeOf(tree, ["returns", "2025"])].sort()).toEqual([
      "2025",
      "q1",
      "returns",
      "signed",
    ]);
  });

  it("still refuses the dragged folders when their place's tree is not known", () => {
    expect([...subtreeOf([], ["2024"])]).toEqual(["2024"]);
    expect(subtreeOf(tree, []).size).toBe(0);
  });
});
