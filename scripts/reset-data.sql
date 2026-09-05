-- Wipe every CLIENT record; keep the team and the firm's own configuration.
--
-- What survives, and why:
--   • User / Session / AuthToken  — the team stays signed in.
--   • FirmProfile                 — the firm's requisites, postal address and invoice counter are
--                                   settings, not client data. Recreating them by hand after every
--                                   reset lost real setup (user, 2026-08-26).
--   • MailSenderAccount           — the configured mailbox (From, signature, SMTP/IMAP) for the
--                                   same reason. The letters it SENT still go.
--   • the ONE default Service     — the one flagged `autoAddToNewClients`, which every new client
--                                   is given on create. Without it a fresh client has no paid
--                                   container at all. Every OTHER service goes.
--   • avatar and logo files       — the File rows the kept rows point at. A kept FirmProfile whose
--                                   logo had vanished is exactly the surprise this file avoids.
--
-- DELETE, not TRUNCATE: `TRUNCATE ... CASCADE` reaches through User.avatarFileId -> File and takes
-- the USERS with it. DELETE only ever touches the rows named here.
--
-- The base data at the bottom (priorities, columns, sources) is recreated by `ensureBaseData()`
-- the next time the app boots — which is why this runs BEFORE the deploy.
BEGIN;

-- ── mailouts (S10/S10.1) ─────────────────────────────────────────────────────
-- Before "Company", not after: MailoutRecipient.companyId is ON DELETE RESTRICT, so a company
-- that was ever written to blocks the wipe — and a failed reset stops the deploy right after the
-- dump, leaving the server neither reset nor updated.
--
-- Campaign before EmailTemplate for the same reason (Campaign.templateId is RESTRICT).
-- MailSenderAccount is NOT here (see the header): the mailbox is configuration, and the three
-- tables that point at it — EmailTemplate, Mailout, Campaign — are all emptied just above it.
DELETE FROM "MailoutRecipient";
DELETE FROM "CampaignRecipient";
DELETE FROM "CampaignDate";
DELETE FROM "ClientMailPreference";
-- Addresses a receiving server said were gone. They name client addresses, so they go with the
-- clients: keeping them would blocklist an address a fresh import might legitimately reuse.
DELETE FROM "DeadEmailAddress";
DELETE FROM "Mailout";
DELETE FROM "Campaign";
DELETE FROM "EmailTemplate";

-- Children first, parents after.
--
-- Rows that would CASCADE from a parent below are still named here on purpose. A cascade is
-- invisible to a reader and, worse, to the next migration: `MailoutRecipient.companyId` was a
-- cascade until it became RESTRICT, and the wipe broke on a server. An explicit DELETE costs
-- nothing on an empty table and survives that change. `server/schema-invariants.test.ts` holds
-- this file to every table the database has.
DELETE FROM "PaymentAuditLog";
DELETE FROM "Payment";
-- Who edited or deleted an interval of somebody's working time. It goes with the entries it
-- describes, exactly as "PaymentAuditLog" and "SecretAuditLog" go with theirs: after a reset the
-- tasks it names do not exist, so a journal of edits to them records nothing anybody can read.
-- ("UserRoleAuditLog" is NOT here — it is about the team, and the team survives a reset. It is
-- named in the KEPT list in server/schema-invariants.test.ts, which makes that a decision.)
DELETE FROM "TimeEntryAuditLog";
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

-- Notifications (S9). The TRAY goes: it is transient, and a reset firm has nothing to be notified
-- about — every row in it points at a task, meeting or invoice that is about to stop existing.
-- "NotificationPreference" and "NotificationPolicy" are NOT here: preferences belong to users, who
-- survive a reset, and the policy is firm configuration like FirmProfile and MailSenderAccount.
-- Both are named in the KEPT list in server/schema-invariants.test.ts, which is what makes that a
-- decision rather than an omission.
DELETE FROM "Notification";
-- ("Reminder" was here. Migration 20260811090000_mailouts dropped that table — it was a
-- design-phase stub nothing ever wrote to. Left in, this line failed with 42P01 and took the
-- whole reset, and therefore the deploy, down with it.)
-- personal pins on the clients list. Cascades from "Client" below, but named here like the rest:
-- a cascade is invisible to the next migration, and this file is checked table by table.
DELETE FROM "ClientPin";
DELETE FROM "ClientPerson";
DELETE FROM "SecretAuditLog";
DELETE FROM "ClientSecret";
DELETE FROM "Company";

-- Every file EXCEPT the ones a kept row points at. Client documents go; the team's avatars and the
-- firm's two logos stay, because the rows that own them stay. `scripts/prune-uploads.ts` deletes
-- the bytes of everything dropped here — run it after the deploy, when the new image is up.
DELETE FROM "File" f
WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."avatarFileId" = f.id)
  AND NOT EXISTS (SELECT 1 FROM "FirmProfile" p WHERE p."logoFileId" = f.id)
  AND NOT EXISTS (SELECT 1 FROM "FirmProfile" p WHERE p."mailLogoFileId" = f.id);

DELETE FROM "Client";
DELETE FROM "Lead";
DELETE FROM "Notification";

-- The catalog, minus the one service every new client is given. Templates first: TaskTemplate
-- would CASCADE from the service anyway, but naming it keeps this file readable and keeps the
-- invariant test's "every table is accounted for" check honest.
DELETE FROM "TaskTemplate" WHERE "serviceId" NOT IN (SELECT id FROM "Service" WHERE "autoAddToNewClients");
DELETE FROM "Service" WHERE NOT "autoAddToNewClients";

-- base data — recreated on the next boot by ensureBaseData()
DELETE FROM "TaskColumn";
DELETE FROM "Priority";
DELETE FROM "SourceOption";
-- after "Lead" above, which is what the RESTRICT on Lead.stageId requires
DELETE FROM "LeadStage";

COMMIT;
