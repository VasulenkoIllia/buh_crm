-- S8 Calendar. `Meeting` and `MeetingParticipant` were modelled back in the design phase but never
-- built against; two columns were missing once the behaviour was decided (user, 2026-08-04).

-- who booked it
ALTER TABLE "Meeting" ADD COLUMN "createdById" UUID;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- the task opened alongside the meeting, when one was asked for. SetNull rather than Cascade:
-- deleting the task must not take the record of the meeting with it.
ALTER TABLE "Meeting" ADD COLUMN "taskId" UUID;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Meeting_taskId_key" ON "Meeting"("taskId");

-- the calendar's read: live meetings inside a window, in order
CREATE INDEX "Meeting_cancelledAt_startAt_idx" ON "Meeting"("cancelledAt", "startAt");

-- the conflict check asks "which meetings is THIS PERSON in". The primary key is ordered
-- (meetingId, userId), so it cannot answer that without scanning the table.
CREATE INDEX "MeetingParticipant_userId_idx" ON "MeetingParticipant"("userId");
