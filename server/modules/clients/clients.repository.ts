import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const clientInclude = {
  companies: { orderBy: { order: "asc" } },
  people: { orderBy: { order: "asc" } },
  // service.type rides along: only type=subscription services make a client regular
  subscriptions: {
    orderBy: { createdAt: "asc" },
    include: { service: { select: { type: true } } },
  },
  categories: { select: { serviceId: true } },
  source: true,
} satisfies Prisma.ClientInclude;

export type ClientRecord = Prisma.ClientGetPayload<{ include: typeof clientInclude }>;

export async function listClients(args: {
  where: Prisma.ClientWhereInput;
  skip: number;
  take: number;
}) {
  const [items, total] = await prisma.$transaction([
    prisma.client.findMany({
      where: args.where,
      include: clientInclude,
      orderBy: { createdAt: "desc" },
      skip: args.skip,
      take: args.take,
    }),
    prisma.client.count({ where: args.where }),
  ]);
  return { items, total };
}

/** Tab counts for the clients screen pills (regular / one-time). */
export async function countClientsByTab(regularFilter: Prisma.ClientWhereInput) {
  const [total, regular] = await prisma.$transaction([
    prisma.client.count({ where: { archivedAt: null } }),
    prisma.client.count({ where: { archivedAt: null, ...regularFilter } }),
  ]);
  return { regular, one_time: total - regular };
}

export function findClient(id: string) {
  return prisma.client.findUnique({ where: { id }, include: clientInclude });
}

export function createClient(data: Prisma.ClientCreateInput) {
  return prisma.client.create({ data, include: clientInclude });
}

export function updateClient(id: string, data: Prisma.ClientUpdateInput) {
  return prisma.client.update({ where: { id }, data, include: clientInclude });
}

/**
 * Reconcile the client's company list BY NAME — never delete-and-recreate.
 *
 * Companies are a reporting/billing dimension: subscriptions, tasks and issued invoices point at
 * a company row. Recreating them on every save handed out new ids and (via the FK) silently blanked
 * that dimension on history — re-saving a client's form was enough to lose it. So: keep the rows
 * whose name is still in the list (refresh their order), insert only genuinely new names, and
 * report the ones that would be dropped so the caller can refuse when something still points there.
 */
export async function reconcileClientCompanies(clientId: string, names: string[]) {
  // case-insensitive dedup, first occurrence wins (decision: companies are a report/invoice
  // dimension — duplicates would silently split totals; mirrors the TagInput behaviour)
  const seen = new Set<string>();
  const unique = names
    .map((n) => n.trim())
    .filter((n) => {
      const key = n.toLowerCase();
      if (!n || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const existing = await prisma.company.findMany({ where: { clientId } });
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const keep = new Map<string, { id: string; order: number }>();
  const create: { clientId: string; name: string; order: number }[] = [];

  unique.forEach((name, order) => {
    const match = byName.get(name.toLowerCase());
    if (match) keep.set(match.id, { id: match.id, order });
    else create.push({ clientId, name, order });
  });
  const removed = existing.filter((c) => !keep.has(c.id));

  return {
    removed, // the caller decides whether dropping these is allowed
    apply: () =>
      prisma.$transaction([
        ...[...keep.values()].map((c) =>
          prisma.company.update({ where: { id: c.id }, data: { order: c.order } }),
        ),
        ...(removed.length
          ? [prisma.company.deleteMany({ where: { id: { in: removed.map((c) => c.id) } } })]
          : []),
        ...(create.length ? [prisma.company.createMany({ data: create })] : []),
      ]),
  };
}

/** What still points at these companies — a referenced company may not be dropped. */
export async function countCompanyReferences(companyIds: string[]) {
  if (companyIds.length === 0) return { subscriptions: 0, tasks: 0, invoices: 0 };
  const [subscriptions, tasks, invoices] = await prisma.$transaction([
    prisma.subscription.count({ where: { companyId: { in: companyIds } } }),
    prisma.task.count({ where: { companyId: { in: companyIds } } }),
    prisma.invoice.count({ where: { companyId: { in: companyIds } } }),
  ]);
  return { subscriptions, tasks, invoices };
}

export interface PersonData {
  name: string;
  serviceId: string | null;
  serviceLabel: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
}

/** Replaces the client's people list ("People" tab). */
export async function setClientPeople(clientId: string, people: PersonData[]) {
  await prisma.$transaction([
    prisma.clientPerson.deleteMany({ where: { clientId } }),
    prisma.clientPerson.createMany({
      data: people.map((p, order) => ({ clientId, order, ...p })),
    }),
  ]);
}

// ── subscriptions & categories (S3) ─────────────────────────────────────────

export function findServiceById(id: string) {
  return prisma.service.findUnique({ where: { id } });
}

/** The one active one-time service flagged to auto-add to every new client (or null). */
export function findDefaultClientService() {
  return prisma.service.findFirst({
    where: { autoAddToNewClients: true, active: true, type: "one_time" },
  });
}

export function findClientCompany(clientId: string, companyId: string) {
  return prisma.company.findFirst({ where: { id: companyId, clientId } });
}

export function countServicesByIds(ids: string[]) {
  return prisma.service.count({ where: { id: { in: ids } } });
}

/** Active AND client-assignable (excludes internal) — for validating new category chips. */
export function countActiveServicesByIds(ids: string[]) {
  return prisma.service.count({
    where: { id: { in: ids }, active: true, type: { not: "internal" } },
  });
}

/** How many of these ids are internal (firm-only) services — guards the People service label. */
export function countInternalServicesByIds(ids: string[]) {
  return prisma.service.count({ where: { id: { in: ids }, type: "internal" } });
}

export async function listServiceTemplateIds(serviceId: string) {
  const rows = await prisma.taskTemplate.findMany({
    where: { serviceId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** An existing subscription for the same client+service+company target (null = client root). */
export function findDuplicateSubscription(
  clientId: string,
  serviceId: string,
  companyId: string | null,
  excludeId?: string,
) {
  return prisma.subscription.findFirst({
    where: {
      clientId,
      serviceId,
      companyId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export function createSubscription(data: {
  clientId: string;
  serviceId: string;
  companyId: string | null;
  amount: number;
  period: "month" | "quarter" | "year";
  invoiceTrigger: "on_period_start" | "on_period_end" | null;
  invoiceDay: number | null;
  dueDays: number | null;
}) {
  // billingStartAt = the billing anchor (S7): invoicing starts with the CURRENT period,
  // never before it — see payments.generation.ts
  return prisma.subscription.create({ data: { ...data, billingStartAt: new Date() } });
}

export function findSubscription(clientId: string, id: string) {
  return prisma.subscription.findFirst({ where: { id, clientId } });
}

export function updateSubscription(id: string, data: Prisma.SubscriptionUncheckedUpdateInput) {
  // Unchecked: callers pass scalar FKs (companyId), not nested relation writes
  return prisma.subscription.update({ where: { id }, data });
}

/** Full replace of the client's category chip set. */
export async function setClientCategories(clientId: string, serviceIds: string[]) {
  await prisma.$transaction([
    prisma.clientServiceCategory.deleteMany({ where: { clientId } }),
    prisma.clientServiceCategory.createMany({
      data: [...new Set(serviceIds)].map((serviceId) => ({ clientId, serviceId })),
    }),
  ]);
}

// ── files ────────────────────────────────────────────────────────────────────

export function listClientFiles(clientId: string) {
  return prisma.file.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } });
}

export function createClientFile(data: {
  clientId: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  uploadedById: string;
}) {
  return prisma.file.create({ data });
}

export function findClientFile(clientId: string, fileId: string) {
  return prisma.file.findFirst({ where: { id: fileId, clientId } });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}
