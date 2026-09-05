-- S9.1 — the chime, as a THIRD CHANNEL rather than a setting of its own.
--
-- Purely additive: three columns with defaults and one enum value. Nothing is rewritten, nothing
-- is backfilled, and every existing row keeps working — `sound` defaults to false, so no
-- notification already in somebody's tray suddenly acquires a noise.
--
-- `ALTER TYPE ... ADD VALUE` inside a transaction is allowed from PostgreSQL 12 (we run 16), with
-- one rule: the new value may not be USED in the same transaction that adds it. This migration
-- only adds it — the `sound` columns are BOOLEAN, not the enum — so that rule is not touched. If a
-- later migration ever needs to write `'sound'::"NotificationChannel"`, it must be a separate one.

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'sound';

-- AlterTable: what the notification was FOR, beside `emailedAt`. Decided at write time by the
-- same precedence as the other channels, so the tray hands the browser a boolean instead of
-- re-deriving policy + preferences on every 60-second poll for every user.
ALTER TABLE "Notification" ADD COLUMN     "sound" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: `sound` = allowed at all (an office is a shared room, so the firm can silence the
-- chime for everybody); `defaultSound` = what somebody with no preference row gets.
ALTER TABLE "NotificationPolicy" ADD COLUMN     "defaultSound" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sound" BOOLEAN NOT NULL DEFAULT true;

-- Backfill, and the reason it MUST be here rather than in `ensureBaseData`.
--
-- The seeder deliberately does not overwrite an existing policy row's defaults: those belong to
-- the firm from the moment they are first written (§9's rollout is "ship all sixteen on, then
-- silence what proves noisy", and a deploy must not undo that). The consequence is that a NEW
-- FIELD added to the registry reaches new installs only — every database seeded before this
-- migration would keep the column default, `false`, for all sixteen triggers, and the chime would
-- silently never ring on exactly the firms that have been running longest.
--
-- Bringing existing rows to the state a fresh install would have IS what a migration is for. The
-- four listed here are the ones the registry marks `defaultSound: true`: the triggers where a
-- PERSON just did something that concerns you. Every sweep stays silent, because they all land at
-- 07:00 together.
--
-- `WHERE "defaultSound" = false` is not redundant: it makes this statement safe to re-run, and it
-- means a firm that has already set one of these by hand is left alone.
UPDATE "NotificationPolicy"
SET "defaultSound" = true
WHERE trigger IN ('task_assigned', 'task_comment', 'meeting_invited', 'meeting_moved')
  AND "defaultSound" = false;
