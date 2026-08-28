-- Files attached to a task.
--
-- The row ALSO carries `clientId` when the task has a client, and that is the whole mechanism
-- behind "a file uploaded on a job appears on the client's card": one row with two pointers rather
-- than a copy. Nothing to keep in step, no second set of bytes, and one file to delete.
--
-- A task's client cannot be changed after it is created, so a file filed under a client stays
-- filed correctly for good. A task on a LEAD has no client and its files stay with the task.
--
-- SET NULL, not CASCADE: a document filed under the client has to survive its task. Tasks are
-- archived rather than deleted here, so that is a statement of intent more than a live path.
ALTER TABLE "File" ADD COLUMN "taskId" UUID;
CREATE INDEX "File_taskId_idx" ON "File"("taskId");
ALTER TABLE "File" ADD CONSTRAINT "File_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
