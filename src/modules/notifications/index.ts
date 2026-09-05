import { lazy } from "react";

/**
 * The module's CROSS-MODULE surface, and nothing more.
 *
 * `NotificationTray` is static because the app shell renders it on every screen — it is first-chunk
 * work by definition.
 *
 * The two settings sections are LAZY, and that is not decoration. A barrel is shared, so whatever
 * it reaches statically travels to every module that imports it — and `layout.tsx` imports this one
 * for the tray, which puts it in the first chunk. A plain `export … from "./notification-policy"`
 * would therefore ship the whole admin policy screen to everybody on first load, for a screen
 * almost nobody opens. This is the exact failure `src/app/code-splitting.test.ts` was written for
 * after `client-services` did it to the clients barrel (measured 2026-09-04: 9.66 → 14.27 kB gzip).
 *
 * Both are rendered inside a `<Suspense>` whose fallback keeps the frame — see their call sites.
 */
export { NotificationTray } from "./notification-tray";

export const NotificationPreferences = lazy(() =>
  import("./notification-preferences").then((m) => ({ default: m.NotificationPreferences })),
);

export const NotificationPolicySection = lazy(() =>
  import("./notification-policy").then((m) => ({ default: m.NotificationPolicySection })),
);
