-- A letterhead logo of its own, separate from the sidebar one.
--
-- The two have different jobs: the sidebar mark is small, sits on a dark panel and can be any
-- shape; the letterhead is 168px wide on white and needs a tight raster crop at the lockup's own
-- aspect ratio. One file could serve both only by being wrong for one of them — and a firm that
-- changes its app logo should not silently change what its clients receive.

ALTER TABLE "FirmProfile" ADD COLUMN "mailLogoFileId" UUID;

CREATE UNIQUE INDEX "FirmProfile_mailLogoFileId_key" ON "FirmProfile"("mailLogoFileId");

ALTER TABLE "FirmProfile" ADD CONSTRAINT "FirmProfile_mailLogoFileId_fkey"
  FOREIGN KEY ("mailLogoFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
