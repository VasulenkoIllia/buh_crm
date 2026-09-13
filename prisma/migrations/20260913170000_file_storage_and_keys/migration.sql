-- S17 stage A (files.md §14.1, §14.4): where a file's bytes are, and the key they are sealed with.
--
-- Additive. Every existing row is a local file stored before encryption, which is exactly what the
-- defaults say, so nothing is backfilled. A constant default rewrites no rows on PostgreSQL 11+.
CREATE TYPE "FileStorage" AS ENUM ('local', 's3');

ALTER TABLE "File"
  ADD COLUMN "storage" "FileStorage" NOT NULL DEFAULT 'local',
  ADD COLUMN "wrappedKey" BYTEA,
  ADD COLUMN "keyVersion" INTEGER;

-- A wrapped key is useless without the version of the key that sealed it, and a version alone names
-- nothing.
ALTER TABLE "File" ADD CONSTRAINT "File_key_with_version"
  CHECK (("wrappedKey" IS NULL) = ("keyVersion" IS NULL));

-- Nothing reaches the bucket unencrypted: plaintext exists only as a legacy local file.
ALTER TABLE "File" ADD CONSTRAINT "File_bucket_is_encrypted"
  CHECK ("storage" = 'local' OR "wrappedKey" IS NOT NULL);
