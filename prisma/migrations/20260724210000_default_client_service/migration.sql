-- One catalog service (one-time only) can be flagged to auto-add to every new client
-- (decision 2026-07-24) so every client has at least one paid container. At most ONE
-- may carry the flag — enforced by a partial unique index on a constant expression
-- (Prisma can't express this, mirrors TimeEntry_one_running_per_user).

ALTER TABLE "Service" ADD COLUMN "autoAddToNewClients" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Service_single_default_for_new_clients"
  ON "Service" ((true)) WHERE "autoAddToNewClients";
