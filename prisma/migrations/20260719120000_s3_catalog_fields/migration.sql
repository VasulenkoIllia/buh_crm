-- S3 Catalog: planned labor on task templates, invoice day on services,
-- People → Service link (legacy free-text serviceLabel kept for pre-S3 rows).

ALTER TABLE "TaskTemplate" ADD COLUMN "estimatedMinutes" INTEGER;

ALTER TABLE "Service" ADD COLUMN "invoiceDay" INTEGER;

ALTER TABLE "ClientPerson" ADD COLUMN "serviceId" UUID;
ALTER TABLE "ClientPerson" ADD CONSTRAINT "ClientPerson_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ClientPerson_serviceId_idx" ON "ClientPerson"("serviceId");
