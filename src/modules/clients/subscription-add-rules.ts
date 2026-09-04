import { isClientFacing } from "@shared/schema/catalog";
import type { Service } from "@shared/schema/catalog";
import type { Subscription } from "@shared/schema/client";

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
export type BillingTiming = { trigger: "on_period_start" | "on_period_end"; day: number | null };

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
export function billingNote(service: Service, timing: BillingTiming): string | null {
  if (service.type !== "subscription") return null;
  const when =
    timing.trigger === "on_period_end"
      ? "the first invoice comes at the end of the first period"
      : timing.day != null
        ? `invoices are issued on day ${timing.day} of each period`
        : "the first invoice is issued as soon as the period starts";
  return `Adding this starts billing — ${when}.`;
}
