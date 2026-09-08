import { lazy } from "react";

/**
 * **The module's cross-module surface — and both things on it are already lazy.**
 *
 * A barrel is shared, so what it reaches statically travels to every module that imports it
 * (AGENTS.md, measured twice on this codebase). Both of these are big: the feed pulls in the whole
 * 138-event registry and the switches pull in its prose, and the two screens that render them —
 * Settings and the client card — are themselves loaded on demand. Exporting either with a plain
 * `export … from` would put the registry in whatever chunk the importer happens to share.
 *
 * Render them inside a `<Suspense>` whose fallback keeps the frame.
 */
export const ActivityFeed = lazy(() =>
  import("./activity-feed").then((m) => ({ default: m.ActivityFeed })),
);

export const ActivityPolicySection = lazy(() =>
  import("./activity-policies").then((m) => ({ default: m.ActivityPolicySection })),
);
