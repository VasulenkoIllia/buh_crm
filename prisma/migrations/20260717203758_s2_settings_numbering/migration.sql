-- S2: invoice numbering = prefix + yearly counter (drop free-format column)
ALTER TABLE "FirmProfile" DROP COLUMN "invoiceNumberFormat";
ALTER TABLE "FirmProfile" ADD COLUMN "invoicePrefix" TEXT NOT NULL DEFAULT 'INV';
ALTER TABLE "FirmProfile" ADD COLUMN "invoiceCounterDigits" INTEGER NOT NULL DEFAULT 4;
