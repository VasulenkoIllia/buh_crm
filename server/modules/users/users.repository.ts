import type { Prisma, UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import type { StoredFile } from "../../core/files.js";

export function listUsers() {
  return prisma.user.findMany({
    where: { status: { not: "deleted" } },
    orderBy: [{ status: "asc" }, { firstName: "asc" }],
  });
}

export function findById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export async function findByEmail(email: string) {
  // case-insensitive so the invite duplicate-check can't be fooled by a
  // mixed-case existing row (would otherwise let a second account slip in);
  // deterministic orderBy resolves a legacy case-collision pair to a stable row.
  // `lower()`, not Prisma's insensitive `equals`: that is an ILIKE, where an `_` is a wildcard.
  const [row] = await prisma.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text FROM "User" WHERE lower(email) = lower(${email})
    ORDER BY "createdAt" ASC LIMIT 1
  `;
  return row ?? null;
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

// never onto a row deleted meanwhile: a deleted colleague is gone for good (users.md §2)
export function updateUser(id: string, data: Prisma.UserUpdateInput) {
  return prisma.user.update({ where: { id, status: { not: "deleted" } }, data });
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
        where: { id, status: { notIn: ["blocked", "deleted"] } },
        data: { status: "blocked" },
      });
      const moved = changed.count === 1 ? await alsoInTx(tx) : null;
      const user = await tx.user.update({ where: { id, status: { not: "deleted" } }, data });
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

/**
 * Out of the team for good, the row kept for what points at it, and only while still blocked. The
 * address is replaced so it can be invited again, and every way back in goes with the password:
 * tokens, sessions, a second factor, personal access exceptions.
 */
export function markDeleted(id: string, freedEmail: string) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id, status: "blocked" },
      data: { status: "deleted", email: freedEmail, passwordHash: null },
    });
    if (changed.count === 0) return changed;
    await tx.authToken.deleteMany({ where: { userId: id } });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.twoFactorCredential.deleteMany({ where: { userId: id } });
    await tx.accessOverride.deleteMany({ where: { userId: id } });
    return changed;
  });
}

/** Only while still an invitation: one accepted meanwhile is a colleague, and stays. */
export function deleteInvitedUser(id: string) {
  return prisma.user.deleteMany({ where: { id, status: "invited" } });
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
