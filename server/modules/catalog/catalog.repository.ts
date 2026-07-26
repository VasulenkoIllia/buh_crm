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

/**
 * Apply the default-for-new-clients flag inside a transaction (unset the previous
 * holder BEFORE setting this one, else the partial unique index would reject two
 * flagged rows). `flag` undefined = leave the flag untouched.
 */
async function applyDefaultFlag(
  tx: Prisma.TransactionClient,
  id: string,
  flag: boolean | undefined,
) {
  if (flag === true) {
    await tx.service.updateMany({
      where: { autoAddToNewClients: true, id: { not: id } },
      data: { autoAddToNewClients: false },
    });
    await tx.service.update({ where: { id }, data: { autoAddToNewClients: true } });
  } else if (flag === false) {
    await tx.service.update({ where: { id }, data: { autoAddToNewClients: false } });
  }
}

/** Create a service and (atomically) set the default flag if requested. */
export function createServiceWithDefault(
  data: Prisma.ServiceCreateInput,
  flag: boolean | undefined,
) {
  return prisma.$transaction(async (tx) => {
    const service = await tx.service.create({ data });
    await applyDefaultFlag(tx, service.id, flag);
    return tx.service.findUnique({ where: { id: service.id }, include: serviceInclude });
  });
}

/** Update a service's fields and (atomically) apply the default flag change if any. */
export function updateServiceWithDefault(
  id: string,
  data: Prisma.ServiceUpdateInput,
  flag: boolean | undefined,
) {
  return prisma.$transaction(async (tx) => {
    await tx.service.update({ where: { id }, data });
    await applyDefaultFlag(tx, id, flag);
    return tx.service.findUnique({ where: { id }, include: serviceInclude });
  });
}

export async function countServiceUsage(serviceId: string) {
  const [subscriptions, categories, people, tasks, invoices] = await prisma.$transaction([
    prisma.subscription.count({ where: { serviceId } }),
    prisma.clientServiceCategory.count({ where: { serviceId } }),
    prisma.clientPerson.count({ where: { serviceId } }),
    // generated tasks belong to the service (internal services have no subscriptions/categories,
    // so tasks are their only usage — without this an internal service could be hard-deleted,
    // cascade-dropping its templates and orphaning already-generated tasks)
    prisma.task.count({ where: { serviceId } }),
    // billing history keeps a service alive too — deleting it would break the FK (and the
    // invoice would lose what it was for)
    prisma.invoice.count({ where: { serviceId } }),
  ]);
  return { subscriptions, categories, people, tasks, invoices };
}

export function deleteService(id: string) {
  return prisma.service.delete({ where: { id } });
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
