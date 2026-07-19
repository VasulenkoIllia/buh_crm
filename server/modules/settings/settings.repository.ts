import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

export function listPriorities() {
  return prisma.priority.findMany({ orderBy: { order: "asc" } });
}

export function findPriority(id: string) {
  return prisma.priority.findUnique({ where: { id } });
}

export function updatePriority(id: string, data: Prisma.PriorityUpdateInput) {
  return prisma.priority.update({ where: { id }, data });
}

/** Moves the default flag atomically — exactly one priority is default. */
export function moveDefaultPriority(id: string) {
  return prisma.$transaction([
    prisma.priority.updateMany({ data: { isDefault: false } }),
    prisma.priority.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

export function listSources() {
  return prisma.sourceOption.findMany({ orderBy: { order: "asc" } });
}

/** Case-insensitive — "Referral" and "referral" are the same source. */
export function findSourceByName(name: string) {
  return prisma.sourceOption.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

/** Swaps two priorities' order values in one transaction. */
export function swapPriorityOrders(aId: string, bId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.priority.findUniqueOrThrow({ where: { id: aId } });
    const b = await tx.priority.findUniqueOrThrow({ where: { id: bId } });
    await tx.priority.update({ where: { id: aId }, data: { order: b.order } });
    await tx.priority.update({ where: { id: bId }, data: { order: a.order } });
  });
}

export function maxSourceOrder() {
  return prisma.sourceOption.aggregate({ _max: { order: true } });
}

export function createSource(name: string, order: number) {
  return prisma.sourceOption.create({ data: { name, order } });
}

export function updateSource(id: string, data: Prisma.SourceOptionUpdateInput) {
  return prisma.sourceOption.update({ where: { id }, data });
}

export function getFirmProfile() {
  return prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } });
}

export function updateFirmProfile(data: Prisma.FirmProfileUpdateInput) {
  return prisma.firmProfile.update({ where: { id: 1 }, data });
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
