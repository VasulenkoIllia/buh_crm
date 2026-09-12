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
        return (
          was &&
          (was.access !== r.access ||
            !!was.derived !== !!r.derived ||
            !!was.beforeTwoFactor !== !!r.beforeTwoFactor)
        );
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
      // +3 real routes on 2026-09-08, all of them the activity log's: the list, the event
      // switches, and the one route that flips a switch. +9 on 2026-09-12, all two-factor
      // sign-in's: the second step of signing in, the five routes on the caller's own second
      // factor, and Team's three (the overview, the rule, an admin's reset).
      total: 241,
      derivedHead: 65,
      real: 176,
      api: 175, // everything but /health
      anonymous: 9, // 6 credential routes, 2 unsubscribe pages, /health
      // `POST /tasks/timer/start` moved to the `tasks` gate during the 2026-09-07 audit. It takes a
      // taskId and writes against somebody else's module, so it was never really "the caller's own
      // row" — `active` and `stop` still are, and must be. The two-factor five are the caller's own
      // second factor and name nobody else.
      own: 15,
      shared: 9,
      gated: 143,
      adminOnly: 16,
    });
  });

  it("declares every route under /api", () => {
    const undeclared = live.filter((r) => r.url.startsWith("/api") && !r.access).map(key);
    expect(undeclared).toEqual([]);
  });

  /**
   * The one list nobody had ever seen: what answers without a session. It confirmed the audit's
   * count of 8 exactly — no route had been missed. The ninth, the second step of signing in, was
   * decided on 2026-09-12 (two-factor.md §5.4) and is listed here rather than slipped in.
   */
  it("keeps the unauthenticated surface to the nine routes that are meant to be public", () => {
    expect(
      live
        .filter((r) => !r.derived && r.access === "anonymous")
        .map(key)
        .sort(),
    ).toEqual([
      "GET /api/mailouts/unsubscribe/:token",
      "GET /health",
      "POST /api/auth/accept-invite",
      "POST /api/auth/forgot-password",
      "POST /api/auth/login",
      "POST /api/auth/login/2fa",
      "POST /api/auth/logout",
      "POST /api/auth/reset-password",
      "POST /api/mailouts/unsubscribe/:token",
    ]);
  });

  /**
   * **What still answers somebody the firm's two-factor rule is holding back** (two-factor.md §6.4).
   *
   * Everything else refuses them — `own()` included, because their own tray and timer carry task
   * and client names. The security review of 2026-09-12 found the whole `own()` class exempt; this
   * list is what replaced it, and a route added to it is a decision somebody reviews here.
   */
  it("keeps the routes open to a person who must enrol to the four that let them enrol", () => {
    expect(
      live
        .filter((r) => !r.derived && r.beforeTwoFactor)
        .map(key)
        .sort(),
    ).toEqual([
      "GET /api/auth/me",
      "GET /api/two-factor/me",
      "POST /api/two-factor/me/confirm",
      "POST /api/two-factor/me/setup",
    ]);
    // …and only `own()` routes may carry it: a gated or shared route is the firm's data
    expect(live.filter((r) => r.beforeTwoFactor && r.access !== "own").map(key)).toEqual([]);
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
