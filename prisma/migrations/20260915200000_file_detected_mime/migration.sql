-- Stage C (files.md §12.2, §14.3): what a file really is, read from its bytes at upload with
-- file-type, or by scripts/detect-file-types.ts for the files stored before. It decides what may
-- open in the CRM and what a download says it is; the browser's claim at upload (`mime`) decides
-- nothing any more. Null: nothing the CRM shows inline, so a download.
--
-- Additive and nullable: no rewrite of the table, no lock beyond the moment of the ALTER, and the
-- old code simply never reads it.
ALTER TABLE "File" ADD COLUMN "detectedMime" TEXT;
