-- Paying an invoice online, stage A: the pay link (2026-11-12, payments.md §11).
--
-- Additive: a column every invoice gets, a new enum and a new table.
--
-- `Invoice.payToken` is NOT NULL with a VOLATILE default, so Postgres rewrites the table once and
-- evaluates the default per row: every invoice already there gets a token of its own in this one
-- statement, and every later insert gets one too: no code path names the column. The
-- table holds a few hundred invoices, so the rewrite and the unique index hold the table's lock for
-- well under a second, during the deploy, when nothing else writes.
--
-- The token is two random UUIDs' bytes as base64url: 43 characters carrying 244 random bits
-- (each v4 UUID has 122; `gen_random_uuid()` reads the server's strong random source).
--
-- Rollback: a code-only rollback to the release before works with this schema in place (the old
-- code never names the column, the default fills it, and nothing reads the new table). Undoing
-- the schema is the deploy's dump.

-- CreateEnum
CREATE TYPE "StripeCheckoutStatus" AS ENUM ('open', 'completed', 'expired');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "payToken" TEXT NOT NULL DEFAULT translate(rtrim(encode(decode(replace(((gen_random_uuid())::text || (gen_random_uuid())::text), '-'::text, ''::text), 'hex'::text), 'base64'::text), '='::text), '+/'::text, '-_'::text);

-- CreateTable
CREATE TABLE "StripeCheckout" (
    "id" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "status" "StripeCheckoutStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckout_sessionId_key" ON "StripeCheckout"("sessionId");

-- CreateIndex
CREATE INDEX "StripeCheckout_invoiceId_status_idx" ON "StripeCheckout"("invoiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_payToken_key" ON "Invoice"("payToken");

-- AddForeignKey
ALTER TABLE "StripeCheckout" ADD CONSTRAINT "StripeCheckout_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
