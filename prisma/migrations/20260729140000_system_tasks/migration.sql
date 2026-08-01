-- Tasks the system raises on its own initiative (decision 2026-07-29): the partial-period invoice
-- reminder, and later the "service ends soon" warning. `shared/system-tasks.ts` is the registry
-- the generators read their wording from, so the Automation screen can never drift from it.

ALTER TABLE "Task" ADD COLUMN "systemKind" TEXT;

-- One system task per (subscription, period). The sweeps run daily AND on every boot, so without
-- this the same reminder would be posted every morning. Raw SQL because Prisma can't put a WHERE
-- on an index — `server/schema-invariants.test.ts` asserts it, like the other six.
CREATE UNIQUE INDEX "Task_system_period"
    ON "Task"("subscriptionId", "periodKey")
    WHERE "systemKind" IS NOT NULL;
