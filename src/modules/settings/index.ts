import { lazy } from "react";

export { useSettings } from "./settings.api";
/** names of the payment details sets, never their text: the client card and New invoice */
export { usePaymentDetailsOptions } from "./payment-details.api";
/** the positions an invoice picks from: the lines editor of New invoice and the correction */
export { useInvoiceItems } from "./invoice-items.api";
/**
 * Settings' own form for an invoice item, for the item a row adds (payments.md §3). Lazy: it lives
 * in the Settings section's file, which the invoice editors would otherwise carry on every open.
 */
export const InvoiceItemForm = lazy(() =>
  import("./invoice-items-section").then((m) => ({ default: m.ItemForm })),
);

/**
 * The tab strip and the gates that can open it.
 *
 * On the barrel because the app SHELL needs it — `router.tsx` decides whether `/settings` opens and
 * `layout.tsx` whether the sidebar item is drawn — and both of those must agree with the screen.
 * Safe to publish statically, unlike a screen: `./tabs` is data with a single TYPE import and
 * reaches nothing (`src/app/code-splitting.test.ts` is the rule this is checked against).
 */
export { SETTINGS_GATES, SETTINGS_TABS, type SettingsTab, type SettingsTabSpec } from "./tabs";
