-- A colleague deleted for good (2026-11-04, users.md §2): blocked first, then out of Team, their
-- address free for a new invite, their row kept for the payments, comments, files, hours and
-- journal rows of what they did.
--
-- Additive: one enum value, catalog-only, no row rewritten. Nothing uses the value in this
-- migration (Postgres refuses a new value before its transaction commits), and IF NOT EXISTS lets a
-- run whose record was lost go again. A value cannot be dropped: rolling back is the deploy's dump,
-- or, keeping the data, `UPDATE "User" SET status = 'blocked' WHERE status = 'deleted'` before the
-- older build starts (deployment.md).
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'deleted';
