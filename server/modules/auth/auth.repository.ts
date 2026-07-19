import type { AuthTokenType } from "../../generated/prisma/enums.js";
import { prisma } from "../../core/db.js";

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function createAuthToken(userId: string, type: AuthTokenType, tokenHash: string, expiresAt: Date) {
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
