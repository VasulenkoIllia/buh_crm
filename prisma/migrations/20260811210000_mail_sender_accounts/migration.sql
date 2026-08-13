-- S10 — several sender mailboxes instead of one set of fields on FirmProfile.
--
-- A firm does not send every letter from one address: news from info@, invoices from billing@, a
-- document request from a particular accountant. One `mailout*` column set could only ever
-- describe one of them, and the signature block — which names a PERSON — differs by mailbox.
--
-- ORDER MATTERS HERE. `prisma migrate diff` emits the DROP COLUMNs before the CREATE TABLE, which
-- would destroy the firm's existing sender before there is anywhere to put it. So: create, copy,
-- re-point history, and only then drop.

-- 1. the new home ────────────────────────────────────────────────────────────
CREATE TABLE "MailSenderAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "replyTo" TEXT,
    "signature" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN,
    "smtpUser" TEXT,
    "smtpPass" BYTEA,
    "smtpPassIv" BYTEA,
    "smtpPassTag" BYTEA,
    "smtpKeyVersion" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSenderAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MailSenderAccount_active_idx" ON "MailSenderAccount"("active");

-- Two invariants Prisma cannot express, so they are database facts rather than service hopes.
-- Both are registered in server/schema-invariants.test.ts, which exists because `migrate diff`
-- cannot see raw indexes and would silently let a later migration drop them.

-- names are unique case-insensitively: "Invoices" and "invoices" are the same mailbox
CREATE UNIQUE INDEX "MailSenderAccount_name_key_ci" ON "MailSenderAccount"(lower("name"));

-- at most one default, enforced rather than trusted: two defaults would make "which mailbox does
-- this go from" depend on row order
CREATE UNIQUE INDEX "MailSenderAccount_one_default" ON "MailSenderAccount"("isDefault")
  WHERE "isDefault";

-- 2. who a template and a past send belong to ────────────────────────────────
ALTER TABLE "EmailTemplate" ADD COLUMN "senderAccountId" UUID;
ALTER TABLE "Mailout" ADD COLUMN "senderAccountId" UUID;

-- 3. carry the existing sender across ────────────────────────────────────────
--
-- Always creates one, even from an empty profile: the module needs a default account to exist for
-- the very first send, and a firm that has typed nothing yet still has a name.
INSERT INTO "MailSenderAccount" (
  "id", "name", "fromName", "fromEmail", "replyTo", "signature",
  "smtpHost", "smtpPort", "smtpSecure", "smtpUser",
  "smtpPass", "smtpPassIv", "smtpPassTag", "smtpKeyVersion",
  "isDefault", "active", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  'Main',
  COALESCE(NULLIF("mailoutFromName", ''), "name"),
  COALESCE(NULLIF("mailoutFromEmail", ''), ''),
  "mailoutReplyTo",
  "mailoutSignature",
  "mailoutSmtpHost", "mailoutSmtpPort", "mailoutSmtpSecure", "mailoutSmtpUser",
  "mailoutSmtpPass", "mailoutSmtpPassIv", "mailoutSmtpPassTag", "mailoutSmtpKeyVersion",
  TRUE, TRUE, now(), now()
FROM "FirmProfile"
WHERE "id" = 1;

-- Every send that already happened went from that one account, so say so rather than leaving the
-- log unable to answer "sent from where" for everything before today.
UPDATE "Mailout"
SET "senderAccountId" = (SELECT "id" FROM "MailSenderAccount" WHERE "isDefault" LIMIT 1)
WHERE "senderAccountId" IS NULL;

-- 4. only now is it safe to drop ─────────────────────────────────────────────
ALTER TABLE "FirmProfile"
  DROP COLUMN "mailoutFromEmail",
  DROP COLUMN "mailoutFromName",
  DROP COLUMN "mailoutReplyTo",
  DROP COLUMN "mailoutSignature",
  DROP COLUMN "mailoutSmtpHost",
  DROP COLUMN "mailoutSmtpKeyVersion",
  DROP COLUMN "mailoutSmtpPass",
  DROP COLUMN "mailoutSmtpPassIv",
  DROP COLUMN "mailoutSmtpPassTag",
  DROP COLUMN "mailoutSmtpPort",
  DROP COLUMN "mailoutSmtpSecure",
  DROP COLUMN "mailoutSmtpUser";

-- 5. foreign keys ────────────────────────────────────────────────────────────
--
-- SET NULL, not CASCADE: an account should never be deleted while history points at it (the
-- service refuses), but if one ever is, losing the pointer must not delete the letters.
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_senderAccountId_fkey"
  FOREIGN KEY ("senderAccountId") REFERENCES "MailSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Mailout" ADD CONSTRAINT "Mailout_senderAccountId_fkey"
  FOREIGN KEY ("senderAccountId") REFERENCES "MailSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
