import { describe, expect, it } from "vitest";
import { dirKey, isJunk, planFolderUpload } from "./folder-upload";

const f = (name: string) => ({ name }) as File;

describe("a folder upload's plan (files.md §7.2)", () => {
  it("makes each directory once, parents before their children", () => {
    const plan = planFolderUpload({
      files: [
        { file: f("a.pdf"), dirs: ["Scans", "2024", "Q1"] },
        { file: f("b.pdf"), dirs: ["Scans", "2024", "Q1"] },
        { file: f("c.pdf"), dirs: ["Scans", "2024"] },
        { file: f("d.pdf"), dirs: ["Scans"] },
        { file: f("loose.pdf"), dirs: [] },
      ],
      emptyDirs: [["Scans", "empty"]],
    });
    expect(plan.dirs).toEqual([
      ["Scans"],
      ["Scans", "2024"],
      ["Scans", "empty"],
      ["Scans", "2024", "Q1"],
    ]);
    // one call per distinct directory, never one per file
    expect(new Set(plan.dirs.map(dirKey)).size).toBe(plan.dirs.length);
    expect(plan.groups.map((g) => [g.dirs.join("/"), g.files.map((x) => x.name)])).toEqual([
      ["Scans/2024/Q1", ["a.pdf", "b.pdf"]],
      ["Scans/2024", ["c.pdf"]],
      ["Scans", ["d.pdf"]],
      ["", ["loose.pdf"]],
    ]);
    expect(plan.skipped).toBe(0);
  });

  it("leaves out what the system put there, and nothing a person made", () => {
    const plan = planFolderUpload({
      files: [
        { file: f(".DS_Store"), dirs: ["Scans"] },
        { file: f("._receipt.pdf"), dirs: ["Scans"] },
        { file: f("~$letter.docx"), dirs: ["Scans"] },
        { file: f("receipt.pdf"), dirs: ["__MACOSX", "Scans"] },
        { file: f("receipt.pdf"), dirs: ["Scans"] },
      ],
      emptyDirs: [["__MACOSX"]],
    });
    expect(plan.skipped).toBe(4);
    expect(plan.dirs).toEqual([["Scans"]]);
    expect(plan.groups).toHaveLength(1);
    expect(isJunk("Thumbs.db")).toBe(true);
    expect(isJunk("desktop.ini")).toBe(true);
    expect(isJunk("2024 taxes.pdf")).toBe(false);
    expect(isJunk(".profile.pdf")).toBe(false);
  });
});
