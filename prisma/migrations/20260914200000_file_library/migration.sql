-- S17 stage B (files.md §4, §14.2, §15.1): the library. Folders, a place on every filed file, and
-- the Trash's columns.
--
-- Additive: two enums, one table, nullable columns on "File". No bytes move, no "File".path
-- changes, and no folder is created. Prisma's half comes first. What it cannot say is hand-written
-- after it and guarded by server/schema-invariants.test.ts, because `prisma migrate diff` does not
-- see it: the trigger that copies a place out of `scope`, the CHECKs, the backfill and the partial
-- indexes.

-- CreateEnum
CREATE TYPE "FileSpace" AS ENUM ('personal', 'company', 'client');

-- CreateEnum
CREATE TYPE "ClientZone" AS ENUM ('internal', 'shared', 'from_client');

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" UUID,
ADD COLUMN     "folderId" UUID,
ADD COLUMN     "ownerId" UUID,
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "space" "FileSpace",
ADD COLUMN     "trashBatchId" UUID,
ADD COLUMN     "updatedAt" TIMESTAMP(3),
ADD COLUMN     "zone" "ClientZone";

-- CreateTable
CREATE TABLE "Folder" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "space" "FileSpace",
    "ownerId" UUID,
    "clientId" UUID,
    "zone" "ClientZone",
    "parentId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" UUID,
    "trashBatchId" UUID,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Folder_parentId_scope_idx" ON "Folder"("parentId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_id_scope_key" ON "Folder"("id", "scope");

-- CreateIndex
CREATE INDEX "File_folderId_scope_idx" ON "File"("folderId", "scope");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_folderId_scope_fkey" FOREIGN KEY ("folderId", "scope") REFERENCES "Folder"("id", "scope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_scope_fkey" FOREIGN KEY ("parentId", "scope") REFERENCES "Folder"("id", "scope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Hand-written: invisible to `prisma migrate diff`, guarded by schema-invariants.test.ts ─────

-- The copies of a place (files.md §14.2). One function serves both tables, since each has the four
-- columns. It runs BEFORE the row is written, so the CHECKs below see the copies. It also runs on
-- every row an ON UPDATE CASCADE rewrites: a folder moved to another zone or client changes its own
-- scope, the composite keys carry the new scope to every row below it, trashed ones included, and
-- this fixes each one's copies. Without it the first child would fail the CHECKs, which cannot be
-- deferred.
CREATE FUNCTION "library_place_from_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  part text[];
BEGIN
  part := string_to_array(NEW."scope", ':');
  IF NEW."scope" = 'company' THEN
    NEW."space" := 'company';
    NEW."ownerId" := NULL;
    NEW."clientId" := NULL;
    NEW."zone" := NULL;
  ELSIF part[1] = 'personal' AND cardinality(part) = 2 THEN
    NEW."space" := 'personal';
    NEW."ownerId" := part[2]::uuid;
    NEW."clientId" := NULL;
    NEW."zone" := NULL;
  ELSIF part[1] = 'client' AND cardinality(part) = 3 THEN
    NEW."space" := 'client';
    NEW."ownerId" := NULL;
    NEW."clientId" := part[2]::uuid;
    NEW."zone" := part[3]::"ClientZone";
  ELSE
    RAISE EXCEPTION 'not a place in the library: %', NEW."scope" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Folder_place_from_scope"
  BEFORE INSERT OR UPDATE OF "scope" ON "Folder"
  FOR EACH ROW EXECUTE FUNCTION "library_place_from_scope"();

-- WHEN: an attachment that is not filed keeps its task's client in "clientId".
CREATE TRIGGER "File_place_from_scope"
  BEFORE INSERT OR UPDATE OF "scope" ON "File"
  FOR EACH ROW WHEN (NEW."scope" IS NOT NULL) EXECUTE FUNCTION "library_place_from_scope"();

-- A place is its scope and nothing else. COALESCE, because a CHECK that comes out NULL passes.
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_place_matches_scope" CHECK (COALESCE(
     ("space" = 'company' AND "ownerId" IS NULL AND "clientId" IS NULL AND "zone" IS NULL
      AND "scope" = 'company')
  OR ("space" = 'personal' AND "ownerId" IS NOT NULL AND "clientId" IS NULL AND "zone" IS NULL
      AND "scope" = 'personal:' || "ownerId"::text)
  OR ("space" = 'client' AND "ownerId" IS NULL AND "clientId" IS NOT NULL AND "zone" IS NOT NULL
      AND "scope" = 'client:' || "clientId"::text || ':' || "zone"::text),
  false));

-- The same on File, plus a row outside the library, which has no place at all. A foreign key is not
-- checked while one of its columns is null (MATCH SIMPLE), so without the first branch's
-- `"folderId" IS NULL` a row could claim a folder while standing outside the library.
ALTER TABLE "File" ADD CONSTRAINT "File_place_matches_scope" CHECK (COALESCE(
     ("scope" IS NULL AND "space" IS NULL AND "ownerId" IS NULL AND "zone" IS NULL
      AND "folderId" IS NULL)
  OR ("space" = 'company' AND "ownerId" IS NULL AND "clientId" IS NULL AND "zone" IS NULL
      AND "scope" = 'company')
  OR ("space" = 'personal' AND "ownerId" IS NOT NULL AND "clientId" IS NULL AND "zone" IS NULL
      AND "scope" = 'personal:' || "ownerId"::text)
  OR ("space" = 'client' AND "ownerId" IS NULL AND "clientId" IS NOT NULL AND "zone" IS NOT NULL
      AND "scope" = 'client:' || "clientId"::text || ':' || "zone"::text),
  false));

-- A file on a task is never in anybody's My files (files.md §5.5). A client task's file sits in its
-- client's zones, and an internal task's (no client, no lead) in Company (owner, 2026-09-14). Which
-- of the two is the service's rule, since a CHECK cannot read the task. Moving a file anywhere else
-- detaches it from its task first, in the same transaction.
ALTER TABLE "File" ADD CONSTRAINT "File_attachment_not_personal"
  CHECK ("taskId" IS NULL OR "space" IS NULL OR "space" <> 'personal');

-- A trashed item always belongs to a gesture, and restoring clears both (files.md §9).
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_trash_is_a_gesture"
  CHECK (("deletedAt" IS NULL) = ("trashBatchId" IS NULL));
ALTER TABLE "File" ADD CONSTRAINT "File_trash_is_a_gesture"
  CHECK (("deletedAt" IS NULL) = ("trashBatchId" IS NULL));

-- The backfill (files.md §15.1), as a function so that a test can run it again over rows of its
-- own (`only_ids`); the migration runs it once, over everything.
--   • A file uploaded on a client card, and a file on a converted lead's task, go to that client's
--     Internal, at its root. The lead's file keeps its task, and takes the client from its place.
--   • Where two would share a name there, the younger becomes `name (2).ext`: card files first,
--     then the lead's, oldest first within each. Today nothing stops a client holding two W-2.pdf,
--     and without this the unique index below would refuse to build.
--   • A file on a client's task stays an attachment. Avatars and logos never enter the library.
--   • It writes no activity rows: SQL cannot call record(), and the deploy's summary says so.
CREATE FUNCTION "library_backfill"(only_ids uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  target text;
  dot int;
  base text;
  ext text;
  candidate text;
  n int;
  filed int := 0;
BEGIN
  FOR r IN
    SELECT f."id", f."name", c."clientId"
    FROM "File" f
    CROSS JOIN LATERAL (
      SELECT f."clientId", 1 AS "rank"
      WHERE f."taskId" IS NULL AND f."clientId" IS NOT NULL
      UNION ALL
      SELECT l."convertedClientId", 2
      FROM "Task" t JOIN "Lead" l ON l."id" = t."leadId"
      WHERE t."id" = f."taskId" AND t."clientId" IS NULL AND l."convertedClientId" IS NOT NULL
    ) c
    WHERE f."scope" IS NULL
      AND (only_ids IS NULL OR f."id" = ANY (only_ids))
      AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."avatarFileId" = f."id")
      AND NOT EXISTS (
        SELECT 1 FROM "FirmProfile" p WHERE p."logoFileId" = f."id" OR p."mailLogoFileId" = f."id"
      )
    ORDER BY c."clientId", c."rank", f."createdAt", f."id"
  LOOP
    target := 'client:' || r."clientId"::text || ':internal';
    dot := length(r."name") - strpos(reverse(r."name"), '.') + 1;
    IF strpos(r."name", '.') = 0 OR dot <= 1 THEN
      base := r."name";
      ext := '';
    ELSE
      base := left(r."name", dot - 1);
      ext := substr(r."name", dot);
    END IF;
    candidate := r."name";
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "File" x
      WHERE x."scope" = target AND x."folderId" IS NULL AND x."deletedAt" IS NULL
        AND lower(x."name") = lower(candidate)
    ) LOOP
      n := n + 1;
      candidate := base || ' (' || n || ')' || ext;
    END LOOP;
    UPDATE "File" SET "scope" = target, "name" = candidate WHERE "id" = r."id";
    filed := filed + 1;
  END LOOP;
  RETURN filed;
END
$$;

SELECT "library_backfill"();

-- One live name per folder, case-insensitive (files.md §6.3). NULLS NOT DISTINCT makes the root, a
-- null parent, one folder like any other. Built after the backfill, which settles today's
-- duplicates first.
CREATE UNIQUE INDEX "Folder_live_name" ON "Folder" ("scope", "parentId", lower("name"))
  NULLS NOT DISTINCT WHERE "deletedAt" IS NULL;
-- Unfiled attachments stay outside it: two tasks may each hold a scan.pdf.
CREATE UNIQUE INDEX "File_live_name" ON "File" ("scope", "folderId", lower("name"))
  NULLS NOT DISTINCT WHERE "scope" IS NOT NULL AND "deletedAt" IS NULL;

-- The Trash's list, its restores and the nightly purge.
CREATE INDEX "File_trashed" ON "File" ("deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE INDEX "Folder_trashed" ON "Folder" ("deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE INDEX "File_trash_batch" ON "File" ("trashBatchId") WHERE "trashBatchId" IS NOT NULL;
CREATE INDEX "Folder_trash_batch" ON "Folder" ("trashBatchId") WHERE "trashBatchId" IS NOT NULL;
