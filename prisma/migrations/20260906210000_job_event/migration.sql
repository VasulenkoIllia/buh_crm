-- A run that DID something, or failed trying. Not every run.
--
-- `JobHealth` answers "is it working?"; this answers "what has been happening?". The reminder job
-- wakes 1 440 times a day with nothing to do, and recording that would bury the handful of lines a
-- person wants under half a million that say "nothing" — so `recordJobRun` writes here only when
-- the run failed, skipped work, or did something. A quiet system writes almost nothing.
--
-- Two indexes because the screen asks two questions: one job's history, and everything's history.
CREATE TABLE "JobEvent" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "note" TEXT,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobEvent_job_at_idx" ON "JobEvent"("job", "at");
CREATE INDEX "JobEvent_at_idx" ON "JobEvent"("at");
