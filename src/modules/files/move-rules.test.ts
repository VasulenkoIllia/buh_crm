import { describe, expect, it } from "vitest";
import { checkMove, type MoveFacts } from "./move-rules";
import type { UiPlace } from "./places";

const internal = (clientId = "a"): UiPlace => ({ kind: "client", clientId, zone: "internal" });
const shared = (clientId = "a"): UiPlace => ({ kind: "client", clientId, zone: "shared" });
const facts = (over: Partial<MoveFacts>): MoveFacts => ({
  from: { kind: "company" },
  to: { kind: "company" },
  files: 2,
  onTasks: 0,
  admin: false,
  clientName: (id) => (id === "a" ? "Petrenko" : "BrightLine"),
  ...over,
});

describe("what a move means, before it happens (files.md §6.2)", () => {
  it("says when a client will start or stop seeing the files", () => {
    expect(checkMove(facts({ from: internal(), to: shared() })).lines).toEqual([
      { tone: "info", text: "Petrenko will see these 2 files once the portal opens." },
    ]);
    expect(checkMove(facts({ from: shared(), to: internal(), files: 1 })).lines).toEqual([
      { tone: "warn", text: "Petrenko will no longer see this file." },
    ]);
    // within what the client sees, nothing changes for them
    const within = {
      from: shared(),
      to: { kind: "client", clientId: "a", zone: "from_client" },
    };
    expect(checkMove(facts(within as Partial<MoveFacts>)).lines).toEqual([]);
  });

  it("leaves a move out of a client to an admin, on its own route", () => {
    const out = facts({ from: internal(), to: { kind: "company" } });
    expect(checkMove(out)).toMatchObject({
      allowed: false,
      url: "/api/files/clients/a/move-out",
    });
    const asAdmin = checkMove({ ...out, admin: true, onTasks: 1 });
    expect(asAdmin.allowed).toBe(true);
    expect(asAdmin.lines.map((l) => l.text)).toEqual([
      "Out of Petrenko's files. Only admins may do this, and the activity log keeps it.",
      "One of them is on a task, and will leave it.",
    ]);
    expect(checkMove(facts({ from: internal(), to: shared() })).url).toBe(
      "/api/files/clients/a/move",
    );
  });

  it("says that files leaving My files are shared, and that task files leave their task", () => {
    expect(checkMove(facts({ from: { kind: "my" }, to: { kind: "company" } })).lines).toEqual([
      {
        tone: "info",
        text: "Out of My files: everyone who can see Company will see these 2 files.",
      },
    ]);
    // an internal task's file filed in Company leaves its task on the way into My files
    const toMine = checkMove(
      facts({ from: { kind: "company" }, to: { kind: "my" }, onTasks: 2 }),
    );
    expect(toMine.lines).toEqual([
      { tone: "warn", text: "2 of them are on tasks, and will leave them." },
    ]);
    expect(checkMove(facts({ onTasks: 2 })).lines).toEqual([]);
  });
});
