-- Service categories are DERIVED, not curated (user, 2026-07-26).
--
--   A client's categories are simply the services of their ACTIVE subscriptions. Adding a service
--   puts its chip on the client; stopping it takes the chip away. There is nothing to tick.
--
-- `ClientServiceCategory` was a hand-maintained list from S3, when it was the only way to say
-- "this client does bookkeeping" — subscriptions did not exist yet. Once they did, the list became
-- a second source of truth that drifts from the services the client actually holds. Same reasoning
-- as `Client.regularOverride`, dropped in the migration before this one.
DROP TABLE "ClientServiceCategory";
