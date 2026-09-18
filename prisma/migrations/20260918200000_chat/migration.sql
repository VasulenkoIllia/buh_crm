-- S19 stage A (chat.md §16): the chat's tables.
--
-- Additive: eight new tables and four enums; not one existing table or row changes. The keys to
-- "User" only matter to a suite that wipes the team (a person is never deleted in production):
-- memberships, reactions, votes and "last seen" go with the person, a message stays and loses its
-- author.
--
-- Prisma's half comes first. What `prisma migrate diff` cannot see is hand-written after it and
-- guarded by server/schema-invariants.test.ts: the CHECKs that hold each row to its shape.

-- CreateEnum
CREATE TYPE "ChatKind" AS ENUM ('direct', 'group', 'saved', 'announcements');

-- CreateEnum
CREATE TYPE "ChatMemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "ChatMessageKind" AS ENUM ('text', 'poll', 'notice');

-- CreateEnum
CREATE TYPE "ChatNotice" AS ENUM ('created', 'renamed', 'member_added', 'member_removed', 'member_left', 'member_blocked', 'role_changed', 'owner_changed');

-- CreateTable
CREATE TABLE "Chat" (
    "id" UUID NOT NULL,
    "kind" "ChatKind" NOT NULL,
    "uniqueKey" TEXT,
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "authTag" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMember" (
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ChatMemberRole" NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMentionSeq" INTEGER NOT NULL DEFAULT 0,
    "mutedUntil" TIMESTAMP(3),
    "pinnedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "ChatMember_pkey" PRIMARY KEY ("chatId","userId")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "ChatMessageKind" NOT NULL DEFAULT 'text',
    "authorId" UUID,
    "clientMessageId" UUID,
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "authTag" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "replyToId" UUID,
    "forwardedFromId" UUID,
    "mentions" UUID[],
    "notice" "ChatNotice",
    "noticeUserIds" UUID[],
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatReaction" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReaction_pkey" PRIMARY KEY ("messageId","userId","emoji")
);

-- CreateTable
CREATE TABLE "ChatPin" (
    "messageId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "pinnedById" UUID,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPin_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "ChatPoll" (
    "messageId" UUID NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,

    CONSTRAINT "ChatPoll_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "ChatPollVote" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "option" INTEGER NOT NULL,
    "votedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPollVote_pkey" PRIMARY KEY ("messageId","userId","option")
);

-- CreateTable
CREATE TABLE "ChatPresence" (
    "userId" UUID NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPresence_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Chat_uniqueKey_key" ON "Chat"("uniqueKey");

-- CreateIndex
CREATE INDEX "ChatMember_userId_leftAt_idx" ON "ChatMember"("userId", "leftAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_chatId_seq_key" ON "ChatMessage"("chatId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_authorId_clientMessageId_key" ON "ChatMessage"("authorId", "clientMessageId");

-- CreateIndex
CREATE INDEX "ChatPin_chatId_idx" ON "ChatPin"("chatId");

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_forwardedFromId_fkey" FOREIGN KEY ("forwardedFromId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPin" ADD CONSTRAINT "ChatPin_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPin" ADD CONSTRAINT "ChatPin_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPin" ADD CONSTRAINT "ChatPin_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPoll" ADD CONSTRAINT "ChatPoll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPoll" ADD CONSTRAINT "ChatPoll_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatPoll"("messageId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPresence" ADD CONSTRAINT "ChatPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A chat other than a group has exactly one place it may exist (direct:<a>:<b>, saved:<id>,
-- announcements), and a group has none; the unique index above does the rest.
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_one_place" CHECK (("kind" = 'group') = ("uniqueKey" IS NULL));

-- Only a group has a title, and a group always has one.
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_title_only_on_group" CHECK (("kind" = 'group') = ("ciphertext" IS NOT NULL));

-- A sealed value is whole or absent: a ciphertext without its iv or tag can never be opened.
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_sealed_whole" CHECK (
  ("ciphertext" IS NULL) = ("iv" IS NULL) AND ("iv" IS NULL) = ("authTag" IS NULL)
);
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sealed_whole" CHECK (
  ("ciphertext" IS NULL) = ("iv" IS NULL) AND ("iv" IS NULL) = ("authTag" IS NULL)
);

-- A message's place in its chat starts at 1; the unique index keeps two messages out of one place.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_seq_positive" CHECK ("seq" > 0);

-- A notice says what it says by its code, never by text, and only a notice has a code. Every
-- other message was sent by somebody, once, which is what its client id is for.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_notice_shape" CHECK (
  (("kind" = 'notice') = ("notice" IS NOT NULL))
  AND ("kind" <> 'notice' OR "ciphertext" IS NULL)
  AND ("kind" = 'notice' OR "clientMessageId" IS NOT NULL)
);

-- One emoji, not a sentence: a reaction is plain text on purpose, so it must stay an emoji.
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_emoji_short" CHECK (char_length("emoji") BETWEEN 1 AND 32);

-- A poll has 2 to 10 options, counted from 0.
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_option_range" CHECK ("option" BETWEEN 0 AND 9);

-- The read markers only count up from the start.
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_markers" CHECK ("lastReadSeq" >= 0 AND "lastMentionSeq" >= 0);
