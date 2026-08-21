import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

/**
 * Campaign storage. Lives in the Mailouts module rather than beside it: a campaign is a planned
 * mailout, it writes ordinary `Mailout` rows when it fires, and splitting the two would mean two
 * modules owning one send path.
 */

const campaignInclude = {
  dates: { select: { on: true }, orderBy: { on: "asc" } },
  template: { select: { name: true, subject: true, body: true } },
  senderAccount: { select: { name: true } },
  createdBy: { select: { firstName: true, lastName: true } },
  _count: { select: { recipients: true, runs: true } },
} satisfies Prisma.CampaignInclude;

export type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }>;

export function listCampaigns() {
  return prisma.campaign.findMany({
    include: campaignInclude,
    // due soonest first, then the ones with no date left (stopped, finished) by recency
    orderBy: [{ nextRunOn: "asc" }, { createdAt: "desc" }],
  });
}

export function findCampaign(id: string) {
  return prisma.campaign.findUnique({ where: { id }, include: campaignInclude });
}

export function findCampaignByName(name: string) {
  return prisma.campaign.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
}

export function createCampaign(
  data: Prisma.CampaignCreateInput,
  recipients: Prisma.CampaignRecipientCreateManyCampaignInput[],
  dates: Date[],
) {
  return prisma.campaign.create({
    data: {
      ...data,
      recipients: { createMany: { data: recipients } },
      dates: { createMany: { data: dates.map((on) => ({ on })) } },
    },
    include: campaignInclude,
  });
}

/**
 * Replace the whole list in one transaction.
 *
 * Delete-then-insert rather than a diff: the list has no identity worth preserving (no per-row
 * state, nothing points at these rows), and a diff would be more code for the same result. Inside
 * a transaction so a campaign is never briefly empty — the sweep could run in that window.
 */
export function updateCampaign(
  id: string,
  data: Prisma.CampaignUpdateInput,
  recipients: Prisma.CampaignRecipientCreateManyCampaignInput[] | null,
  /** null = leave the days alone (a stop/start does not touch them) */
  dates: Date[] | null = null,
) {
  return prisma.$transaction(async (tx) => {
    if (recipients) {
      await tx.campaignRecipient.deleteMany({ where: { campaignId: id } });
      await tx.campaignRecipient.createMany({
        data: recipients.map((r) => ({ ...r, campaignId: id })),
      });
    }
    if (dates) {
      // Replaced wholesale, like the recipients: these rows carry no state of their own — which
      // day already fired lives on `Mailout.periodKey` — so there is nothing to preserve.
      await tx.campaignDate.deleteMany({ where: { campaignId: id } });
      await tx.campaignDate.createMany({ data: dates.map((on) => ({ campaignId: id, on })) });
    }
    return tx.campaign.update({ where: { id }, data, include: campaignInclude });
  });
}

export function deleteCampaign(id: string) {
  return prisma.campaign.delete({ where: { id } });
}

/** The list, with everything a decision needs — same shape the send path resolves against. */
export function listCampaignRecipients(campaignId: string) {
  return prisma.campaignRecipient.findMany({
    where: { campaignId },
    select: { clientId: true, companyId: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * What is due, in one query the sweep can run every night.
 *
 * `nextRunOn <= today` rather than `= today` on purpose: a date missed while the server was down
 * must still fire, once. The unique (campaignId, periodKey) on Mailout is what makes "once" true
 * regardless of how many times the sweep runs.
 */
export function findDueCampaigns(todayUtcMidnight: Date) {
  return prisma.campaign.findMany({
    where: { status: "scheduled", nextRunOn: { not: null, lte: todayUtcMidnight } },
    include: campaignInclude,
    orderBy: { nextRunOn: "asc" },
  });
}

export function markCampaignRun(
  id: string,
  data: { nextRunOn: Date | null; lastRunAt: Date; status?: "scheduled" | "finished" },
) {
  return prisma.campaign.update({ where: { id }, data });
}

/** The firings so far, newest first — each one is a row in the Sent log. */
export function listCampaignRuns(campaignId: string) {
  return prisma.mailout.findMany({
    where: { campaignId },
    select: { id: true, periodKey: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Who unsubscribed because of THIS campaign.
 *
 * Answerable only because the unsubscribe link carries the letter it came from and the letter
 * knows its campaign — the token itself belongs to the client and says nothing about where it was
 * clicked. The opt-out stays global; this names what prompted it.
 */
export function listCampaignOptOuts(campaignId: string) {
  return prisma.clientMailPreference.findMany({
    where: { unsubscribedAt: { not: null }, unsubscribedFrom: { campaignId } },
    select: {
      clientId: true,
      unsubscribedAt: true,
      client: { select: { firstName: true, lastName: true } },
      unsubscribedFrom: { select: { periodKey: true } },
    },
    orderBy: { unsubscribedAt: "desc" },
    // bounded: this one grows with CLIENT behaviour rather than the firm's, and it renders in a
    // panel on the campaign card. The count beside the heading is what answers "how many".
    take: 100,
  });
}

/** The campaigns a client is on, for their card. */
export function listClientCampaigns(clientId: string) {
  return prisma.campaignRecipient.findMany({
    where: { clientId, campaign: { status: { not: "finished" } } },
    include: {
      company: { select: { name: true } },
      campaign: {
        select: {
          id: true,
          name: true,
          kind: true,
          rhythm: true,
          status: true,
          nextRunOn: true,
          // carried so the card can say "would this client actually receive it" without a
          // second query per campaign
          templateId: true,
          senderAccountId: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    // bounded like the card's letter history: each row costs one assessment, and an unbounded
    // list would put that cost on a screen that refetches whenever the window regains focus
    take: 50,
  });
}

/**
 * Does this mailout really have a row for this client?
 *
 * The unsubscribe link carries its own mailout id, which makes that id a CLAIM — anyone can edit
 * a URL. Recording provenance without this check would let a stray link credit an opt-out to a
 * campaign that never wrote to them.
 */
export async function mailoutIncludesClient(mailoutId: string, clientId: string) {
  return (
    (await prisma.mailoutRecipient.count({ where: { mailoutId, clientId } })) > 0
  );
}
