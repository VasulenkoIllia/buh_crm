/**
 * Root cache keys, in one place.
 *
 * Modules invalidate each other's data all the time — completing a billable job moves an
 * invoice AND a client's debt — and each module used to re-declare the other's key as a local
 * literal to avoid importing across module indexes. That put the same string in four files.
 * These constants belong to no module, so anyone can import them without coupling.
 */

export const CLIENTS_KEY = ["clients"] as const;
export const TASKS_KEY = ["tasks"] as const;
export const INVOICES_KEY = ["invoices"] as const;
export const LEADS_KEY = ["leads"] as const;
export const CATALOG_KEY = ["catalog"] as const;
export const SETTINGS_KEY = ["settings"] as const;
export const USERS_KEY = ["users"] as const;
// the signed-in user's own key stays with the auth provider that owns it (`ME_QUERY_KEY`
// in app/auth.tsx) — shared/ must not reach up into app/
