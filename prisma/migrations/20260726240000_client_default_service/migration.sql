-- The client's DEFAULT service (user, 2026-07-26).
--
--   One of a client's services is "the usual one": it prefills the service picker wherever work
--   or an invoice is raised for them. With a single service that's automatic; with several, the
--   firm picks. At most one per client, and it can't be stopped while it holds the flag —
--   clear the default first, then stop the service.
ALTER TABLE "Subscription" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a client with exactly one active service already has an unambiguous default.
UPDATE "Subscription" s
SET "isDefault" = true
WHERE s.active
  AND (SELECT count(*) FROM "Subscription" x WHERE x."clientId" = s."clientId" AND x.active) = 1;

-- at most one default per client — partial, so the many `false` rows don't collide.
-- Not expressible in the Prisma schema; server/schema-invariants.test.ts asserts it.
CREATE UNIQUE INDEX "Subscription_one_default_per_client"
  ON "Subscription" ("clientId") WHERE "isDefault";
