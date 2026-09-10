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
import { diff, labelOf, record } from "../../core/activity.js";
import * as repo from "./leads.repository.js";
import { reorder } from "../../core/order.js";

/** New/changed service on a lead must exist and be active (existing refs stay untouched). */
async function assertActiveService(
  serviceId: string | null | undefined,
  current?: string | null,
) {
  if (!serviceId || serviceId === current) return null;
  const service = await repo.findService(serviceId);
  if (!service || !service.active) throw new ValidationError("Unknown or inactive service");
  // internal services are firm-internal recurring tasks — not a lead's/client's service
  if (service.type === "internal")
    throw new ValidationError("Internal services aren't client-facing");
  // returned so the log can name it: the validating read already has the row, and a second one
  // just to turn an id into a word is a query bought for nothing
  return service;
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
  // Same field-by-field shape as the clients and invoices searches, so a phrase typed on the
  // Archive means the same thing whichever tab it is typed on. A lead has no client code to
  // match — it is not a client yet, which is the whole point of the pipeline.
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    where.OR = [
      { name: contains },
      { companyName: contains },
      { email: contains },
      { phone: contains },
    ];
  }

  const { items, total } = await repo.listLeads(where, LEAD_LIST_LIMIT);
  return { items: items.map(toLeadDto), total, truncated: total > items.length };
}

export async function createLead(input: CreateLeadInput) {
  const service = await assertActiveService(input.serviceId);
  // a new lead starts at the front of the pipeline — whichever column the firm has put there
  const first = await repo.firstStage();
  if (!first)
    throw new ValidationError("The pipeline has no stages — add one on the board first");
  // `stageId`, not `stage: { connect }` — the rest of the input is scalars, and one relation
  // form among them flips Prisma to its checked variant, where `serviceId` is not a valid key
  const lead = await repo.createLead({ ...input, stageId: first.id });
  record("lead.created", {
    subjectId: lead.id,
    subjectLabel: lead.name,
    changes: { companyName: lead.companyName, service: service?.name ?? null },
  });
  return toLeadDto(lead);
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
  const moved = await getActiveLead(id);
  // only a change of STAGE — re-ordering within one is presentation, exactly as on the task board
  if (lead.stageId !== input.stageId) {
    record("lead.stage_changed", {
      subjectId: id,
      subjectLabel: lead.name,
      // the NAMES, from the row before and the row after: "moved from New to Qualified" is the
      // answer, and the re-read above already holds the second half of it
      changes: { stage: { from: lead.stage.name, to: moved.stage.name } },
    });
  }
  return toLeadDto(moved);
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
  // the validated row is kept: the entry names the service, and asking twice is a round trip
  const service = await assertActiveService(input.serviceId, lead.serviceId);
  const updated = await repo.updateLead(id, input);
  /**
   * The two reference fields are diffed by NAME, not by id.
   *
   * `serviceId` and `sourceId` are what the table stores, and a diff of them reads
   * `sourceId 1f2e… → 9a0b…`, which tells a reader that something changed and nothing about what.
   * `diff()` compares the ids, because that is what actually moved and comparing names would miss
   * a rename; the pair is then relabelled before it is recorded.
   */
  const moved =
    diff(lead as unknown as Record<string, unknown>, input as Record<string, unknown>, [
      "name",
      "companyName",
      "phone",
      "email",
      "serviceId",
      "sourceId",
      "description",
    ]) ?? undefined;
  if (moved?.serviceId) {
    moved.service = {
      from: await labelOf("service", moved.serviceId.from as string),
      to: service?.name ?? null,
    };
    delete moved.serviceId;
  }
  if (moved?.sourceId) {
    moved.source = {
      from: await labelOf("sourceOption", moved.sourceId.from as string),
      to: await labelOf("sourceOption", moved.sourceId.to as string),
    };
    delete moved.sourceId;
  }
  record("lead.updated", { subjectId: id, subjectLabel: updated.name, changes: moved });
  return toLeadDto(updated);
}

export async function markLost(id: string) {
  const lead = await getActiveLead(id);
  if (lead.outcome === "won") {
    throw new ValidationError("A converted lead is read-only");
  }
  const lost = await repo.updateLead(id, { outcome: "lost" });
  // only on a real move: marking an already-lost lead lost again is a legal no-op write, and a
  // second row for it is the log claiming a decision nobody took
  if (lead.outcome !== "lost") {
    record("lead.marked_lost", { subjectId: id, subjectLabel: lead.name });
  }
  return toLeadDto(lost);
}

export async function reopen(id: string) {
  const lead = await getActiveLead(id);
  if (lead.outcome !== "lost") {
    throw new ValidationError("Only lost leads can be reopened");
  }
  const reopened = await repo.updateLead(id, { outcome: "in_process" });
  record("lead.reopened", { subjectId: id, subjectLabel: lead.name });
  return toLeadDto(reopened);
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
  // the one lead event that outlives the pipeline: where a real client came from. `clientId` is
  // filled as well as the subject, so it also shows on the new client's own Activity tab
  record("lead.converted", {
    subjectId: id,
    subjectLabel: lead.name,
    // no `changes`: `clientId` is a column on the row and renders as the client's NAME beside the
    // sentence. Repeating it as a diff field said the same thing twice, and said it as a uuid
    clientId: client.id,
  });
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
  record("lead.archived", { subjectId: id, subjectLabel: lead.name });
  return { ok: true as const };
}

/** Put an archived lead back — it returns to whichever tab its outcome puts it on. */
export async function restoreLead(id: string) {
  const lead = await repo.findLead(id);
  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.archivedAt) throw new ConflictError("This lead is not archived");
  await repo.updateLead(id, { archivedAt: null, archivedById: null });
  record("lead.restored", { subjectId: id, subjectLabel: lead.name });
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
  const stage = await repo.createStage(input.name);
  record("settings.stage_created", { subjectId: stage.id, subjectLabel: stage.name });
  return stage;
}

export async function renameStage(id: string, input: UpdateLeadStageInput) {
  const stage = await repo.findStage(id);
  if (!stage) throw new NotFoundError("Stage not found");
  const clash = await repo.findStageByName(input.name);
  if (clash && clash.id !== id)
    throw new ConflictError("A stage with this name already exists");
  const renamed = await repo.renameStage(id, input.name);
  if (stage.name !== input.name) {
    record("settings.stage_updated", {
      subjectId: id,
      subjectLabel: input.name,
      changes: { name: { from: stage.name, to: input.name } },
    });
  }
  return renamed;
}

export async function moveStage(id: string, input: MoveLeadStageInput) {
  const stage = await repo.findStage(id);
  if (!stage) throw new NotFoundError("Stage not found");
  // a drag that lands where it started is not a move — the same rule the board's cards follow
  const { moved, after } = await reorder(
    () => repo.listStages(),
    () => repo.moveStage(id, input.afterStageId),
  );
  if (moved) record("settings.stage_moved", { subjectId: id, subjectLabel: stage.name });
  return after;
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
  record("settings.stage_deleted", { subjectId: id, subjectLabel: stage.name });
  return { ok: true as const };
}
