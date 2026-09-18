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

const CHAT_WITH_MEMBERS = {
  members: {
    where: { leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { userId: true, role: true, joinedAt: true, user: { select: PERSON } },
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
