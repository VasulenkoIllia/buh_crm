import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ConflictError } from "../../core/errors.js";

/** the stage's NAME rides along, so no screen has to hold the stage list to draw one card */
const withStage = { stage: { select: { name: true } } } satisfies Prisma.LeadInclude;
export type LeadRecord = Prisma.LeadGetPayload<{ include: typeof withStage }>;

export async function listLeads(where: Prisma.LeadWhereInput, take: number) {
  const [items, total] = await prisma.$transaction([
    // board order first, newest second: the pipeline is arranged by hand, and a lead nobody has
    // moved keeps the place its arrival gave it (the back-fill matched exactly that)
    prisma.lead.findMany({
      where,
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      take,
      include: withStage,
    }),
    prisma.lead.count({ where }),
  ]);
  return { items, total };
}

/**
 * Put `leadId` in `stage`, immediately after `afterLeadId` — or at the top when that is null.
 *
 * Renumbers the whole stage 0..n-1 and writes only the rows that actually move, exactly as
 * `moveTaskInBoard` does. Same problem, same answer; the two are worth comparing if either is
 * ever changed.
 */
export async function moveLeadInBoard(
  leadId: string,
  stageId: string,
  afterLeadId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const inStage = await tx.lead.findMany({
      where: { stageId, archivedAt: null, id: { not: leadId } },
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      select: { id: true, boardOrder: true },
    });
    const was = new Map(inStage.map((l) => [l.id, l.boardOrder]));
    const ids = inStage.map((l) => l.id);

    // an anchor that is not in this stage (a stale board, someone else moved it) means the
    // caller's picture is out of date — put the lead on top rather than guess a position
    const at = afterLeadId ? ids.indexOf(afterLeadId) : -1;
    ids.splice(at + 1, 0, leadId);

    for (const [order, id] of ids.entries()) {
      if (id === leadId || was.get(id) === order) continue;
      await tx.lead.update({ where: { id }, data: { boardOrder: order } });
    }
    await tx.lead.update({
      where: { id: leadId },
      data: { stageId, boardOrder: ids.indexOf(leadId) },
    });
  });
}

export function findLead(id: string) {
  return prisma.lead.findUnique({ where: { id }, include: withStage });
}

/** The catalog service a lead points at — validated on write (active + client-facing). */
export function findService(id: string) {
  return prisma.service.findUnique({
    where: { id },
    select: { id: true, active: true, type: true },
  });
}

export function createLead(data: Prisma.LeadUncheckedCreateInput) {
  return prisma.lead.create({ data, include: withStage });
}

export function updateLead(id: string, data: Prisma.LeadUpdateInput) {
  return prisma.lead.update({ where: { id }, data, include: withStage });
}

/** Convert transaction: create the client + mark the lead won, atomically + race-safe. */
export function convertLead(
  leadId: string,
  clientData: Prisma.ClientCreateInput,
) {
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: clientData });
    // conditional update: only the first concurrent request wins; the loser rolls back
    const marked = await tx.lead.updateMany({
      where: { id: leadId, outcome: { not: "won" } },
      data: { outcome: "won", convertedClientId: client.id },
    });
    if (marked.count !== 1) {
      throw new ConflictError("This lead is already converted"); // rolls back the created client
    }
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, include: withStage });
    // The lead's service used to be copied onto the client as a category chip (2026-07-21).
    // Categories are derived from the client's actual subscriptions now (2026-07-26), and a
    // subscription needs an amount and a period nobody has agreed yet — so convert doesn't
    // invent one. The service stays visible on the won lead, which links to the client.
    return { client, lead };
  });
}

// ── the pipeline's columns ───────────────────────────────────────────────────

export function listStages() {
  return prisma.leadStage.findMany({ orderBy: { order: "asc" } });
}

export function findStage(id: string) {
  return prisma.leadStage.findUnique({ where: { id } });
}

export function findStageByName(name: string) {
  return prisma.leadStage.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

/** The stage a lead lands in when nobody says otherwise: the first column of the board. */
export function firstStage() {
  return prisma.leadStage.findFirst({ orderBy: { order: "asc" } });
}

export async function createStage(name: string) {
  const { _max } = await prisma.leadStage.aggregate({ _max: { order: true } });
  return prisma.leadStage.create({ data: { name, order: (_max.order ?? -1) + 1 } });
}

export function renameStage(id: string, name: string) {
  return prisma.leadStage.update({ where: { id }, data: { name } });
}

export function countLeadsInStage(id: string) {
  return prisma.lead.count({ where: { stageId: id } });
}

export function deleteStage(id: string) {
  return prisma.leadStage.delete({ where: { id } });
}

/**
 * Drag a stage along the board. The same anchor-and-renumber the task columns use, minus the fixed
 * column they have to keep at the front — every stage of a pipeline is movable.
 */
export async function moveStage(stageId: string, afterStageId: string | null) {
  return prisma.$transaction(async (tx) => {
    const rest = await tx.leadStage.findMany({
      where: { id: { not: stageId } },
      orderBy: { order: "asc" },
      select: { id: true, order: true },
    });
    const was = new Map(rest.map((r) => [r.id, r.order]));
    const ids = rest.map((r) => r.id);
    // an anchor that is gone (a stale board, someone else deleted it) puts the stage first rather
    // than guessing a position from a list that has moved on
    const at = afterStageId ? ids.indexOf(afterStageId) : -1;
    ids.splice(at + 1, 0, stageId);
    for (const [order, id] of ids.entries()) {
      if (id !== stageId && was.get(id) === order) continue;
      await tx.leadStage.update({ where: { id }, data: { order } });
    }
  });
}
