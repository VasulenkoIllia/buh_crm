-- Several sets of payment details, a set per client, and the copy on the invoice (2026-11-02,
-- payments.md §10).
--
-- Additive: a new table, three nullable columns with no default (catalog-only, nothing rewritten)
-- and two plain indexes on small tables (about 200 clients, a few hundred invoices). The foreign
-- keys validate those rows, which all hold NULL.
--
-- `FirmProfile.invoicePaymentInfo` stays where it is, unread from now on: a code-only rollback to
-- the release before still prints it. A later migration drops it.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "paymentDetailsId" UUID;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paymentDetailsId" UUID,
ADD COLUMN     "paymentInfo" TEXT;

-- CreateTable
CREATE TABLE "PaymentDetails" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_paymentDetailsId_idx" ON "Client"("paymentDetailsId");

-- CreateIndex
CREATE INDEX "Invoice_paymentDetailsId_idx" ON "Invoice"("paymentDetailsId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_paymentDetailsId_fkey" FOREIGN KEY ("paymentDetailsId") REFERENCES "PaymentDetails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentDetailsId_fkey" FOREIGN KEY ("paymentDetailsId") REFERENCES "PaymentDetails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One default among the live sets. Partial, so archived sets and the many `false` rows do not
-- collide. Not expressible in the Prisma schema; server/schema-invariants.test.ts asserts it.
CREATE UNIQUE INDEX "PaymentDetails_one_default"
  ON "PaymentDetails" ("isDefault") WHERE "isDefault" AND "archivedAt" IS NULL;

-- The block the firm filled in before sets existed becomes the set named Default, so nothing
-- typed is lost. Blank or never filled: no set, and the admin creates them after the deploy.
-- The text is trimmed the way the old reader trimmed it (`filled` in core/firm.ts).
INSERT INTO "PaymentDetails" ("id", "name", "details", "isDefault", "updatedAt")
SELECT gen_random_uuid(), 'Default', btrim(p."invoicePaymentInfo", E' \t\r\n'), true, CURRENT_TIMESTAMP
FROM "FirmProfile" p
WHERE p.id = 1
  AND btrim(coalesce(p."invoicePaymentInfo", ''), E' \t\r\n') <> '';
