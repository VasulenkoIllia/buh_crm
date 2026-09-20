-- S19 stage B (chat.md §6): the files a message carries.
--
-- Additive: one new table, one nullable column on "File", their indexes and foreign keys. No row
-- changes, and nothing existing is touched, so a code-only rollback leaves a harmless empty table
-- and a column nothing writes.
--
-- Prisma's half comes first. What `prisma migrate diff` cannot see is hand-written after it and
-- guarded by server/schema-invariants.test.ts.

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "chatId" UUID;

-- CreateTable
CREATE TABLE "ChatMessageFile" (
    "messageId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "previewFileId" UUID,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ChatMessageFile_pkey" PRIMARY KEY ("messageId","fileId")
);

-- CreateIndex
CREATE INDEX "ChatMessageFile_fileId_idx" ON "ChatMessageFile"("fileId");

-- CreateIndex
CREATE INDEX "ChatMessageFile_previewFileId_idx" ON "ChatMessageFile"("previewFileId");

-- CreateIndex
CREATE INDEX "File_chatId_idx" ON "File"("chatId");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageFile" ADD CONSTRAINT "ChatMessageFile_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageFile" ADD CONSTRAINT "ChatMessageFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageFile" ADD CONSTRAINT "ChatMessageFile_previewFileId_fkey" FOREIGN KEY ("previewFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── what Prisma cannot say (server/schema-invariants.test.ts) ────────────────

-- A chat's file is the chat's alone (chat.md §6.3): never in the library, never on a task, never
-- in a client's Files, never on a secret. Files' lists and its search all read a place, so a row
-- with none of them cannot appear in any of them. `deletedAt` is deliberately NOT here: a chat
-- file whose last live message is deleted goes to the Trash, and is restored into somebody's My
-- files by clearing this column.
ALTER TABLE "File" ADD CONSTRAINT "File_chat_stands_alone" CHECK (
  "chatId" IS NULL
  OR ("scope" IS NULL AND "taskId" IS NULL AND "clientId" IS NULL AND "secretId" IS NULL)
);

-- Ten files a message (§6.1), counted from 0 by the send.
ALTER TABLE "ChatMessageFile" ADD CONSTRAINT "ChatMessageFile_position_in_range"
  CHECK ("position" >= 0 AND "position" <= 9);

-- A photo's preview is a file of its own, never the photo itself: serving it is the one read of a
-- chat file that is not logged, and pointing it at the photo would be a way around that.
ALTER TABLE "ChatMessageFile" ADD CONSTRAINT "ChatMessageFile_preview_is_another_file"
  CHECK ("previewFileId" IS NULL OR "previewFileId" <> "fileId");
