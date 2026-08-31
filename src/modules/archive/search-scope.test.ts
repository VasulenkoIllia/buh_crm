import { describe, expect, it } from "vitest";
import { type ArchiveTab, phraseFor } from "./search-scope";

const phrases = { clients: "verbena", leads: "qqqqq", tasks: "" };

describe("archive search scope", () => {
  it("gives the visible tab its own phrase", () => {
    expect(phraseFor("clients", "clients", phrases)).toBe("verbena");
    expect(phraseFor("leads", "leads", phrases)).toBe("qqqqq");
  });

  /** The regression this exists for: a stale phrase must not silence another tab's count. */
  it("gives a tab you are not looking at nothing, however much it remembers", () => {
    for (const standingOn of ["clients", "leads", "tasks"] satisfies ArchiveTab[]) {
      for (const key of ["clients", "leads", "tasks"] satisfies ArchiveTab[]) {
        if (key === standingOn) continue;
        expect(phraseFor(standingOn, key, phrases)).toBeUndefined();
      }
    }
  });

  it("treats an empty box as no filter, not as a filter for nothing", () => {
    expect(phraseFor("tasks", "tasks", phrases)).toBeUndefined();
    expect(phraseFor("clients", "clients", { ...phrases, clients: "" })).toBeUndefined();
  });
});
