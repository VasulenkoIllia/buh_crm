import type {
  ConvertLeadInput,
  CreateLeadInput,
  LeadListQuery,
  CreateLeadStageInput,
  MoveLeadInput,
  MoveLeadStageInput,
  UpdateLeadStageInput,
  UpdateLeadInput,
} from "@shared/schema/lead.js";
import { LEAD_LIST_LIMIT } from "@shared/schema/lead.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { applyDefaultClientService } from "../clients/index.js";
import * as repo from "./leads.repository.js";

/** New/changed service on a lead must exist and be active (existing refs stay untouched). */
async function assertActiveService(serviceId: string | null | undefined, current?: string | null) {
  if (!serviceId || serviceId === current) return;
  const service = await repo.findService(serviceId);
  if (!service || !service.active) throw new ValidationError("Unknown or inactive service");
  // internal services are firm-internal recurring tasks — not a lead's/client's service
  if (service.type === "internal") throw new ValidationError("Internal services aren't client-facing");
}

function toLeadDto(lead: repo.LeadRecord) {
  return {
    id: lead.id,
    name: lead.name,
    companyName: lead.companyName,
    phone: lead.phone,
    email: lead.email,
    serviceId: lead.serviceId,
    sourceId: lead.sourceId,
    description: lead.description,
    stageId: lead.stageId,
    stageName: lead.stage.name,
    boardOrder: lead.boardOrder,
    outcome: lead.outcome,
    convertedClientId: lead.convertedClientId,
    createdAt: lead.createdAt.toISOString(),
    archivedAt: lead.archivedAt?.toISOString() ?? null,
  };
}

/**
 * The board asks for live leads, "Closed" for won + lost, Archive for the archived — each side is
 * a database query, not a filter over every lead the firm ever had.
 *
 * Closed and archived are different axes and always were: `outcome` says how the conversation
 * ended, `archivedAt` says the row is gone from the working views. The screen's tab used to be
 * called "Archive" while meaning the first of those, which is exactly the confusion this round
 * set out to remove.
 */
export async function listLeads(query: LeadListQuery) {
  const where: Prisma.LeadWhereInput =
    query.scope === "archived" ? { archivedAt: { not: null } } : { archivedAt: null };
  if (query.scope === "in_process") where.outcome = "in_process";
  if (query.scope === "closed") where.outcome = { not: "in_process" };

  const { items, total } = await repo.listLeads(where, LEAD_LIST_LIMIT);
  return { items: items.map(toLeadDto), total, truncated: total > items.length };
}

export async function createLead(input: CreateLeadInput) {
  await assertActiveService(input.serviceId);
  // a new lead starts at the front of the pipeline — whichever column the firm has put there
  const first = await repo.firstStage();
  if (!first) throw new ValidationError("The pipeline has no stages — add one on the board first");
  // `stageId`, not `stage: { connect }` — the rest of the input is scalars, and one relation
  // form among them flips Prisma to its checked variant, where `serviceId` is not a valid key
  return toLeadDto(await repo.createLead({ ...input, stageId: first.id }));
}

async function getActiveLead(id: string) {
  const lead = await repo.findLead(id);
  if (!lead || lead.archivedAt) throw new NotFoundError("Lead not found");
  return lead;
}

/**
 * One lead by id — what a deep link into the lead card resolves through. It answers for a WON or
 * LOST lead too (those left the board but a task can still be filed against them), and refuses an
 * archived one on the same terms as every other operation here.
 */
export async function getLead(id: string) {
  return toLeadDto(await getActiveLead(id));
}

/**
 * Dragging a lead across the board — its own action, because it carries a POSITION and not just a
 * stage. The same guards as an edit: a won lead is read-only and a lost one has to be reopened
 * first, so the board cannot quietly resurrect either by dropping it somewhere.
 */
export async function moveLead(id: string, input: MoveLeadInput) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") throw new ValidationError("A converted lead is read-only");
  if (lead.outcome === "lost") {
    throw new ValidationError("Reopen this lead before editing or moving it");
  }
  await repo.moveLeadInBoard(id, input.stageId, input.afterLeadId);
  // re-read rather than patch the copy in hand: the move renumbered its neighbours too, and the
  // row that comes back is the one the board will be compared against
  return toLeadDto(await getActiveLead(id));
}

export async function updateLead(id: string, input: UpdateLeadInput) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ValidationError("A converted lead is read-only");
  }
  if (lead.outcome === "lost") {
    throw new ValidationError("Reopen this lead before editing or moving it");
  }
  // contacts are optional (user, 2026-07-26): a lead may be a name and a note, and an edit
  // may clear the phone or the email again — only the name has to survive
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
    firstName: input.firstName,
    lastName: input.lastName ?? null,
    // the company label rides straight over — it was never an identity on either side
    companyName: input.companyName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    description: input.description ?? null,
    ...(input.sourceId ? { source: { connect: { id: input.sourceId } } } : {}),
  });
  // a converted lead becomes a new client → give it the default service too (no-op if none)
  await applyDefaultClientService(client.id);
  return { clientId: client.id, lead: toLeadDto(updated) };
}

/**
 * Archive a lead — a soft delete, not an outcome. Losing a lead is `mark-lost`, which keeps it on
 * the Closed tab where the firm can still see who was talked to and reopen the conversation.
 * Archiving is for rows that should stop appearing at all: duplicates, tests, mistakes.
 *
 * A converted lead can't be archived: it is the paper trail of where a real client came from, and
 * the client card links back to it.
 */
export async function archiveLead(id: string, actor: User) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ConflictError("A converted lead is the record of where a client came from");
  }
  await repo.updateLead(id, { archivedAt: new Date(), archivedById: actor.id });
  return { ok: true as const };
}

/** Put an archived lead back — it returns to whichever tab its outcome puts it on. */
export async function restoreLead(id: string) {
  const lead = await repo.findLead(id);
  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.archivedAt) throw new ConflictError("This lead is not archived");
  await repo.updateLead(id, { archivedAt: null, archivedById: null });
  return toLeadDto(await getActiveLead(id));
}

// ── the pipeline's columns ───────────────────────────────────────────────────

/**
 * The stages, and everything that can be done to them. Deliberately the same set of rules as the
 * task board's columns, because they are the same thing: rename, add at the end, drag into place,
 * and delete only while nothing is standing in it.
 *
 * Unlike the task board there is no FIXED column. A new lead simply starts in whichever stage the
 * firm has put first, so the pipeline can be rearranged completely without a special case.
 */
export async function listStages() {
  return repo.listStages();
}

export async function addStage(input: CreateLeadStageInput) {
  if (await repo.findStageByName(input.name)) {
    throw new ConflictError("A stage with this name already exists");
  }
  return repo.createStage(input.name);
}

export async function renameStage(id: string, input: UpdateLeadStageInput) {
  const stage = await repo.findStage(id);
  if (!stage) throw new NotFoundError("Stage not found");
  const clash = await repo.findStageByName(input.name);
  if (clash && clash.id !== id) throw new ConflictError("A stage with this name already exists");
  return repo.renameStage(id, input.name);
}

export async function moveStage(id: string, input: MoveLeadStageInput) {
  const stage = await repo.findStage(id);
  if (!stage) throw new NotFoundError("Stage not found");
  await repo.moveStage(id, input.afterStageId);
  return repo.listStages();
}

/**
 * Delete a stage — only while no lead stands in it, ARCHIVED and closed ones included. The count is
 * for the message; the foreign key is `RESTRICT`, so the database is what actually holds the line.
 *
 * The last stage cannot go either: a pipeline with no columns has nowhere to put the next lead,
 * and `createLead` would start failing with something far less clear than this.
 */
export async function removeStage(id: string) {
  const stage = await repo.findStage(id);
  if (!stage) throw new NotFoundError("Stage not found");
  const leads = await repo.countLeadsInStage(id);
  if (leads > 0) {
    throw new ConflictError(
      `“${stage.name}” still holds ${leads} lead${leads === 1 ? "" : "s"} (archived and closed included) — move them first`,
    );
  }
  if ((await repo.listStages()).length === 1) {
    throw new ValidationError("A pipeline needs at least one stage");
  }
  await repo.deleteStage(id);
  return { ok: true as const };
}
