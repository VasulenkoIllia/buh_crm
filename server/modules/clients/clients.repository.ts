import type { Prisma } from "../../generated/prisma/client.js";
import { notEndedWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

const clientInclude = {
  companies: { orderBy: { order: "asc" } },
  people: { orderBy: { order: "asc" } },
  // service.type rides along: only type=subscription services make a client regular
  subscriptions: {
    orderBy: { createdAt: "asc" },
    include: {
      service: { select: { type: true } },
      // served periods: `active`, the in-force window and the row's state all derive from these
      periods: { orderBy: { startsOn: "asc" } },
    },
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

/**
 * The client's LIVE services — running today or agreed for a future date. Counting only what is
 * in force today meant a client whose first service was scheduled ahead never claimed a default,
 * and nothing re-ran once it started, so their pickers silently never prefilled (2026-08-01 audit).
 */
export function countLiveSubscriptions(clientId: string, tz: string) {
  return prisma.subscription.count({ where: { clientId, ...notEndedWhere(tz) } });
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

export function createSubscription(
  data: {
    clientId: string;
    serviceId: string;
    companyId: string | null;
    amount: number;
    period: "month" | "quarter" | "year";
    invoiceTrigger: "on_period_start" | "on_period_end" | null;
    invoiceDay: number | null;
    dueDays: number | null;
  },
  startsOn: Date,
  createdById?: string | null,
) {
  // a subscription IS its served periods — it starts with one open-ended period, so nothing but a
  // person pausing it can ever end it (decision 2026-07-29)
  return prisma.subscription.create({
    data: { ...data, periods: { create: { startsOn, createdById: createdById ?? null } } },
  });
}

/** The open period, if the subscription has one (it has at most one — partial unique index). */
export function findOpenPeriod(subscriptionId: string) {
  return prisma.subscriptionPeriod.findFirst({ where: { subscriptionId, endsBefore: null } });
}

/**
 * The period that covers `day` — open-ended OR already carrying a future end date.
 *
 * "Is it running" and "does it have an end date" are different questions: a subscription paused as
 * of 1 October is still being served today. Pausing has to act on THIS period, not only on an open
 * one, or a scheduled pause can't be moved or called off (found in the 2026-07-30 audit).
 */
export function findPeriodCovering(subscriptionId: string, day: Date) {
  return prisma.subscriptionPeriod.findFirst({
    where: {
      subscriptionId,
      startsOn: { lte: day },
      OR: [{ endsBefore: null }, { endsBefore: { gt: day } }],
    },
  });
}

/** Drop a scheduled end date — the service goes back to open-ended, which is the normal state. */
export function reopenPeriod(id: string) {
  return prisma.subscriptionPeriod.update({
    where: { id },
    data: { endsBefore: null, endNote: null, endedById: null },
  });
}

export function listPeriods(subscriptionId: string) {
  return prisma.subscriptionPeriod.findMany({
    where: { subscriptionId },
    orderBy: { startsOn: "asc" },
  });
}

export function closePeriod(
  id: string,
  endsBefore: Date,
  by: { endNote: string | null; endedById: string | null },
) {
  return prisma.subscriptionPeriod.update({ where: { id }, data: { endsBefore, ...by } });
}

export function openPeriod(args: {
  subscriptionId: string;
  startsOn: Date;
  startNote: string | null;
  createdById: string | null;
}) {
  return prisma.subscriptionPeriod.create({ data: args });
}

/**
 * Stop the subscription clock for a whole client, as of `endsBefore` (exclusive).
 *
 * Archiving used to leave the periods alone, so they still read "in force" for the entire archived
 * stretch — and the two nightly sweeps back-filled every occurrence the moment the client came
 * back. Measured on a client archived six months: 6 tasks, all already overdue, 2 invoices issued
 * and 5 reminders raised, for work nobody did (probe, 2026-08-03). Closing the periods is what
 * makes the archive mean "we stopped serving them", which is what archiving a client means.
 *
 * Touches open periods AND ones ending later, so a pause already scheduled for next month doesn't
 * keep the clock running past the archive date.
 */
export function closeLivePeriodsForClient(
  clientId: string,
  endsBefore: Date,
  endedById: string | null,
) {
  return prisma.$transaction([
    // a start agreed for later never served anything — drop it rather than leave a period that
    // ends before it begins
    prisma.subscriptionPeriod.deleteMany({
      where: { subscription: { clientId }, startsOn: { gte: endsBefore } },
    }),
    prisma.subscriptionPeriod.updateMany({
      where: {
        subscription: { clientId },
        startsOn: { lt: endsBefore },
        OR: [{ endsBefore: null }, { endsBefore: { gt: endsBefore } }],
      },
      data: { endsBefore, endNote: "Client archived", endedById },
    }),
  ]);
}

/** Cancelling a subscription that never started removes its period — no zero-length junk. */
export function deletePeriod(id: string) {
  return prisma.subscriptionPeriod.delete({ where: { id } });
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
