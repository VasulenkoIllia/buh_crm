-- Where a card sits IN its column, so it can be dragged up and down and not only across.
--
-- Board order was `createdAt desc` and nothing else. The back-fill reproduces exactly that, per
-- column, so no board changes the moment this lands — it only becomes movable.
ALTER TABLE "Task" ADD COLUMN "boardOrder" INTEGER NOT NULL DEFAULT 0;

UPDATE "Task" t
   SET "boardOrder" = n.rn
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY "statusColumnId" ORDER BY "createdAt" DESC) - 1 AS rn
      FROM "Task"
  ) n
 WHERE n.id = t.id;

-- the board reads one column at a time, in order
CREATE INDEX "Task_statusColumnId_boardOrder_idx" ON "Task"("statusColumnId", "boardOrder");
