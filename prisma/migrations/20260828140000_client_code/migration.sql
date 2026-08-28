-- The short handle staff say to each other about a client. Rendered `C-042`; stored as the bare
-- number so it sorts numerically and the format can be changed without touching a single row.
--
-- The DATABASE hands it out. A client is created from the Clients page, the meeting form, the task
-- form, the import scripts, and — inside a transaction of its own — lead conversion. An application
-- counter would have to be threaded through every one of those, and any path added later would
-- quietly produce a client with no code. Invoices keep their counter because accounting demands
-- numbering with no gaps; a gap in a client code costs nothing.
--
-- Written out by hand rather than as `ADD COLUMN code SERIAL`, which is what the schema alone
-- implies: SERIAL fills existing rows in the table's PHYSICAL order, and rows move when they are
-- updated, so a client edited last week would sort ahead of one imported before it. The order a
-- code is handed out in is the one thing about it that carries meaning, so it is chosen here.
ALTER TABLE "Client" ADD COLUMN "code" INTEGER;

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn FROM "Client"
)
UPDATE "Client" c SET "code" = n.rn FROM numbered n WHERE n.id = c.id;

ALTER TABLE "Client" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "Client_code_key" ON "Client"("code");

-- The sequence `autoincrement()` expects, named the way SERIAL would have named it.
CREATE SEQUENCE "Client_code_seq" OWNED BY "Client"."code";
ALTER TABLE "Client" ALTER COLUMN "code" SET DEFAULT nextval('"Client_code_seq"');

-- Positioned PAST the back-fill. Without this the sequence still starts at 1 and the very next
-- client created collides with a code already handed out — the classic way this migration is got
-- wrong. `is_called = false` makes the next value exactly max + 1 rather than max + 2.
SELECT setval('"Client_code_seq"', COALESCE((SELECT MAX("code") FROM "Client"), 0) + 1, false);
