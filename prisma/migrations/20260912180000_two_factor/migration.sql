-- **Two-factor sign-in** (docs/modules/two-factor.md §11, Phase B).
--
-- Additive throughout: three new tables, an enum, and two columns on the singleton FirmProfile
-- row. No backfill, no lock risk on a hot table. An account with no credential row has no second
-- factor, which is every account on the day this ships.
--
-- The credential is a table of its own rather than columns on "User": the client portal will sign
-- in people who are not "User" rows, and gains a second nullable owner column and a CHECK here
-- instead of a copy (§4.2). The challenge is a table of its own rather than an "AuthToken", which
-- points at "User" and has nowhere to count attempts (§5.2).

-- CreateEnum
CREATE TYPE "TwoFactorPolicy" AS ENUM ('off', 'admins', 'everyone');

-- AlterTable: the firm's rule, shipped off (§6.4)
ALTER TABLE "FirmProfile" ADD COLUMN "require2fa" "TwoFactorPolicy" NOT NULL DEFAULT 'off',
ADD COLUMN "require2faSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TwoFactorCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "lastStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorRecoveryCode" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorChallenge" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one authenticator per person
CREATE UNIQUE INDEX "TwoFactorCredential_userId_key" ON "TwoFactorCredential"("userId");

-- CreateIndex
CREATE INDEX "TwoFactorRecoveryCode_credentialId_idx" ON "TwoFactorRecoveryCode"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorChallenge_tokenHash_key" ON "TwoFactorChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "TwoFactorChallenge_credentialId_idx" ON "TwoFactorChallenge"("credentialId");

-- CreateIndex
CREATE INDEX "TwoFactorChallenge_expiresAt_idx" ON "TwoFactorChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "TwoFactorCredential" ADD CONSTRAINT "TwoFactorCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorRecoveryCode" ADD CONSTRAINT "TwoFactorRecoveryCode_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "TwoFactorCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorChallenge" ADD CONSTRAINT "TwoFactorChallenge_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "TwoFactorCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
