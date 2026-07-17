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

export function markTokenUsed(id: string) {
  return prisma.authToken.update({ where: { id }, data: { usedAt: new Date() } });
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
