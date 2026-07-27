import type {
  ClientListQuery,
  CreateClientInput,
  CreateSubscriptionInput,
  SetClientCategoriesInput,
  UpdateClientInput,
  UpdateSubscriptionInput,
} from "@shared/schema/client.js";
import { rhythmOverridesSchema } from "@shared/schema/catalog.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { debtByClient, generateForSubscriptionInvoices } from "../payments/index.js";
import { generateForSubscription } from "../tasks/index.js";
import { MAX_FILE_SIZE, deleteFileBytes, saveFileBytes } from "../../core/files.js";
import { clientLabel } from "../../core/names.js";
import * as repo from "./clients.repository.js";

/**
 * `isRegular` is **purely derived** (user, 2026-07-26): a client is regular exactly while they
 * hold an active SUBSCRIPTION-type service. Adding one makes them regular; stopping it makes them
 * one-time again, with no stored flag that could drift from the services they actually have.
 * One-time subs are just containers ad-hoc jobs flow through — they never count.
 */
export function toClientDto(client: repo.ClientRecord, debt = 0) {
  return {
    id: client.id,
    categories: client.categories.map((c) => c.serviceId),
    subscriptions: client.subscriptions.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      companyId: s.companyId,
      serviceId: s.serviceId,
      amount: s.amount,
      period: s.period,
      invoiceTrigger: s.invoiceTrigger,
      invoiceDay: s.invoiceDay,
      dueDays: s.dueDays,
      // validated on write; the parse also shields the API from malformed legacy blobs
      rhythmOverrides: rhythmOverridesSchema.catch({}).parse(s.rhythmOverrides ?? {}),
      active: s.active,
    })),
    firstName: client.firstName,
    lastName: client.lastName,
    companyName: client.companyName,
    displayName: clientLabel(client),
    phone: client.phone,
    email: client.email,
    address: client.address,
    sourceId: client.sourceId,
    isRegular: client.subscriptions.some((s) => s.active && s.service.type === "subscription"),
    description: client.description,
    companies: client.companies.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      description: c.description,
    })),
    people: client.people.map((p) => ({
      id: p.id,
      name: p.name,
      serviceId: p.serviceId,
      serviceLabel: p.serviceLabel,
      role: p.role,
      phone: p.phone,
      email: p.email,
    })),
    debt, // Σ open invoice balance — derived in Payments (S7), passed in by the caller
    createdAt: client.createdAt.toISOString(),
    archivedAt: client.archivedAt?.toISOString() ?? null,
  };
}

/** Only subscription-type services count toward "regular" — one-time subs are job containers. */
const ACTIVE_REGULAR_SUB: Prisma.SubscriptionWhereInput = {
  active: true,
  service: { type: "subscription" },
};

// the tab filters ARE the rule, expressed in SQL — nothing else decides who is regular
const REGULAR_FILTER: Prisma.ClientWhereInput = { subscriptions: { some: ACTIVE_REGULAR_SUB } };
const ONE_TIME_FILTER: Prisma.ClientWhereInput = { subscriptions: { none: ACTIVE_REGULAR_SUB } };

export async function listClients(query: ClientListQuery) {
  const where: Prisma.ClientWhereInput = {
    archivedAt: null,
    ...(query.tab === "regular" ? REGULAR_FILTER : query.tab === "one_time" ? ONE_TIME_FILTER : {}),
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
  const debts = await debtByClient(items.map((c) => c.id));
  return {
    items: items.map((c) => toClientDto(c, debts[c.id] ?? 0)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts,
  };
}

export async function getClient(id: string) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  const debts = await debtByClient([id]);
  return toClientDto(client, debts[id] ?? 0);
}

function toClientFields(input: CreateClientInput | UpdateClientInput, isCreate: boolean) {
  const fields: Prisma.ClientUpdateInput = {};
  if (input.firstName !== undefined) fields.firstName = input.firstName;
  if (input.lastName !== undefined) fields.lastName = input.lastName ?? null;
  if (input.companyName !== undefined) fields.companyName = input.companyName ?? null;
  if (input.phone !== undefined) fields.phone = input.phone ?? null;
  if (input.email !== undefined) fields.email = input.email ?? null;
  if (input.address !== undefined) fields.address = input.address ?? null;
  if (input.description !== undefined) fields.description = input.description ?? null;
  if (input.sourceId) {
    fields.source = { connect: { id: input.sourceId } };
  } else if (!isCreate && input.sourceId !== undefined) {
    fields.source = { disconnect: true }; // clearing the source (update only)
  }
  return fields;
}

/**
 * A company NAME identifies one company for the whole firm, so a name another client already
 * holds is refused with the owner named rather than surfacing a raw unique-index violation.
 *
 * Checked BEFORE the client row is written on create — otherwise a rejected save would leave a
 * half-created client behind (`clientId` is null then: nothing of this client's is excluded yet).
 */
async function assertCompanyNamesFree(
  clientId: string | null,
  companies: repo.CompanyRecordInput[],
) {
  const names = companies.map((c) => c.name.trim()).filter(Boolean);
  const taken = await repo.findCompaniesNamedElsewhere(clientId, names);
  if (taken.length > 0) {
    const [first] = taken;
    throw new ConflictError(
      `"${first.name}" already belongs to ${clientLabel(first.client)} — a company name identifies one company across the whole firm`,
    );
  }
}

/**
 * Save the client's companies. A company that subscriptions, tasks or issued invoices still
 * point at can't just disappear — the save is refused with the reason instead of silently
 * orphaning that history.
 */
async function applyCompanies(clientId: string, companies: repo.CompanyRecordInput[]) {
  await assertCompanyNamesFree(clientId, companies);
  const { removed, apply } = await repo.reconcileClientCompanies(clientId, companies);

  if (removed.length > 0) {
    const refs = await repo.countCompanyReferences(removed.map((c) => c.id));
    const used = [
      refs.subscriptions && `${refs.subscriptions} subscription(s)`,
      refs.tasks && `${refs.tasks} task(s)`,
      refs.invoices && `${refs.invoices} invoice(s)`,
    ].filter(Boolean);
    if (used.length > 0) {
      throw new ConflictError(
        `"${removed.map((c) => c.name).join('", "')}" is still used by ${used.join(", ")} — move those to another company (or to the client) before removing it`,
      );
    }
  }
  await apply();
}

/** Normalize the people payload for the repo (optional fields → null). */
const mapPeople = (people: CreateClientInput["people"]) =>
  people.map((p) => ({
    name: p.name,
    serviceId: p.serviceId ?? null,
    serviceLabel: p.serviceLabel ?? null,
    role: p.role ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
  }));

/** A person's optional service label must be client-facing — never an internal (firm-only) service. */
async function assertPeopleServicesClientFacing(people: CreateClientInput["people"]) {
  const ids = [...new Set(people.map((p) => p.serviceId).filter((v): v is string => !!v))];
  if (ids.length > 0 && (await repo.countInternalServicesByIds(ids)) > 0) {
    throw new ValidationError("Can't tag a person with an internal service");
  }
}

export async function createClient(input: CreateClientInput) {
  await assertPeopleServicesClientFacing(input.people);
  // check before writing anything: a refused save must not leave a half-created client behind
  await assertCompanyNamesFree(null, input.companies);
  const client = await repo.createClient(toClientFields(input, true) as Prisma.ClientCreateInput);
  if (input.companies.length > 0) await applyCompanies(client.id, input.companies);
  if (input.people.length > 0) {
    await repo.setClientPeople(client.id, mapPeople(input.people));
  }
  await applyDefaultClientService(client.id);
  return getClient(client.id);
}

/**
 * Auto-add the catalog's "default for new clients" service (one active one-time service, if any)
 * as a subscription on a freshly-created client — so every client has at least one paid
 * container. On the client root (no company); amount prefilled from the service's expected
 * price. Called on direct create AND on lead→client convert. No-op when no default is set.
 */
export async function applyDefaultClientService(clientId: string) {
  const svc = await repo.findDefaultClientService();
  if (!svc) return;
  await repo.createSubscription({
    clientId,
    serviceId: svc.id,
    companyId: null,
    amount: svc.defaultAmount ?? 0,
    period: "month", // stored but unused for one-time
    invoiceTrigger: null,
    invoiceDay: null,
    dueDays: null,
  });
}

export async function updateClient(id: string, input: UpdateClientInput) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");

  // a PATCH may omit the name entirely, but it must never CLEAR it — the first name is what
  // identifies the client (the last name and the companyName label stay optional)
  if (input.firstName !== undefined && !input.firstName) {
    throw new ValidationError("First name is required");
  }

  if (input.people !== undefined) await assertPeopleServicesClientFacing(input.people);
  await repo.updateClient(id, toClientFields(input, false));
  if (input.companies !== undefined) await applyCompanies(id, input.companies);
  if (input.people !== undefined) {
    await repo.setClientPeople(id, mapPeople(input.people));
  }
  return getClient(id);
}

// ── subscriptions & categories (S3) ─────────────────────────────────────────

export async function addSubscription(clientId: string, input: CreateSubscriptionInput) {
  await getClient(clientId);
  const service = await repo.findServiceById(input.serviceId);
  if (!service || !service.active) throw new ValidationError("Unknown or inactive service");
  if (service.type === "internal") {
    throw new ValidationError("Internal services aren't assignable to clients");
  }
  if (input.companyId) {
    const company = await repo.findClientCompany(clientId, input.companyId);
    if (!company) throw new ValidationError("Company does not belong to this client");
  }
  // same service twice only for DIFFERENT companies of the client (decision 2026-07-21)
  const duplicate = await repo.findDuplicateSubscription(
    clientId,
    input.serviceId,
    input.companyId ?? null,
  );
  if (duplicate) {
    throw new ValidationError(
      "This service is already assigned to the same target — edit the existing subscription or pick another company",
    );
  }
  const created = await repo.createSubscription({
    clientId,
    serviceId: input.serviceId,
    companyId: input.companyId ?? null,
    amount: input.amount,
    period: input.period,
    invoiceTrigger: input.invoiceTrigger ?? null,
    invoiceDay: input.invoiceDay ?? null,
    dueDays: input.dueDays ?? null,
  });
  // instant feedback: today's-due tasks and this period's invoice appear right away
  // (both idempotent; no-op for one-time). Best-effort — a generation hiccup must NOT fail the
  // (already-committed) subscription; the daily scheduler sweeps + startup catch-up fill any gap.
  await generateForSubscription(created.id).catch(() => {});
  await generateForSubscriptionInvoices(created.id).catch(() => {});
  return getClient(clientId);
}

export async function updateSubscription(
  clientId: string,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
) {
  await getClient(clientId);
  const sub = await repo.findSubscription(clientId, subscriptionId);
  if (!sub) throw new NotFoundError("Subscription not found");
  if (input.companyId) {
    const company = await repo.findClientCompany(clientId, input.companyId);
    if (!company) throw new ValidationError("Company does not belong to this client");
  }
  // billing timing must stay valid against the MERGED row (partial PATCH skips the Zod refine)
  const trigger =
    input.invoiceTrigger !== undefined ? input.invoiceTrigger : sub.invoiceTrigger;
  const day = input.invoiceDay !== undefined ? input.invoiceDay : sub.invoiceDay;
  if (day != null && trigger !== "on_period_start") {
    throw new ValidationError("A custom day only applies when billing at the start of the period");
  }
  // duplicate-target rule also holds when the company changes
  if (input.companyId !== undefined) {
    const duplicate = await repo.findDuplicateSubscription(
      clientId,
      sub.serviceId,
      input.companyId ?? null,
      subscriptionId,
    );
    if (duplicate) {
      throw new ValidationError(
        "This service is already assigned to the same target — edit the existing subscription instead",
      );
    }
  }
  // per-client task overrides may only key on THIS service's task templates
  if (input.rhythmOverrides !== undefined) {
    const templateIds = new Set(await repo.listServiceTemplateIds(sub.serviceId));
    for (const id of Object.keys(input.rhythmOverrides)) {
      if (!templateIds.has(id)) {
        throw new ValidationError("Override references a task that isn't part of this service");
      }
    }
  }
  // reactivation moves the billing anchor to today — a paused subscription is never
  // back-billed for the periods it slept through (user decision 2026-07-25)
  const reactivated = input.active === true && !sub.active;
  await repo.updateSubscription(subscriptionId, {
    ...input,
    ...(reactivated ? { billingStartAt: new Date() } : {}),
  });
  // rhythm overrides / reactivation may make today's tasks due — sweep this sub now
  // (best-effort; the scheduler self-heals so a hiccup never fails the saved edit)
  if (input.rhythmOverrides !== undefined || input.active === true) {
    await generateForSubscription(subscriptionId).catch(() => {});
  }
  if (reactivated) await generateForSubscriptionInvoices(subscriptionId).catch(() => {});
  return getClient(clientId);
}

export async function setCategories(clientId: string, input: SetClientCategoriesInput) {
  const client = await getClient(clientId);
  const ids = [...new Set(input.serviceIds)];
  const count = await repo.countServicesByIds(ids);
  if (count !== ids.length) {
    throw new ValidationError("Unknown service in the category list");
  }
  // NEW chips must reference active services; existing ones may outlive a deactivation
  const existing = new Set(client.categories);
  const added = ids.filter((id) => !existing.has(id));
  if (added.length > 0 && (await repo.countActiveServicesByIds(added)) !== added.length) {
    throw new ValidationError("Can't add an inactive or internal service as a category");
  }
  await repo.setClientCategories(clientId, input.serviceIds);
  return getClient(clientId);
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
