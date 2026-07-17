import type {
  ClientListQuery,
  CreateClientInput,
  UpdateClientInput,
} from "@shared/schema/client.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { MAX_FILE_SIZE, deleteFileBytes, saveFileBytes } from "../../core/files.js";
import * as repo from "./clients.repository.js";

/** isRegular = regularOverride ?? hasActiveSubscription (cross-cutting rule). */
export function toClientDto(client: repo.ClientRecord) {
  return {
    id: client.id,
    firstName: client.firstName,
    lastName: client.lastName,
    phone: client.phone,
    email: client.email,
    address: client.address,
    sourceId: client.sourceId,
    isRegular: client.regularOverride ?? client.subscriptions.length > 0,
    regularOverride: client.regularOverride,
    description: client.description,
    companies: client.companies.map((link) => ({
      id: link.company.id,
      name: link.company.name,
    })),
    debt: 0, // derived in Payments (S7)
    createdAt: client.createdAt.toISOString(),
    archivedAt: client.archivedAt?.toISOString() ?? null,
  };
}

const REGULAR_FILTER: Prisma.ClientWhereInput = {
  OR: [
    { regularOverride: true },
    { regularOverride: null, subscriptions: { some: { active: true } } },
  ],
};

const ONE_TIME_FILTER: Prisma.ClientWhereInput = {
  OR: [
    { regularOverride: false },
    { regularOverride: null, subscriptions: { none: { active: true } } },
  ],
};

export async function listClients(query: ClientListQuery) {
  const where: Prisma.ClientWhereInput = { archivedAt: null };

  if (query.tab === "regular") Object.assign(where, REGULAR_FILTER);
  if (query.tab === "one_time") Object.assign(where, ONE_TIME_FILTER);

  if (query.search) {
    where.AND = [
      {
        OR: [
          { firstName: { contains: query.search, mode: "insensitive" } },
          { lastName: { contains: query.search, mode: "insensitive" } },
          { email: { contains: query.search, mode: "insensitive" } },
          { phone: { contains: query.search, mode: "insensitive" } },
          {
            companies: {
              some: { company: { name: { contains: query.search, mode: "insensitive" } } },
            },
          },
        ],
      },
    ];
  }

  const [{ items, total }, counts] = await Promise.all([
    repo.listClients({
      where,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    repo.countClientsByTab(REGULAR_FILTER),
  ]);
  return {
    items: items.map(toClientDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts, // per-tab counts for the tab pills (design)
  };
}

export async function getClient(id: string) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  return toClientDto(client);
}

export async function createClient(input: CreateClientInput) {
  const { companyNames, ...fields } = input;
  const client = await repo.createClient(fields);
  if (companyNames.length > 0) {
    const companyIds = await repo.resolveCompanyIds(companyNames);
    await repo.setClientCompanies(client.id, companyIds);
  }
  return getClient(client.id);
}

export async function updateClient(id: string, input: UpdateClientInput) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");

  const { companyNames, ...fields } = input;
  await repo.updateClient(id, fields);
  if (companyNames !== undefined) {
    const companyIds = await repo.resolveCompanyIds(companyNames);
    await repo.setClientCompanies(id, companyIds);
  }
  return getClient(id);
}

export async function archiveClient(id: string, actor: User) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");
  await repo.updateClient(id, { archivedAt: new Date(), archivedById: actor.id });
  return { ok: true as const };
}

export function searchCompanies(search: string) {
  return repo.searchCompanies(search);
}

// ── files (≤ 25 MB, uploads volume, API-served) ──────────────────────────────

export async function listFiles(clientId: string) {
  await getClient(clientId); // 404 if missing/archived
  const files = await repo.listClientFiles(clientId);
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: f.createdAt.toISOString(),
  }));
}

export async function addFile(
  clientId: string,
  actor: User,
  file: { buffer: Buffer; filename: string; mimetype: string },
) {
  await getClient(clientId);
  if (file.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError("File must be 25 MB or smaller");
  }
  const relPath = await saveFileBytes(file.buffer, file.filename);
  const row = await repo.createClientFile({
    clientId,
    name: file.filename,
    size: file.buffer.byteLength,
    mime: file.mimetype,
    path: relPath,
    uploadedById: actor.id,
  });
  return { id: row.id, name: row.name, size: row.size, mime: row.mime };
}

export async function getFile(clientId: string, fileId: string) {
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  return file;
}

export async function removeFile(clientId: string, fileId: string) {
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  await repo.deleteFileRow(file.id);
  await deleteFileBytes(file.path);
  return { ok: true as const };
}
