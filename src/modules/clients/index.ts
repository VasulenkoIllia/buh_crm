import { lazy } from "react";

export { ClientFormModal } from "./client-form";
export { useClient, useClients, useClientsInfinite, useRestoreClient } from "./clients.api";

/**
 * Lazy, and that is the whole point of the line.
 *
 * `modules/tasks/index.ts` publishes `ClientLeadSearch` out of `task-modals.tsx`, so that file is a
 * SHARED chunk — the board, leads, the client card and the calendar's meeting form all pull it. A
 * plain `export … from "./client-services"` here would let the task form reach the subscription
 * screen statically, and Rollup would move all of it into that shared chunk: measured 2026-09-04,
 * `task-modals` went 9.66 → 14.27 kB gzip and opening the CALENDAR started downloading billing
 * pills. Through `lazy()` it is its own 6.59 kB chunk, fetched when someone actually opens the
 * form, and `task-modals` moves by 0.34 kB.
 *
 * Callers must render it inside a <Suspense>.
 */
export const AddServiceModal = lazy(() =>
  import("./client-services").then((m) => ({ default: m.AddServiceModal })),
);
