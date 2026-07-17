import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

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

/** Convert transaction: create the client + mark the lead won, atomically. */
export function convertLead(
  leadId: string,
  clientData: Prisma.ClientCreateInput,
) {
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: clientData });
    const lead = await tx.lead.update({
      where: { id: leadId },
      data: { outcome: "won", convertedClientId: client.id },
    });
    return { client, lead };
  });
}
