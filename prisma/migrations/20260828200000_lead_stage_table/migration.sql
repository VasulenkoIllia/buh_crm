-- The leads pipeline's columns become DATA.
--
-- `LeadStage` was a Prisma enum, which means the firm could not reorder its own pipeline, rename a
-- column or add one — every change was a migration, and the board could not be dragged at all. It
-- is a table now, the same shape as `TaskColumn`, so both boards are one idea rather than two that
-- happen to look alike (user, 2026-08-28).
--
-- ORDER MATTERS HERE. In Postgres a table and a type share one namespace, so `CREATE TABLE
-- "LeadStage"` fails while the enum of that name still exists — and the enum cannot be dropped
-- while a column uses it. The values are therefore parked in a text column first, the enum is
-- taken away, and only then does the table arrive to be joined against.

-- 1. park the current stage as plain text
ALTER TABLE "Lead" ADD COLUMN "stageKey" TEXT;
UPDATE "Lead" SET "stageKey" = "stage"::text;

-- 2. the enum can go now that nothing reads it
ALTER TABLE "Lead" DROP COLUMN "stage";
DROP TYPE "LeadStage";

-- 3. the table, and the six stages this firm has been working with, in the order the board drew
CREATE TABLE "LeadStage" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "LeadStage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadStage_name_key" ON "LeadStage"("name");
CREATE INDEX "LeadStage_order_idx" ON "LeadStage"("order");

INSERT INTO "LeadStage" (id, name, "order") VALUES
  (gen_random_uuid(), 'First contact',  0),
  (gen_random_uuid(), 'No answer',      1),
  (gen_random_uuid(), 'Set up meeting', 2),
  (gen_random_uuid(), 'Thinking',       3),
  (gen_random_uuid(), 'On hold',        4),
  (gen_random_uuid(), 'Next time',      5);

-- 4. every lead keeps the column it was standing in
ALTER TABLE "Lead" ADD COLUMN "stageId" UUID;
UPDATE "Lead" l SET "stageId" = s.id
  FROM "LeadStage" s
 WHERE s.name = CASE l."stageKey"
                  WHEN 'first_contact'  THEN 'First contact'
                  WHEN 'no_answer'      THEN 'No answer'
                  WHEN 'set_up_meeting' THEN 'Set up meeting'
                  WHEN 'thinking'       THEN 'Thinking'
                  WHEN 'on_hold'        THEN 'On hold'
                  WHEN 'next_time'      THEN 'Next time'
                END;

-- a lead whose key matched nothing would silently become NOT NULL-violating below; there is no such
-- row by construction, and if there ever were, failing here with the dump still fresh is the right
-- outcome rather than inventing a stage for it
ALTER TABLE "Lead" ALTER COLUMN "stageId" SET NOT NULL;
CREATE INDEX "Lead_stageId_idx" ON "Lead"("stageId");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "LeadStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Lead" DROP COLUMN "stageKey";
