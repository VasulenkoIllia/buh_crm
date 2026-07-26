/**
 * Display names — one rule, used by every module that renders a person into a DTO.
 * (Tasks, Payments and Clients each grew their own copy of this; they now share it.)
 */

export interface Nameable {
  type: "individual" | "company";
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

/** individual → "First Last"; company → the company name. Never empty — falls back to "—". */
export function clientLabel(c: Nameable): string {
  if (c.type === "company") return c.companyName ?? "—";
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
}

/** A team member's name for audit trails and "recorded by" lines. */
export function personName(u: { firstName: string | null; lastName: string | null } | null): string {
  return u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "—" : "—";
}
