-- Invoice items, a list of positions New invoice can pick from (2026-11-02, payments.md §3).
--
-- Additive: a new table, and one nullable column with no default on "InvoiceLine" (catalog-only,
-- nothing rewritten). The index and the foreign key read a small table (a few thousand lines at
-- most), every row of which holds NULL. Nothing is back-filled: a line written before this was
-- typed by hand, which is what NULL says.

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "itemId" UUID;

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "InvoiceLineUnit" NOT NULL,
    "price" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceLine_itemId_idx" ON "InvoiceLine"("itemId");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InvoiceItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One item per name, whatever the case: two "Consultation" in the picker would be a coin toss.
-- Inactive items count, since switching one back on must not make two. A functional index, which
-- the Prisma schema cannot express; server/schema-invariants.test.ts asserts it.
CREATE UNIQUE INDEX "InvoiceItem_name_key_ci" ON "InvoiceItem" (lower("name"));
