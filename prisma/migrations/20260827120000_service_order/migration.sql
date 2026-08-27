-- Where a service sits in the catalog, so the firm can put it in an order that means something.
--
-- One query feeds every service picker, chip and filter in the app, so this column decides all of
-- them at once. The back-fill reproduces `createdAt ASC` — exactly what the list was sorted by
-- until now — so nothing moves anywhere on the deploy that adds it.
ALTER TABLE "Service" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;

UPDATE "Service" s
   SET "order" = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY "createdAt" ASC) - 1 AS rn FROM "Service") n
 WHERE n.id = s.id;

CREATE INDEX "Service_order_idx" ON "Service"("order");
