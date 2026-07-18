import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ConflictError } from "../../core/errors.js";

export function listLeads() {
  return prisma.lead.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

export function findLead(id: string) {
  return prisma.lead.findUnique({ where: { id } });
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
    return { client, lead };
  });
}
