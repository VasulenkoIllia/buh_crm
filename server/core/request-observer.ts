/**
 * **A seam for watching finished requests: which route, and whether anything described it.**
 *
 * Nothing in production registers an observer. The test suite does (`server/test/route-log.ts`),
 * and `server/test/check-activity-routes.ts` reads what it wrote once the whole suite has run.
 *
 * Here, with no imports, rather than as test code inside `core/activity.ts`: the first version put
 * a file write and an environment check into the log's own module, on the path every mutating
 * request takes, for the sake of its tests (review, 2026-09-10). Inert until something registers.
 */
export interface FinishedRequest {
  method: string;
  route: string;
  statusCode: number;
  /** a service's event was actually WRITTEN — after the policy and dedupe filters, not just buffered */
  described: boolean;
}

let observer: ((request: FinishedRequest) => void) | null = null;

export function observeFinishedRequests(fn: ((request: FinishedRequest) => void) | null) {
  observer = fn;
}

export function reportFinishedRequest(request: FinishedRequest) {
  observer?.(request);
}
