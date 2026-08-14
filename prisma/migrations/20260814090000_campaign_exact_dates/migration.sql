-- A campaign can fire on a hand-picked list of days instead of a rhythm.
--
-- An accounting firm's calendar is 15 March, 15 April, 15 September — deadlines, not a rhythm.
-- Bending them into "every quarter" would be a lie the sweep then acts on, so the days are stored
-- as they were typed.

ALTER TYPE "CampaignRhythm" ADD VALUE IF NOT EXISTS 'dates' AFTER 'once';

CREATE TABLE "CampaignDate" (
  "id"         UUID         PRIMARY KEY,
  "campaignId" UUID         NOT NULL,
  "on"         DATE         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "CampaignDate" ADD CONSTRAINT "CampaignDate_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No "sent" column on purpose: which day already fired is `Mailout.periodKey`, and
-- UNIQUE(campaignId, periodKey) is what refuses a second run. A flag here would be a second
-- answer to the same question, and two answers drift.
CREATE UNIQUE INDEX "CampaignDate_campaignId_on_key" ON "CampaignDate"("campaignId", "on");
CREATE INDEX "CampaignDate_campaignId_idx" ON "CampaignDate"("campaignId");
