-- S18.1 stage A (secrets.md §21): a file attached to a free-form secret.
--
-- Additive: one nullable column on "File", its index and foreign key, and three values on the
-- journal's enum. No row changes. The bytes of such a file are stored and sealed exactly as every
-- other file's (core/files.ts: its own key, sealed with SECRETS_KEY); only the row says whose it is.
--
-- Prisma's half comes first. What `prisma migrate diff` cannot see is hand-written after it and
-- guarded by server/schema-invariants.test.ts: the CHECK that keeps such a file out of everything
-- else a file can belong to.

-- AlterEnum
-- Three values in one migration, which PostgreSQL has allowed inside a transaction since 12. None
-- of them is USED below, which is the rule that would make it fail.
ALTER TYPE "SecretAuditAction" ADD VALUE 'file_added';
ALTER TYPE "SecretAuditAction" ADD VALUE 'file_opened';
ALTER TYPE "SecretAuditAction" ADD VALUE 'file_removed';

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "secretId" UUID;

-- CreateIndex
CREATE INDEX "File_secretId_idx" ON "File"("secretId");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "ClientSecret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A secret's file is the secret's alone (secrets.md §21): not in the library, not on a task, not in
-- a client's Files, and never in the Files Trash, whose purge would delete its bytes behind the
-- vault's back. It goes to the Trash with its secret, whose columns say so.
ALTER TABLE "File" ADD CONSTRAINT "File_secret_stands_alone" CHECK (
  "secretId" IS NULL
  OR ("scope" IS NULL AND "taskId" IS NULL AND "clientId" IS NULL AND "deletedAt" IS NULL)
);
