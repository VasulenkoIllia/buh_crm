-- A served period has TWO stories: why it started and why it ended. One `note` column meant that
-- pausing overwrote whatever the resume had recorded (found in the 2026-07-29 audit), so each gets
-- its own — plus who closed it, which was being dropped on the floor.

ALTER TABLE "SubscriptionPeriod" RENAME COLUMN "note" TO "startNote";
ALTER TABLE "SubscriptionPeriod" ADD COLUMN "endNote" TEXT;
ALTER TABLE "SubscriptionPeriod" ADD COLUMN "endedById" UUID;

ALTER TABLE "SubscriptionPeriod"
    ADD CONSTRAINT "SubscriptionPeriod_endedById_fkey"
    FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
