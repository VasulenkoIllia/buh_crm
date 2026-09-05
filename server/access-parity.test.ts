import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GATES, allowsMethod, type AccessState } from "@shared/access.js";
import type { UserRole } from "@shared/schema/enums.js";
import type { RouteRecord } from "./core/route-inventory.js";

/**
 * **Deploy day changes nothing anybody notices — proved, not asserted.**
 *
 * The app is in production. This change deletes 46 `requireAdmin` guards, 105 `requireAuth`
 * guards and three module-level hooks, and replaces them with a registry of defaults. "It should
 * behave the same" is not a claim anyone can check by reading 162 routes across thirteen files, so
 * this test asks the OLD arrangement and the NEW one the same question about every route — may an
 * admin call it, may a plain user call it, does it need a session at all — and requires the same
 * answer.
 *
 * `ADMIN_BEFORE` and `PUBLIC_BEFORE` below are the frozen measurement, taken from the running app on 2026-09-05 by
 * enumerating `onRoute` and comparing each route's resolved `preHandler` (plus the three
 * encapsulated-context hooks, which `onRoute` does not expose and which a naive reading would have
 * recorded as UNGUARDED — 41 routes' worth, the Clients module included). It is a historical
 * record: it must never be regenerated, only read.
 *
 * Every difference is listed in `INTENDED_CHANGES`, with the reason. There are seven: two
 * behaviour changes and five routes that did not exist before.
 */

/** What protected each route the day before the access module landed. */
const ADMIN_BEFORE = [
  "POST /api/catalog",
  "DELETE /api/catalog/:id",
  "PATCH /api/catalog/:id",
  "PATCH /api/catalog/:id/position",
  "POST /api/catalog/:id/tasks",
  "DELETE /api/catalog/:id/tasks/:templateId",
  "PATCH /api/catalog/:id/tasks/:templateId",
  "PATCH /api/invoices/:id",
  "GET /api/invoices/:id/audit",
  "POST /api/invoices/:id/cancel",
  "DELETE /api/invoices/payments/:paymentId",
  "PATCH /api/invoices/payments/:paymentId",
  "POST /api/leads/stages",
  "DELETE /api/leads/stages/:id",
  "PATCH /api/leads/stages/:id",
  "PATCH /api/leads/stages/:id/position",
  "PATCH /api/mailouts/settings/firm-mail",
  "DELETE /api/mailouts/settings/mail-logo",
  "PUT /api/mailouts/settings/mail-logo",
  "POST /api/mailouts/settings/senders",
  "DELETE /api/mailouts/settings/senders/:id",
  "PATCH /api/mailouts/settings/senders/:id",
  "POST /api/mailouts/settings/senders/:id/default",
  "POST /api/mailouts/settings/senders/:id/invoice-sender",
  "POST /api/mailouts/settings/senders/:id/test",
  "GET /api/notifications/policies",
  "PATCH /api/notifications/policies/:trigger",
  "PATCH /api/settings/firm",
  "PUT /api/settings/firm/logo",
  "PATCH /api/settings/priorities/:id",
  "PATCH /api/settings/priorities/swap",
  "POST /api/settings/sources",
  "DELETE /api/settings/sources/:id",
  "PATCH /api/settings/sources/:id",
  "GET /api/settings/system",
  "POST /api/tasks/:id/time",
  "POST /api/tasks/columns",
  "DELETE /api/tasks/columns/:id",
  "PATCH /api/tasks/columns/:id",
  "PATCH /api/tasks/columns/:id/position",
  "DELETE /api/tasks/time/:entryId",
  "PATCH /api/tasks/time/:entryId",
  "GET /api/users",
  "PATCH /api/users/:id",
  "POST /api/users/:id/resend-invite",
  "POST /api/users/invites",
];

/** Answered without a session. The audit said eight; the inventory confirmed exactly these. */
const PUBLIC_BEFORE = [
  "POST /api/auth/accept-invite",
  "POST /api/auth/forgot-password",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/reset-password",
  "GET /api/mailouts/unsubscribe/:token",
  "POST /api/mailouts/unsubscribe/:token",
  "GET /health",
];

type Answer = "public" | "everyone" | "admin-only" | "nobody";

/**
 * Three differences, each argued rather than discovered.
 *
 * The two time-entry routes are the only BEHAVIOUR change in the whole release, and it is the one
 * §8 asks for: editing your own recorded time stops requiring an admin. It ships with
 * `TimeEntryAuditLog` in the same migration, because opening it without a journal would make every
 * dispute about billed hours unresolvable in principle. Somebody else's entry is still refused —
 * by an ownership check in the service, which is a stricter shape than the bare role flag it
 * replaces, not a looser one.
 *
 * The other five are new routes — the access screen's four, and the From picker's narrow read.
 */
const INTENDED_CHANGES: Record<string, { before: Answer; after: Answer; why: string }> = {
  "PATCH /api/tasks/time/:entryId": {
    before: "admin-only",
    after: "everyone",
    why: "§8 — own entry or admin, enforced in the service, shipping with TimeEntryAuditLog",
  },
  "DELETE /api/tasks/time/:entryId": {
    before: "admin-only",
    after: "everyone",
    why: "§8 — own entry or admin, enforced in the service, shipping with TimeEntryAuditLog",
  },
  "GET /api/access": {
    before: "nobody",
    after: "admin-only",
    why: "new: the access screen itself, behind the Team gate — whoever manages people manages access",
  },
  "PUT /api/access/policies/:gate/:role": {
    before: "nobody",
    after: "admin-only",
    why: "new: the access screen itself, behind the Team gate",
  },
  "PUT /api/access/overrides/:userId/:gate": {
    before: "nobody",
    after: "admin-only",
    why: "new: the access screen itself, behind the Team gate",
  },
  "DELETE /api/access/overrides/:userId/:gate": {
    before: "nobody",
    after: "admin-only",
    why: "new: the access screen itself, behind the Team gate",
  },
  "GET /api/mailouts/senders": {
    before: "nobody",
    after: "everyone",
    why:
      "new: the From picker's narrow read. The composer used to call the mailbox EDITOR's " +
      "endpoint, which answers with SMTP and IMAP hostnames and usernames — so closing the " +
      "mailboxes gate would have taken the composer down with it, and leaving it open ships the " +
      "firm's mail credentials to every browser that opens the composer",
  },
};

function before(route: string): Answer {
  if (PUBLIC_BEFORE.includes(route)) return "public";
  if (ADMIN_BEFORE.includes(route)) return "admin-only";
  return "everyone";
}

/** What the registry's shipped defaults say, with no policy rows in the database. */
function after(record: RouteRecord): Answer {
  if (record.access === "anonymous") return "public";
  if (record.access === "shared" || record.access === "own") return "everyone";

  const [, gateName, adminFlag] = record.access.split(":");
  const spec = GATES[gateName as keyof typeof GATES];
  const may = (role: UserRole) => {
    const state: AccessState = spec.defaults[role];
    if (!allowsMethod(state, record.method)) return false;
    return !(adminFlag === "admin" || spec.fixedAdmin) || role === "admin";
  };
  const admin = may("admin");
  const user = may("user");
  if (admin && user) return "everyone";
  if (admin) return "admin-only";
  return "nobody";
}

describe("access parity — the day of the deploy", () => {
  it("gives every route the same answer the guards gave", async () => {
    const rows = (
      JSON.parse(
        await readFile(new URL("route-inventory.json", import.meta.url), "utf8"),
      ) as RouteRecord[]
    ).filter((r) => !r.derived);

    const drift: string[] = [];
    for (const record of rows) {
      const route = `${record.method} ${record.url}`;
      const was = INTENDED_CHANGES[route]?.before ?? before(route);
      const now = after(record);
      const expected = INTENDED_CHANGES[route]?.after ?? was;
      if (now !== expected) {
        drift.push(`${route} (${record.access}): was ${was}, is now ${now}`);
      }
    }

    expect(
      drift,
      "A route answers differently than it did before the access module. Either the declaration " +
        "is wrong, or the change is deliberate — in which case add it to INTENDED_CHANGES with a " +
        "reason, so somebody reviews it.",
    ).toEqual([]);
  });

  it("accounts for every guard that was removed", async () => {
    const rows = (
      JSON.parse(
        await readFile(new URL("route-inventory.json", import.meta.url), "utf8"),
      ) as RouteRecord[]
    ).filter((r) => !r.derived);
    const known = new Set(rows.map((r) => `${r.method} ${r.url}`));

    // Every route that carried a guard still exists. A guard removed together with its route is
    // fine; a guard removed while the route stayed is what this whole file is here to catch.
    const vanished = [...ADMIN_BEFORE, ...PUBLIC_BEFORE].filter((r) => !known.has(r));
    expect(vanished, "these routes carried a guard and are no longer in the inventory").toEqual(
      [],
    );
    expect(ADMIN_BEFORE.length).toBe(46);
    expect(PUBLIC_BEFORE.length).toBe(8);
  });
});
