/**
 * Display names — one rule, used by every module that renders a person into a DTO.
 * (Tasks, Payments and Clients each grew their own copy of this; they now share it.)
 */

export interface Nameable {
  firstName: string;
  lastName: string | null;
}

/**
 * A client reads as "First Last" — there is no company/individual split any more (2026-07-26):
 * the companies a client holds are their own rows, and `Client.companyName` is a label, not an
 * identity. Never empty: `firstName` is required.
 */
export function clientLabel(c: Nameable): string {
  return `${c.firstName} ${c.lastName ?? ""}`.trim() || "—";
}

/** A team member's name for audit trails and "recorded by" lines. */
export function personName(u: { firstName: string | null; lastName: string | null } | null): string {
  return u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "—" : "—";
}
