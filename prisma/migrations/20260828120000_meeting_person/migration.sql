-- Who at the client a meeting is with.
--
-- An OPTIONAL refinement of `clientId`, never a replacement for it. The meeting still belongs to
-- the client, so every rollup that counts a client's meetings keeps working unchanged, and a
-- contact who leaves the company takes nothing with them: ON DELETE SET NULL drops the contact
-- and leaves the meeting, its history and its task exactly where they were.
--
-- Nullable with no back-fill, because "no particular contact" is the honest answer for every
-- meeting booked before today — and stays a legitimate answer afterwards.
ALTER TABLE "Meeting" ADD COLUMN "personId" UUID;

ALTER TABLE "Meeting"
  ADD CONSTRAINT "Meeting_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "ClientPerson"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- without it, deleting one contact seq-scans Meeting to find the rows to null out
CREATE INDEX "Meeting_personId_idx" ON "Meeting"("personId");
