import { describe, expect, it } from "vitest";
import { MAX_STAGES } from "@shared/schema/catalog";
import {
  addRow,
  copyRows,
  moveRow,
  rowsOf,
  stageProblems,
  stagesToSend,
  toStagesInput,
} from "./stages";

const saved = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Invite Sent", order: 0 },
  { id: "00000000-0000-4000-8000-000000000002", name: "Docs Received", order: 1 },
];

describe("the stages editor", () => {
  it("keeps a saved stage's id through a rename and a move, and sends a new one without", () => {
    let rows = rowsOf(saved);
    rows = addRow(rows, "Filed");
    rows = moveRow(rows, 1, 0);
    rows[0] = { ...rows[0], name: " Docs in " };
    expect(toStagesInput(rows)).toEqual([
      { id: saved[1].id, name: "Docs in" },
      { id: saved[0].id, name: "Invite Sent" },
      { name: "Filed" },
    ]);
  });

  it("puts a dragged row where it is dropped, and the rest close up", () => {
    const rows = addRow(rowsOf(saved), "Filed");
    const names = (r: typeof rows) => r.map((x) => x.name);
    expect(names(moveRow(rows, 0, 2))).toEqual(["Docs Received", "Filed", "Invite Sent"]);
    expect(names(moveRow(rows, 2, 0))).toEqual(["Filed", "Invite Sent", "Docs Received"]);
  });

  it("changes nothing for a drop on itself or outside the list", () => {
    const rows = rowsOf(saved);
    expect(moveRow(rows, 1, 1)).toBe(rows);
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 1, 2)).toBe(rows);
  });

  it("copies another service's names as new stages, never its ids", () => {
    expect(toStagesInput(copyRows(saved))).toEqual([
      { name: "Invite Sent" },
      { name: "Docs Received" },
    ]);
  });

  it("names an empty row and a repeated one, however it is cased", () => {
    const rows = [
      ...rowsOf(saved),
      { key: "a", name: "docs received " },
      { key: "b", name: " " },
    ];
    const problems = stageProblems(rows);
    expect(problems.get("a")).toBe("Already in the list");
    expect(problems.get("b")).toMatch(/Give the stage a name/);
    expect(problems.size).toBe(2);
  });

  it("sends the list only when it changed, so a save of the price leaves stages alone", () => {
    expect(stagesToSend(rowsOf(saved), saved)).toBeUndefined();
    expect(stagesToSend(rowsOf([]), [])).toBeUndefined();
    expect(stagesToSend(moveRow(rowsOf(saved), 0, 1), saved)).toHaveLength(2);
    const renamed = rowsOf(saved).map((r, i) => (i ? r : { ...r, name: "Invited" }));
    expect(stagesToSend(renamed, saved)?.[0]).toEqual({ id: saved[0].id, name: "Invited" });
    expect(stagesToSend(rowsOf(saved).slice(1), saved)).toEqual([
      { id: saved[1].id, name: "Docs Received" },
    ]);
  });

  it("stops at the most a service may have", () => {
    let rows = rowsOf([]);
    for (let i = 0; i < MAX_STAGES + 3; i++) rows = addRow(rows, `S${i}`);
    expect(rows).toHaveLength(MAX_STAGES);
  });
});
