import { QUIET_ROUTES } from "./test/quiet-routes.js";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import inventory from "./route-inventory.json" with { type: "json" };

/**
 * **A module that changes things and records none of them.**
 *
 * The tier-1 hook makes the log WIDE without anybody's help: every mutating request is recorded
 * with the actor, the IP, the route and the outcome, so nothing anybody ships can be invisible.
 * What it cannot do is make the log READABLE — tier 1 says `Olena sent PATCH /api/leads/:id`, and
 * only the service knows that she changed a prospect's phone number.
 *
 * That gap is invisible by construction: the feature works, the tests pass, and the cost only
 * appears months later when somebody asks a question the log cannot answer. This is the check that
 * makes it appear immediately instead — the same shape `route-inventory.json` uses to stop a route
 * shipping without an access declaration.
 *
 * It is deliberately coarse. Asserting event-by-event coverage of 116 routes would need a fixture
 * nobody would keep honest; asserting that a module which mutates records SOMETHING catches the
 * case that actually happens — a whole area of the product shipping unlogged.
 */

/**
 * Modules whose mutating routes are deliberately tier-1 only. Each needs a reason, and the reason
 * has to be about the ACTS, not about the effort.
 */
const TIER1_ONLY: Record<string, string> = {
  activity:
    "the log's own module. Its reads record nothing by design (§3.2), and its one mutating " +
    "route writes `settings.activity_switched` from its service — but under the `settings` " +
    "subject, so the grep for this module's directory does not see it.",
};

/** `app.register(clientsModule, { prefix: "/api/clients" })` → { "/api/clients": "clients" } */
async function moduleByPrefix(): Promise<Map<string, string>> {
  const app = await readFile(new URL("app.ts", import.meta.url), "utf8");
  const out = new Map<string, string>();
  for (const m of app.matchAll(/register\((\w+)Module,\s*\{\s*prefix:\s*"([^"]+)"/g)) {
    out.set(m[2], m[1]);
  }
  return out;
}

async function recordsSomething(module: string): Promise<boolean> {
  const dir = new URL(`modules/${module}/`, import.meta.url);
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    if ((await readFile(new URL(entry, dir), "utf8")).includes('record("')) return true;
  }
  return false;
}

describe("every part of the product that changes something says what it changed", () => {
  it("finds an enriched event in every module with mutating routes", async () => {
    const prefixes = await moduleByPrefix();
    expect(prefixes.size).toBeGreaterThan(10); // the parse found the registrations at all

    const mutating = new Set(
      inventory
        .filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method))
        .map((r) => [...prefixes.keys()].find((p) => r.url.startsWith(p)))
        .filter((p): p is string => Boolean(p)),
    );

    const silent: string[] = [];
    for (const prefix of mutating) {
      const module = prefixes.get(prefix)!;
      if (module in TIER1_ONLY) continue;
      if (!(await recordsSomething(module))) silent.push(`${module} (${prefix})`);
    }

    expect(
      silent,
      "these modules change things and record nothing but the bare request. Either enrich the " +
        "service — see AGENTS.md, 'The activity log' — or add the module to TIER1_ONLY with a " +
        "reason about the acts rather than about the effort.",
    ).toEqual([]);
  });

  it("keeps the quiet-route list honest — each names a changing route that exists, and why", async () => {
    const inventory = JSON.parse(
      await readFile(new URL("route-inventory.json", import.meta.url), "utf8"),
    ) as { method: string; url: string }[];
    const changing = new Set(
      inventory
        .filter((r) => /^(POST|PUT|PATCH|DELETE)$/.test(r.method))
        .map((r) => `${r.method} ${r.url}`),
    );
    for (const [route, why] of Object.entries(QUIET_ROUTES)) {
      expect(changing.has(route), `${route} is not a changing route in the inventory`).toBe(
        true,
      );
      expect(why.length, `${route} needs a reason, not a word`).toBeGreaterThan(20);
    }
  });

  it("keeps the exception list honest — an exception must name a module that exists", async () => {
    const prefixes = await moduleByPrefix();
    const known = new Set(prefixes.values());
    expect(Object.keys(TIER1_ONLY).filter((m) => !known.has(m))).toEqual([]);
    for (const [module, why] of Object.entries(TIER1_ONLY)) {
      expect(
        why.length,
        `${module}: an exception without a reason is not an exception`,
      ).toBeGreaterThan(40);
    }
  });
});
