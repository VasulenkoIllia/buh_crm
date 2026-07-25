-- Track who created a task (2026-07-25): manual tasks record the actor; scheduler-generated
-- tasks stay null ("Auto"). Additive + FK SetNull (a deleted user leaves their tasks intact).

ALTER TABLE "Task" ADD COLUMN "createdById" UUID;

ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");
