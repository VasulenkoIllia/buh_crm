-- One row per scheduled job, holding its LAST outcome only.
--
--   name       -> the job's own name from `registerJob`. That name is already the identity the
--                 scheduler, the log and shared/system-jobs.ts agree on; a surrogate id would be a
--                 fourth thing to keep in step.
--   failStreak -> consecutive throwing runs. One blip is not a broken job, and without a streak
--                 the screen cannot tell "failed once at 3am" from "has been dead for a week".
--   unreported -> skipped items nobody has been told about yet. The notification sweep drains this
--                 and raises `ops_sweep_failed`. It replaces an in-memory register, which lost the
--                 alert whenever the process restarted before the morning run.
--
-- No history table on purpose: the question is "is the background work happening?", which needs
-- the last run and not every run. Nine rows, bounded, and therefore no retention rule of its own.
CREATE TABLE "JobHealth" (
    "name" TEXT NOT NULL,
    "lastOkAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "failStreak" INTEGER NOT NULL DEFAULT 0,
    "lastSkipped" INTEGER NOT NULL DEFAULT 0,
    "lastDurationMs" INTEGER,
    "lastNote" TEXT,
    "lastError" TEXT,
    "unreported" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobHealth_pkey" PRIMARY KEY ("name")
);
