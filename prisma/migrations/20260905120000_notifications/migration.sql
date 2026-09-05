-- S9 Notifications: the trigger registry made storable.
--
-- `Notification` has existed since 20260717165413_init and has NEVER been written to — no
-- `prisma.notification.*` call exists outside the generated client. That is what makes this
-- reshape free, and the freedom ends with the first production row.
--
-- The DELETE below is not bookkeeping: three of the statements after it (two NOT NULL columns and
-- one SET NOT NULL) fail outright on a table that turns out to have rows, and a migration that
-- fails halfway through a deploy leaves the server on old code with a fresh dump. On the empty
-- table it is documented to be, it costs nothing.
DELETE FROM "Notification";

-- CreateEnum
CREATE TYPE "RecipientRole" AS ENUM ('assignee', 'author', 'participant', 'mentioned', 'admin', 'custom', 'self', 'client_owner');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'email');

-- DropIndex
DROP INDEX "Notification_userId_read_idx";

-- AlterTable
--   kind  -> trigger : a category cannot be configured, and every screen here configures triggers
--   read  -> readAt  : a state with a WHEN is a timestamp in this schema (sentAt, completedAt)
--   reason           : which role put the row here, so "assignee but not participant" is sayable
--   emailedAt        : null = never mailed. Not a status enum, like Invoice.sentAt is not.
--   userId nullable  : the fifth actor column to become nullable, joining Payment.createdById,
--                      PaymentAuditLog.byUserId, TaskComment.authorId and File.uploadedById.
--                      A client-facing notification (portal, chat) has no User. One line now;
--                      a migration on a table with rows later.
--   dedupKey NOT NULL: the idempotency mechanism. `catchUp` re-runs each sweep in full on EVERY
--                      boot and a mail is sent only when this insert succeeds — and Postgres
--                      treats NULLs as distinct, so a nullable key would mail the whole firm on
--                      every restart.
ALTER TABLE "Notification" DROP COLUMN "kind",
DROP COLUMN "read",
ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "reason" "RecipientRole" NOT NULL,
ADD COLUMN     "trigger" TEXT NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "dedupKey" SET NOT NULL;

-- DropEnum
DROP TYPE "NotificationKind";

-- CreateTable
CREATE TABLE "NotificationPolicy" (
    "trigger" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "roles" "RecipientRole"[],
    "customUserIds" UUID[],
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "defaultInApp" BOOLEAN NOT NULL DEFAULT true,
    "defaultEmail" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPolicy_pkey" PRIMARY KEY ("trigger")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","trigger","channel")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
