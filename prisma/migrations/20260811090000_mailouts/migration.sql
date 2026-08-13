-- S10 Mailouts — client mailouts with templates, a delivery log and unsubscribe.
--
-- `Campaign` and `Reminder` are DROPPED. They were design-phase stubs from the original schema
-- sketch: no service, route or UI ever wrote to them, and all three tables were verified empty in
-- dev before this migration was written. Scheduled campaigns are a later round and will be
-- designed against the shape the send path actually turned out to need, not the sketch.
--
-- `EmailTemplate.variables` (Json) goes the same way: the merge-variable catalog is a constant in
-- shared/mailouts.ts, so storing a per-template copy could only ever drift from the renderer that
-- actually resolves them.


-- CreateEnum
CREATE TYPE "MailoutKind" AS ENUM ('commercial', 'transactional');

-- CreateEnum
CREATE TYPE "MailoutStatus" AS ENUM ('queued', 'sent', 'failed', 'skipped');

-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_templateId_fkey";

-- DropForeignKey
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_clientId_fkey";

-- DropForeignKey
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_templateId_fkey";

-- AlterTable
ALTER TABLE "EmailTemplate" DROP COLUMN "variables",
ADD COLUMN     "heading" TEXT,
ADD COLUMN     "kind" "MailoutKind" NOT NULL DEFAULT 'commercial';

-- AlterTable
ALTER TABLE "FirmProfile" ADD COLUMN     "mailoutFromEmail" TEXT,
ADD COLUMN     "mailoutFromName" TEXT,
ADD COLUMN     "mailoutReplyTo" TEXT,
ADD COLUMN     "mailoutSignature" TEXT,
ADD COLUMN     "mailoutSmtpHost" TEXT,
ADD COLUMN     "mailoutSmtpKeyVersion" INTEGER,
ADD COLUMN     "mailoutSmtpPass" BYTEA,
ADD COLUMN     "mailoutSmtpPassIv" BYTEA,
ADD COLUMN     "mailoutSmtpPassTag" BYTEA,
ADD COLUMN     "mailoutSmtpPort" INTEGER,
ADD COLUMN     "mailoutSmtpSecure" BOOLEAN,
ADD COLUMN     "mailoutSmtpUser" TEXT,
ADD COLUMN     "postalAddress" TEXT;

-- DropTable
DROP TABLE "Campaign";

-- DropTable
DROP TABLE "Reminder";

-- DropEnum
DROP TYPE "CampaignAudience";

-- DropEnum
DROP TYPE "CampaignSchedule";

-- CreateTable
CREATE TABLE "Mailout" (
    "id" UUID NOT NULL,
    "templateId" UUID,
    "subject" TEXT NOT NULL,
    "heading" TEXT,
    "body" TEXT NOT NULL,
    "kind" "MailoutKind" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mailout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailoutRecipient" (
    "id" UUID NOT NULL,
    "mailoutId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "MailoutStatus" NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailoutRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMailPreference" (
    "clientId" UUID NOT NULL,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribedById" UUID,
    "token" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMailPreference_pkey" PRIMARY KEY ("clientId")
);

-- CreateIndex
CREATE INDEX "Mailout_createdAt_idx" ON "Mailout"("createdAt");

-- CreateIndex
CREATE INDEX "MailoutRecipient_clientId_createdAt_idx" ON "MailoutRecipient"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailoutRecipient_mailoutId_clientId_key" ON "MailoutRecipient"("mailoutId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMailPreference_token_key" ON "ClientMailPreference"("token");

-- AddForeignKey
ALTER TABLE "Mailout" ADD CONSTRAINT "Mailout_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailout" ADD CONSTRAINT "Mailout_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailoutRecipient" ADD CONSTRAINT "MailoutRecipient_mailoutId_fkey" FOREIGN KEY ("mailoutId") REFERENCES "Mailout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailoutRecipient" ADD CONSTRAINT "MailoutRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMailPreference" ADD CONSTRAINT "ClientMailPreference_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMailPreference" ADD CONSTRAINT "ClientMailPreference_unsubscribedById_fkey" FOREIGN KEY ("unsubscribedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seed the letter signature with the firm's own block (user, 2026-08-11). `postalAddress` is left
-- NULL deliberately: the service refuses to send COMMERCIAL mail until the firm fills it in, which
-- is how CAN-SPAM's physical-address requirement is enforced rather than merely documented.
UPDATE "FirmProfile" SET
  "mailoutSignature" = E'Maryna Onyshchenko, EA, MBA\nAccountant | Tax & Accounting Services\nILLION — tax & accounting\nillion.tax\ninfo@illion.tax\n+1 (704) 726-6994\nTelegram / WhatsApp: +1 (704) 726-6994',
  "mailoutFromName"  = COALESCE("mailoutFromName", 'ILLION Tax & Accounting')
WHERE "id" = 1 AND "mailoutSignature" IS NULL;
