-- Client secrets: a credential the firm holds for a client (tax portal, client-bank, КЕП).
--
-- `label`/`description` are readable by anyone who can open the client; the VALUE is encrypted at
-- rest with AES-256-GCM (key from SECRETS_KEY) and revealed only by an admin, with their own
-- password, for five minutes. All three crypto columns stay NULL for a pointer-only entry —
-- something too sensitive to hold, recorded as "it lives in the password manager" and no more.

CREATE TYPE "SecretAuditAction" AS ENUM ('created', 'updated', 'deleted', 'revealed', 'unlock_failed');

CREATE TABLE "ClientSecret" (
    "id"          UUID NOT NULL,
    "clientId"    UUID NOT NULL,
    "label"       TEXT NOT NULL,
    "description" TEXT,
    "ciphertext"  BYTEA,
    "iv"          BYTEA,
    "authTag"     BYTEA,
    "keyVersion"  INTEGER NOT NULL DEFAULT 1,
    "order"       INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientSecret_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecretAuditLog" (
    "id"        UUID NOT NULL,
    "secretId"  UUID,
    "clientId"  UUID NOT NULL,
    "byUserId"  UUID NOT NULL,
    "action"    "SecretAuditAction" NOT NULL,
    "ip"        TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecretAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientSecret_clientId_idx" ON "ClientSecret"("clientId");
CREATE INDEX "SecretAuditLog_clientId_createdAt_idx" ON "SecretAuditLog"("clientId", "createdAt");
CREATE INDEX "SecretAuditLog_byUserId_idx" ON "SecretAuditLog"("byUserId");

ALTER TABLE "ClientSecret" ADD CONSTRAINT "ClientSecret_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientSecret" ADD CONSTRAINT "ClientSecret_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- the log outlives the secret it describes: deleting a secret must not erase the record that it
-- existed and who looked at it
ALTER TABLE "SecretAuditLog" ADD CONSTRAINT "SecretAuditLog_secretId_fkey"
    FOREIGN KEY ("secretId") REFERENCES "ClientSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecretAuditLog" ADD CONSTRAINT "SecretAuditLog_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecretAuditLog" ADD CONSTRAINT "SecretAuditLog_byUserId_fkey"
    FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
