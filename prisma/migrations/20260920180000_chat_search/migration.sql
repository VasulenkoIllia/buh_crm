-- S19 stage B (chat.md §8): searching sealed text by keyed hashes of its words.
--
-- Additive: one new table. Nothing existing is touched, so a code-only rollback leaves a table
-- nothing writes to.
--
-- A message written BEFORE this migration has no tokens and is not found by the search until it is
-- edited. There is no backfill and none is needed: stage A has not been deployed, so production has
-- no chat messages at all when this arrives. On a machine that has been running the branch, the
-- messages from before are simply not findable, which is the honest trade against a script that
-- would have to open every sealed row.
--
-- Prisma's half, with nothing hand-written after it: the rules this table has are in the code that
-- writes it (`server/modules/chat/chat.search.ts`), because a CHECK cannot say "this is an HMAC".

-- CreateTable
CREATE TABLE "ChatSearchToken" (
    "token" BYTEA NOT NULL,
    "chatId" UUID NOT NULL,
    "messageId" UUID NOT NULL,

    CONSTRAINT "ChatSearchToken_pkey" PRIMARY KEY ("token","messageId")
);

-- CreateIndex
CREATE INDEX "ChatSearchToken_token_chatId_idx" ON "ChatSearchToken"("token", "chatId");

-- CreateIndex
CREATE INDEX "ChatSearchToken_messageId_idx" ON "ChatSearchToken"("messageId");

-- AddForeignKey
ALTER TABLE "ChatSearchToken" ADD CONSTRAINT "ChatSearchToken_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSearchToken" ADD CONSTRAINT "ChatSearchToken_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
