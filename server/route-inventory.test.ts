import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { finalizeInventory, type RouteRecord } from "./core/route-inventory.js";

/**
 * **The API is enumerated, and the enumeration is committed.**
 *
 * This is the file that made the rest of the access work reviewable. Before it, nothing listed the
 * routes and nothing asserted that any of them was guarded, so removing a guard was invisible: no
 * test failed and the diff said only "one line deleted in a 300-line route file". Three route
 * counts were in circulation — 149, 154 and 156 — and none could be reconciled by reading.
 *
 * `server/route-inventory.json` is the answer, sorted and committed. Any change to the API shows
 * up here as a reviewable diff, and the totals below are literal numbers, so moving one is a
 * deliberate edit somebody signs off rather than a number that quietly drifts.
 *
 * It sits beside `schema-invariants.test.ts`, which guards the other thing a tool cannot see.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let live: RouteRecord[];
let fixture: RouteRecord[];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  live = finalizeInventory(app.routeInventory);
  fixture = JSON.parse(
    await readFile(new URL("route-inventory.json", import.meta.url), "utf8"),
  ) as RouteRecord[];
});

afterAll(async () => {
  await app?.close();
});

const key = (r: RouteRecord) => `${r.method} ${r.url}`;
const line = (r: RouteRecord) => `${key(r)} → ${r.access}${r.derived ? " (derived)" : ""}`;

describe("route inventory", () => {
  it("matches the committed fixture", () => {
    const liveByKey = new Map(live.map((r) => [key(r), r]));
    const fixtureByKey = new Map(fixture.map((r) => [key(r), r]));

    const added = live.filter((r) => !fixtureByKey.has(key(r))).map(line);
    const removed = fixture.filter((r) => !liveByKey.has(key(r))).map(line);
    const changed = live
      .filter((r) => {
        const was = fixtureByKey.get(key(r));
        return was && (was.access !== r.access || !!was.derived !== !!r.derived);
      })
      .map((r) => `${key(r)}: ${fixtureByKey.get(key(r))!.access} → ${r.access}`);

    expect(
      { added, removed, changed },
      "server/route-inventory.json is out of date. Regenerate it deliberately and review the " +
        "diff — an added route with the wrong gate is exactly what this file exists to surface.",
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  /**
   * The numbers, written out. `derived` are the `HEAD` routes Fastify exposes for every `GET`
   * (including the trailing-slash twin of a prefixed `GET "/"`) — 59 of them, which is most of
   * why the old counts disagreed.
   */
  it("answers the counts nobody could previously reconcile", () => {
    const real = live.filter((r) => !r.derived);
    const counts = {
      total: live.length,
      derivedHead: live.length - real.length,
      real: real.length,
      api: real.filter((r) => r.url.startsWith("/api")).length,
      anonymous: real.filter((r) => r.access === "anonymous").length,
      own: real.filter((r) => r.access === "own").length,
      shared: real.filter((r) => r.access === "shared").length,
      gated: real.filter((r) => r.access.startsWith("gate:")).length,
      adminOnly: real.filter((r) => r.access.endsWith(":admin")).length,
    };
    expect(counts).toEqual({
      total: 221,
      derivedHead: 59,
      real: 162,
      api: 161, // everything but /health
      anonymous: 8, // 5 credential routes, 2 unsubscribe pages, /health
      // 10, not 11: `POST /tasks/timer/start` moved to the `tasks` gate during the 2026-09-07
      // audit. It takes a taskId and writes against somebody else's module, so it was never
      // really "the caller's own row" — `active` and `stop` still are, and must be.
      own: 10,
      shared: 9,
      gated: 135,
      adminOnly: 14,
    });
  });

  it("declares every route under /api", () => {
    const undeclared = live.filter((r) => r.url.startsWith("/api") && !r.access).map(key);
    expect(undeclared).toEqual([]);
  });

  /**
   * The one list nobody had ever seen: what answers without a session. It confirmed the audit's
   * count of 8 exactly — no route had been missed.
   */
  it("keeps the unauthenticated surface to the eight routes that are meant to be public", () => {
    expect(live.filter((r) => !r.derived && r.access === "anonymous").map(key).sort()).toEqual([
      "GET /api/mailouts/unsubscribe/:token",
      "GET /health",
      "POST /api/auth/accept-invite",
      "POST /api/auth/forgot-password",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/reset-password",
      "POST /api/mailouts/unsubscribe/:token",
    ]);
  });

  /** Every declaration names a gate the registry knows, or is one of the other three kinds. */
  it("declares nothing the registry cannot resolve", () => {
    const bad = live
      .filter((r) => !["shared", "own", "anonymous"].includes(r.access))
      .filter((r) => !/^gate:[a-z_]+(:admin)?$/.test(r.access))
      .map(line);
    expect(bad).toEqual([]);
  });
});
