-- What an invoice position counts: hours at a rate, or items at a price (2026-11-02,
-- payments.md §3).
--
-- Additive: a new enum and one nullable column with no default, so catalog-only, no table rewrite
-- and nothing to back-fill. NULL is every line written before this, read as hours, which is what
-- each of them meant; the code prints and adds them up exactly as before.

-- CreateEnum
CREATE TYPE "InvoiceLineUnit" AS ENUM ('hour', 'item');

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "unit" "InvoiceLineUnit";
