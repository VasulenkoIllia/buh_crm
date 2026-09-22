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
--
-- The backfill is ONE statement and the index is built in the same transaction, which is safe here
-- because the table this deploys onto is empty: the chat's own tables ship in this same batch
-- (20260918200000_chat), so there is nothing to rewrite and nothing to block. Re-running this
-- shape against a populated ChatSearchToken would lock it for the length of the UPDATE and the
-- build; that version wants CREATE INDEX CONCURRENTLY outside a transaction and a batched
-- backfill, for which scripts/reindex-chat-search.ts is already the pattern (audit, 2026-09-21).
ALTER TABLE "ChatSearchToken" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ChatSearchToken" t
SET "createdAt" = m."createdAt"
FROM "ChatMessage" m
WHERE m.id = t."messageId";

CREATE INDEX "ChatSearchToken_token_createdAt_idx" ON "ChatSearchToken"("token", "createdAt" DESC);
