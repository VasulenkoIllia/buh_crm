import type {
  ConvertLeadInput,
  CreateLeadInput,
  UpdateLeadInput,
} from "@shared/schema/lead.js";
import type { Lead } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import * as repo from "./leads.repository.js";

/** New/changed service on a lead must exist and be active (existing refs stay untouched). */
async function assertActiveService(serviceId: string | null | undefined, current?: string | null) {
  if (!serviceId || serviceId === current) return;
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service || !service.active) throw new ValidationError("Unknown or inactive service");
}

function toLeadDto(lead: Lead) {
  return {
    id: lead.id,
    type: lead.type,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    serviceId: lead.serviceId,
    sourceId: lead.sourceId,
    description: lead.description,
    stage: lead.stage,
    outcome: lead.outcome,
    convertedClientId: lead.convertedClientId,
    createdAt: lead.createdAt.toISOString(),
  };
}

export async function listLeads() {
  const leads = await repo.listLeads();
  return leads.map(toLeadDto);
}

export async function createLead(input: CreateLeadInput) {
  await assertActiveService(input.serviceId);
  return toLeadDto(await repo.createLead(input));
}

async function getActiveLead(id: string) {
  const lead = await repo.findLead(id);
  if (!lead || lead.archivedAt) throw new NotFoundError("Lead not found");
  return lead;
}

export async function updateLead(id: string, input: UpdateLeadInput) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ValidationError("A converted lead is read-only");
  }
  if (lead.outcome === "lost") {
    throw new ValidationError("Reopen this lead before editing or moving it");
  }
  // an edit must not leave the lead without any contact
  const phone = input.phone !== undefined ? input.phone : lead.phone;
  const email = input.email !== undefined ? input.email : lead.email;
  if (!phone && !email) {
    throw new ValidationError("At least one of phone or email is required");
  }
  await assertActiveService(input.serviceId, lead.serviceId);
  return toLeadDto(await repo.updateLead(id, input));
}

export async function markLost(id: string) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ValidationError("A converted lead is read-only");
  }
  return toLeadDto(await repo.updateLead(id, { outcome: "lost" }));
}

export async function reopen(id: string) {
  const lead = await getActiveLead(id);
  if (lead.outcome !== "lost") {
    throw new ValidationError("Only lost leads can be reopened");
  }
  return toLeadDto(await repo.updateLead(id, { outcome: "in_process" }));
}

/**
 * Convert (spec: leads.md) — the dialog's reviewed fields become the new Client;
 * the lead is marked won + read-only and keeps a link to the client.
 */
export async function convert(id: string, input: ConvertLeadInput) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ValidationError("This lead is already converted");
  }

  const { client, lead: updated } = await repo.convertLead(id, {
    type: input.type,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    companyName: input.type === "company" ? (input.companyName ?? null) : null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    description: input.description ?? null,
    ...(input.sourceId ? { source: { connect: { id: input.sourceId } } } : {}),
  });
  return { clientId: client.id, lead: toLeadDto(updated) };
}
