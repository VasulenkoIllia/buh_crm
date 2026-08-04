-- "Archive" meant three different things, which is why one Archive screen could not be built:
--   Client / Task  → archivedAt = SOFT DELETED (hidden everywhere, restorable)
--   Invoice        → archivedAt = settled and tidied out of the working list (never a deletion,
--                    and it un-archives itself when a deleted payment brings the debt back)
--   Lead           → the "Archive" TAB was not archivedAt at all, but outcome != in_process
--
-- From here `archivedAt` means exactly one thing everywhere: soft-deleted. The invoice sense gets
-- its own name (decision 2026-08-03).
ALTER TABLE "Invoice" RENAME COLUMN "archivedAt" TO "tidiedAt";
ALTER TABLE "Invoice" RENAME COLUMN "archivedById" TO "tidiedById";
ALTER TABLE "Invoice" RENAME CONSTRAINT "Invoice_archivedById_fkey" TO "Invoice_tidiedById_fkey";
ALTER INDEX "Invoice_archivedAt_idx" RENAME TO "Invoice_tidiedAt_idx";
ALTER INDEX "Invoice_cancelledAt_archivedAt_issuedAt_idx" RENAME TO "Invoice_cancelledAt_tidiedAt_issuedAt_idx";

-- Archiving a client now CLOSES their subscription periods, because leaving them "in force" was a
-- lie the sweeps believed: on restore they back-filled every missed occurrence and invoiced the
-- periods inside the 45-day horizon — six months in the archive measured as 6 overdue tasks,
-- 2 invoices and 5 reminders for work nobody did. Back-fill the clients already archived, using
-- the day they were archived as the last day served.
-- a start agreed for later never served anything: drop it, don't leave a period ending before it begins
DELETE FROM "SubscriptionPeriod" p
USING "Subscription" s, "Client" c
WHERE p."subscriptionId" = s."id" AND c."id" = s."clientId"
  AND c."archivedAt" IS NOT NULL
  AND p."startsOn" >= date_trunc('day', c."archivedAt") + interval '1 day';

UPDATE "SubscriptionPeriod" p
SET "endsBefore" = date_trunc('day', c."archivedAt") + interval '1 day',
    "endNote"    = 'Client archived'
FROM "Subscription" s
JOIN "Client" c ON c."id" = s."clientId"
WHERE p."subscriptionId" = s."id"
  AND c."archivedAt" IS NOT NULL
  AND p."startsOn" < date_trunc('day', c."archivedAt") + interval '1 day'
  AND (p."endsBefore" IS NULL
       OR p."endsBefore" > date_trunc('day', c."archivedAt") + interval '1 day');
