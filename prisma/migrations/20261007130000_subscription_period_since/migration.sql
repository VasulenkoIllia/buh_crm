-- The day a subscription's current billing rhythm took over (2026-10-07; schema.prisma explains).
--
-- Additive and catalog-only: a nullable column with no default rewrites nothing, whatever the size
-- of "Subscription". Null means "one rhythm since it began", which is every subscription but those
-- whose period was ever changed.
ALTER TABLE "Subscription" ADD COLUMN "periodSince" DATE;

-- Those whose period WAS changed before this column existed are found in the activity log, which
-- records every `subscription.updated` with the fields it moved. The day is read on the firm's clock
-- (America/New_York, the TZ this single-tenant deployment runs on): `occurredAt` is stored in UTC,
-- and a change made at 22:00 in New York is already the next day in UTC.
-- On 2026-10-07 production held two: Natalie's Payroll (to quarterly) and Saida Akhbayeva's (to
-- monthly). A database with no such entries updates nothing.
UPDATE "Subscription" s
SET "periodSince" = changed.day
FROM (
  SELECT a."subjectId" AS id,
         max((a."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date) AS day
  FROM "ActivityEvent" a
  WHERE a.action = 'subscription.updated'
    AND a."subjectId" IS NOT NULL
    AND a.changes ? 'period'
  GROUP BY a."subjectId"
) changed
WHERE s.id = changed.id;
