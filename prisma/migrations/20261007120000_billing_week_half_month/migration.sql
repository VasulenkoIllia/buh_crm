-- Two more rhythms a subscription can bill on (owner, 2026-10-07): every week, and twice a month.
--
-- Additive and catalog-only: ADD VALUE rewrites no table and holds no lock beyond the catalog's own
-- update, whatever the size of "Subscription". No row changes; every existing subscription keeps
-- month, quarter or year.
--
-- It cannot be undone by a migration: PostgreSQL has no DROP VALUE for an enum. Rolling the CODE
-- back is only safe while no subscription uses the new values, because the code before this one
-- does not know them (deployment.md, "Rolling back a release that added billing rhythms").
-- IF NOT EXISTS because a deploy that fails partway and is finished by hand re-runs SQL, as in
-- 20260908180000_recipient_role_gate.
ALTER TYPE "BillingPeriod" ADD VALUE IF NOT EXISTS 'week';
ALTER TYPE "BillingPeriod" ADD VALUE IF NOT EXISTS 'half_month';
