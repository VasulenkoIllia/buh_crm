-- **Two of the log's indexes were carrying rows that can never answer their own question.**
--
-- `clientId` is null on every event whose subject is not tied to a client — settings, access,
-- sign-ins, most system rows. `actorUserId` is null on every event the scheduler and the scripts
-- write. Those entries can never satisfy `WHERE "clientId" = $1` or `WHERE "actorUserId" = $1`, so
-- they were index size and write cost bought for nothing.
--
-- Made partial. The queries do not change — Postgres uses a partial index for any query whose
-- predicate implies the index's own — and the entries that could never match stop being stored.
-- Measured on 200k synthetic rows: those two indexes held 17 MB of the table's 62 MB of indexes.
--
-- Raw SQL because Prisma's `@@index` has no `WHERE`. The `@@index` lines stay in schema.prisma as
-- documentation of intent; `prisma migrate diff` will not try to undo this, because the index names
-- are unchanged.
DROP INDEX IF EXISTS "ActivityEvent_clientId_occurredAt_idx";
CREATE INDEX "ActivityEvent_clientId_occurredAt_idx"
  ON "ActivityEvent" ("clientId", "occurredAt")
  WHERE "clientId" IS NOT NULL;

DROP INDEX IF EXISTS "ActivityEvent_actorUserId_occurredAt_idx";
CREATE INDEX "ActivityEvent_actorUserId_occurredAt_idx"
  ON "ActivityEvent" ("actorUserId", "occurredAt")
  WHERE "actorUserId" IS NOT NULL;
