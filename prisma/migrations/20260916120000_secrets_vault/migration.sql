-- S18 stage A (secrets.md §13, §14, §20.2): the vault. Three places, eight templates, the Trash.
--
-- Additive, and it moves the secrets the firm already has: two enums, three values on the journal's
-- enum, ten nullable-or-defaulted columns, and `clientId` made nullable on both tables. Nothing is
-- re-encrypted and no row is copied, so every existing entry stays exactly where it was and still
-- opens: it becomes a FREE-FORM secret in its client's list, which is what the defaults say.
--
-- Prisma's half comes first. What `prisma migrate diff` cannot see is hand-written after it and
-- guarded by server/schema-invariants.test.ts: the backfill of `searchText` and the two CHECKs.

-- CreateEnum
CREATE TYPE "SecretSpace" AS ENUM ('personal', 'company', 'client');

-- CreateEnum
CREATE TYPE "SecretTemplate" AS ENUM ('free_form', 'login', 'tax_account', 'ip_pin', 'bank', 'id_document', 'device', 'payment_card');

-- AlterEnum
-- Three values in one migration, which PostgreSQL has allowed inside a transaction since 12. None
-- of them is USED below, which is the rule that would make it fail.
ALTER TYPE "SecretAuditAction" ADD VALUE 'moved';
ALTER TYPE "SecretAuditAction" ADD VALUE 'restored';
ALTER TYPE "SecretAuditAction" ADD VALUE 'purged';

-- AlterTable
ALTER TABLE "ClientSecret" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" UUID,
ADD COLUMN     "fields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "movedFromName" TEXT,
ADD COLUMN     "ownerId" UUID,
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "space" "SecretSpace" NOT NULL DEFAULT 'client',
ADD COLUMN     "template" "SecretTemplate" NOT NULL DEFAULT 'free_form',
ADD COLUMN     "trashBatchId" UUID,
ADD COLUMN     "updatedById" UUID,
ALTER COLUMN "clientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SecretAuditLog" ALTER COLUMN "clientId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ClientSecret_space_clientId_idx" ON "ClientSecret"("space", "clientId");

-- CreateIndex
CREATE INDEX "ClientSecret_ownerId_idx" ON "ClientSecret"("ownerId");

-- CreateIndex
CREATE INDEX "ClientSecret_trashBatchId_idx" ON "ClientSecret"("trashBatchId");

-- AddForeignKey
ALTER TABLE "ClientSecret" ADD CONSTRAINT "ClientSecret_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSecret" ADD CONSTRAINT "ClientSecret_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSecret" ADD CONSTRAINT "ClientSecret_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The hand-written half.

-- The secrets the firm already has become searchable by what is open about them: their title and
-- their description. A secret field is never in here, and this is the only pass over the old rows.
UPDATE "ClientSecret"
SET "searchText" = lower(trim(coalesce(label, '') || ' ' || coalesce(description, '')));

-- A place is a value, and exactly one of the two columns belongs to it (secrets.md §4.1). Without
-- this, a bad write leaves a secret in a place no screen shows and no reader can see.
ALTER TABLE "ClientSecret" ADD CONSTRAINT "Secret_place_matches_space" CHECK (
  (space = 'personal' AND "ownerId" IS NOT NULL AND "clientId" IS NULL)
  OR (space = 'company' AND "ownerId" IS NULL AND "clientId" IS NULL)
  OR (space = 'client' AND "ownerId" IS NULL AND "clientId" IS NOT NULL)
);

-- A delete is one gesture: who did it, when, and the batch Undo and the Trash restore together
-- (secrets.md §9). Two of the three set is a row the Trash can show but nobody can restore.
ALTER TABLE "ClientSecret" ADD CONSTRAINT "Secret_trash_is_a_gesture" CHECK (
  ("deletedAt" IS NULL AND "deletedById" IS NULL AND "trashBatchId" IS NULL)
  OR ("deletedAt" IS NOT NULL AND "deletedById" IS NOT NULL AND "trashBatchId" IS NOT NULL)
);
