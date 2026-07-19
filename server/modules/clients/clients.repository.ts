import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const clientInclude = {
  companies: { orderBy: { order: "asc" } },
  people: { orderBy: { order: "asc" } },
  subscriptions: { where: { active: true }, select: { id: true } },
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

/** Replaces the client's company list (companies are per-client text, 1:N). */
export async function setClientCompanies(clientId: string, names: string[]) {
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
  await prisma.$transaction([
    prisma.company.deleteMany({ where: { clientId } }),
    prisma.company.createMany({
      data: unique.map((name, order) => ({ clientId, name, order })),
    }),
  ]);
}

export interface PersonData {
  name: string;
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
