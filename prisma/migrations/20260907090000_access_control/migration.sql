-- **Who may open what, and who changed somebody's time.**
--
-- Four tables and two enums, all additive: nothing existing is altered, nothing is dropped, and
-- every one of them starts empty. The app is in production, and the whole point of this migration
-- is that applying it changes nothing anybody notices — the seeded policy rows that arrive on the
-- next boot (`ensureAccessPolicies`, from the registry in shared/access.ts) reproduce exactly what
-- the 46 `requireAdmin` guards were doing the day before.
--
-- `AccessPolicy` and `AccessOverride` are firm CONFIGURATION, like `FirmProfile` and
-- `NotificationPolicy`: they are on the keep-list in server/schema-invariants.test.ts, NOT in
-- scripts/reset-data.sql. A `--reset` that silently re-opened every closed area would be the worst
-- kind of failure, because nothing would report it.
--
-- The `action` column on both tables ships with '*' on every row and nothing reads it. It is here
-- because it is in the composite primary key, and adding a column to a composite primary key later
-- is the one stage-2 change (per-action rules — "sees Billing, cannot cancel invoices") that would
-- NOT be additive: a migration plus a rewrite of every lookup. One unused column now is what keeps
-- that cheap.


-- CreateEnum
CREATE TYPE "AccessState" AS ENUM ('open', 'read_only', 'closed');

-- CreateEnum
CREATE TYPE "TimeEntryAuditAction" AS ENUM ('updated', 'deleted');

-- CreateTable
CREATE TABLE "AccessPolicy" (
    "gate" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "state" "AccessState" NOT NULL,
    "action" TEXT NOT NULL DEFAULT '*',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessPolicy_pkey" PRIMARY KEY ("gate","role","action")
);

-- CreateTable
CREATE TABLE "AccessOverride" (
    "userId" UUID NOT NULL,
    "gate" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '*',
    "state" "AccessState" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessOverride_pkey" PRIMARY KEY ("userId","gate","action")
);

-- The journal that ships WITH the rule it makes safe.
--
-- Editing somebody else's time entry stays restricted, but a person may now fix their own — which
-- today requires asking an admin. That opening is only defensible with a record: before this
-- table, `updateTimeEntry` and `removeTimeEntry` received no actor at all, there was no audit
-- table under any spelling, and an edit did not change `source`, so a doctored row was
-- indistinguishable from an untouched one.
--
-- Values are SNAPSHOTTED (`wasSeconds` / `wasComment`) and `entryId` goes null on delete, so a
-- deleted entry still has a readable history — the same shape as `SecretAuditLog`.
-- CreateTable
CREATE TABLE "TimeEntryAuditLog" (
    "id" UUID NOT NULL,
    "entryId" UUID,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "byUserId" UUID NOT NULL,
    "action" "TimeEntryAuditAction" NOT NULL,
    "wasSeconds" INTEGER,
    "wasComment" TEXT,
    "nowSeconds" INTEGER,
    "nowComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryAuditLog_pkey" PRIMARY KEY ("id")
);

-- The rule the module calls its only irreducible one, finally with a record of having been
-- exercised: whoever can change a role can grant themselves every gate, and until now nothing
-- said who had.
-- CreateTable
CREATE TABLE "UserRoleAuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "byUserId" UUID NOT NULL,
    "fromRole" "UserRole" NOT NULL,
    "toRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessOverride_userId_idx" ON "AccessOverride"("userId");

-- CreateIndex
CREATE INDEX "TimeEntryAuditLog_taskId_createdAt_idx" ON "TimeEntryAuditLog"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TimeEntryAuditLog_entryId_idx" ON "TimeEntryAuditLog"("entryId");

-- CreateIndex
CREATE INDEX "UserRoleAuditLog_userId_createdAt_idx" ON "UserRoleAuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AccessOverride" ADD CONSTRAINT "AccessOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAuditLog" ADD CONSTRAINT "TimeEntryAuditLog_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAuditLog" ADD CONSTRAINT "UserRoleAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAuditLog" ADD CONSTRAINT "UserRoleAuditLog_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

