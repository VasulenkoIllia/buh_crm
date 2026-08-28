import type { LeadStage } from "@shared/schema/enums.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ConflictError } from "../../core/errors.js";

export async function listLeads(where: Prisma.LeadWhereInput, take: number) {
  const [items, total] = await prisma.$transaction([
    // board order first, newest second: the pipeline is arranged by hand, and a lead nobody has
    // moved keeps the place its arrival gave it (the back-fill matched exactly that)
    prisma.lead.findMany({
      where,
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      take,
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
  stage: LeadStage,
  afterLeadId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const inStage = await tx.lead.findMany({
      where: { stage, archivedAt: null, id: { not: leadId } },
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
      data: { stage, boardOrder: ids.indexOf(leadId) },
    });
  });
}

export function findLead(id: string) {
  return prisma.lead.findUnique({ where: { id } });
}

/** The catalog service a lead points at — validated on write (active + client-facing). */
export function findService(id: string) {
  return prisma.service.findUnique({
    where: { id },
    select: { id: true, active: true, type: true },
  });
}

export function createLead(data: Prisma.LeadCreateInput) {
  return prisma.lead.create({ data });
}

export function updateLead(id: string, data: Prisma.LeadUpdateInput) {
  return prisma.lead.update({ where: { id }, data });
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
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    // The lead's service used to be copied onto the client as a category chip (2026-07-21).
    // Categories are derived from the client's actual subscriptions now (2026-07-26), and a
    // subscription needs an amount and a period nobody has agreed yet — so convert doesn't
    // invent one. The service stays visible on the won lead, which links to the client.
    return { client, lead };
  });
}
