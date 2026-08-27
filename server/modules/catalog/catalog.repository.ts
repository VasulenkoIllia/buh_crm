import type { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceTodayWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

// "clients on this service" counts the ones being served TODAY — same question the rest of the
// app asks, so a paused client drops out of the count exactly when they drop off the board
// A FUNCTION, not a const: `inForceTodayWhere` resolves "today", and a module-level object would
// freeze it at import time — the count would then describe the day the server booted.
const serviceInclude = () =>
  ({
    taskTemplates: { orderBy: { createdAt: "asc" } },
    subscriptions: { where: inForceTodayWhere(config.TZ), select: { clientId: true } },
  }) satisfies Prisma.ServiceInclude;

export type ServiceRecord = Prisma.ServiceGetPayload<{
  include: ReturnType<typeof serviceInclude>;
}>;

export function listServices() {
  // the firm's own order — one read feeds every picker, chip and filter in the app, so this is
  // where the Services page's drag-and-drop reaches all of them. `createdAt` breaks ties and is
  // what the list was sorted by before the column existed.
  return prisma.service.findMany({
    include: serviceInclude(),
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

export function findService(id: string) {
  return prisma.service.findUnique({ where: { id }, include: serviceInclude() });
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
  return prisma.service.create({ data, include: serviceInclude() });
}

export function updateService(id: string, data: Prisma.ServiceUpdateInput) {
  return prisma.service.update({ where: { id }, data, include: serviceInclude() });
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
    return tx.service.findUnique({ where: { id: service.id }, include: serviceInclude() });
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
    return tx.service.findUnique({ where: { id }, include: serviceInclude() });
  });
}

export async function countServiceUsage(serviceId: string) {
  const [subscriptions, people, tasks, invoices] = await prisma.$transaction([
    prisma.subscription.count({ where: { serviceId } }),
    prisma.clientPerson.count({ where: { serviceId } }),
    // generated tasks belong to the service (internal services have no subscriptions/categories,
    // so tasks are their only usage — without this an internal service could be hard-deleted,
    // cascade-dropping its templates and orphaning already-generated tasks)
    prisma.task.count({ where: { serviceId } }),
    // billing history keeps a service alive too — deleting it would break the FK (and the
    // invoice would lose what it was for)
    prisma.invoice.count({ where: { serviceId } }),
  ]);
  return { subscriptions, people, tasks, invoices };
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

/**
 * Put `serviceId` immediately after `afterServiceId` in the catalog — or first when that is null.
 *
 * Renumbers the WHOLE catalog rather than the visible tab: the Services page splits External from
 * Internal, and numbering only the rows on screen would shuffle the other tab out of the way. The
 * anchor is a service the reader can see; everything else keeps its relative place. Same rule the
 * board follows, and the same reason.
 */
export async function moveService(serviceId: string, afterServiceId: string | null) {
  return prisma.$transaction(async (tx) => {
    const rest = await tx.service.findMany({
      where: { id: { not: serviceId } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, order: true },
    });
    const was = new Map(rest.map((r) => [r.id, r.order]));
    const ids = rest.map((r) => r.id);
    // an anchor that is not in the catalog (a stale page, someone else deleted it) puts the
    // service first rather than guessing a position from a list that has moved on
    const at = afterServiceId ? ids.indexOf(afterServiceId) : -1;
    ids.splice(at + 1, 0, serviceId);

    // renumber in full, WRITE only what actually moves — a drop one place down touches two rows
    for (const [order, id] of ids.entries()) {
      if (id !== serviceId && was.get(id) === order) continue;
      await tx.service.update({ where: { id }, data: { order } });
    }
  });
}
