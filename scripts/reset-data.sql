-- Wipe every domain record; keep the team, their sessions and their reset tokens.
--
-- DELETE, not TRUNCATE: `TRUNCATE ... CASCADE` reaches through User.avatarFileId -> File and takes
-- the USERS with it. DELETE only ever touches the rows named here, and the two UPDATEs above the
-- list break the only links that point from kept rows into files.
--
-- The base data at the bottom (priorities, columns, sources, firm profile) is recreated by
-- `ensureBaseData()` the next time the app boots — which is why this runs BEFORE the deploy.
BEGIN;

UPDATE "User" SET "avatarFileId" = NULL;
UPDATE "FirmProfile" SET "logoFileId" = NULL;

-- ── mailouts (S10/S10.1) ─────────────────────────────────────────────────────
-- Before "Company", not after: MailoutRecipient.companyId is ON DELETE RESTRICT, so a company
-- that was ever written to blocks the wipe — and a failed reset stops the deploy right after the
-- dump, leaving the server neither reset nor updated.
--
-- Campaign before EmailTemplate for the same reason (Campaign.templateId is RESTRICT).
-- MailSenderAccount goes too: it is firm configuration like the rest of the block at the bottom,
-- and `ensureDefaultMailbox()` recreates the .env one on the next boot. Its sealed SMTP password
-- would otherwise outlive the FirmProfile it belongs to.
DELETE FROM "MailoutRecipient";
DELETE FROM "CampaignRecipient";
DELETE FROM "CampaignDate";
DELETE FROM "ClientMailPreference";
DELETE FROM "Mailout";
DELETE FROM "Campaign";
DELETE FROM "EmailTemplate";
DELETE FROM "MailSenderAccount";

-- Children first, parents after.
--
-- Rows that would CASCADE from a parent below are still named here on purpose. A cascade is
-- invisible to a reader and, worse, to the next migration: `MailoutRecipient.companyId` was a
-- cascade until it became RESTRICT, and the wipe broke on a server. An explicit DELETE costs
-- nothing on an empty table and survives that change. `server/schema-invariants.test.ts` holds
-- this file to every table the database has.
DELETE FROM "PaymentAuditLog";
DELETE FROM "Payment";
DELETE FROM "TimeEntry";
DELETE FROM "Subtask";
DELETE FROM "TaskAssignee";
DELETE FROM "TaskComment";
DELETE FROM "Task";
DELETE FROM "InvoiceLine";
DELETE FROM "Invoice";
DELETE FROM "SubscriptionPeriod";
DELETE FROM "Subscription";
DELETE FROM "MeetingParticipant";
DELETE FROM "Meeting";
-- ("Reminder" was here. Migration 20260811090000_mailouts dropped that table — it was a
-- design-phase stub nothing ever wrote to. Left in, this line failed with 42P01 and took the
-- whole reset, and therefore the deploy, down with it.)
DELETE FROM "ClientPerson";
DELETE FROM "SecretAuditLog";
DELETE FROM "ClientSecret";
DELETE FROM "Company";
DELETE FROM "File";
DELETE FROM "Client";
DELETE FROM "Lead";
DELETE FROM "Notification";
DELETE FROM "TaskTemplate";
DELETE FROM "Service";

-- base data — recreated on the next boot
DELETE FROM "TaskColumn";
DELETE FROM "Priority";
DELETE FROM "SourceOption";
DELETE FROM "FirmProfile";

COMMIT;
