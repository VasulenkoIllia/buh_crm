-- When a task was finished. `done` is a flag with no timestamp, so the Done view had no way to
-- show "the last 7 days" — it listed every task ever completed and grew forever.
-- Also the column S12's "weekly closed tasks" report needs.
ALTER TABLE "Task" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill: for work already marked done, its last touch is the best evidence we have of when
-- that happened (nothing else was recorded). Only rows that are done — reopening clears it.
UPDATE "Task" SET "completedAt" = "updatedAt" WHERE "done" = true;

-- the Done view asks "done, newest first, since <date>"
CREATE INDEX "Task_completedAt_idx" ON "Task"("completedAt");
