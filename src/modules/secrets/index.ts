import { lazy } from "react";

/**
 * The secrets module's cross-module surface: the client card's tab. Published already lazy, as the
 * files module publishes its browser: a card is opened far more often than its Secrets tab, and the
 * tab brings the eight forms, the generator and the move dialog with it.
 *
 * Callers render it inside a <Suspense>.
 */
export const ClientSecrets = lazy(() =>
  import("./client-secrets").then((m) => ({ default: m.ClientSecrets })),
);
