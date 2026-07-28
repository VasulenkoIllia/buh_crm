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

export interface CompanyRecordInput {
  /** present = an existing row being edited (a rename keeps the same id, so history follows) */
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
}

/**
 * Reconcile the client's companies — never delete-and-recreate.
 *
 * Companies are the reporting/billing dimension: subscriptions, tasks and issued invoices point
 * at a company row. Recreating them on every save handed out new ids and (via the FK) silently
 * blanked that dimension on history — re-saving a client's form was enough to lose it. So rows
 * are matched by **id** when the editor sends one (which is what makes renaming safe) and by name
 * otherwise, updated in place, and the ones that would be dropped are reported so the caller can
 * refuse while something still points at them.
 *
 * An OMITTED optional field means "leave it alone"; only an explicit `null` clears it (2026-07-28).
 * It used to write `?? null` for every field, so the client's profile form — whose tag input
 * carries names and nothing else — wiped every company's phone, email and description each time
 * it was saved, including the address their invoices are meant to go to.
 */
export async function reconcileClientCompanies(clientId: string, input: CompanyRecordInput[]) {
  // case-insensitive dedup within the payload itself, first occurrence wins — duplicates would
  // silently split a client's totals across two rows
  const seen = new Set<string>();
  const unique = input
    .map((c) => ({ ...c, name: c.name.trim() }))
    .filter((c) => {
      const key = c.name.toLowerCase();
      if (!c.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const existing = await prisma.company.findMany({ where: { clientId } });
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

  const update: { id: string; data: Prisma.CompanyUncheckedUpdateInput }[] = [];
  const create: Prisma.CompanyUncheckedCreateInput[] = [];
  const keptIds = new Set<string>();

  unique.forEach((c, order) => {
    const match = (c.id && byId.get(c.id)) || byName.get(c.name.toLowerCase());
    // absent = keep what's stored · explicit null = clear it
    const given = {
      ...(c.phone !== undefined ? { phone: c.phone } : {}),
      ...(c.email !== undefined ? { email: c.email } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
    };
    if (match) {
      keptIds.add(match.id);
      update.push({ id: match.id, data: { name: c.name, order, ...given } });
    } else {
      // a brand-new row has nothing to keep — whatever wasn't given starts empty
      create.push({
        clientId,
        name: c.name,
        order,
        phone: null,
        email: null,
        description: null,
        ...given,
      });
    }
  });
  const removed = existing.filter((c) => !keptIds.has(c.id));

  return {
    removed, // the caller decides whether dropping these is allowed
    apply: () =>
      prisma.$transaction([
        ...update.map((u) => prisma.company.update({ where: { id: u.id }, data: u.data })),
        ...(removed.length
          ? [prisma.company.deleteMany({ where: { id: { in: removed.map((c) => c.id) } } })]
          : []),
        ...(create.length ? [prisma.company.createMany({ data: create })] : []),
      ]),
  };
}

/**
 * Companies elsewhere in the system already holding any of these names (case-insensitive).
 * A company name identifies one company for the whole firm, so the save is refused with the
 * owner named rather than hitting the raw unique-index error.
 */
export function findCompaniesNamedElsewhere(clientId: string | null, names: string[]) {
  if (names.length === 0) return Promise.resolve([]);
  return prisma.company.findMany({
    where: {
      // null = the client doesn't exist yet (create) — nothing of theirs to exclude
      ...(clientId ? { clientId: { not: clientId } } : {}),
      OR: names.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })),
    },
    select: { name: true, client: { select: { firstName: true, lastName: true } } },
  });
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

export function countActiveSubscriptions(clientId: string) {
  return prisma.subscription.count({ where: { clientId, active: true } });
}

/**
 * Make this subscription the client's default, clearing whichever held the flag before —
 * in one transaction, so the partial unique index never sees two.
 */
export function setDefaultSubscription(clientId: string, subscriptionId: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { clientId, isDefault: true, ...(subscriptionId ? { id: { not: subscriptionId } } : {}) },
      data: { isDefault: false },
    });
    if (subscriptionId) {
      await tx.subscription.update({ where: { id: subscriptionId }, data: { isDefault: true } });
    }
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
