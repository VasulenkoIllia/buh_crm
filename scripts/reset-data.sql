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

-- children first, parents after
DELETE FROM "PaymentAuditLog";
DELETE FROM "Payment";
DELETE FROM "TimeEntry";
DELETE FROM "Subtask";
DELETE FROM "TaskAssignee";
DELETE FROM "TaskComment";
DELETE FROM "Task";
DELETE FROM "Invoice";
DELETE FROM "Subscription";
DELETE FROM "MeetingParticipant";
DELETE FROM "Meeting";
DELETE FROM "Reminder";
DELETE FROM "ClientPerson";
DELETE FROM "Company";
DELETE FROM "File";
DELETE FROM "Client";
DELETE FROM "Lead";
DELETE FROM "Notification";
DELETE FROM "TaskTemplate";
DELETE FROM "Service";
DELETE FROM "Campaign";
DELETE FROM "EmailTemplate";

-- base data — recreated on the next boot
DELETE FROM "TaskColumn";
DELETE FROM "Priority";
DELETE FROM "SourceOption";
DELETE FROM "FirmProfile";

COMMIT;
