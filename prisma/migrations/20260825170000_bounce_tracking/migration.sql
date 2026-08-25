-- Recording what a delivery report said, and which addresses it retired.
--
-- Additive and idempotent throughout: nothing existing changes meaning, and a deploy that
-- half-applied once can be re-run without hand-editing the database.

-- `bounced` is a real outcome, not a flavour of `failed`: a letter that was handed over and then
-- refused is a different fact from one that never left, and the screen says so differently.
ALTER TYPE "MailoutStatus" ADD VALUE IF NOT EXISTS 'bounced';

DO $$ BEGIN
  CREATE TYPE "BounceKind" AS ENUM ('address', 'system', 'letter', 'transient');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "MailoutRecipient"
  ADD COLUMN IF NOT EXISTS "bouncedAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bounceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "bounceKind" "BounceKind";

-- The reader's bookmark. `bounceCheckedAt` is load-bearing beyond bookkeeping: a letter is only
-- called delivered once this proves the mailbox was read AFTER it was sent and held no complaint.
-- Silence is evidence only when somebody was listening.
ALTER TABLE "MailSenderAccount"
  ADD COLUMN IF NOT EXISTS "bounceUidValidity" TEXT,
  ADD COLUMN IF NOT EXISTS "bounceLastUid"     INTEGER,
  ADD COLUMN IF NOT EXISTS "bounceCheckedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bounceError"       TEXT;

-- Keyed by the ADDRESS: a client has several — their own and one per company — and a bounce kills
-- exactly one of them. Only a `5.1.x`-class report ever writes here.
CREATE TABLE IF NOT EXISTS "DeadEmailAddress" (
  "email"       TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL,
  "clearedAt"   TIMESTAMP(3),
  "clearedById" UUID,
  CONSTRAINT "DeadEmailAddress_pkey" PRIMARY KEY ("email")
);

CREATE INDEX IF NOT EXISTS "DeadEmailAddress_clearedAt_idx" ON "DeadEmailAddress" ("clearedAt");

DO $$ BEGIN
  ALTER TABLE "DeadEmailAddress"
    ADD CONSTRAINT "DeadEmailAddress_clearedById_fkey"
    FOREIGN KEY ("clearedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
