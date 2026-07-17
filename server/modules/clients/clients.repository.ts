import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const clientInclude = {
  companies: { include: { company: true } },
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

export function findClient(id: string) {
  return prisma.client.findUnique({ where: { id }, include: clientInclude });
}

export function createClient(data: Prisma.ClientCreateInput) {
  return prisma.client.create({ data, include: clientInclude });
}

export function updateClient(id: string, data: Prisma.ClientUpdateInput) {
  return prisma.client.update({ where: { id }, data, include: clientInclude });
}

/** Resolves company names → ids: links existing (case-insensitive), creates new. */
export async function resolveCompanyIds(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const existing = await prisma.company.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
    });
    const company = existing ?? (await prisma.company.create({ data: { name } }));
    if (!ids.includes(company.id)) ids.push(company.id);
  }
  return ids;
}

export async function setClientCompanies(clientId: string, companyIds: string[]) {
  await prisma.$transaction([
    prisma.clientCompany.deleteMany({ where: { clientId } }),
    prisma.clientCompany.createMany({
      data: companyIds.map((companyId) => ({ clientId, companyId })),
    }),
  ]);
}

export function searchCompanies(search: string) {
  return prisma.company.findMany({
    where: search ? { name: { contains: search, mode: "insensitive" } } : undefined,
    orderBy: { name: "asc" },
    take: 20,
  });
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
