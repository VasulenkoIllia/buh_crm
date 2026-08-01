/**
 * Tasks the system raises on its OWN initiative — not from a service template someone configured.
 *
 * This is the source, not a copy: the generators read their titles and descriptions from here, so
 * the read-only "Automation" screen that lists them cannot drift from what actually happens. Add a
 * kind here and the screen picks it up; change the wording here and the generator follows.
 *
 * Zero dependencies on purpose (no zod): importing a VALUE out of a schema module pulls the whole
 * schema runtime into the browser bundle — measured at +433 kB — and this one is read by the UI.
 */

export type SystemTaskKind = "partial_period_invoice" | "subscription_ending";

export interface SystemTaskSpec {
  /** short label, also the task's title prefix */
  title: string;
  /** goes into the task's description, so whoever picks it up knows what is being asked */
  description: string;
  /** in plain words, when the system raises it */
  when: string;
  /** why it exists — the mistake it prevents */
  why: string;
  /** what it hangs off, so the Automation screen can say where to look */
  attachedTo: string;
}

export const SYSTEM_TASKS: Record<SystemTaskKind, SystemTaskSpec> = {
  partial_period_invoice: {
    title: "Invoice a part-served period",
    description:
      "This period was not invoiced automatically — either it was served only in part (the amount " +
      "for half a period is an agreement, not arithmetic) or its billing day is long past and the " +
      "system will not issue backdated invoices on its own. Check what was served, issue the " +
      "invoice by hand, then close this task.",
    when:
      "A billing period the client was served for only part of: they joined mid-period, or the " +
      "service was paused mid-period. Also for a period older than the 45-day auto-issue window.",
    why:
      "The system never guesses a part-period amount and never silently skips one either. " +
      "Without this, work that was done would simply go unbilled.",
    attachedTo: "the client, through the subscription it concerns",
  },
  subscription_ending: {
    title: "Service ends soon",
    description:
      "This subscription has an end date coming up. Extend it, or let it end — either way the " +
      "decision should be made on purpose rather than noticed afterwards.",
    when: "A week before a subscription's explicitly set end date.",
    why:
      "Subscriptions are open-ended by default and nothing renews them, so an end date that was " +
      "agreed months ago would otherwise pass unnoticed.",
    attachedTo: "the client, through the subscription that is ending",
  },
};
