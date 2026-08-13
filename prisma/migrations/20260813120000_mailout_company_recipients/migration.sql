-- A mailout recipient becomes a client OR one of that client's companies.
--
-- A firm's client can hold several companies, each with its own inbox — "send to Olena" and "send
-- to Kvitka Trade LLC" are different acts with different addresses, and only the first was
-- possible. `Company.email` already existed for exactly this (see the model comment, written when
-- companies were reworked); nothing pointed at it.
--
-- Written with IF EXISTS / IF NOT EXISTS throughout: the first attempt failed halfway (the old
-- uniqueness is an INDEX, not a table constraint, so DROP CONSTRAINT errored after the column had
-- already been added) and a migration that cannot be re-run leaves the database stuck.

ALTER TABLE "MailoutRecipient" ADD COLUMN IF NOT EXISTS "companyId" UUID;

-- RESTRICT, not CASCADE: a sent letter is history, and deleting the company it went to must be
-- refused rather than silently erasing the record that it was ever sent. The same rule the
-- billing provenance FKs follow (migration 20260726090000).
ALTER TABLE "MailoutRecipient" DROP CONSTRAINT IF EXISTS "MailoutRecipient_companyId_fkey";
ALTER TABLE "MailoutRecipient" ADD CONSTRAINT "MailoutRecipient_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The old rule said "one row per client per mailout". Too strict now: a letter may go to the
-- client AND to two of their companies.
DROP INDEX IF EXISTS "MailoutRecipient_mailoutId_clientId_key";

-- Uniqueness needs TWO indexes, because Postgres treats NULLs as distinct and a plain
-- UNIQUE(mailoutId, clientId, companyId) would happily allow the same client twice with NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "MailoutRecipient_mailoutId_clientId_companyId_key"
  ON "MailoutRecipient"("mailoutId", "clientId", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "MailoutRecipient_one_client_row"
  ON "MailoutRecipient"("mailoutId", "clientId") WHERE "companyId" IS NULL;

CREATE INDEX IF NOT EXISTS "MailoutRecipient_companyId_idx" ON "MailoutRecipient"("companyId");
