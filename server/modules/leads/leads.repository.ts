import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ConflictError } from "../../core/errors.js";

export async function listLeads(where: Prisma.LeadWhereInput, take: number) {
  const [items, total] = await prisma.$transaction([
    prisma.lead.findMany({ where, orderBy: { createdAt: "desc" }, take }),
    prisma.lead.count({ where }),
  ]);
  return { items, total };
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
