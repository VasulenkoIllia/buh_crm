-- The served periods are now the only source of truth for "is this subscription running"
-- (decision 2026-07-29). This is the DESTRUCTIVE half of that change and runs only after the code
-- stopped reading these — the additive half landed in 20260729120000_subscription_periods.
--
-- `active` was a stored boolean that said whether a service is on RIGHT NOW and nothing about when
-- it was switched, which is why a pause could be unbilled yet fully worked. `billingStartAt` was
-- the billing-only half of the same idea. `startedAt` was dead from S0 — nothing ever read it.

DROP INDEX IF EXISTS "Subscription_active_idx";

ALTER TABLE "Subscription" DROP COLUMN "active";
ALTER TABLE "Subscription" DROP COLUMN "billingStartAt";
ALTER TABLE "Subscription" DROP COLUMN "startedAt";
