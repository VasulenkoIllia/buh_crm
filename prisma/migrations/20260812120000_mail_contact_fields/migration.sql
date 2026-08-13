-- Contact buttons become real fields, and one mailbox can be named the invoice sender.
--
-- The buttons used to be parsed out of the signature's free text, which meant GUESSING: is this
-- line a Telegram number or a plain phone? A number written a new way produced a dead link that
-- nobody would notice until a client tapped it. Explicit fields cannot be misread.

ALTER TABLE "MailSenderAccount"
  ADD COLUMN "contactEmail"    TEXT,
  ADD COLUMN "contactPhone"    TEXT,
  ADD COLUMN "contactTelegram" TEXT,
  ADD COLUMN "contactWhatsapp" TEXT,
  ADD COLUMN "contactViber"    TEXT,
  ADD COLUMN "contactWebsite"  TEXT,
  ADD COLUMN "isInvoiceSender" BOOLEAN NOT NULL DEFAULT false;

-- At most one invoice sender, enforced rather than trusted — the same reason `isDefault` has one.
-- Two would make "which mailbox does a bill come from" depend on row order.
CREATE UNIQUE INDEX "MailSenderAccount_one_invoice_sender"
  ON "MailSenderAccount"("isInvoiceSender") WHERE "isInvoiceSender";

-- Seed the new fields from what the existing signatures already say, so nobody has to retype
-- contacts the firm entered yesterday. Deliberately conservative: only the first email and the
-- first plain phone, and only where the line does NOT name a messenger — those were exactly the
-- cases the parser got wrong, and a wrong value carried forward is worse than an empty field.
UPDATE "MailSenderAccount" SET
  "contactEmail" = (
    SELECT (regexp_match(signature, '[\w.+-]+@[\w-]+\.[\w.-]+'))[1]
  ),
  "contactPhone" = (
    SELECT (regexp_match(line, '\+?[\d][\d\s().-]{7,}\d'))[1]
    FROM regexp_split_to_table(signature, E'\n') AS line
    WHERE line ~ '\+?[\d][\d\s().-]{7,}\d'
      AND line !~* 'telegram|whats\s?app|viber'
    LIMIT 1
  )
WHERE signature IS NOT NULL;

-- The default mailbox also sends invoices until the firm says otherwise: with nothing marked,
-- the invoice path would have no mailbox at all the day it ships.
UPDATE "MailSenderAccount" SET "isInvoiceSender" = TRUE
WHERE "isDefault" AND NOT EXISTS (SELECT 1 FROM "MailSenderAccount" WHERE "isInvoiceSender");
