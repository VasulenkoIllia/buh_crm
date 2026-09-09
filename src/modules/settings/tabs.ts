import type { GateKey } from "@shared/access";

/**
 * **The Settings tabs and the gate each one sits behind — in ONE place, because three files read
 * it.**
 *
 * The screen renders the strip from this; `router.tsx` decides whether the route opens at all from
 * it; `layout.tsx` decides whether the sidebar item is drawn. Those three were three separate
 * lists, and they disagreed — which is not a tidiness problem but the way this module can be
 * bricked:
 *
 * The route named `["settings", "activity"]` while the strip also holds tabs gated by `team` (the
 * ACCESS TABLE) and `notification_rules`. So an admin who closed `settings` and `activity` for the
 * admin role — two switches, both offered on the access screen itself — was bounced off `/settings`
 * and lost the only screen that could put either of them back. The API still answered; nothing in
 * the product could reach it, and the way out was SQL (audit, 2026-09-09).
 *
 * `SETTINGS_GATES` is therefore DERIVED from the strip rather than restated beside it: the screen
 * opens if any tab on it may be opened, whichever tab that is, for ever.
 *
 * Data only — no React, no page import — so the shell may read it without pulling the screen into
 * the first chunk (`src/app/code-splitting.test.ts`).
 */
export type SettingsTab =
  "firm" | "lists" | "invoices" | "notifications" | "system" | "access" | "activity";

export interface SettingsTabSpec {
  value: SettingsTab;
  label: string;
  /** absent = the tab belongs to `settings` itself, the gate the screen is named for */
  gate?: GateKey;
}

/**
 * The strip, in the order it is drawn.
 *
 * A tab with no `gate` is part of the firm's own settings and follows the `settings` gate; the
 * three that name one are other areas seen from here, and each is switchable on its own.
 */
export const SETTINGS_TABS: readonly SettingsTabSpec[] = [
  { value: "firm", label: "Firm" },
  { value: "lists", label: "Lists" },
  { value: "invoices", label: "Invoices" },
  { value: "notifications", label: "Notifications", gate: "notification_rules" },
  { value: "system", label: "System" },
  // whoever manages people manages their access — the tab is the Team gate, never its own switch
  { value: "access", label: "Access", gate: "team" },
  /**
   * Beside Access, and behind a gate of its OWN (activity-log.md §12).
   *
   * Not `team`: that gate is `fixedAdmin`, so reading the log would have meant full admin, and
   * giving a lead their department's record would have meant giving them roles and invitations
   * with it. Its own gate is one line in `shared/access.ts` and lets the firm decide.
   */
  { value: "activity", label: "Activity", gate: "activity" },
];

/**
 * Every gate that can open `/settings` — `settings` for the tabs that carry none, plus each tab's
 * own. The route and the sidebar item open while ANY of these is not `closed`.
 */
export const SETTINGS_GATES: readonly GateKey[] = [
  "settings",
  ...new Set(SETTINGS_TABS.flatMap((t) => (t.gate ? [t.gate] : []))),
];
