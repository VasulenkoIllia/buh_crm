import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const serviceInclude = {
  taskTemplates: { orderBy: { createdAt: "asc" } },
  subscriptions: { where: { active: true }, select: { clientId: true } },
} satisfies Prisma.ServiceInclude;

export type ServiceRecord = Prisma.ServiceGetPayload<{ include: typeof serviceInclude }>;

export function listServices() {
  return prisma.service.findMany({ include: serviceInclude, orderBy: { createdAt: "asc" } });
}

export function findService(id: string) {
  return prisma.service.findUnique({ where: { id }, include: serviceInclude });
}

/** Case-insensitive — "Payroll" and "payroll" are the same service. */
export function findServiceByName(name: string) {
  return prisma.service.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

export function countServices() {
  return prisma.service.count();
}

export function createService(data: Prisma.ServiceCreateInput) {
  return prisma.service.create({ data, include: serviceInclude });
}

export function updateService(id: string, data: Prisma.ServiceUpdateInput) {
  return prisma.service.update({ where: { id }, data, include: serviceInclude });
}

// ── task templates ───────────────────────────────────────────────────────────

export function findTemplate(serviceId: string, templateId: string) {
  return prisma.taskTemplate.findFirst({ where: { id: templateId, serviceId } });
}

export function createTemplate(serviceId: string, data: Prisma.TaskTemplateUncheckedCreateWithoutServiceInput) {
  return prisma.taskTemplate.create({ data: { ...data, serviceId } });
}

export function updateTemplate(id: string, data: Prisma.TaskTemplateUpdateInput) {
  return prisma.taskTemplate.update({ where: { id }, data });
}

export function deleteTemplate(id: string) {
  return prisma.taskTemplate.delete({ where: { id } });
}
