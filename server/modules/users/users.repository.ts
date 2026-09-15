import type { Prisma, UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import type { StoredFile } from "../../core/files.js";

export function listUsers() {
  return prisma.user.findMany({
    orderBy: [{ status: "asc" }, { firstName: "asc" }],
  });
}

export function findById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findByEmail(email: string) {
  // case-insensitive so the invite duplicate-check can't be fooled by a
  // mixed-case existing row (would otherwise let a second account slip in);
  // deterministic orderBy resolves a legacy case-collision pair to a stable row
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
}

export function createInvitedUser(email: string, role: "admin" | "user") {
  return prisma.user.create({
    data: {
      email,
      role,
      status: "invited",
      invitedAt: new Date(),
      // names are set by the user on acceptance
      firstName: "",
      lastName: "",
    },
  });
}

export function updateUser(id: string, data: Prisma.UserUpdateInput) {
  return prisma.user.update({ where: { id }, data });
}

/**
 * **Blocking, in one transaction with what it moves** (files.md §8.3). The guarded update locks the
 * row first and makes the second of two Block clicks a no-op: only the request that really changes
 * the status runs `alsoInTx`. An upload into the person's My files, which takes a share lock on
 * this row, waits for it and then finds them blocked.
 */
export function blockUser<T>(
  id: string,
  data: Prisma.UserUpdateInput,
  alsoInTx: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(
    async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, status: { not: "blocked" } },
        data: { status: "blocked" },
      });
      const moved = changed.count === 1 ? await alsoInTx(tx) : null;
      const user = await tx.user.update({ where: { id }, data });
      return { user, moved };
    },
    { timeout: 30_000 },
  );
}

export function createInviteToken(userId: string, tokenHash: string, expiresAt: Date) {
  return prisma.authToken.create({
    data: { userId, type: "invite", tokenHash, expiresAt },
  });
}

export function invalidateInviteTokens(userId: string) {
  return prisma.authToken.updateMany({
    where: { userId, type: "invite", usedAt: null },
    data: { usedAt: new Date() },
  });
}

export function createFileRow(
  data: StoredFile & { name: string; size: number; mime: string; uploadedById: string },
) {
  return prisma.file.create({ data });
}

export function findFileById(id: string) {
  return prisma.file.findUnique({ where: { id } });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}

/** Who changed whose role, from what to what. See `updateUser` for why this exists. */
export function recordRoleChange(data: {
  userId: string;
  byUserId: string;
  fromRole: UserRole;
  toRole: UserRole;
}) {
  return prisma.userRoleAuditLog.create({ data });
}
