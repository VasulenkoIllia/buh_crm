-- Where a lead sits INSIDE its stage on the pipeline board.
--
-- The same column, for the same reason, as `Task.boardOrder`: a kanban column has the order the
-- firm arranged by hand, not the one the database happened to return. Until now the leads board
-- drew each stage in `createdAt DESC` and a card could not be moved within its column at all.
--
-- Back-filled to match exactly what the board was already showing — newest first — so the deploy
-- that adds this moves nothing on screen.
ALTER TABLE "Lead" ADD COLUMN "boardOrder" INTEGER NOT NULL DEFAULT 0;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY stage ORDER BY "createdAt" DESC) - 1 AS rn
    FROM "Lead"
)
UPDATE "Lead" l SET "boardOrder" = n.rn FROM numbered n WHERE n.id = l.id;
