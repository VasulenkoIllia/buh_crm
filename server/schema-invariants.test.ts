import { describe, expect, it } from "vitest";
import { prisma } from "./core/db.js";

/**
 * Three guarantees this app relies on are PARTIAL unique indexes, which Prisma's schema language
 * can't express — they're hand-written SQL in migrations. `prisma migrate diff` doesn't see them
 * either, so a schema-drift check comes back clean whether they're there or not. This test is the
 * check: if a migration ever drops one, the failure is here and not in production.
 */

interface IndexRow {
  indexname: string;
  indexdef: string;
}

const REQUIRED = [
  {
    name: "TimeEntry_one_running_per_user",
    guarantees: "one running timer per person, enforced by the database (the timer's 409)",
    mustMatch: /ON public\."TimeEntry".*\("userId"\).*WHERE.*"stoppedAt" IS NULL/is,
  },
  {
    name: "Task_internal_template_period",
    guarantees: "internal templates generate a period's task once (the sweep is idempotent)",
    mustMatch: /ON public\."Task".*"taskTemplateId".*"periodKey".*WHERE.*"subscriptionId" IS NULL/is,
  },
  {
    name: "Service_single_default_for_new_clients",
    guarantees: "at most one service is the default added to every new client",
    mustMatch: /ON public\."Service".*WHERE.*"autoAddToNewClients"/is,
  },
  {
    name: "Subscription_one_default_per_client",
    guarantees: "a client has at most one default service (the one that prefills their pickers)",
    mustMatch: /ON public\."Subscription".*\("clientId"\).*WHERE.*"isDefault"/is,
  },
  {
    // a FUNCTIONAL index — Prisma can't express lower(name) either, so it lands here too
    name: "Company_name_key_ci",
    guarantees: "a company name identifies one company across the whole firm (case-insensitive)",
    mustMatch: /ON public\."Company".*lower\(name\)/is,
  },
];

describe("raw-SQL schema invariants (invisible to prisma migrate diff)", () => {
  it("keeps every partial unique index the app depends on", async () => {
    const rows = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    for (const index of REQUIRED) {
      const def = byName.get(index.name);
      expect(def, `missing index ${index.name} — ${index.guarantees}`).toBeDefined();
      expect(def).toMatch(/CREATE UNIQUE INDEX/i);
      expect(def, `${index.name} no longer covers what it must`).toMatch(index.mustMatch);
    }
  });

  it("keeps billing history un-blankable (ON DELETE RESTRICT on the provenance FKs)", async () => {
    // deleting a company or a service must be REFUSED, not silently blank what an issued
    // invoice or a generated task was for (migration 20260726090000)
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND rc.delete_rule = 'RESTRICT'
    `;
    const restricted = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const fk of [
      "Invoice.serviceId",
      "Invoice.subscriptionId",
      "Invoice.companyId",
      "Task.serviceId",
      "Task.companyId",
      "Subscription.companyId",
    ]) {
      expect(restricted, `${fk} must be ON DELETE RESTRICT`).toContain(fk);
    }
  });
});
