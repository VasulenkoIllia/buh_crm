import type { FastifyInstance } from "fastify";
import type { RouteAccess, RouteAccessConfig } from "./access.js";

/**
 * **Every route this server answers, enumerated, sorted and committed.**
 *
 * Before this file nothing enumerated the API. Three route counts were in circulation (149, 154,
 * 156) and none could be reconciled by reading, because Fastify silently adds a `HEAD` route for
 * every `GET` — 56 of them here, which is most of the gap. Worse, nothing asserted that a route
 * had a guard at all, so removing one was invisible: no test failed, no diff said anything.
 *
 * So the app enumerates itself. `server/route-inventory.json` is the committed answer and
 * `server/route-inventory.test.ts` fails on any drift, printing what was added, removed or
 * changed. Adding a route is then a two-line diff in a file somebody reviews — one line for the
 * route, one for the access it declared.
 *
 * **Collected during `buildApp()`, not in a test.** `onRoute` fires only for routes registered
 * after the hook in the same context, so it must sit at the root of `server/app.ts` before the
 * module registrations — and putting it there is what lets the same pass THROW on an undeclared
 * route. `printRoutes()` was never an option: it prints the radix tree and can see neither
 * `preHandler` nor `config`.
 */
export interface RouteRecord {
  /** one row per method — Fastify expands the arrays a route may register with */
  method: string;
  /** the registered path, prefix included */
  url: string;
  /** what the route declares about itself: `gate:<unit>` · `gate:<unit>:admin` · shared · own · anonymous */
  access: string;
  /**
   * True for the `HEAD` Fastify exposes automatically alongside every `GET`
   * (`exposeHeadRoutes` defaults on). Recorded rather than dropped — they are real entries that
   * reach the access hook — but excluded from the counts, because counting them as rules is what
   * made the three totals disagree in the first place.
   */
  derived?: true;
}

export function describeAccess(access: RouteAccess): string {
  switch (access.kind) {
    case "gate":
      return access.adminOnly ? `gate:${access.gate}:admin` : `gate:${access.gate}`;
    default:
      return access.kind;
  }
}

/**
 * Installs the collector on `app` and returns the (initially empty) array it fills.
 *
 * Must be called BEFORE any route or module is registered on `app`.
 */
export function collectRouteInventory(app: FastifyInstance): RouteRecord[] {
  const rows: RouteRecord[] = [];

  app.addHook("onRoute", (route) => {
    const declared = (route.config as Partial<RouteAccessConfig> | undefined)?.access;

    /**
     * **The server does not start when a route forgets to declare itself.**
     *
     * Not a lint rule and not a test that can be skipped. This is the whole of "a new route is
     * closed by default": the alternative — a warning — is the arrangement this module replaced,
     * where a new route was reachable by anyone until somebody remembered otherwise.
     */
    if (!declared) {
      if (route.url.startsWith("/api")) {
        throw new Error(
          `Route ${route.method} ${route.url} declares no access. Every route under /api must ` +
            `carry exactly one of gate("<unit>"), shared(), own() or anonymous() in its ` +
            `\`config\` — see server/core/access.ts and docs/modules/permissions.md §5.`,
        );
      }
      return; // non-/api: /health declares anonymous; the prod static tree declares nothing
    }

    const access = describeAccess(declared);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      rows.push({ method, url: route.url, access });
    }
  });

  return rows;
}

/**
 * Sorts the way the fixture is committed — by url, then method — and marks the `HEAD` rows Fastify
 * added for us.
 *
 The marking is a SECOND PASS on purpose. Fastify does not emit a route's auto-`HEAD` in a fixed
 * order relative to its `GET`, so a one-pass "have I seen the GET yet?" test gets some of them
 * wrong. After every route is registered the question has one answer.
 *
 * **The trailing slash is the second half of the same quirk**, and it is worth naming because it
 * is one of the three things that made the route counts disagree. A module registering `GET "/"`
 * under a prefix is reachable at `/api/users` AND `/api/users/`; `onRoute` reports the `GET` once
 * but the `HEAD` for both spellings. Those ten extra rows are as derived as the rest — Fastify
 * wrote them, nobody chose them — so a `HEAD` matches a `GET` at its own url or at that url
 * without its trailing slash.
 *
 * Nothing in this codebase registers a `HEAD` by hand; if something ever does, it will show up in
 * the fixture diff as a `HEAD` with no matching `GET` and no `derived` flag, which is the right
 * thing for a reviewer to be asked about.
 */
export function finalizeInventory(rows: RouteRecord[]): RouteRecord[] {
  const gets = new Set(rows.filter((r) => r.method === "GET").map((r) => r.url));
  const hasGet = (url: string) =>
    gets.has(url) || (url.endsWith("/") && gets.has(url.slice(0, -1)));
  return rows
    .map((r) =>
      r.method === "HEAD" && hasGet(r.url) ? { ...r, derived: true as const } : { ...r },
    )
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}
