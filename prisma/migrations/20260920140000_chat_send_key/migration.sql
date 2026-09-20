-- S19 stage A (chat.md §5.1): the idempotency key of a send takes the chat in too.
--
-- "This person's Nth attempt to say this HERE". With the author alone, a retry that reached a
-- different chat was answered with the first chat's message, and nothing was written where it was
-- sent (review, 2026-09-20). Additive in effect: no row changes, and the new index is wider than
-- the one it replaces, so nothing that fitted the old rule breaks the new one.

-- DropIndex
DROP INDEX "ChatMessage_authorId_clientMessageId_key";

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_chatId_authorId_clientMessageId_key" ON "ChatMessage"("chatId", "authorId", "clientMessageId");

