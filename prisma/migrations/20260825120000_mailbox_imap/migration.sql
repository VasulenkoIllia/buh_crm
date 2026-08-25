-- Reading a mailbox back, and the key that makes a bounce matchable.
--
-- Every column is nullable and every default is "off", so an existing mailbox keeps behaving
-- exactly as it did: no IMAP host means it is simply not polled. Idempotent throughout, because
-- a deploy that half-applied once must be re-runnable without hand-editing the database.

ALTER TABLE "MailSenderAccount"
  ADD COLUMN IF NOT EXISTS "imapHost"       TEXT,
  ADD COLUMN IF NOT EXISTS "imapPort"       INTEGER,
  ADD COLUMN IF NOT EXISTS "imapSecure"     BOOLEAN,
  ADD COLUMN IF NOT EXISTS "imapUser"       TEXT,
  ADD COLUMN IF NOT EXISTS "imapPass"       BYTEA,
  ADD COLUMN IF NOT EXISTS "imapPassIv"     BYTEA,
  ADD COLUMN IF NOT EXISTS "imapPassTag"    BYTEA,
  ADD COLUMN IF NOT EXISTS "imapKeyVersion" INTEGER;

-- The `Message-ID` a letter went out with. A DSN quotes it in `References:`, which is how a
-- returned letter is matched to the row that sent it rather than guessed at from the address.
ALTER TABLE "MailoutRecipient"
  ADD COLUMN IF NOT EXISTS "messageId" TEXT;
