import type { ChatMemberRole, ChatNotice, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

/**
 * The chat's database access (architecture.md §3). Services decide; this reads and writes.
 */

// ── the announcements channel ─────────────────────────────────────────────────

/** The channel's row, made when it is missing; its unique key makes a second one impossible. */
export async function upsertChannel(uniqueKey: string): Promise<string> {
  const channel = await prisma.chat.upsert({
    where: { uniqueKey },
    create: { kind: "announcements", uniqueKey },
    update: {},
    select: { id: true },
  });
  return channel.id;
}

export async function activeUserIds(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  return rows.map((u) => u.id);
}

/**
 * The channel's membership made to match these people, in one transaction: each of them in it
 * (back in it, after an unblock), and every other membership ended.
 */
export async function matchChannelMembers(chatId: string, userIds: string[], now: Date) {
  await prisma.$transaction([
    prisma.chatMember.createMany({
      data: userIds.map((userId) => ({ chatId, userId })),
      skipDuplicates: true,
    }),
    prisma.chatMember.updateMany({
      where: { chatId, userId: { in: userIds }, leftAt: { not: null } },
      data: { leftAt: null, joinedAt: now },
    }),
    prisma.chatMember.updateMany({
      where: { chatId, userId: { notIn: userIds }, leftAt: null },
      data: { leftAt: now },
    }),
  ]);
}

// ── people and memberships ─────────────────────────────────────────────────────

/** What the chat shows of a person (`ChatPerson`). */
export const PERSON = {
  id: true,
  firstName: true,
  lastName: true,
  avatarFileId: true,
  status: true,
} as const satisfies Prisma.UserSelect;

/** The people one may start a chat with: the active team, with when each was last online. */
export function colleagues() {
  return prisma.user.findMany({
    where: { status: "active" },
    select: { ...PERSON, chatPresence: { select: { lastSeenAt: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

export function findActiveUsers(ids: readonly string[]) {
  return prisma.user.findMany({
    where: { id: { in: [...ids] }, status: "active" },
    select: PERSON,
  });
}

export function findPerson(id: string) {
  return prisma.user.findUnique({ where: { id }, select: PERSON });
}

/** The newest message, for the one line the chat list shows (§4.2). */
const LAST_MESSAGE = {
  orderBy: { seq: "desc" },
  take: 1,
  select: {
    seq: true,
    authorId: true,
    kind: true,
    notice: true,
    deletedAt: true,
    createdAt: true,
    ciphertext: true,
    iv: true,
    authTag: true,
    keyVersion: true,
    /** so a photo sent with no words is "Photo" in the list rather than an empty line (§4.2) */
    _count: { select: { files: true } },
  },
} as const satisfies Prisma.Chat$messagesArgs;

const CHAT_WITH_MEMBERS = {
  messages: LAST_MESSAGE,
  members: {
    where: { leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: {
      userId: true,
      role: true,
      joinedAt: true,
      lastReadSeq: true,
      lastReadAt: true,
      user: { select: PERSON },
    },
  },
} as const satisfies Prisma.ChatInclude;

/** Every chat the person is in now, with each chat's current people. */
export function membershipsOf(userId: string) {
  return prisma.chatMember.findMany({
    where: { userId, leftAt: null },
    include: { chat: { include: CHAT_WITH_MEMBERS } },
  });
}

/** One person's place in one chat, active or not, with the chat and its current people. */
export function membershipIn(chatId: string, userId: string) {
  return prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    include: { chat: { include: CHAT_WITH_MEMBERS } },
  });
}

export type MembershipRow = NonNullable<Awaited<ReturnType<typeof membershipIn>>>;

export function updateOwnSettings(
  chatId: string,
  userId: string,
  data: { mutedUntil?: Date | null; pinnedAt?: Date | null; hiddenAt?: Date | null },
) {
  return prisma.chatMember.update({ where: { chatId_userId: { chatId, userId } }, data });
}

export async function lastSeen(userId: string, at: Date) {
  await prisma.chatPresence.upsert({
    where: { userId },
    create: { userId, lastSeenAt: at },
    update: { lastSeenAt: at },
  });
}

// ── one chat per place ─────────────────────────────────────────────────────────

/**
 * The direct chat of two people, or somebody's Saved messages: found, or made with its members.
 * Two requests making the same one at once meet on the unique key; the loser reads the winner's.
 */
export async function findOrCreatePlace(
  kind: "direct" | "saved",
  uniqueKey: string,
  memberIds: readonly string[],
  createdById: string,
): Promise<string> {
  const existing = await prisma.chat.findUnique({ where: { uniqueKey }, select: { id: true } });
  if (existing) return existing.id;
  try {
    const chat = await prisma.chat.create({
      data: {
        kind,
        uniqueKey,
        createdById,
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    return chat.id;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await prisma.chat.findUniqueOrThrow({
      where: { uniqueKey },
      select: { id: true },
    });
    return winner.id;
  }
}

// ── writing inside a transaction ───────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

export function transaction<T>(fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(fn, { timeout: 15_000 });
}

/**
 * **The chat's next place, taken under its row's lock** (chat.md §16): concurrent writes to one
 * chat queue on this UPDATE, so no two get the same `seq` and none is skipped. Moves the chat's
 * last activity with it, which is what orders the list and unhides it.
 */
export async function nextSeq(tx: Tx, chatId: string, at: Date): Promise<number> {
  const [row] = await tx.$queryRaw<{ lastSeq: number }[]>`
    UPDATE "Chat" SET "lastSeq" = "lastSeq" + 1, "lastActivityAt" = ${at}
    WHERE "id" = ${chatId}::uuid
    RETURNING "lastSeq"`;
  return row.lastSeq;
}

/** A line the chat writes itself: a code and the people it is about, never text. */
export async function writeNotice(
  tx: Tx,
  chatId: string,
  notice: ChatNotice,
  about: readonly string[],
  authorId: string | null,
  at: Date,
): Promise<number> {
  const seq = await nextSeq(tx, chatId, at);
  await tx.chatMessage.create({
    data: {
      chatId,
      seq,
      kind: "notice",
      notice,
      noticeUserIds: [...about],
      authorId,
      createdAt: at,
    },
  });
  return seq;
}

export function createGroupTx(
  tx: Tx,
  sealed: {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  },
  ownerId: string,
  memberIds: readonly string[],
  at: Date,
) {
  return tx.chat.create({
    data: {
      kind: "group",
      ...sealed,
      createdById: ownerId,
      lastActivityAt: at,
      members: {
        create: [
          { userId: ownerId, role: "owner", joinedAt: at },
          ...memberIds.map((userId) => ({ userId, joinedAt: at })),
        ],
      },
    },
    select: { id: true },
  });
}

export function setGroupWords(
  tx: Tx,
  chatId: string,
  sealed: {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  },
) {
  return tx.chat.update({ where: { id: chatId }, data: sealed });
}

/** Locks the chat's row, so two changes to one group's people happen one after the other. */
export async function lockChat(tx: Tx, chatId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Chat" WHERE "id" = ${chatId}::uuid FOR UPDATE`;
}

export function activeMembersTx(tx: Tx, chatId: string) {
  return tx.chatMember.findMany({
    where: { chatId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { userId: true, role: true, joinedAt: true },
  });
}

/**
 * Adds a person, or brings back one who left: a member again, reading from now, and able to scroll
 * the whole history (decision 4).
 */
export function joinTx(tx: Tx, chatId: string, userId: string, readUpTo: number, at: Date) {
  return tx.chatMember.upsert({
    where: { chatId_userId: { chatId, userId } },
    create: { chatId, userId, joinedAt: at, lastReadSeq: readUpTo },
    update: {
      leftAt: null,
      role: "member",
      joinedAt: at,
      lastReadSeq: readUpTo,
      hiddenAt: null,
      pinnedAt: null,
    },
  });
}

export function leaveTx(tx: Tx, chatId: string, userId: string, at: Date) {
  return tx.chatMember.update({
    where: { chatId_userId: { chatId, userId } },
    data: { leftAt: at, role: "member" },
  });
}

export function setRoleTx(tx: Tx, chatId: string, userId: string, role: ChatMemberRole) {
  return tx.chatMember.update({ where: { chatId_userId: { chatId, userId } }, data: { role } });
}

export function lastSeqTx(tx: Tx, chatId: string) {
  return tx.chat.findUniqueOrThrow({ where: { id: chatId }, select: { lastSeq: true } });
}

/** Every group a person is in now, for a block (chat.md §11). */
export function activeGroupsOfTx(tx: Tx, userId: string) {
  return tx.chatMember.findMany({
    where: { userId, leftAt: null, chat: { kind: "group" } },
    select: {
      chatId: true,
      role: true,
      chat: { select: { ciphertext: true, iv: true, authTag: true, keyVersion: true } },
    },
  });
}

export function leaveChannelTx(tx: Tx, userId: string, at: Date) {
  return tx.chatMember.updateMany({
    where: { userId, leftAt: null, chat: { kind: "announcements" } },
    data: { leftAt: at },
  });
}

// ── messages (chat.md §5) ──────────────────────────────────────────────────────

/**
 * Everything one message shows: who reacted, whether it is pinned, its poll and its votes, and the
 * files it carries (§6.3) — names and sizes, never bytes.
 */
const MESSAGE_PARTS = {
  files: {
    select: {
      fileId: true,
      previewFileId: true,
      position: true,
      file: { select: { name: true, size: true, detectedMime: true } },
    },
    orderBy: { position: "asc" },
  },
  reactions: { select: { emoji: true, userId: true } },
  pin: { select: { messageId: true } },
  poll: {
    select: {
      multiple: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      keyVersion: true,
      closedAt: true,
      votes: { select: { option: true, userId: true } },
    },
  },
  replyTo: {
    select: {
      id: true,
      seq: true,
      authorId: true,
      deletedAt: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      keyVersion: true,
    },
  },
} as const satisfies Prisma.ChatMessageInclude;

export type MessageRow = Prisma.ChatMessageGetPayload<{ include: typeof MESSAGE_PARTS }>;

export function messageById(messageId: string) {
  return prisma.chatMessage.findUnique({
    where: { id: messageId },
    include: { ...MESSAGE_PARTS, chat: { select: { id: true, kind: true } } },
  });
}

export function messagesById(ids: readonly string[]) {
  return prisma.chatMessage.findMany({
    where: { id: { in: [...ids] } },
    include: MESSAGE_PARTS,
    orderBy: { seq: "asc" },
  });
}

/**
 * A page of history (§7.2): the newest 50, the 50 below a place, or everything after one, which is
 * how a tab catches up when its connection comes back.
 */
export async function messagePage(
  chatId: string,
  opts: { before?: number; after?: number; limit: number },
): Promise<{ rows: MessageRow[]; more: boolean }> {
  if (opts.after !== undefined) {
    const rows = await prisma.chatMessage.findMany({
      where: { chatId, seq: { gt: opts.after } },
      include: MESSAGE_PARTS,
      orderBy: { seq: "asc" },
      take: opts.limit + 1,
    });
    return { rows: rows.slice(0, opts.limit), more: rows.length > opts.limit };
  }
  const rows = await prisma.chatMessage.findMany({
    where: { chatId, ...(opts.before ? { seq: { lt: opts.before } } : {}) },
    include: MESSAGE_PARTS,
    orderBy: { seq: "desc" },
    take: opts.limit + 1,
  });
  const page = rows.slice(0, opts.limit).reverse();
  return { rows: page, more: rows.length > opts.limit };
}

export function pinnedMessages(chatId: string) {
  return prisma.chatMessage.findMany({
    where: { chatId, pin: { isNot: null } },
    include: MESSAGE_PARTS,
    orderBy: { seq: "asc" },
  });
}

/** The same send, already posted in THIS chat: what a retry after a lost connection is answered with. */
export function sentAlready(chatId: string, authorId: string, clientMessageId: string) {
  return prisma.chatMessage.findUnique({
    where: { chatId_authorId_clientMessageId: { chatId, authorId, clientMessageId } },
    include: MESSAGE_PARTS,
  });
}

export interface NewMessage {
  chatId: string;
  seq: number;
  authorId: string;
  clientMessageId: string;
  sealed: {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  } | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  mentions?: string[];
  kind?: "text" | "poll";
  at: Date;
}

export function insertMessageTx(tx: Tx, m: NewMessage) {
  return tx.chatMessage.create({
    data: {
      chatId: m.chatId,
      seq: m.seq,
      kind: m.kind ?? "text",
      authorId: m.authorId,
      clientMessageId: m.clientMessageId,
      ...(m.sealed ?? {}),
      replyToId: m.replyToId ?? null,
      forwardedFromId: m.forwardedFromId ?? null,
      mentions: m.mentions ?? [],
      createdAt: m.at,
    },
    select: { id: true },
  });
}

export function insertPollTx(
  tx: Tx,
  messageId: string,
  multiple: boolean,
  sealed: {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  },
) {
  return tx.chatPoll.create({ data: { messageId, multiple, ...sealed } });
}

/** The sender has read their own message, and everybody named in it has an `@` waiting. */
export async function markSentTx(
  tx: Tx,
  chatId: string,
  authorId: string,
  seq: number,
  mentioned: readonly string[],
) {
  await tx.chatMember.updateMany({
    where: { chatId, userId: authorId, lastReadSeq: { lt: seq } },
    data: { lastReadSeq: seq },
  });
  if (mentioned.length > 0) {
    await tx.chatMember.updateMany({
      where: { chatId, userId: { in: [...mentioned] }, leftAt: null },
      data: { lastMentionSeq: seq },
    });
  }
}

export function editMessage(
  messageId: string,
  sealed: {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  },
  at: Date,
) {
  return prisma.chatMessage.update({
    where: { id: messageId },
    data: { ...sealed, editedAt: at },
  });
}

/**
 * **A delete for everyone destroys the text at once** (§5.3): the sealed columns are cleared, so
 * nothing is left to open. The row stays, so the chat's places have no hole, and it reads
 * "Message deleted".
 */
/**
 * **The delete, once.** Guarded by `deletedAt: null` and answered by the count, so two clicks — or
 * two people deleting the same message in the same instant — write one row in the log rather than
 * two describing one act (audit, 2026-09-20).
 */
export async function deleteMessage(
  messageId: string,
  byUserId: string,
  at: Date,
): Promise<boolean> {
  const { count } = await prisma.chatMessage.updateMany({
    where: { id: messageId, deletedAt: null },
    data: {
      ciphertext: null,
      iv: null,
      authTag: null,
      deletedAt: at,
      deletedById: byUserId,
      mentions: [],
    },
  });
  return count === 1;
}

/**
 * **Of these files, the ones a live message OTHER than this one still carries** — asked inside the
 * delete's own transaction, with the rows locked first.
 *
 * The lock is the whole point. Two deletes of the two messages carrying one forwarded file each
 * asked this outside a transaction, each saw the other's message still live, and NEITHER trashed
 * the file: it stayed live with nothing carrying it, reachable by nobody and swept by nothing
 * (found by the test written for the review's own finding, 2026-09-20). Locked, the second to
 * arrive reads the first's delete and disposes of it.
 */
export async function carriedElsewhereTx(
  tx: Tx,
  fileIds: readonly string[],
  exceptMessageId: string,
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  // ORDER BY: two transactions locking an overlapping set must take the rows in the same order, and
  // the planner's physical order is a habit rather than a promise (audits, 2026-09-20)
  await tx.$queryRaw`
    SELECT id FROM "File" WHERE id = ANY(${[...fileIds]}::uuid[]) ORDER BY id FOR UPDATE`;
  const rows = await tx.chatMessageFile.findMany({
    where: {
      messageId: { not: exceptMessageId },
      message: { deletedAt: null },
      OR: [{ fileId: { in: [...fileIds] } }, { previewFileId: { in: [...fileIds] } }],
    },
    select: { fileId: true, previewFileId: true },
  });
  const held = new Set<string>();
  for (const row of rows) {
    held.add(row.fileId);
    if (row.previewFileId) held.add(row.previewFileId);
  }
  return held;
}

export function linksOfMessageTx(tx: Tx, messageId: string) {
  return tx.chatMessageFile.findMany({
    where: { messageId },
    select: { fileId: true, previewFileId: true, position: true },
    orderBy: { position: "asc" },
  });
}

export function filesByIdsTx(tx: Tx, ids: readonly string[]) {
  return tx.file.findMany({ where: { id: { in: [...ids] } }, select: CHAT_FILE });
}

export function deleteFileRowsTx(tx: Tx, ids: readonly string[]) {
  return tx.file.deleteMany({ where: { id: { in: [...ids] } } });
}

export async function toggleReaction(messageId: string, userId: string, emoji: string) {
  const existing = await prisma.chatReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });
  if (existing) {
    await prisma.chatReaction.delete({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    return false;
  }
  await prisma.chatReaction.create({ data: { messageId, userId, emoji } });
  return true;
}

export function pinMessage(messageId: string, chatId: string, byUserId: string) {
  return prisma.chatPin.upsert({
    where: { messageId },
    create: { messageId, chatId, pinnedById: byUserId },
    update: {},
  });
}

export function unpinMessage(messageId: string) {
  return prisma.chatPin.deleteMany({ where: { messageId } });
}

export async function replaceVotes(
  messageId: string,
  userId: string,
  options: readonly number[],
) {
  await prisma.$transaction([
    prisma.chatPollVote.deleteMany({ where: { messageId, userId } }),
    prisma.chatPollVote.createMany({
      data: options.map((option) => ({ messageId, userId, option })),
      skipDuplicates: true,
    }),
  ]);
}

export function closePoll(messageId: string, byUserId: string, at: Date) {
  return prisma.chatPoll.update({
    where: { messageId },
    data: { closedAt: at, closedById: byUserId },
  });
}

export function peopleByIds(ids: readonly string[]) {
  return prisma.user.findMany({ where: { id: { in: [...ids] } }, select: PERSON });
}

/**
 * **A read marker only moves forward** (§19): a page read out of order, or an answer that crossed
 * a scroll, can never take it back. The count says whether it moved at all, so a marker standing
 * still tells nobody anything.
 */
export async function markRead(chatId: string, userId: string, seq: number, at: Date) {
  const { count } = await prisma.chatMember.updateMany({
    where: { chatId, userId, leftAt: null, lastReadSeq: { lt: seq } },
    data: { lastReadSeq: seq, lastReadAt: at },
  });
  return count === 1;
}

/** Who in the chat has read as far as this place, and when their marker last moved. */
export function readersOf(chatId: string, seq: number) {
  return prisma.chatMember.findMany({
    where: { chatId, leftAt: null, lastReadSeq: { gte: seq } },
    select: { lastReadAt: true, user: { select: PERSON } },
    orderBy: { lastReadAt: "asc" },
  });
}

// ── files (chat.md §6) ─────────────────────────────────────────────────────────

/** Everything a chat file's row is asked for: what it shows, and what opens its bytes. */
export const CHAT_FILE = {
  id: true,
  name: true,
  size: true,
  mime: true,
  detectedMime: true,
  path: true,
  storage: true,
  wrappedKey: true,
  keyVersion: true,
  uploadedById: true,
  chatId: true,
  createdAt: true,
} as const satisfies Prisma.FileSelect;

export type ChatFileRow = Prisma.FileGetPayload<{ select: typeof CHAT_FILE }>;

export interface NewChatFile {
  chatId: string;
  name: string;
  size: number;
  mime: string;
  detectedMime: string | null;
  path: string;
  storage: "local" | "s3";
  wrappedKey: Uint8Array<ArrayBuffer>;
  keyVersion: number;
  uploadedById: string;
}

/** A file sent into a chat: no place in the library, no task, no client, no secret (§6.3). */
export function insertChatFile(file: NewChatFile) {
  return prisma.file.create({ data: file, select: CHAT_FILE });
}

export function deleteFileRow(fileId: string) {
  return prisma.file.delete({ where: { id: fileId } });
}

/** Carried by no message at all: an upload waiting for its send, or one nobody ever sent. */
const UNSENT = { inChatMessages: { none: {} }, previewInChatMessages: { none: {} } } as const;

/**
 * The uploads this person made into THIS chat that no message carries yet — what a send may name
 * (§6.1). Somebody else's upload, one made into another chat and one already sent are all simply
 * not here, and the send refuses what it cannot find.
 */
export function unsentUploads(chatId: string, uploaderId: string, ids: readonly string[]) {
  return prisma.file.findMany({
    where: {
      id: { in: [...ids] },
      chatId,
      uploadedById: uploaderId,
      deletedAt: null,
      ...UNSENT,
    },
    select: CHAT_FILE,
  });
}

export function linkFilesTx(
  tx: Tx,
  messageId: string,
  files: readonly { fileId: string; previewFileId: string | null; position: number }[],
) {
  return tx.chatMessageFile.createMany({
    data: files.map((f) => ({ messageId, ...f })),
  });
}

/** A live message of a chat this person is in: the one thing that opens a chat file (§6.3). */
const REACHABLE = (userId: string) =>
  ({
    some: {
      message: {
        deletedAt: null,
        chat: { members: { some: { userId, leftAt: null } } },
      },
    },
  }) as const;

/**
 * **Who may open a chat file** (§6.3): a member of any chat holding a live message that carries
 * it, as the file or as its photo preview. Its uploader may open it while nothing carries it yet,
 * which is the composer showing what is about to be sent.
 *
 * A deleted message's files are not here, and neither is a file in the Trash.
 */
export function openableChatFile(fileId: string, userId: string) {
  return prisma.file.findFirst({
    where: {
      id: fileId,
      chatId: { not: null },
      deletedAt: null,
      OR: [
        { inChatMessages: REACHABLE(userId) },
        { previewInChatMessages: REACHABLE(userId) },
        { uploadedById: userId, ...UNSENT },
      ],
    },
    select: CHAT_FILE,
  });
}

/**
 * **The preview door's own question** (§6.2), deliberately narrower than the one above: a file that
 * a live message names AS A PREVIEW, or an upload of the caller's that nothing carries yet.
 *
 * It must not accept a file that a message carries as the file itself. A photo sent as the
 * attachment — a screenshot, a scan — is an `image/jpeg` like its thumbnail, so the wider question
 * would let anybody who may open it fetch the same bytes through the one door that writes no log
 * row and may be cached for a week (security review, 2026-09-20).
 */
export function openableChatPreview(fileId: string, userId: string) {
  return prisma.file.findFirst({
    where: {
      id: fileId,
      chatId: { not: null },
      deletedAt: null,
      OR: [{ previewInChatMessages: REACHABLE(userId) }, { uploadedById: userId, ...UNSENT }],
    },
    select: CHAT_FILE,
  });
}

/**
 * **Delete this upload only if it is STILL unsent** — the sweep's snapshot is minutes old by the
 * time it reaches a row, and a send in between would have linked it. Deleting it then would take
 * the link with it through the cascade and leave the message with a hole, which is the one thing
 * the send's own check exists to prevent (review, 2026-09-20). The count says whether the row went;
 * its bytes are removed only then.
 */
export async function deleteIfStillUnsent(fileId: string): Promise<boolean> {
  const { count } = await prisma.file.deleteMany({
    where: { id: fileId, chatId: { not: null }, deletedAt: null, ...UNSENT },
  });
  return count === 1;
}

/**
 * **Files a message once carried that no LIVE message carries any more, and that nobody put in the
 * Trash.** The disposal happens inside the delete's transaction, so this should always be empty —
 * but if that transaction fails after the message's own delete has committed (a lock timeout, a
 * restart between the two statements), the file is left live, reachable by nobody, in no Trash and
 * taken by no sweep: kept for ever with nothing able to show it. The nightly job is the net.
 *
 * Which is which is said by the caller: a file that is somebody's preview goes, the rest go to the
 * Trash, exactly as a delete would have done.
 */
export function strandedChatFiles(limit: number) {
  return prisma.file.findMany({
    where: {
      chatId: { not: null },
      deletedAt: null,
      // it was carried once…
      OR: [{ inChatMessages: { some: {} } }, { previewInChatMessages: { some: {} } }],
      // …and nothing live carries it now
      AND: [
        { inChatMessages: { none: { message: { deletedAt: null } } } },
        { previewInChatMessages: { none: { message: { deletedAt: null } } } },
      ],
    },
    select: {
      id: true,
      path: true,
      storage: true,
      previewInChatMessages: { select: { messageId: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Uploads no message ever named, older than this: the nightly sweep's work (§6.1). */
export function staleUploads(before: Date, limit: number) {
  return prisma.file.findMany({
    where: { chatId: { not: null }, deletedAt: null, createdAt: { lt: before }, ...UNSENT },
    select: { id: true, path: true, storage: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * **What a forward may copy, read at the moment it copies it**: the source if it is still live, and
 * of its files the ones still live too. A delete a moment earlier trashes a file nothing else
 * carries, and copying that link would put a dead attachment on a brand-new message (review,
 * 2026-09-20).
 */
export function sourceForForward(messageId: string) {
  return prisma.chatMessage.findFirst({
    where: { id: messageId, deletedAt: null },
    select: {
      id: true,
      // the words as they read NOW: an edit between the batch read and this copy would otherwise
      // forward what the message used to say (audit, 2026-09-20)
      ciphertext: true,
      iv: true,
      authTag: true,
      keyVersion: true,
      files: {
        where: { file: { deletedAt: null } },
        select: { fileId: true, previewFileId: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  });
}

/**
 * **The uploads a send is claiming, locked and checked inside its own transaction.** `forSend`
 * asks the same question before the transaction, which is what gives a person a clear refusal; this
 * is what makes it true: two sends naming the same upload in the same instant both passed that
 * check and both linked it (review, 2026-09-20). The second waits on the lock, reads the link the
 * first committed, and is refused.
 */
export async function claimUploadsTx(
  tx: Tx,
  chatId: string,
  uploaderId: string,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  await tx.$queryRaw`
    SELECT id FROM "File" WHERE id = ANY(${[...ids]}::uuid[]) ORDER BY id FOR UPDATE`;
  const still = await tx.file.findMany({
    where: {
      id: { in: [...ids] },
      chatId,
      uploadedById: uploaderId,
      deletedAt: null,
      ...UNSENT,
    },
    select: { id: true },
  });
  return still.length === ids.length;
}

/** One message's files, for a delete deciding what to put in the Trash and for a forward. */
export function linksOfMessage(messageId: string) {
  return prisma.chatMessageFile.findMany({
    where: { messageId },
    select: { fileId: true, previewFileId: true, position: true },
    orderBy: { position: "asc" },
  });
}

/**
 * Of these files, the ones a LIVE message other than this one still carries — as the file itself
 * or as a photo's preview. What is left is what a delete disposes of (§6.3).
 */
export async function stillCarried(
  fileIds: readonly string[],
  exceptMessageId: string,
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const rows = await prisma.chatMessageFile.findMany({
    where: {
      messageId: { not: exceptMessageId },
      message: { deletedAt: null },
      OR: [{ fileId: { in: [...fileIds] } }, { previewFileId: { in: [...fileIds] } }],
    },
    select: { fileId: true, previewFileId: true },
  });
  const held = new Set<string>();
  for (const row of rows) {
    held.add(row.fileId);
    if (row.previewFileId) held.add(row.previewFileId);
  }
  return held;
}

export async function deleteFileRowIfLive(fileId: string): Promise<boolean> {
  const { count } = await prisma.file.deleteMany({ where: { id: fileId, deletedAt: null } });
  return count === 1;
}

export async function trashFileIfLiveTx(
  tx: Tx,
  fileId: string,
  byUserId: string | null,
  at: Date,
  batchId: string,
): Promise<boolean> {
  const { count } = await tx.file.updateMany({
    where: { id: fileId, deletedAt: null },
    data: { deletedAt: at, deletedById: byUserId, trashBatchId: batchId },
  });
  return count === 1;
}

export function filesByIds(ids: readonly string[]) {
  return prisma.file.findMany({ where: { id: { in: [...ids] } }, select: CHAT_FILE });
}

/** A file's own row, whatever chat it came from: what a forward copies without moving bytes. */
export function copyLinksTx(
  tx: Tx,
  messageId: string,
  links: readonly { fileId: string; previewFileId: string | null; position: number }[],
) {
  return linkFilesTx(tx, messageId, links);
}

/**
 * **A chat's own files** (§6.4), newest first: what the Files tab lists. A deleted message's files
 * are not here, and neither is one in the Trash — the tab shows what the chat still carries.
 */
export async function filesOfChat(
  chatId: string,
  opts: { q?: string; senderId?: string; before?: number; limit: number },
) {
  const rows = await prisma.chatMessageFile.findMany({
    where: {
      message: {
        chatId,
        deletedAt: null,
        ...(opts.senderId ? { authorId: opts.senderId } : {}),
        ...(opts.before ? { seq: { lt: opts.before } } : {}),
      },
      file: {
        deletedAt: null,
        ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" as const } } : {}),
      },
    },
    select: {
      fileId: true,
      previewFileId: true,
      position: true,
      file: { select: { name: true, size: true, detectedMime: true } },
      message: { select: { id: true, seq: true, authorId: true, createdAt: true } },
    },
    orderBy: [{ message: { seq: "desc" } }, { position: "desc" }],
    take: opts.limit + 1,
  });
  return { rows: rows.slice(0, opts.limit), more: rows.length > opts.limit };
}

// ── the word search (chat.md §8) ───────────────────────────────────────────────

export type { Tx };

export function insertTokensTx(
  tx: Tx,
  chatId: string,
  messageId: string,
  tokens: readonly Uint8Array<ArrayBuffer>[],
) {
  return tx.chatSearchToken.createMany({
    data: tokens.map((token) => ({ token, chatId, messageId })),
    skipDuplicates: true,
  });
}

export function insertTokens(
  chatId: string,
  messageId: string,
  tokens: readonly Uint8Array<ArrayBuffer>[],
) {
  return insertTokensTx(prisma, chatId, messageId, tokens);
}

export function clearTokens(messageId: string) {
  return prisma.chatSearchToken.deleteMany({ where: { messageId } });
}

/** What a hit says about the chat it is in: enough to name it to a member (§8). */
const CHAT_FOR_LABEL = {
  id: true,
  kind: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  keyVersion: true,
  members: { where: { leftAt: null }, select: { userId: true, user: { select: PERSON } } },
} as const satisfies Prisma.ChatSelect;

export type ChatForLabel = Prisma.ChatGetPayload<{ select: typeof CHAT_FOR_LABEL }>;

export async function chatsByIds(ids: readonly string[]): Promise<Map<string, ChatForLabel>> {
  const rows = await prisma.chat.findMany({
    where: { id: { in: [...ids] } },
    select: CHAT_FOR_LABEL,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

export interface SearchFilters {
  chatId?: string;
  senderId?: string;
  from?: Date;
  to?: Date;
  hasFiles?: boolean;
  skip: number;
  take: number;
}

/**
 * **The messages holding every one of these words**, newest first, in the chats this person is in
 * NOW (§8). Raw SQL because the shape is a grouped intersection — one row per message, counted
 * over the tokens it matched — which Prisma cannot express, and because the membership join
 * belongs inside the query rather than around it: a filter applied afterwards would make the page
 * sizes and "there is more" wrong.
 */
export function searchMessages(
  userId: string,
  tokens: readonly Uint8Array<ArrayBuffer>[],
  f: SearchFilters,
): Promise<
  {
    id: string;
    chatId: string;
    seq: number;
    authorId: string | null;
    createdAt: Date;
    ciphertext: Uint8Array | null;
    iv: Uint8Array | null;
    authTag: Uint8Array | null;
    keyVersion: number;
  }[]
> {
  return prisma.$queryRaw`
    SELECT m.id, m."chatId", m.seq, m."authorId", m."createdAt",
           m.ciphertext, m.iv, m."authTag", m."keyVersion"
    FROM "ChatMessage" m
    JOIN "ChatSearchToken" t ON t."messageId" = m.id
    JOIN "ChatMember" cm ON cm."chatId" = m."chatId"
      AND cm."userId" = ${userId}::uuid AND cm."leftAt" IS NULL
    WHERE t.token = ANY(${tokens.map((t) => Buffer.from(t))}::bytea[])
      AND m."deletedAt" IS NULL
      AND (${f.chatId ?? null}::uuid IS NULL OR m."chatId" = ${f.chatId ?? null}::uuid)
      -- the token table carries the chat of its own, which is what its (token, chatId) index is
      -- for: searching ONE chat reads that index instead of every message holding the word
      AND (${f.chatId ?? null}::uuid IS NULL OR t."chatId" = ${f.chatId ?? null}::uuid)
      AND (${f.senderId ?? null}::uuid IS NULL OR m."authorId" = ${f.senderId ?? null}::uuid)
      AND (${f.from ?? null}::timestamptz IS NULL OR m."createdAt" >= ${f.from ?? null}::timestamptz)
      AND (${f.to ?? null}::timestamptz IS NULL OR m."createdAt" <= ${f.to ?? null}::timestamptz)
      AND (
        ${f.hasFiles ?? false} = false
        OR EXISTS (SELECT 1 FROM "ChatMessageFile" mf WHERE mf."messageId" = m.id)
      )
    GROUP BY m.id
    HAVING count(DISTINCT t.token) = ${tokens.length}
    -- the id as well: two messages written in the same millisecond have no order of their own, and
    -- a page boundary inside such a pair would repeat one and skip the other (review, 2026-09-20)
    ORDER BY m."createdAt" DESC, m.id DESC
    LIMIT ${f.take} OFFSET ${f.skip}
  `;
}
