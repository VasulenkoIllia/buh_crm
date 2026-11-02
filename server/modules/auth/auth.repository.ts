import type { AuthTokenType } from "../../generated/prisma/enums.js";
import { prisma } from "../../core/db.js";

export async function findUserByEmail(email: string) {
  // Case-insensitive: inputs are normalized to lowercase, but a legacy or
  // manually-inserted mixed-case row would otherwise be unreachable (can't log
  // in or reset). insensitive match keeps such accounts usable. Deterministic
  // orderBy so a (migration-skipped) case-collision pair always resolves the same row.
  // `lower()`, not Prisma's insensitive `equals`: that is an ILIKE, where the `_` an
  // address may hold is a wildcard, and "audit_admin@…" signed in as "audit-admin@…".
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE lower(email) = lower(${email}) ORDER BY "createdAt" ASC LIMIT 1
  `;
  return row ? prisma.user.findUnique({ where: { id: row.id } }) : null;
}

export function createAuthToken(
  userId: string,
  type: AuthTokenType,
  tokenHash: string,
  expiresAt: Date,
) {
  return prisma.authToken.create({ data: { userId, type, tokenHash, expiresAt } });
}

export function findValidToken(tokenHash: string, type: AuthTokenType) {
  return prisma.authToken.findFirst({
    where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
    include: { user: true },
  });
}

/** Marks a token used ONLY if it is still unused — returns false when it lost the race. */
export async function consumeToken(id: string): Promise<boolean> {
  const res = await prisma.authToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return res.count === 1;
}

export function invalidateUserTokens(userId: string, type: AuthTokenType) {
  return prisma.authToken.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export function activateInvitedUser(
  id: string,
  data: { firstName: string; lastName: string; passwordHash: string },
) {
  return prisma.user.update({
    where: { id },
    data: { ...data, status: "active", emailConfirmedAt: new Date() },
  });
}

export function setUserPassword(id: string, passwordHash: string) {
  return prisma.user.update({ where: { id }, data: { passwordHash } });
}
