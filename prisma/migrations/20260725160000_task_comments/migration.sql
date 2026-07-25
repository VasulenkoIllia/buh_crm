-- Free-text notes on a task (for self or colleagues), separate from time-entry comments.
CREATE TABLE "TaskComment" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "taskId"    UUID NOT NULL,
  "authorId"  UUID NOT NULL,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TaskComment_taskId_idx" ON "TaskComment"("taskId");
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
