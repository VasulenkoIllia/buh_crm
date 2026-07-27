-- "Regular" is no longer something anyone ticks (user, 2026-07-26).
--
--   A client is REGULAR exactly while they hold an active subscription-type service, and
--   one-time otherwise. Adding such a service makes them regular; stopping it makes them
--   one-time again — automatically, with no state of its own to drift.
--
-- `regularOverride` existed so the flag could be set by hand before subscriptions were built
-- (S4 shipped ahead of the Catalog). Subscriptions exist now, so the override is not a feature —
-- it is a second source of truth that can disagree with the services the client actually has.
ALTER TABLE "Client" DROP COLUMN "regularOverride";
