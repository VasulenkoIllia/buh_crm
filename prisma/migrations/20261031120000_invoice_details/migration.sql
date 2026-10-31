-- Who an invoice is from and how to pay it (2026-10-31, payments.md §10).
--
-- Additive: six nullable columns with no default on a table of one row, so catalog-only and nothing
-- to back-fill. `invoiceIssuer` falls back on the firm's name and postal address while they are empty.

-- AlterTable
ALTER TABLE "FirmProfile" ADD COLUMN     "invoiceFromAddress" TEXT,
ADD COLUMN     "invoiceFromEmail" TEXT,
ADD COLUMN     "invoiceFromName" TEXT,
ADD COLUMN     "invoiceFromPhone" TEXT,
ADD COLUMN     "invoiceFromWebsite" TEXT,
ADD COLUMN     "invoicePaymentInfo" TEXT;
