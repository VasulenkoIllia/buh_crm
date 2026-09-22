-- The chat, on the link between a message and the file it carries.
--
-- `ChatMessageFile` held only `messageId` and `fileId`, so "what is every chat of THIS person
-- holding" had no way to narrow before it started: the planner scanned the whole firm's link table
-- on every call and only then joined outward to find whose chats those messages were in. Measured
-- with EXPLAIN ANALYZE against a synthetic year of one group (audit, 2026-09-22) — the cost
-- followed the FIRM's files, not the reader's, for every reader at once. With this column the
-- reader's own chat ids narrow it first, off the small `ChatMember(userId, leftAt)` index.
--
-- **The database keeps it true**, rather than the code remembering to: the column is half of a
-- composite foreign key onto `ChatMessage (id, chatId)`, so a link naming a chat that is not its
-- message's cannot be written at all. It is the same shape `File` already uses for a folder's
-- scope (`Folder (id, scope)`, files.md §14.2), and `ON UPDATE CASCADE` carries a change the one
-- way it could ever happen.
--
-- Additive, and on PRODUCTION it lands on a table that does not exist yet: the chat's own tables
-- ship in this same undeployed batch (20260918200000_chat, 20260920160000_chat_files), so there is
-- nothing to backfill and nothing to lock there. Doing it now is the last moment it is free.
--
-- It is still written the way it would have to be against a populated table — nullable, filled
-- from the messages, then made NOT NULL — because a development database HAS rows, and because a
-- migration that only works on an empty table is a trap for whoever reads it next.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_id_chatId_key" UNIQUE ("id", "chatId");

ALTER TABLE "ChatMessageFile" ADD COLUMN "chatId" UUID;

UPDATE "ChatMessageFile" cmf
SET "chatId" = m."chatId"
FROM "ChatMessage" m
WHERE m.id = cmf."messageId";

ALTER TABLE "ChatMessageFile" ALTER COLUMN "chatId" SET NOT NULL;

CREATE INDEX "ChatMessageFile_chatId_idx" ON "ChatMessageFile"("chatId");

ALTER TABLE "ChatMessageFile"
  ADD CONSTRAINT "ChatMessageFile_messageId_chatId_fkey"
  FOREIGN KEY ("messageId", "chatId") REFERENCES "ChatMessage"("id", "chatId")
  ON DELETE CASCADE ON UPDATE CASCADE;
