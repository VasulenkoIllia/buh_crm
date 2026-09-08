-- **Who did what, when, and to whom — the table, and the two columns that make its IP true.**
--
-- Additive and empty. Applying it changes nothing anybody notices: the tier-1 hook that fills the
-- table ships in the same release, but the module only RECORDS — nothing here changes what any
-- person can do, which is what makes activity-log.md §13 able to roll out in pieces.
--
-- Three things about this table are decisions rather than defaults, and each is load-bearing:
--
--   • NO FOREIGN KEYS. `actorUserId`, `actorClientId`, `subjectId` and `clientId` are plain UUID
--     columns. §11 makes the log outlive what it describes — it is the evidence that disposal
--     happened — so a cascade from a purged client would delete the proof at the moment it is
--     needed, and a RESTRICT would block the purge instead. The labels beside the ids are
--     snapshotted, the way `SecretAuditLog` has done since S7.5, so a deleted actor still reads.
--
--   • `action` is TEXT, not an enum. An enum would make every new event a migration, which is
--     exactly what the registry in shared/activity.ts exists to avoid: a new module adds entries to
--     a constant and ships.
--
--   • `clientId` is denormalised. §1 opens with "what has happened to this client" and that question
--     crosses subjects — an invoice issued for Petrenko is `subject: 'invoice'`. Keyed only by
--     [subject, subjectId] the client card would find a tenth of what concerns that client
--     (decided 2026-09-08).
--
-- `Session.ip` / `Session.userAgent` are here rather than in a migration of their own because they
-- are the same act: a log whose addresses are the reverse proxy's is a lie that looks like data, so
-- `trustProxy` moves to a real hop count in the same release (§13 A1).

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "ip" TEXT,
                      ADD COLUMN "userAgent" TEXT;

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('user', 'client', 'system');

-- CreateEnum
CREATE TYPE "ActivityOutcome" AS ENUM ('ok', 'refused', 'failed');

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" UUID NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "actorUserId" UUID,
    "actorClientId" UUID,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectId" UUID,
    "subjectLabel" TEXT,
    "clientId" UUID,
    "changes" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "gate" TEXT,
    "method" TEXT,
    "route" TEXT,
    "outcome" "ActivityOutcome" NOT NULL DEFAULT 'ok',
    "refusalCode" TEXT,
    "correlationId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- Whether an event is recorded at all. One row per registry key, seeded create-if-missing by
-- `ensureBaseData` — the shape `NotificationPolicy` already uses, so a firm's decision survives
-- every deploy. It exists for `client.viewed` (present and off — the event that would scope a
-- breach precisely and is also the noisiest in the product), and it is what lets the firm silence
-- a new event that turns out to be noise without waiting for a developer.
-- CreateTable
CREATE TABLE "ActivityPolicy" (
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityPolicy_pkey" PRIMARY KEY ("action")
);

-- The screen's questions, one index each (§5.2). Not the table's size: at ten people and ~250
-- working days this is 50–200k rows a year, which Postgres does not notice.
-- CreateIndex
CREATE INDEX "ActivityEvent_occurredAt_idx" ON "ActivityEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_actorUserId_occurredAt_idx" ON "ActivityEvent"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_subject_subjectId_occurredAt_idx" ON "ActivityEvent"("subject", "subjectId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_clientId_occurredAt_idx" ON "ActivityEvent"("clientId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_action_occurredAt_idx" ON "ActivityEvent"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_correlationId_idx" ON "ActivityEvent"("correlationId");
