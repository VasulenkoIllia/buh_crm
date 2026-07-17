import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

export function listUsers() {
  return prisma.user.findMany({
    orderBy: [{ status: "asc" }, { firstName: "asc" }],
  });
}

export function findById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
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

export function createFileRow(data: {
  name: string;
  size: number;
  mime: string;
  path: string;
  uploadedById: string;
}) {
  return prisma.file.create({ data });
}

export function findFileById(id: string) {
  return prisma.file.findUnique({ where: { id } });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}
