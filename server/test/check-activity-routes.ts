/**
 * **Does every changing route describe itself?** Run by `npm run verify` after the test suite.
 *
 * The suite writes one line per successful request — which route, and whether a service described
 * it or only the bare request row was written (`route-log.ts`, through `core/request-observer.ts`). A route
 * whose EVERY successful call is bare is a gap: people will read "Maryna sent /api/tasks/timer/stop"
 * and learn nothing. That is how the timer, the checklist and a client's own unsubscribe shipped,
 * past a coverage test that only asked whether each MODULE recorded something (audit, 2026-09-10).
 *
 * A route that is sometimes bare is fine — a save with nothing changed, a drag inside one column,
 * a bulk action that matched nothing. What fails is a route that never says what it did.
 *
 * Separate from the suite because it has to see all of it, and a failing vitest global teardown
 * does not fail the run (measured).
 */
import { existsSync, readFileSync } from "node:fs";
import { QUIET_ROUTES } from "./quiet-routes.js";

const MUTATING = /^(POST|PUT|PATCH|DELETE)$/;
const log = new URL("../../node_modules/.cache/activity-routes.jsonl", import.meta.url);
const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
if (lines.length === 0) {
  console.error("activity routes: no log — run the whole suite first (`npm run test`).");
  process.exit(1);
}

const seen = new Map<string, { described: number; bare: number }>();
for (const line of lines) {
  const { method, route, bare } = JSON.parse(line) as {
    method: string;
    route: string;
    bare: boolean;
  };
  if (!MUTATING.test(method)) continue;
  const key = `${method} ${route}`;
  const tally = seen.get(key) ?? { described: 0, bare: 0 };
  if (bare) tally.bare += 1;
  else tally.described += 1;
  seen.set(key, tally);
}

const inventory = JSON.parse(
  readFileSync(new URL("../route-inventory.json", import.meta.url), "utf8"),
) as { method: string; url: string }[];
const changing = inventory
  .filter((r) => MUTATING.test(r.method))
  .map((r) => `${r.method} ${r.url}`);

/**
 * A log from a filtered run cannot be judged: a route's describing test may live in a file that
 * did not run. The full suite reaches ~90% of changing routes with a successful call; far fewer
 * means somebody ran part of it and then this.
 */
if (seen.size < changing.length * 0.8) {
  console.error(
    `activity routes: the log covers ${seen.size} of ${changing.length} changing routes — it looks ` +
      "like a partial run. Run the whole suite, then this.",
  );
  process.exit(1);
}

const gaps = [...seen]
  .filter(([key, t]) => t.bare > 0 && t.described === 0 && !(key in QUIET_ROUTES))
  .map(([key, t]) => `  ${key}   (${t.bare} successful calls, none described)`);
const stale = Object.keys(QUIET_ROUTES)
  .filter((key) => (seen.get(key)?.described ?? 0) > 0)
  .map((key) => `  ${key}`);
const untested = changing.filter((key) => !seen.has(key)).map((key) => `  ${key}`);

if (untested.length > 0) {
  console.warn(
    `activity routes: ${untested.length} changing routes have no successful call in the suite, so ` +
      `whether they describe themselves is unknown:\n${untested.join("\n")}`,
  );
}
if (gaps.length > 0) {
  console.error(
    "activity routes: these change something and never say what — every successful call left only " +
      `a bare "sent /api/…" row:\n${gaps.join("\n")}\n\nDescribe the act from its service ` +
      "(AGENTS.md, 'The activity log'), or add it to server/test/quiet-routes.ts with a reason.",
  );
}
if (stale.length > 0) {
  console.error(
    `activity routes: these describe themselves now — take them out of quiet-routes.ts:\n${stale.join("\n")}`,
  );
}
if (gaps.length > 0 || stale.length > 0) process.exit(1);
console.log(
  `activity routes: ${seen.size} changing routes checked, each describes what it did.`,
);
