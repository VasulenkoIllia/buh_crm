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
