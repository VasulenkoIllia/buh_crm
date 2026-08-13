-- Campaigns: a template, a list, and a date it goes out on — possibly again and again.
--
-- The Sent log stays the single record of what actually left the building: a campaign does not
-- send, it CREATES a Mailout when its date comes round. Whether a person pressed Send or a date
-- arrived is one nullable column apart, and every screen that reads the log keeps working.

CREATE TYPE "CampaignRhythm" AS ENUM ('once', 'monthly', 'quarterly', 'yearly');
CREATE TYPE "CampaignStatus" AS ENUM ('scheduled', 'stopped', 'finished');

CREATE TABLE "Campaign" (
  "id"              UUID           PRIMARY KEY,
  "name"            TEXT           NOT NULL,
  "templateId"      UUID           NOT NULL,
  "senderAccountId" UUID,
  "kind"            "MailoutKind"  NOT NULL DEFAULT 'commercial',
  "rhythm"          "CampaignRhythm" NOT NULL DEFAULT 'once',
  "startsOn"        DATE           NOT NULL,
  "sendAt"          TEXT           NOT NULL DEFAULT '09:00',
  "endsOn"          DATE,
  "status"          "CampaignStatus" NOT NULL DEFAULT 'scheduled',
  "nextRunOn"       DATE,
  "lastRunAt"       TIMESTAMP(3),
  "createdById"     UUID,
  "createdAt"       TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)   NOT NULL
);

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_templateId_fkey" FOREIGN KEY ("templateId")
    REFERENCES "EmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Campaign_senderAccountId_fkey" FOREIGN KEY ("senderAccountId")
    REFERENCES "MailSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- the sweep's only question: what is due today
CREATE INDEX "Campaign_status_nextRunOn_idx" ON "Campaign"("status", "nextRunOn");

CREATE TABLE "CampaignRecipient" (
  "id"         UUID         PRIMARY KEY,
  "campaignId" UUID         NOT NULL,
  "clientId"   UUID         NOT NULL,
  "companyId"  UUID,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CASCADE throughout, unlike the sent letters' RESTRICT: this is a plan, not a record. A company
-- merely queued up to be written to should drop off the list when it is deleted, not block it.
ALTER TABLE "CampaignRecipient"
  ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId")
    REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignRecipient_clientId_fkey" FOREIGN KEY ("clientId")
    REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignRecipient_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same two-index shape MailoutRecipient needs, for the same reason: Postgres treats every
-- NULL as distinct, so the three-column unique cannot stop the client's own address twice.
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_clientId_companyId_key"
  ON "CampaignRecipient"("campaignId", "clientId", "companyId");
CREATE UNIQUE INDEX "CampaignRecipient_one_client_row"
  ON "CampaignRecipient"("campaignId", "clientId") WHERE "companyId" IS NULL;
CREATE INDEX "CampaignRecipient_clientId_idx" ON "CampaignRecipient"("clientId");
CREATE INDEX "CampaignRecipient_companyId_idx" ON "CampaignRecipient"("companyId");

-- ── the run, and the occurrence it is for ────────────────────────────────────
ALTER TABLE "Mailout" ADD COLUMN "campaignId" UUID;
ALTER TABLE "Mailout" ADD COLUMN "periodKey" TEXT;

ALTER TABLE "Mailout" ADD CONSTRAINT "Mailout_campaignId_fkey" FOREIGN KEY ("campaignId")
  REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One run per occurrence, enforced here rather than by the sweep being careful: the sweep runs
-- daily AND on every boot, so a server down over a weekend would otherwise re-send twice.
-- Hand-pressed sends are all (NULL, NULL) and never collide, because NULLs are distinct.
CREATE UNIQUE INDEX "Mailout_campaignId_periodKey_key" ON "Mailout"("campaignId", "periodKey");

-- ── where an unsubscribe came from ───────────────────────────────────────────
-- The token belongs to the client, not to a letter, so a click alone cannot say which letter it
-- came from. The letter puts its own id in the link — a claim, checked server-side before it is
-- stored. SET NULL on delete: losing the provenance is better than losing the opt-out.
ALTER TABLE "ClientMailPreference" ADD COLUMN "unsubscribedFromMailoutId" UUID;
ALTER TABLE "ClientMailPreference"
  ADD CONSTRAINT "ClientMailPreference_unsubscribedFromMailoutId_fkey"
  FOREIGN KEY ("unsubscribedFromMailoutId") REFERENCES "Mailout"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
