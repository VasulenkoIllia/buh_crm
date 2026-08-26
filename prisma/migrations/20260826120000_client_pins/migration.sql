-- A client one USER keeps at the top of their clients list.
--
-- Per-user, not per-firm: a shared pin would let one accountant reorder everyone else's screen.
-- The composite primary key IS the uniqueness rule (a user pins a client once); un-pinning is a
-- delete. Both FKs cascade so a removed user or a deleted client leaves no pin behind.
CREATE TABLE "ClientPin" (
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPin_pkey" PRIMARY KEY ("userId","clientId")
);

-- the list reads "which of MY pins survive these filters", so userId leads the PK; this covers the
-- other direction (a client being deleted, and "who pinned this client")
CREATE INDEX "ClientPin_clientId_idx" ON "ClientPin"("clientId");

ALTER TABLE "ClientPin" ADD CONSTRAINT "ClientPin_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientPin" ADD CONSTRAINT "ClientPin_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
