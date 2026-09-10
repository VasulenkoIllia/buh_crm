/**
 * Writes each successful request's route, and whether a service described it, to the log that
 * `check-activity-routes.ts` reads after the full suite.
 *
 * A setup file, so it runs in every test worker before the tests load the app — and in the same
 * module graph, so the observer it registers is the one `core/activity.ts` reports to. The path
 * comes from `global-setup.ts`, which empties the log once per run.
 */
import { appendFileSync } from "node:fs";
import { observeFinishedRequests } from "../core/request-observer.js";

const log = process.env.ACTIVITY_ROUTE_LOG;
if (log) {
  observeFinishedRequests(({ method, route, statusCode, described }) => {
    if (statusCode < 200 || statusCode >= 300) return;
    appendFileSync(log, `${JSON.stringify({ method, route, bare: !described })}\n`);
  });
}
