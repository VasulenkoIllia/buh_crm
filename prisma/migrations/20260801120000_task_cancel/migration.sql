-- A task can be CANCELLED: raised by mistake, or agreed and then called off. Never deleted —
-- the row is what stops the nightly sweep re-creating a generated task it already made, and it
-- is what the Archive will show later (user, 2026-08-01). Mirrors Invoice.cancelledAt exactly.
ALTER TABLE "Task" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "cancelledById" UUID;

ALTER TABLE "Task" ADD CONSTRAINT "Task_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- the board asks "open work" on every load: not done, not cancelled, not archived
CREATE INDEX "Task_cancelledAt_idx" ON "Task"("cancelledAt");
