import { isClientFacing } from "@shared/schema/catalog";
import type { Service } from "@shared/schema/catalog";
import type { Subscription } from "@shared/schema/client";
import type { BillingPeriod } from "@shared/schema/enums";

/**
 * Whether a catalog service can be added to a client — and if not, why.
 *
 * The server's rule is one line (`findDuplicateSubscription`): the same service may exist twice on
 * a client only for DIFFERENT companies. It deliberately ignores whether the existing row is
 * running, so a service that is merely PAUSED still blocks a new one — and until this module
 * existed the only way to learn that was to fill the form and be refused by the server with
 * "already assigned", which names no company and no date and offers no way forward.
 *
 * Asking the same question client-side needs no new endpoint: the client DTO already carries every
 * subscription, running or not, each with its `state` and its dates.
 */
export type AddState =
  | { kind: "addable" }
  /** running right now — it is already in the task form's picker */
  | { kind: "in_force" }
  /** agreed, starts later; tasks can only hang off it from that day */
  | { kind: "scheduled"; from: string }
  /** was served until `until` (null = paused open-endedly); the way back is Resume, not Add */
  | { kind: "paused"; until: string | null };

/**
 * A subscription's billing timing, normalized. Narrower than `InvoiceTrigger`, which also carries
 * the two one-time modes (`on_create` / `on_complete`) that a period never has. It lives here
 * rather than in the screen because the rules below read it and the screen already imports them —
 * the other direction would be a cycle.
 */
export type BillingTiming = {
  trigger: "on_period_start" | "on_period_end";
  day: number | null;
};

/** The services a client may hold at all: live in the catalog, and not firm-internal. */
export function assignableServices(services: Service[]): Service[] {
  return services.filter((s) => s.active && isClientFacing(s));
}

/**
 * What the client already holds for this service, ACROSS ALL COMPANIES — the row's note.
 *
 * Separate from the rule below on purpose: the company is chosen in a panel that only appears once
 * a service is picked, so a row cannot know its own verdict yet. It states facts; the Add button
 * states the rule, for the company actually chosen.
 */
export function existingFor(serviceId: string, subscriptions: Subscription[]): Subscription[] {
  return subscriptions.filter((s) => s.serviceId === serviceId);
}

/** The rule, for the target actually chosen. Mirrors `findDuplicateSubscription` on the server. */
export function addStateFor(
  serviceId: string,
  subscriptions: Subscription[],
  companyId: string | null,
): AddState {
  const held = subscriptions.find(
    (s) => s.serviceId === serviceId && (s.companyId ?? null) === companyId,
  );
  if (!held) return { kind: "addable" };
  // every case spelled out and no `default`: a fourth subscription state would then fail to
  // compile here rather than silently reading as "already running"
  switch (held.state) {
    case "scheduled":
      return { kind: "scheduled", from: held.inForceFrom };
    case "paused":
      return { kind: "paused", until: held.inForceUntil };
    case "in_force":
      return { kind: "in_force" };
  }
}

/**
 * What adding this service does to MONEY, in one line.
 *
 * `addSubscription` calls the invoice generator the moment it commits, so attaching a subscription
 * service is not filing paperwork — it starts billing. That is obvious on the client card, where
 * you went to manage services; it is not obvious from a task form, where the reader's mind is on
 * the task. A one-time service is a container for manual jobs and bills nothing on its own, so it
 * says nothing.
 *
 * Deliberately does not promise a DATE: a period served only in part raises a task to invoice by
 * hand instead of issuing one, and that rule lives on the server. The form's own "Service starts
 * on" hint already spells that out.
 */
export function billingNote(
  service: Service,
  timing: BillingTiming,
  period: BillingPeriod = "month",
): string | null {
  if (service.type !== "subscription") return null;
  const when =
    period === "half_month"
      ? "invoices are issued on the 15th and the last day of each month"
      : timing.trigger === "on_period_end"
        ? "the first invoice comes at the end of the first period"
        : timing.day != null
          ? period === "week"
            ? `invoices are issued every ${WEEKDAYS[timing.day - 1] ?? "week"}`
            : `invoices are issued on day ${timing.day} of each period`
          : "the first invoice is issued as soon as the period starts";
  return `Adding this starts billing — ${when}.`;
}

/** A week's custom day is a day of the week, Monday = 1, as for the task rhythms. */
export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * The timing a subscription keeps when its rhythm changes in the form.
 *
 * Twice a month has no choice: each half bills on its last day, so it is held at the end of the
 * period with no day. A week keeps a custom day only if it is a day of the week; day 20 of a month
 * falls back to the week's start rather than reaching the server as a day that does not exist.
 */
export function fitTiming(timing: BillingTiming, period: BillingPeriod): BillingTiming {
  if (period === "half_month") return { trigger: "on_period_end", day: null };
  if (period === "week" && timing.day != null && timing.day > 7) {
    return { trigger: "on_period_start", day: null };
  }
  return timing;
}

/**
 * The timing when the form's rhythm changes from one to another.
 *
 * A day of the week and a day of the month share a column and nothing else: Friday is 5 and so is
 * the 5th. Carried across, a preset's 5th would bill every Friday and a Friday every 5th, neither of
 * them chosen by anybody, so crossing between a week and the rest drops the day for a person to pick.
 */
export function retime(
  timing: BillingTiming,
  from: BillingPeriod,
  to: BillingPeriod,
): BillingTiming {
  const crosses = (from === "week") !== (to === "week");
  return fitTiming(crosses ? { trigger: timing.trigger, day: null } : timing, to);
}

/** When in its period a subscription bills, in the words of its rhythm. */
export function timingLabel(timing: BillingTiming, period: BillingPeriod | null): string {
  if (period === "half_month") return "15th and last day";
  if (period === "week") {
    if (timing.trigger === "on_period_end") return "Sunday";
    return timing.day != null ? (WEEKDAYS[timing.day - 1] ?? "Monday") : "Monday";
  }
  if (timing.trigger === "on_period_end") return "end of period";
  return timing.day != null ? `day ${timing.day}` : "start of period";
}

/** What one price is for, in a word: "week", "month", "quarter", "year". */
export const priceUnit = (period: BillingPeriod) =>
  period === "half_month" ? "month" : period;
