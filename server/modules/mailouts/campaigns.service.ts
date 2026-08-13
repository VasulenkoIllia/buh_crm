/**
 * Campaigns (S10.1) — a planned mailout: a template, a list, and a date it goes out on.
 *
 * ## A campaign does not send
 *
 * When its date comes round it creates an ordinary `Mailout`, through the same `dispatch` a person
 * pressing Send goes through. So the Sent log stays the single record of what left the building,
 * and a scheduled letter cannot quietly stop honouring an opt-out because its own copy of the
 * rules drifted.
 *
 * ## Once per occurrence, never twice
 *
 * The sweep runs nightly AND on every boot, so "it already ran" cannot be a fact the sweep
 * remembers — it has to be one the database enforces. Every run carries a `periodKey` naming its
 * date, and `UNIQUE(campaignId, periodKey)` on `Mailout` is what makes a second attempt fail
 * rather than duplicate. A date missed while the server was down fires late, once.
 *
 * ## Late, but never a backlog
 *
 * After a late run the next date is counted from TODAY, not from the date that was missed. The
 * task and invoice sweeps deliberately do the opposite and catch up every missed period, because
 * a missing invoice is a missing fact. A campaign catching up the same way would empty six months
 * of newsletters into a client's inbox in one morning.
 */
import type {
  Campaign,
  CampaignDetail,
  CampaignInput,
  CampaignOptOut,
  CampaignRecipientRow,
  CampaignRun,
} from "@shared/schema/campaigns.js";
import type { MailoutTarget } from "@shared/schema/mailouts.js";
import type { CampaignRhythm, CampaignStatus, MailoutKind } from "@shared/schema/enums.js";
import { firstRunOn, nextRunAfter, periodKeyOf } from "@shared/campaigns.js";
import { config } from "../../core/config.js";
import { fromDate } from "../../core/dates.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { clientLabel, personName } from "../../core/names.js";
import type { User } from "../../generated/prisma/client.js";
import * as repo from "./campaigns.repository.js";
import * as mailRepo from "./mailouts.repository.js";
import { assessTargets, countsFor, runCampaign } from "./mailouts.service.js";

/** Today as a business date — the firm's calendar day, read explicitly, never the process's. */
function todayMs(now: Date = new Date()): number {
  const { y, m, d } = fromDate(now, config.TZ);
  return Date.UTC(y, m - 1, d);
}

/** "HH:MM" on the firm's clock — what `sendAt` is compared against. */
function hhmm(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

const dayMs = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoDay = (d: Date | null) => (d ? new Date(dayMs(d)).toISOString().slice(0, 10) : null);
const parseDay = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

// ── reading ──────────────────────────────────────────────────────────────────

function toCampaign(row: repo.CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    templateId: row.templateId,
    templateName: row.template.name,
    senderAccountId: row.senderAccountId,
    senderAccountName: row.senderAccount?.name ?? null,
    kind: row.kind as MailoutKind,
    rhythm: row.rhythm as CampaignRhythm,
    startsOn: isoDay(row.startsOn)!,
    sendAt: row.sendAt,
    endsOn: isoDay(row.endsOn),
    status: row.status as CampaignStatus,
    nextRunOn: isoDay(row.nextRunOn),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdByName: row.createdBy ? personName(row.createdBy) : null,
    createdAt: row.createdAt.toISOString(),
    recipientCount: row._count.recipients,
    runCount: row._count.runs,
  };
}

export async function list(): Promise<{ items: Campaign[] }> {
  return { items: (await repo.listCampaigns()).map(toCampaign) };
}

export async function detail(id: string): Promise<CampaignDetail> {
  const row = await repo.findCampaign(id);
  if (!row) throw new NotFoundError("Campaign not found");

  const targets = await repo.listCampaignRecipients(id);
  const [decisions, runRows, optOutRows] = await Promise.all([
    // Assessed LIVE, not stored: a client can unsubscribe between planning and sending, and the
    // whole point of showing this is that the firm sees it before the date rather than after.
    assessTargets(row.templateId, row.kind as MailoutKind, row.senderAccountId, targets),
    repo.listCampaignRuns(id),
    repo.listCampaignOptOuts(id),
  ]);

  const counts = await countsFor(runRows.map((r) => r.id));
  const runs: CampaignRun[] = runRows.map((r) => ({
    mailoutId: r.id,
    periodKey: r.periodKey,
    createdAt: r.createdAt.toISOString(),
    ...(counts.get(r.id) ?? { sent: 0, failed: 0, skipped: 0, queued: 0 }),
  }));

  const recipients: CampaignRecipientRow[] = decisions.map((d) => ({
    clientId: d.clientId,
    companyId: d.companyId,
    clientName: d.clientName,
    companyName: d.companyName,
    email: d.email,
    blockedReason: d.blockedReason,
  }));

  const optOuts: CampaignOptOut[] = optOutRows.map((o) => ({
    clientId: o.clientId,
    clientName: clientLabel(o.client),
    unsubscribedAt: o.unsubscribedAt!.toISOString(),
    periodKey: o.unsubscribedFrom?.periodKey ?? null,
  }));

  return {
    ...toCampaign(row),
    recipients,
    runs,
    optOuts,
    subject: row.template.subject,
    body: row.template.body,
  };
}

// ── writing ──────────────────────────────────────────────────────────────────

/** Collapse duplicates the same way a send does — twice on a list means one letter. */
function dedupe(targets: MailoutTarget[]) {
  const seen = new Map<string, { clientId: string; companyId: string | null }>();
  for (const t of targets) {
    const companyId = t.companyId ?? null;
    const key = `${t.clientId}:${companyId ?? ""}`;
    if (!seen.has(key)) seen.set(key, { clientId: t.clientId, companyId });
  }
  return [...seen.values()];
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await repo.findCampaignByName(name);
  if (clash && clash.id !== exceptId) {
    throw new ConflictError(`A campaign named “${name}” already exists`);
  }
}

async function assertTemplateUsable(templateId: string) {
  const template = await mailRepo.findTemplate(templateId);
  if (!template) throw new NotFoundError("Template not found");
  if (!template.active) {
    throw new ValidationError(`“${template.name}” is inactive — activate it to schedule it`);
  }
}

export async function create(actor: User, input: CampaignInput): Promise<CampaignDetail> {
  await assertNameFree(input.name);
  await assertTemplateUsable(input.templateId);

  const startsOn = parseDay(input.startsOn);
  const endsOn = input.endsOn ? parseDay(input.endsOn) : null;
  const nextRun = firstRunOn(startsOn, endsOn);
  if (nextRun === null) {
    throw new ValidationError("This campaign would never run — check the dates");
  }

  const row = await repo.createCampaign(
    {
      name: input.name,
      template: { connect: { id: input.templateId } },
      senderAccount: input.senderAccountId ? { connect: { id: input.senderAccountId } } : undefined,
      kind: input.kind,
      rhythm: input.rhythm,
      startsOn: new Date(startsOn),
      sendAt: input.sendAt,
      endsOn: endsOn === null ? null : new Date(endsOn),
      nextRunOn: new Date(nextRun),
      createdBy: { connect: { id: actor.id } },
    },
    dedupe(input.recipients),
  );
  return detail(row.id);
}

/**
 * Editing is allowed while a campaign is scheduled or stopped — including its list, which is the
 * whole reason the list is stored rather than frozen at creation.
 *
 * What has already gone out is untouched by any of this: those are `Mailout` rows with their own
 * snapshot of the letter and their own recipient list, and nothing here can reach them.
 */
export async function update(id: string, input: CampaignInput): Promise<CampaignDetail> {
  const existing = await repo.findCampaign(id);
  if (!existing) throw new NotFoundError("Campaign not found");
  if (existing.status === "finished") {
    throw new ConflictError(
      "This campaign has run out of dates — copy it into a new one rather than reviving it",
    );
  }
  await assertNameFree(input.name, id);
  await assertTemplateUsable(input.templateId);

  const startsOn = parseDay(input.startsOn);
  const endsOn = input.endsOn ? parseDay(input.endsOn) : null;

  // Moving the dates re-derives what is due next. Counted from yesterday so a start date set to
  // TODAY is still due today — the sweep has not necessarily run yet.
  const next =
    existing.lastRunAt === null
      ? firstRunOn(startsOn, endsOn)
      : nextRunAfter(startsOn, input.rhythm, Math.max(todayMs() - 86_400_000, dayMs(existing.lastRunAt)), endsOn);

  await repo.updateCampaign(
    id,
    {
      name: input.name,
      template: { connect: { id: input.templateId } },
      senderAccount: input.senderAccountId
        ? { connect: { id: input.senderAccountId } }
        : { disconnect: true },
      kind: input.kind,
      rhythm: input.rhythm,
      startsOn: new Date(startsOn),
      sendAt: input.sendAt,
      endsOn: endsOn === null ? null : new Date(endsOn),
      nextRunOn: next === null ? null : new Date(next),
      status: next === null ? "finished" : existing.status,
    },
    dedupe(input.recipients),
  );
  return detail(id);
}

/** Stop a campaign, or start a stopped one again. A finished one cannot be resumed. */
export async function setActive(id: string, active: boolean): Promise<CampaignDetail> {
  const existing = await repo.findCampaign(id);
  if (!existing) throw new NotFoundError("Campaign not found");
  if (existing.status === "finished") {
    throw new ConflictError("This campaign has run out of dates");
  }

  if (!active) {
    // nextRunOn is cleared as well as the status: a stopped campaign still carrying a date reads
    // as "due", and one forgotten `status` check anywhere would then send it.
    //
    // `lastRunAt` is deliberately untouched. Stamping it here would tell a later resume that this
    // campaign has already run, and a campaign stopped before it ever fired would come back with
    // its first date silently skipped.
    await repo.updateCampaign(id, { status: "stopped", nextRunOn: null }, null);
    return detail(id);
  }

  const startsOn = dayMs(existing.startsOn);
  const endsOn = existing.endsOn ? dayMs(existing.endsOn) : null;
  const next =
    existing.lastRunAt === null
      ? firstRunOn(startsOn, endsOn)
      : nextRunAfter(startsOn, existing.rhythm as CampaignRhythm, todayMs() - 86_400_000, endsOn);
  if (next === null) {
    throw new ValidationError("There are no dates left — change the schedule before starting it");
  }
  await repo.updateCampaign(id, { status: "scheduled", nextRunOn: new Date(next) }, null);
  return detail(id);
}

/** Deleting is refused once anything has gone out — those letters point back at this row. */
export async function remove(id: string): Promise<void> {
  const existing = await repo.findCampaign(id);
  if (!existing) throw new NotFoundError("Campaign not found");
  if (existing._count.runs > 0) {
    throw new ConflictError(
      `“${existing.name}” has already sent ${existing._count.runs} time${existing._count.runs === 1 ? "" : "s"} — stop it instead of deleting, so the letters keep their history`,
    );
  }
  await repo.deleteCampaign(id);
}

// ── the sweep ────────────────────────────────────────────────────────────────

/**
 * Fire every campaign whose date has come.
 *
 * Runs nightly and on every boot. Safe to run twice: the second attempt collides on
 * `UNIQUE(campaignId, periodKey)` and is swallowed, because "already sent" is not an error.
 */
export async function runDueCampaigns(
  /**
   * The instant to judge "due" against. Defaults to now; the tests pass a fixed one.
   *
   * A scheduler test that depends on the wall clock passes for twenty-three hours a day, which is
   * indistinguishable from passing — and the hour it fails is the hour nobody is looking.
   */
  now: Date = new Date(),
): Promise<{ fired: number; failed: number }> {
  const today = todayMs(now);
  const due = await repo.findDueCampaigns(new Date(today));
  let fired = 0;
  let failed = 0;

  const clock = hhmm(now);
  for (const campaign of due) {
    const runOn = dayMs(campaign.nextRunOn!);
    const key = periodKeyOf(runOn);

    // The time of day the firm typed is honoured, not decoration: a campaign due TODAY waits
    // until its hour. One already past its date does not wait — it is late, and holding it back
    // for a clock reading would make a date missed at 23:00 wait another whole day.
    if (runOn >= today && campaign.sendAt > clock) continue;

    try {
      const targets = await repo.listCampaignRecipients(campaign.id);
      if (targets.length > 0) {
        await runCampaign({
          id: campaign.id,
          templateId: campaign.templateId,
          kind: campaign.kind as MailoutKind,
          senderAccountId: campaign.senderAccountId,
          targets,
          periodKey: key,
        });
      }

      // Counted from TODAY, not from the date that was missed — see the module comment. A campaign
      // five months late sends one letter and lines up the next one, not five letters.
      const endsOn = campaign.endsOn ? dayMs(campaign.endsOn) : null;
      const next = nextRunAfter(
        dayMs(campaign.startsOn),
        campaign.rhythm as CampaignRhythm,
        Math.max(today, runOn),
        endsOn,
      );
      await repo.markCampaignRun(campaign.id, {
        nextRunOn: next === null ? null : new Date(next),
        lastRunAt: new Date(),
        status: next === null ? "finished" : "scheduled",
      });
      fired += 1;
    } catch (err) {
      // A campaign that cannot fire must not stop the ones behind it, and must not silently
      // advance either — it stays due, and the error is in the log where somebody looks.
      failed += 1;
      console.error(`[campaigns] run failed for campaign=${campaign.id} period=${key}:`, err);
    }
  }
  return { fired, failed };
}
