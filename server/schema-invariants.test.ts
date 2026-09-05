import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prisma } from "./core/db.js";

/**
 * Several guarantees this app relies on are PARTIAL or FUNCTIONAL indexes, which Prisma's schema
 * language can't express — they're hand-written SQL in migrations. `prisma migrate diff` doesn't
 * see them either, so a schema-drift check comes back clean whether they're there or not. This
 * test is the check: if a migration ever drops one, the failure is here and not in production.
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
  {
    name: "Subscription_one_open_period",
    guarantees:
      "a subscription is in force in at most one open-ended period — two would make 'was it " +
      "served on day X' ambiguous, and coverage is what decides both billing and task generation",
    mustMatch: /ON public\."SubscriptionPeriod".*\("subscriptionId"\).*WHERE.*"endsBefore" IS NULL/is,
  },
  {
    name: "Task_system_period",
    guarantees:
      "a system-raised task exists once per (subscription, period) — the sweeps run daily and on " +
      "every boot, so without it the same reminder would be posted every morning",
    mustMatch: /ON public\."Task".*"subscriptionId".*"periodKey".*WHERE.*"systemKind" IS NOT NULL/is,
  },
  {
    name: "MailoutRecipient_one_client_row",
    guarantees:
      "one letter reaches a client's own address once. The table's UNIQUE(mailoutId, clientId, " +
      "companyId) cannot say this on its own: companyId is NULL for the client's own row, and " +
      "Postgres treats every NULL as distinct, so the same person would be mailable twice",
    mustMatch: /ON public\."MailoutRecipient".*\("mailoutId", "clientId"\).*WHERE.*"companyId" IS NULL/is,
  },
  {
    name: "CampaignRecipient_one_client_row",
    guarantees:
      "a campaign writes to a client's own address once per run. Same NULL problem as the sent " +
      "letters: UNIQUE(campaignId, clientId, companyId) cannot see two NULL companyIds as equal",
    mustMatch: /ON public\."CampaignRecipient".*\("campaignId", "clientId"\).*WHERE.*"companyId" IS NULL/is,
  },
  {
    name: "Mailout_campaignId_periodKey_key",
    guarantees:
      "a campaign fires once per occurrence — the sweep runs daily AND on every boot, so without " +
      "this a server down over a weekend would send the same letter twice on Monday",
    mustMatch: /ON public\."Mailout".*\("campaignId", "periodKey"\)/is,
  },
  {
    name: "MailSenderAccount_name_key_ci",
    guarantees: "a mailbox name means one mailbox, however it was capitalised",
    mustMatch: /ON public\."MailSenderAccount".*lower\(name\)/is,
  },
  {
    name: "MailSenderAccount_one_default",
    guarantees:
      "exactly one sender mailbox is the default — with two, which one a letter goes from would " +
      "depend on row order, and the log would record something nobody chose",
    mustMatch: /ON public\."MailSenderAccount".*\("isDefault"\).*WHERE.*"isDefault"/is,
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

  /**
   * **Every table is either wiped by `--reset` or deliberately kept.**
   *
   * `scripts/reset-data.sql` runs BEFORE the deploy pulls, so when it fails the server is left with
   * a fresh dump, the old code and untouched data. It has broken that way three times in one
   * round: a `DELETE FROM "Reminder"` for a table a migration had dropped, a `DELETE FROM
   * "Company"` blocked by the new RESTRICT on sent letters, and — in a test's own wipe — templates
   * deleted before the campaigns that hold them.
   *
   * Every one was the same shape: a list of table names that a new migration made wrong. Nothing
   * could catch it, because that file runs on a server and nowhere else. This is that check: ask
   * the DATABASE what tables exist and hold the script to all of them.
   */
  it("wipes every table on --reset, or names it as deliberately kept", async () => {
    const sql = await readFile(
      new URL("../scripts/reset-data.sql", import.meta.url),
      "utf8",
    );
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;

    /**
     * Kept on purpose:
     *   • User / Session / AuthToken — the team stays signed in.
     *   • FirmProfile, MailSenderAccount — the firm's OWN configuration (requisites, invoice
     *     counter, the mailbox it sends from). They are not client data, and rebuilding them by
     *     hand after every reset lost real setup (user, 2026-08-26). The letters that WERE sent
     *     from the mailbox are still wiped — see the DELETEs above them in the script.
     *   • NotificationPreference — a user's own choices about their bell, and users survive.
     *     Populating them again from the defaults would silently un-mute everything they muted.
     *   • NotificationPolicy — firm configuration, like FirmProfile above: which triggers the firm
     *     has switched off is a decision they made, not client data. (The TRAY is wiped — see the
     *     DELETE in the script.)
     *   • JobHealth, JobEvent — the server's record of its OWN background jobs, not the firm's data. A
     *     reset wipes clients; it does not un-run last night's sweeps, and clearing it would make
     *     every job on the System tab read "Has not run yet" — false, on the one screen whose
     *     whole value is being believed.
     *   • AccessPolicy, AccessOverride — who may open what. Firm configuration in the same sense
     *     as FirmProfile and NotificationPolicy, and the one whose loss would be INVISIBLE: a
     *     reset that silently re-opened every closed area looks exactly like a reset that worked.
     *   • UserRoleAuditLog — who granted whom which role. It is about the TEAM, and the team
     *     survives a reset; wiping it would erase the only record that the rule the access module
     *     calls irreducible was ever exercised. (TimeEntryAuditLog is NOT kept: it describes
     *     edits to client-work time entries, which the reset wipes — same call as PaymentAuditLog
     *     and SecretAuditLog, and it is in the script.)
     *   • _prisma_migrations — Prisma owns its own ledger.
     */
    const KEPT = new Set([
      "User",
      "Session",
      "AuthToken",
      "FirmProfile",
      "MailSenderAccount",
      "NotificationPolicy",
      "NotificationPreference",
      "JobHealth",
      "JobEvent",
      "AccessPolicy",
      "AccessOverride",
      "UserRoleAuditLog",
      "_prisma_migrations",
    ]);

    const missed = rows
      .map((r) => r.tablename)
      .filter((t) => !KEPT.has(t))
      .filter((t) => !new RegExp(`DELETE FROM "${t}"`).test(sql));

    expect(
      missed,
      `scripts/reset-data.sql does not clear: ${missed.join(", ")}. A --reset deploy fails on the ` +
        `server, AFTER the dump and BEFORE the pull. Add the DELETE (in FK order) or add the table ` +
        `to KEPT here with a reason.`,
    ).toEqual([]);
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
      // a sent letter records that this company was written to — deleting the company must be
      // refused, not silently erase the record
      "MailoutRecipient.companyId",
    ]) {
      expect(restricted, `${fk} must be ON DELETE RESTRICT`).toContain(fk);
    }
  });
});
