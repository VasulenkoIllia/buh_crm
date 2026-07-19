import type {
  ClientListQuery,
  CreateClientInput,
  UpdateClientInput,
} from "@shared/schema/client.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { MAX_FILE_SIZE, deleteFileBytes, saveFileBytes } from "../../core/files.js";
import * as repo from "./clients.repository.js";

function displayName(c: {
  type: "individual" | "company";
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.type === "company") return c.companyName ?? "—";
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
}

/** isRegular = regularOverride ?? hasActiveSubscription (cross-cutting rule). */
export function toClientDto(client: repo.ClientRecord) {
  return {
    id: client.id,
    type: client.type,
    firstName: client.firstName,
    lastName: client.lastName,
    companyName: client.companyName,
    displayName: displayName(client),
    phone: client.phone,
    email: client.email,
    address: client.address,
    sourceId: client.sourceId,
    isRegular: client.regularOverride ?? client.subscriptions.length > 0,
    regularOverride: client.regularOverride,
    description: client.description,
    companies: client.companies.map((c) => ({ id: c.id, name: c.name })),
    people: client.people.map((p) => ({
      id: p.id,
      name: p.name,
      serviceLabel: p.serviceLabel,
      role: p.role,
      phone: p.phone,
      email: p.email,
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
  const where: Prisma.ClientWhereInput = {
    archivedAt: null,
    ...(query.tab === "regular" ? REGULAR_FILTER : ONE_TIME_FILTER),
  };

  if (query.search) {
    where.AND = [
      {
        OR: [
          { firstName: { contains: query.search, mode: "insensitive" } },
          { lastName: { contains: query.search, mode: "insensitive" } },
          { companyName: { contains: query.search, mode: "insensitive" } },
          { email: { contains: query.search, mode: "insensitive" } },
          { phone: { contains: query.search, mode: "insensitive" } },
          { companies: { some: { name: { contains: query.search, mode: "insensitive" } } } },
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
    counts,
  };
}

export async function getClient(id: string) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  return toClientDto(client);
}

function toClientFields(input: CreateClientInput | UpdateClientInput, isCreate: boolean) {
  const fields: Prisma.ClientUpdateInput = {};
  if (input.type !== undefined) fields.type = input.type;
  if (input.firstName !== undefined) fields.firstName = input.firstName ?? null;
  if (input.lastName !== undefined) fields.lastName = input.lastName ?? null;
  if (input.companyName !== undefined) fields.companyName = input.companyName ?? null;
  if (input.phone !== undefined) fields.phone = input.phone ?? null;
  if (input.email !== undefined) fields.email = input.email ?? null;
  if (input.address !== undefined) fields.address = input.address ?? null;
  if (input.description !== undefined) fields.description = input.description ?? null;
  if (input.regularOverride !== undefined) fields.regularOverride = input.regularOverride ?? null;
  if (input.sourceId) {
    fields.source = { connect: { id: input.sourceId } };
  } else if (!isCreate && input.sourceId !== undefined) {
    fields.source = { disconnect: true }; // clearing the source (update only)
  }
  return fields;
}

export async function createClient(input: CreateClientInput) {
  const client = await repo.createClient({
    ...(toClientFields(input, true) as Prisma.ClientCreateInput),
    type: input.type,
  });
  if (input.companyNames.length > 0) await repo.setClientCompanies(client.id, input.companyNames);
  if (input.people.length > 0) {
    await repo.setClientPeople(
      client.id,
      input.people.map((p) => ({
        name: p.name,
        serviceLabel: p.serviceLabel ?? null,
        role: p.role ?? null,
        phone: p.phone ?? null,
        email: p.email ?? null,
      })),
    );
  }
  return getClient(client.id);
}

export async function updateClient(id: string, input: UpdateClientInput) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");

  // re-validate the type invariant against the MERGED record (the Zod refine only
  // runs when `type` is in the patch, which routine edits omit)
  const type = input.type ?? existing.type;
  const firstName = input.firstName !== undefined ? input.firstName : existing.firstName;
  const lastName = input.lastName !== undefined ? input.lastName : existing.lastName;
  const companyName = input.companyName !== undefined ? input.companyName : existing.companyName;
  const valid = type === "individual" ? !!firstName && !!lastName : !!companyName;
  if (!valid) {
    throw new ValidationError(
      "Individual needs first and last name; company needs a company name",
    );
  }

  await repo.updateClient(id, toClientFields(input, false));
  if (input.companyNames !== undefined) await repo.setClientCompanies(id, input.companyNames);
  if (input.people !== undefined) {
    await repo.setClientPeople(
      id,
      input.people.map((p) => ({
        name: p.name,
        serviceLabel: p.serviceLabel ?? null,
        role: p.role ?? null,
        phone: p.phone ?? null,
        email: p.email ?? null,
      })),
    );
  }
  return getClient(id);
}

export async function archiveClient(id: string, actor: User) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");
  await repo.updateClient(id, { archivedAt: new Date(), archivedById: actor.id });
  return { ok: true as const };
}

// ── files (≤ 25 MB, uploads volume, API-served) ──────────────────────────────

export async function listFiles(clientId: string) {
  await getClient(clientId);
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
  await getClient(clientId); // 404s archived/missing clients — files go dark with the client
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  return file;
}

export async function removeFile(clientId: string, fileId: string) {
  await getClient(clientId); // 404s archived/missing clients
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  await repo.deleteFileRow(file.id);
  await deleteFileBytes(file.path);
  return { ok: true as const };
}
