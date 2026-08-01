-- Subscriptions become SERVED PERIODS (decision 2026-07-29, see docs/modules/decisions-log.md).
--
-- ADDITIVE ONLY. `Subscription.active` / `billingStartAt` / `startedAt` stay for now and are
-- dropped by a later migration, once no code reads them — so the app runs at every point of the
-- rollout instead of being half-migrated.

CREATE TABLE "SubscriptionPeriod" (
    "id"             UUID         NOT NULL,
    "subscriptionId" UUID         NOT NULL,
    -- first day IN FORCE (inclusive)
    "startsOn"       DATE         NOT NULL,
    -- first day NOT in force (exclusive); NULL = open-ended, the normal state
    "endsBefore"     DATE,
    "note"           TEXT,
    "createdById"    UUID,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPeriod_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SubscriptionPeriod"
    ADD CONSTRAINT "SubscriptionPeriod_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionPeriod"
    ADD CONSTRAINT "SubscriptionPeriod_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SubscriptionPeriod_subscriptionId_startsOn_idx"
    ON "SubscriptionPeriod"("subscriptionId", "startsOn");

-- At most ONE open period per subscription. Prisma can't express a WHERE on an index, so this is
-- raw SQL and therefore invisible to `prisma migrate diff` — `server/schema-invariants.test.ts`
-- asserts it, the same way it guards the other five.
CREATE UNIQUE INDEX "Subscription_one_open_period"
    ON "SubscriptionPeriod"("subscriptionId")
    WHERE "endsBefore" IS NULL;

-- ── carry every existing subscription over ───────────────────────────────────
-- One period each. Start = the billing anchor if it was set, else when the row was created.
-- Active ones stay OPEN (no end). Stopped ones are closed at `updatedAt`, which is an ASSUMPTION:
-- the real stop date was never recorded anywhere, and `updatedAt` is the closest thing to it.
-- Recorded as such in the decisions log rather than presented as fact.
INSERT INTO "SubscriptionPeriod" ("id", "subscriptionId", "startsOn", "endsBefore", "note", "createdAt")
SELECT
    gen_random_uuid(),
    s."id",
    (COALESCE(s."billingStartAt", s."createdAt") AT TIME ZONE 'UTC')::date,
    CASE
        WHEN s."active" THEN NULL
        -- +1 day: `endsBefore` is exclusive, and the last served day is taken as the update day
        ELSE ((s."updatedAt" AT TIME ZONE 'UTC')::date + 1)
    END,
    CASE WHEN s."active" THEN NULL ELSE 'migrated: stop date assumed from updatedAt' END,
    s."createdAt"
FROM "Subscription" s;

-- A stopped subscription updated the same day it was created would otherwise get a period that
-- ends before it starts. Give those a single served day so the data stays sane.
UPDATE "SubscriptionPeriod"
SET "endsBefore" = "startsOn" + 1
WHERE "endsBefore" IS NOT NULL AND "endsBefore" <= "startsOn";
