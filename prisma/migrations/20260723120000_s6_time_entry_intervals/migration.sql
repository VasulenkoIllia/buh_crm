-- S6 timer model (decision 2026-07-23): TimeEntry becomes an INTERVAL log.
-- Old shape: one accumulated row per task+user (seconds + runningSince).
-- New shape: one row per tracked interval — startedAt/stoppedAt/seconds/comment,
-- source timer|manual, createdById for admin-added manual entries. One running
-- interval per USER across all tasks (partial unique index below). Closing a
-- timer interval requires a comment (enforced in the service layer).

CREATE TYPE "TimeEntrySource" AS ENUM ('timer', 'manual');

ALTER TABLE "TimeEntry"
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "stoppedAt" TIMESTAMP(3),
  ADD COLUMN "comment" TEXT,
  ADD COLUMN "source" "TimeEntrySource" NOT NULL DEFAULT 'timer',
  ADD COLUMN "createdById" UUID;

-- legacy accumulated rows (pre-S6, if any): close them as manual entries
-- anchored on their own timestamps so no tracked time is lost
UPDATE "TimeEntry"
SET "startedAt" = "createdAt", "stoppedAt" = "updatedAt", "source" = 'manual'
WHERE "startedAt" IS NULL;

ALTER TABLE "TimeEntry" ALTER COLUMN "startedAt" SET NOT NULL;
ALTER TABLE "TimeEntry" ALTER COLUMN "seconds" DROP NOT NULL;
ALTER TABLE "TimeEntry" ALTER COLUMN "seconds" DROP DEFAULT;
ALTER TABLE "TimeEntry" DROP COLUMN "runningSince";

DROP INDEX "TimeEntry_taskId_userId_key";
CREATE INDEX "TimeEntry_taskId_idx" ON "TimeEntry"("taskId");
CREATE INDEX "TimeEntry_userId_idx" ON "TimeEntry"("userId");

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- one running timer per user (not representable in Prisma schema — keep in sync manually)
CREATE UNIQUE INDEX "TimeEntry_one_running_per_user" ON "TimeEntry"("userId") WHERE "stoppedAt" IS NULL;
