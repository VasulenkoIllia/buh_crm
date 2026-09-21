-- The message's own instant, on its search tokens.
--
-- The search answers newest first. Without the time on the token row, a query of ONE trigram —
-- which is what any three-letter search is — had to aggregate every message in the firm holding
-- that triple and sort them before the 500-row limit could bite: the limit bounded the rows
-- returned and not the work done (audit, 2026-09-20). With this column and its index the common
-- case walks the index in the order it answers in and stops at the first page.
--
-- Additive. The default fills existing rows with `now()`, and the UPDATE below then puts the real
-- instant on them, so the ordering is right for everything already written.
ALTER TABLE "ChatSearchToken" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ChatSearchToken" t
SET "createdAt" = m."createdAt"
FROM "ChatMessage" m
WHERE m.id = t."messageId";

CREATE INDEX "ChatSearchToken_token_createdAt_idx" ON "ChatSearchToken"("token", "createdAt" DESC);
