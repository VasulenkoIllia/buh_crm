-- Paying an invoice online, stage B: the webhook records the payment (2026-11-12, payments.md §11).
--
-- Additive only: two enums, a table, three nullable columns, one column with a constant default,
-- two NOT NULLs dropped, and unique indexes on columns that are empty on the day this runs.
--
-- `Payment.source` has a CONSTANT default, so Postgres stores it in the catalogue and does not
-- rewrite the table. Dropping NOT NULL is a catalogue change too. The tables hold a few thousand
-- rows at most, so every statement holds its lock for milliseconds, during the deploy.
--
-- `Payment.createdById` and `PaymentAuditLog.byUserId` become nullable because a payment the
-- webhook records has no person behind it. Their foreign keys stay ON DELETE RESTRICT: the schema
-- names it, since an optional relation would otherwise default to SET NULL.
--
-- Rollback: a code-only rollback to stage A works with this schema in place, as long as no
-- payment was recorded by the webhook (stage A reads `createdBy` as required). Undoing the schema
-- is the deploy's dump.

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('manual', 'stripe');

-- CreateEnum
CREATE TYPE "StripeEventOutcome" AS ENUM ('applied', 'ignored', 'needs_attention');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "source" "PaymentSource" NOT NULL DEFAULT 'manual',
ADD COLUMN     "stripePaymentIntentId" TEXT,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PaymentAuditLog" ALTER COLUMN "byUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StripeCheckout" ADD COLUMN     "paymentIntentId" TEXT;

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "objectId" TEXT,
    "invoiceId" UUID,
    "outcome" "StripeEventOutcome" NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeEvent_invoiceId_idx" ON "StripeEvent"("invoiceId");

-- CreateIndex
CREATE INDEX "StripeEvent_livemode_receivedAt_idx" ON "StripeEvent"("livemode", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckout_paymentIntentId_key" ON "StripeCheckout"("paymentIntentId");

-- AddForeignKey
ALTER TABLE "StripeEvent" ADD CONSTRAINT "StripeEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

