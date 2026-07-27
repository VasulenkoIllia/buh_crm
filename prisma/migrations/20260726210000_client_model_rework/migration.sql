-- Client model rework (user, 2026-07-26) — supersedes the 2026-07-18 "one entity with a type".
--
--   A client is just a client. `Client.companyName` survives as an informational label only.
--   A COMPANY becomes a real entity owned by exactly one client: name (globally unique,
--   case-insensitive) + optional phone / email / description. `companyId = null` everywhere
--   else now means one unambiguous thing: "the client directly, no company".
--
-- The delicate part is step 3: for a client that WAS type=company, `companyId IS NULL` used to
-- mean "the main company" — the client's own title. Left alone, those already-issued invoices
-- would silently start reading as "no company". So each such client gets a real Company built
-- from its `companyName`, and its root-level rows move onto it. History keeps its meaning.

-- 1 ── the company's own contact details -------------------------------------------------
ALTER TABLE "Company"
  ADD COLUMN "phone"       TEXT,
  ADD COLUMN "email"       TEXT,
  ADD COLUMN "description" TEXT;

-- 2 ── make existing names unique case-insensitively so step 6's index can be created.
-- Dev is clean today; this exists so the migration is safe on any data it meets.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY lower("name") ORDER BY "createdAt", id) AS n
  FROM "Company"
)
UPDATE "Company" c
SET "name" = c."name" || ' (' || ranked.n || ')'
FROM ranked
WHERE c.id = ranked.id AND ranked.n > 1;

-- 3 ── company-type clients: their title becomes a real Company, and everything that was
-- billed/tracked at "the main company" (companyId IS NULL) moves onto it.
WITH promoted AS (
  INSERT INTO "Company" ("id", "clientId", "name", "order", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), cl.id, cl."companyName", 0, now(), now()
  FROM "Client" cl
  WHERE cl."type" = 'company'
    AND cl."companyName" IS NOT NULL
    AND btrim(cl."companyName") <> ''
    -- skip when this client already lists a company by that name, and never collide globally
    AND NOT EXISTS (
      SELECT 1 FROM "Company" c WHERE lower(c."name") = lower(cl."companyName")
    )
  RETURNING "id", "clientId"
)
UPDATE "Subscription" s SET "companyId" = p."id"
FROM promoted p WHERE s."clientId" = p."clientId" AND s."companyId" IS NULL;

-- the same move for tasks and invoices (a separate statement each: `promoted` is consumed by
-- the CTE above, so re-select the company by name)
UPDATE "Task" t
SET "companyId" = c."id"
FROM "Client" cl
JOIN "Company" c ON c."clientId" = cl.id AND lower(c."name") = lower(cl."companyName")
WHERE t."clientId" = cl.id AND t."companyId" IS NULL AND cl."type" = 'company';

UPDATE "Invoice" i
SET "companyId" = c."id"
FROM "Client" cl
JOIN "Company" c ON c."clientId" = cl.id AND lower(c."name") = lower(cl."companyName")
WHERE i."clientId" = cl.id AND i."companyId" IS NULL AND cl."type" = 'company';

-- 4 ── leads: the discriminator goes, the company name stays as a plain label
ALTER TABLE "Lead" ADD COLUMN "companyName" TEXT;
UPDATE "Lead" SET "companyName" = "name" WHERE "type" = 'company';

-- 5 ── a client is identified by their first name now, so it can't be null
UPDATE "Client"
SET "firstName" = COALESCE(NULLIF(btrim("firstName"), ''), NULLIF(btrim("companyName"), ''), 'Client')
WHERE "firstName" IS NULL OR btrim("firstName") = '';
ALTER TABLE "Client" ALTER COLUMN "firstName" SET NOT NULL;

-- 6 ── drop the discriminator everywhere + enforce the new company-name rule
DROP INDEX IF EXISTS "Client_type_idx";
ALTER TABLE "Client" DROP COLUMN "type";
ALTER TABLE "Lead" DROP COLUMN "type";
DROP TYPE "ClientType";

-- unique across the whole system, case-insensitively. Functional indexes aren't expressible in
-- the Prisma schema — server/schema-invariants.test.ts asserts this one exists.
CREATE UNIQUE INDEX "Company_name_key_ci" ON "Company" (lower("name"));
