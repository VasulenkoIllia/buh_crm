import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ACTIVITY_KEYS, PLANNED_EVENT_KEYS } from "@shared/activity.js";

/**
 * **A declared event with no producer is a promise the log does not keep.**
 *
 * The registry is read by the screen, seeded into `ActivityPolicy` and offered to the firm as a
 * switch. An entry nothing writes therefore shows up as a filter that never matches and a switch
 * that does nothing — worse than an absent event, because the absence is visible and the dead
 * switch is not.
 *
 * So the rule is mechanical: a key is DECLARED when its service is wired, and stays in
 * `PLANNED_EVENT_KEYS` until then. This test is what makes that true rather than intended, and it
 * is the guard on the enrichment pass — moving a key up without wiring it fails here.
 */

const ROOTS = ["../server", "../scripts", "../shared"];
const SKIP_DIRS = new Set(["node_modules", "generated", "dist"]);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield child;
  }
}

/**
 * **The registry itself is excluded, and that exclusion is the whole test.**
 *
 * Without it every key matches its own declaration in `shared/activity.ts` and the check passes
 * vacuously — which is exactly what it did when first written (found 2026-09-08 while splitting
 * commits). A test that cannot fail is worse than no test, because it is believed.
 */
const REGISTRY = "shared/activity.ts";

async function sources(): Promise<string> {
  let all = "";
  for (const root of ROOTS) {
    for await (const file of walk(new URL(`${root}/`, import.meta.url))) {
      if (file.pathname.endsWith(REGISTRY)) continue;
      all += await readFile(file, "utf8");
    }
  }
  return all;
}

/**
 * Written by something other than a literal `record("…")` call, and each for a stated reason.
 *
 * `system.request` and `session.gate_refused` are the tier-1 hook's own two keys: it reads them
 * from `TIER1_REQUEST` / `TIER1_REFUSED` so the hook cannot drift from the registry, which is the
 * same reason they cannot be found by grepping for the literal.
 *
 * `system.data_reset` is written by `scripts/deploy.sh` in SQL, before the wipe it records — the
 * one statement outside Prisma that names this table, and the reason the table is on the
 * `--reset` keep-list (activity-log.md §3.3, §11).
 */
const WRITTEN_ELSEWHERE: Record<string, string> = {
  "system.request": "the tier-1 hook, via TIER1_REQUEST",
  "session.gate_refused": "the tier-1 hook, via TIER1_REFUSED",
  "system.data_reset": "scripts/deploy.sh, in SQL, before the wipe",
};

describe("every declared event has something that writes it", () => {
  it("finds a producer for each key in the registry", async () => {
    const code = await sources();
    const orphans = ACTIVITY_KEYS.filter(
      (key) => !(key in WRITTEN_ELSEWHERE) && !code.includes(`"${key}"`),
    );
    expect(
      orphans,
      "these events are declared but nothing writes them. Either wire the service, or move the " +
        "key back to PLANNED_EVENT_KEYS until you do — a switch on the screen for an event that " +
        "never fires is worse than no switch.",
    ).toEqual([]);
  });

  it("keeps the deploy script's SQL and the hook's constants honest", async () => {
    const deploy = await readFile(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
    // the one place a shell statement names this table — if the column list here drifts from the
    // model, `--reset` fails on the server AFTER the dump and BEFORE the pull
    expect(deploy).toContain("system.data_reset");
    expect(deploy).toContain('INSERT INTO "ActivityEvent"');
  });

  /**
   * The other direction: a PLANNED key that something already writes is a key that should have been
   * declared. It would be recorded and then refused by `record()`, which throws under test — so
   * this fails loudly rather than in production.
   */
  it("finds nothing writing a key that is still only planned", async () => {
    const code = await sources();
    const premature = PLANNED_EVENT_KEYS.filter((key) => code.includes(`record("${key}"`));
    expect(
      premature,
      "these keys are written by a service but are still in PLANNED_EVENT_KEYS. Declare them in " +
        "ACTIVITY_EVENTS — with the changeKeys the service actually moves.",
    ).toEqual([]);
  });
});
