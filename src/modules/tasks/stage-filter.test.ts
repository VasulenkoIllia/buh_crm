import { describe, expect, it } from "vitest";
import type { Service } from "@shared/schema/catalog";
import { anyStages, nextStageSort, stageFilterNames } from "./stage-filter";

const service = (id: string, names: string[], active = true) =>
  ({
    id,
    active,
    stages: names.map((name, order) => ({ id: `${id}-${order}`, name, order })),
  }) as unknown as Service;

const personal = service("p", ["Invite Sent", "Docs Received", "Filed"]);
const business = service("b", ["Invite Sent", "docs received", "Contract Signed", "Filed"]);
const retired = service("r", ["Old step"], false);

describe("the tasks screen's stage filter", () => {
  it("offers every service's names once, by earliest position, an inactive one's too", () => {
    expect(stageFilterNames([personal, business, retired])).toEqual([
      "Invite Sent",
      "Old step",
      "Docs Received",
      "Contract Signed",
      "Filed",
    ]);
  });

  it("knows a firm that has no stages anywhere", () => {
    expect(anyStages([service("x", []), service("y", [])])).toBe(false);
    expect(anyStages([service("x", []), retired])).toBe(true);
  });

  it("offers one service's own stages, in its order, once a service is picked", () => {
    expect(stageFilterNames([personal, business], "b")).toEqual([
      "Invite Sent",
      "docs received",
      "Contract Signed",
      "Filed",
    ]);
  });

  it("offers nothing for internal work, which goes through no service", () => {
    expect(stageFilterNames([personal], "none")).toEqual([]);
  });

  it("cycles the header's sort: up, down, off", () => {
    expect(nextStageSort("none")).toBe("asc");
    expect(nextStageSort("asc")).toBe("desc");
    expect(nextStageSort("desc")).toBe("none");
  });
});
