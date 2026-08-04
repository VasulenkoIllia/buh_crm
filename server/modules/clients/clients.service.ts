import type {
  ClientListQuery,
  CreateClientInput,
  CreateSubscriptionInput,
  UpdateClientInput,
  UpdateSubscriptionInput,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
} from "@shared/schema/client.js";
import { rhythmOverridesSchema } from "@shared/schema/catalog.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceOn, inForceTodayWhere, notEnded, type InForcePeriod } from "../../core/coverage.js";
import { type Day, addDays, dateToUtc, todayInTz, toUtc } from "../../core/dates.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { debtByClient, generateForSubscriptionInvoices } from "../payments/index.js";
import { generateForSubscription } from "../tasks/index.js";
import { MAX_FILE_SIZE, deleteFileBytes, saveFileBytes } from "../../core/files.js";
import { clientLabel } from "../../core/names.js";
import * as repo from "./clients.repository.js";

/**
 * `isRegular` is **purely derived** (user, 2026-07-26): a client is regular exactly while they
 * hold an active SUBSCRIPTION-type service. Adding one makes them regular; stopping it makes them
 * one-time again, with no stored flag that could drift from the services they actually have.
 * One-time subs are just containers ad-hoc jobs flow through — they never count.
 */
/** "YYYY-MM-DD" of a stored DATE column — read off the UTC clock, like every business date. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const dayBefore = (d: Date): Date => new Date(d.getTime() - 86_400_000);

/**
 * What the row says about being served, all of it derived from the periods:
 *
 * - **in_force** — a period covers today;
 * - **scheduled** — none does, but one starts later (a pause or a start agreed in advance);
 * - **paused** — the last period is closed and nothing is planned.
 *
 * `inForceUntil` is the LAST SERVED DAY (inclusive) even though the column is exclusive — the
 * stored 21 Aug is shown as "до 20.08", which is what a person means by "paused on the 20th".
 */
function servedWindow(periods: InForcePeriod[], today: Day) {
  const todayUtc = toUtc(today);
  const sorted = [...periods].sort((a, b) => a.startsOn.getTime() - b.startsOn.getTime());
  const current = sorted.find((p) => inForceOn([p], today));
  if (current) {
    return {
      active: true,
      inForceFrom: isoDay(current.startsOn),
      inForceUntil: current.endsBefore ? isoDay(dayBefore(current.endsBefore)) : null,
      state: "in_force" as const,
    };
  }
  const upcoming = sorted.find((p) => p.startsOn > todayUtc);
  if (upcoming) {
    return {
      active: false,
      inForceFrom: isoDay(upcoming.startsOn),
      inForceUntil: upcoming.endsBefore ? isoDay(dayBefore(upcoming.endsBefore)) : null,
      state: "scheduled" as const,
    };
  }
  const last = sorted[sorted.length - 1];
  return {
    active: false,
    inForceFrom: isoDay(last?.startsOn ?? todayUtc),
    inForceUntil: last?.endsBefore ? isoDay(dayBefore(last.endsBefore)) : null,
    state: "paused" as const,
  };
}

export function toClientDto(client: repo.ClientRecord, debt = 0) {
  const today = todayInTz(config.TZ);
  return {
    id: client.id,
    // the services this client actually holds — a chip appears when a service is added and
    // disappears when it's stopped. Nothing curated, nothing to keep in step by hand.
    categories: [
      ...new Set(
        client.subscriptions.filter((s) => inForceOn(s.periods, today)).map((s) => s.serviceId),
      ),
    ],
    subscriptions: client.subscriptions.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      companyId: s.companyId,
      serviceId: s.serviceId,
      amount: s.amount,
      period: s.period,
      invoiceTrigger: s.invoiceTrigger,
      invoiceDay: s.invoiceDay,
      dueDays: s.dueDays,
      // validated on write; the parse also shields the API from malformed legacy blobs
      rhythmOverrides: rhythmOverridesSchema.catch({}).parse(s.rhythmOverrides ?? {}),
      ...servedWindow(s.periods, today),
      isDefault: s.isDefault,
    })),
    firstName: client.firstName,
    lastName: client.lastName,
    companyName: client.companyName,
    displayName: clientLabel(client),
    phone: client.phone,
    email: client.email,
    address: client.address,
    sourceId: client.sourceId,
    isRegular: client.subscriptions.some(
      (s) => inForceOn(s.periods, today) && s.service.type === "subscription",
    ),
    description: client.description,
    companies: client.companies.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      description: c.description,
    })),
    people: client.people.map((p) => ({
      id: p.id,
      name: p.name,
      serviceId: p.serviceId,
      serviceLabel: p.serviceLabel,
      role: p.role,
      phone: p.phone,
      email: p.email,
    })),
    debt, // Σ open invoice balance — derived in Payments (S7), passed in by the caller
    createdAt: client.createdAt.toISOString(),
    archivedAt: client.archivedAt?.toISOString() ?? null,
  };
}

/** Only subscription-type services count toward "regular" — one-time subs are job containers. */
const ACTIVE_REGULAR_SUB = (): Prisma.SubscriptionWhereInput => ({
  ...inForceTodayWhere(config.TZ),
  service: { type: "subscription" },
});

// the tab filters ARE the rule, expressed in SQL — nothing else decides who is regular.
// Built per call because "in force" is relative to today, which a module-level const would freeze.
const REGULAR_FILTER = (): Prisma.ClientWhereInput => ({
  subscriptions: { some: ACTIVE_REGULAR_SUB() },
});
const ONE_TIME_FILTER = (): Prisma.ClientWhereInput => ({
  subscriptions: { none: ACTIVE_REGULAR_SUB() },
});

export async function listClients(query: ClientListQuery) {
  // "archived" is the Archive screen's read and the only tab that shows archived clients;
  // every other tab is live-only, which is what makes archiving mean "gone from the working views"
  const where: Prisma.ClientWhereInput =
    query.tab === "archived"
      ? { archivedAt: { not: null } }
      : {
          archivedAt: null,
          ...(query.tab === "regular"
            ? REGULAR_FILTER()
            : query.tab === "one_time"
              ? ONE_TIME_FILTER()
              : {}),
        };

  if (query.search) {
    where.AND = [
      {
        OR: [
          { firstName: { contains: query.search, mode: "insensitive" } },
          { lastName: { contains: query.search, mode: "insensitive" } },
          { companyName: { contains: query.search, mode: "insensitive" } },
          { email: { contains: query.search, mode: "insensitive" } },
          { phone: { contains: query.search, mode: "insensitive" } },
          { companies: { some: { name: { contains: query.search, mode: "insensitive" } } } },
        ],
      },
    ];
  }

  const [{ items, total }, counts] = await Promise.all([
    repo.listClients({
      where,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    repo.countClientsByTab(REGULAR_FILTER()),
  ]);
  const debts = await debtByClient(items.map((c) => c.id));
  return {
    items: items.map((c) => toClientDto(c, debts[c.id] ?? 0)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts,
  };
}

export async function getClient(id: string) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  const debts = await debtByClient([id]);
  return toClientDto(client, debts[id] ?? 0);
}

function toClientFields(input: CreateClientInput | UpdateClientInput, isCreate: boolean) {
  const fields: Prisma.ClientUpdateInput = {};
  if (input.firstName !== undefined) fields.firstName = input.firstName;
  if (input.lastName !== undefined) fields.lastName = input.lastName ?? null;
  if (input.companyName !== undefined) fields.companyName = input.companyName ?? null;
  if (input.phone !== undefined) fields.phone = input.phone ?? null;
  if (input.email !== undefined) fields.email = input.email ?? null;
  if (input.address !== undefined) fields.address = input.address ?? null;
  if (input.description !== undefined) fields.description = input.description ?? null;
  if (input.sourceId) {
    fields.source = { connect: { id: input.sourceId } };
  } else if (!isCreate && input.sourceId !== undefined) {
    fields.source = { disconnect: true }; // clearing the source (update only)
  }
  return fields;
}

/**
 * A company NAME identifies one company for the whole firm, so a name another client already
 * holds is refused with the owner named rather than surfacing a raw unique-index violation.
 *
 * Checked BEFORE the client row is written on create — otherwise a rejected save would leave a
 * half-created client behind (`clientId` is null then: nothing of this client's is excluded yet).
 */
async function assertCompanyNamesFree(
  clientId: string | null,
  companies: repo.CompanyRecordInput[],
) {
  const names = companies.map((c) => c.name.trim()).filter(Boolean);
  const taken = await repo.findCompaniesNamedElsewhere(clientId, names);
  if (taken.length > 0) {
    const [first] = taken;
    throw new ConflictError(
      `"${first.name}" already belongs to ${clientLabel(first.client)} — a company name identifies one company across the whole firm`,
    );
  }
}

/**
 * Save the client's companies. A company that subscriptions, tasks or issued invoices still
 * point at can't just disappear — the save is refused with the reason instead of silently
 * orphaning that history.
 */
async function applyCompanies(clientId: string, companies: repo.CompanyRecordInput[]) {
  await assertCompanyNamesFree(clientId, companies);
  const { removed, apply } = await repo.reconcileClientCompanies(clientId, companies);

  if (removed.length > 0) {
    const refs = await repo.countCompanyReferences(removed.map((c) => c.id));
    const used = [
      refs.subscriptions && `${refs.subscriptions} subscription(s)`,
      refs.tasks && `${refs.tasks} task(s)`,
      refs.invoices && `${refs.invoices} invoice(s)`,
    ].filter(Boolean);
    if (used.length > 0) {
      throw new ConflictError(
        `"${removed.map((c) => c.name).join('", "')}" is still used by ${used.join(", ")} — move those to another company (or to the client) before removing it`,
      );
    }
  }
  await apply();
}

/** Normalize the people payload for the repo (optional fields → null). */
const mapPeople = (people: CreateClientInput["people"]) =>
  people.map((p) => ({
    name: p.name,
    serviceId: p.serviceId ?? null,
    serviceLabel: p.serviceLabel ?? null,
    role: p.role ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
  }));

/** A person's optional service label must be client-facing — never an internal (firm-only) service. */
async function assertPeopleServicesClientFacing(people: CreateClientInput["people"]) {
  const ids = [...new Set(people.map((p) => p.serviceId).filter((v): v is string => !!v))];
  if (ids.length > 0 && (await repo.countInternalServicesByIds(ids)) > 0) {
    throw new ValidationError("Can't tag a person with an internal service");
  }
}

export async function createClient(input: CreateClientInput) {
  await assertPeopleServicesClientFacing(input.people);
  // check before writing anything: a refused save must not leave a half-created client behind
  await assertCompanyNamesFree(null, input.companies);
  const client = await repo.createClient(toClientFields(input, true) as Prisma.ClientCreateInput);
  if (input.companies.length > 0) await applyCompanies(client.id, input.companies);
  if (input.people.length > 0) {
    await repo.setClientPeople(client.id, mapPeople(input.people));
  }
  await applyDefaultClientService(client.id);
  return getClient(client.id);
}

/**
 * Auto-add the catalog's "default for new clients" service (one active one-time service, if any)
 * as a subscription on a freshly-created client — so every client has at least one paid
 * container. On the client root (no company); amount prefilled from the service's expected
 * price. Called on direct create AND on lead→client convert. No-op when no default is set.
 */
export async function applyDefaultClientService(clientId: string) {
  const svc = await repo.findDefaultClientService();
  if (!svc) return;
  const created = await repo.createSubscription(
    {
      clientId,
      serviceId: svc.id,
      companyId: null,
      amount: svc.defaultAmount ?? 0,
      period: "month", // stored but unused for one-time
      invoiceTrigger: null,
      invoiceDay: null,
      dueDays: null,
    },
    toUtc(todayInTz(config.TZ)), // open-ended from today — nothing can expire it
  );
  await claimDefaultIfFirst(clientId, created.id);
}

/**
 * A service is never agreed BACKWARDS (user, 2026-08-01). Today or a future date only — for both
 * the first period and every resume.
 *
 * Why the rule sits at the door rather than being cleaned up downstream: the start date is what
 * decides which periods get billed and which rhythm days generate tasks, so one mistyped year
 * would have the nightly sweep raise a manual-invoice reminder for every month since — dozens of
 * tasks, deduped but all to be cleared by hand. Work that really was done before today is billed
 * with a manual invoice, which is the one place a person states the amount on purpose.
 */
function assertNotBackdated(day: Date, field: "start" | "resume"): void {
  const today = toUtc(todayInTz(config.TZ));
  if (day >= today) return;
  throw new ValidationError(
    field === "start"
      ? `A service can't start in the past — today (${isoDay(today)}) or later. Bill work already done with a one-off invoice.`
      : `A service can't resume in the past — today (${isoDay(today)}) or later.`,
  );
}

/**
 * The first service a client gets is unambiguously their default — with one option there is
 * nothing to choose. Later ones leave the existing default alone.
 *
 * Both paths that can hand a client their first service go through here (2026-07-28). The
 * auto-added catalog default used to write the subscription straight to the repository and skip
 * this, so a client created while a catalog default was set ended up with a service but NO
 * default — and since their NEXT service was then no longer the first, they never got one at all.
 * Their task and invoice pickers silently stopped prefilling.
 */
async function claimDefaultIfFirst(clientId: string, subscriptionId: string) {
  if ((await repo.countLiveSubscriptions(clientId, config.TZ)) === 1) {
    await repo.setDefaultSubscription(clientId, subscriptionId);
  }
}

export async function updateClient(id: string, input: UpdateClientInput) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");

  // a PATCH may omit the name entirely, but it must never CLEAR it — the first name is what
  // identifies the client (the last name and the companyName label stay optional)
  if (input.firstName !== undefined && !input.firstName) {
    throw new ValidationError("First name is required");
  }

  if (input.people !== undefined) await assertPeopleServicesClientFacing(input.people);
  await repo.updateClient(id, toClientFields(input, false));
  if (input.companies !== undefined) await applyCompanies(id, input.companies);
  if (input.people !== undefined) {
    await repo.setClientPeople(id, mapPeople(input.people));
  }
  return getClient(id);
}

// ── subscriptions & categories (S3) ─────────────────────────────────────────

export async function addSubscription(clientId: string, input: CreateSubscriptionInput) {
  await getClient(clientId);
  const service = await repo.findServiceById(input.serviceId);
  if (!service || !service.active) throw new ValidationError("Unknown or inactive service");
  if (service.type === "internal") {
    throw new ValidationError("Internal services aren't assignable to clients");
  }
  if (input.companyId) {
    const company = await repo.findClientCompany(clientId, input.companyId);
    if (!company) throw new ValidationError("Company does not belong to this client");
  }
  // same service twice only for DIFFERENT companies of the client (decision 2026-07-21)
  const duplicate = await repo.findDuplicateSubscription(
    clientId,
    input.serviceId,
    input.companyId ?? null,
  );
  if (duplicate) {
    throw new ValidationError(
      "This service is already assigned to the same target — edit the existing subscription or pick another company",
    );
  }
  const startsOn = input.startsOn ? dateToUtc(input.startsOn) : toUtc(todayInTz(config.TZ));
  assertNotBackdated(startsOn, "start");
  const created = await repo.createSubscription(
    {
      clientId,
      serviceId: input.serviceId,
      companyId: input.companyId ?? null,
      amount: input.amount,
      period: input.period,
      invoiceTrigger: input.invoiceTrigger ?? null,
      invoiceDay: input.invoiceDay ?? null,
      dueDays: input.dueDays ?? null,
    },
    // service starts today unless a FUTURE date was agreed; no end date — open-ended is normal
    startsOn,
  );
  await claimDefaultIfFirst(clientId, created.id);
  // instant feedback: today's-due tasks and this period's invoice appear right away
  // (both idempotent; no-op for one-time). Best-effort — a generation hiccup must NOT fail the
  // (already-committed) subscription; the daily scheduler sweeps + startup catch-up fill any gap.
  await generateForSubscription(created.id).catch(() => {});
  await generateForSubscriptionInvoices(created.id).catch(() => {});
  return getClient(clientId);
}

export async function updateSubscription(
  clientId: string,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
) {
  await getClient(clientId);
  const sub = await repo.findSubscription(clientId, subscriptionId);
  if (!sub) throw new NotFoundError("Subscription not found");
  if (input.companyId) {
    const company = await repo.findClientCompany(clientId, input.companyId);
    if (!company) throw new ValidationError("Company does not belong to this client");
  }
  // billing timing must stay valid against the MERGED row (partial PATCH skips the Zod refine)
  const trigger =
    input.invoiceTrigger !== undefined ? input.invoiceTrigger : sub.invoiceTrigger;
  const day = input.invoiceDay !== undefined ? input.invoiceDay : sub.invoiceDay;
  if (day != null && trigger !== "on_period_start") {
    throw new ValidationError("A custom day only applies when billing at the start of the period");
  }
  // duplicate-target rule also holds when the company changes
  if (input.companyId !== undefined) {
    const duplicate = await repo.findDuplicateSubscription(
      clientId,
      sub.serviceId,
      input.companyId ?? null,
      subscriptionId,
    );
    if (duplicate) {
      throw new ValidationError(
        "This service is already assigned to the same target — edit the existing subscription instead",
      );
    }
  }
  // per-client task overrides may only key on THIS service's task templates
  if (input.rhythmOverrides !== undefined) {
    const templateIds = new Set(await repo.listServiceTemplateIds(sub.serviceId));
    for (const id of Object.keys(input.rhythmOverrides)) {
      if (!templateIds.has(id)) {
        throw new ValidationError("Override references a task that isn't part of this service");
      }
    }
  }
  // the default is what gets picked automatically, so it has to be a service they actually use
  // must AGREE with the automatic claim above: a service agreed for a future date is still the
  // client's service, and forbidding it by hand while the system assigns it would contradict itself
  if (input.isDefault === true && !notEnded(await repo.listPeriods(subscriptionId), todayInTz(config.TZ))) {
    throw new ValidationError("A stopped service can't be the client's default");
  }
  const { isDefault, ...fields } = input;
  await repo.updateSubscription(subscriptionId, fields);
  // moving the flag clears the previous holder in the same transaction (one default per client)
  if (isDefault === true) {
    await repo.setDefaultSubscription(clientId, subscriptionId);
  } else if (isDefault === false && sub.isDefault) {
    // clearing only ever drops THIS one's flag — never another service's
    await repo.setDefaultSubscription(clientId, null);
  }
  // rhythm overrides may make today's tasks due — sweep this sub now (best-effort; the scheduler
  // self-heals so a hiccup never fails the saved edit)
  if (input.rhythmOverrides !== undefined) {
    await generateForSubscription(subscriptionId).catch(() => {});
  }
  return getClient(clientId);
}

/**
 * Stop serving this subscription. Closes its open period at `lastDay` (inclusive), which may be in
 * the future to plan a pause agreed in advance.
 *
 * Pausing is NOT a flag: the date is the point of it — it is what lets the system still answer
 * "was this client served on the 1st" months later, which is what decides billing and generation.
 * Nothing already issued or already generated is touched: an invoice that went out stays out (the
 * caller is warned in the UI) and tasks record work that was planned while the service was on.
 */
export async function pauseSubscription(
  clientId: string,
  subscriptionId: string,
  input: PauseSubscriptionInput,
  actor: User,
) {
  await getClient(clientId);
  const sub = await repo.findSubscription(clientId, subscriptionId);
  if (!sub) throw new NotFoundError("Subscription not found");

  const today = toUtc(todayInTz(config.TZ));
  // the period that COVERS today, which may already carry a future end date — "is it running" and
  // "does it have an end date" are different questions, and pausing owns the second one
  const open = await repo.findPeriodCovering(subscriptionId, today);
  if (!open) throw new ConflictError("This service is already paused");

  // explicit null = call off a scheduled pause; the service goes back to open-ended. Deliberately
  // ABOVE the default-service guard: removing an end date is the opposite of switching the service
  // off, so there is nothing to protect the pickers from (found in the 2026-07-30 audit).
  if (input.lastDay === null) {
    if (!open.endsBefore) throw new ConflictError("This service has no end date to remove");
    await repo.reopenPeriod(open.id);
    return getClient(clientId);
  }

  // The default service can't just be switched off — it is what prefills every service picker for
  // this client, so losing it silently would be a surprise. Clear the flag first (move it to
  // another service, or drop it), then pause.
  if (sub.isDefault) {
    throw new ConflictError(
      "This is the client's default service — make another one the default (or clear it) before pausing this one",
    );
  }
  const lastDay = input.lastDay ? dateToUtc(input.lastDay) : today;

  if (open.startsOn > lastDay) {
    // A period that HASN'T STARTED yet isn't being paused, it's being cancelled — drop it rather
    // than leave a zero-length stub that would confuse the history and the coverage maths.
    if (open.startsOn > today) {
      await repo.deletePeriod(open.id);
      return getClient(clientId);
    }
    // …but service that is already running must not be erased by a mistyped date. This used to
    // delete the whole open period and answer 200 (found in the 2026-07-29 audit).
    throw new ValidationError(
      `Service has been running since ${isoDay(open.startsOn)} — the last served day can't be before that`,
    );
  }
  // `endsBefore` is exclusive: pausing "on the 20th" still serves the 20th
  await repo.closePeriod(open.id, new Date(lastDay.getTime() + 86_400_000), {
    endNote: input.note ?? null,
    endedById: actor.id,
  });
  return getClient(clientId);
}

/**
 * Serve it again from `startsOn` (default today; may be in the future). Opens a NEW period rather
 * than reopening the old one — the gap between them is exactly what makes a period "partial", and
 * partial periods are the ones a person invoices by hand.
 */
export async function resumeSubscription(
  clientId: string,
  subscriptionId: string,
  input: ResumeSubscriptionInput,
  actor: User,
) {
  await getClient(clientId);
  const sub = await repo.findSubscription(clientId, subscriptionId);
  if (!sub) throw new NotFoundError("Subscription not found");
  const service = await repo.findServiceById(sub.serviceId);
  if (!service || !service.active) {
    throw new ValidationError("This service is no longer offered — pick another one");
  }
  if (await repo.findOpenPeriod(subscriptionId)) {
    throw new ConflictError("This service is already running");
  }
  const startsOn = input.startsOn ? dateToUtc(input.startsOn) : toUtc(todayInTz(config.TZ));
  assertNotBackdated(startsOn, "resume");
  const periods = await repo.listPeriods(subscriptionId);
  const lastEnd = periods.reduce<Date | null>(
    (a, p) => (p.endsBefore && (!a || p.endsBefore > a) ? p.endsBefore : a),
    null,
  );
  if (lastEnd && startsOn < lastEnd) {
    throw new ValidationError(
      `Service was already running up to ${isoDay(new Date(lastEnd.getTime() - 86_400_000))} — start the new period after that`,
    );
  }
  await repo.openPeriod({
    subscriptionId,
    startsOn,
    startNote: input.note ?? null,
    createdById: actor.id,
  });
  // today's work may already be due — sweep this one now; the scheduler self-heals either way
  await generateForSubscription(subscriptionId).catch(() => {});
  await generateForSubscriptionInvoices(subscriptionId).catch(() => {});
  return getClient(clientId);
}

/**
 * Archive = we stopped serving this client. Everything of theirs disappears from the working
 * views, and **their services stop** as of today — the last day served is the day they were
 * archived.
 *
 * Stopping the services is the whole point. Left running, the periods keep reading "in force" for
 * however long the client sits in the archive, and both nightly sweeps back-fill the lot the
 * moment they come back: a client archived six months regained 6 tasks (every one already
 * overdue), 2 auto-issued invoices and 5 reminders, for work nobody did (probe, 2026-08-03).
 *
 * What is deliberately NOT touched: invoices. Debt survives archiving — an unpaid invoice stays
 * unpaid and stays visible in Billing, flagged `clientArchived`. Hiding money owed would be the
 * one genuinely dangerous thing archiving could do.
 */
export async function archiveClient(id: string, actor: User) {
  const existing = await repo.findClient(id);
  if (!existing || existing.archivedAt) throw new NotFoundError("Client not found");
  // exclusive end: the last day served is today, so the period ends before tomorrow
  const endsBefore = toUtc(addDays(todayInTz(config.TZ), 1));
  await repo.closeLivePeriodsForClient(id, endsBefore, actor.id);
  await repo.updateClient(id, { archivedAt: new Date(), archivedById: actor.id });
  return { ok: true as const };
}

/**
 * Bring a client back. Their history returns exactly as it was — the same tasks, the same
 * invoices, the same debt — but **the services stay paused**.
 *
 * That is the deliberate half. Resuming automatically would have to pick a date, and every choice
 * is wrong: "from the archive date" back-fills months of work nobody did, "from today" silently
 * loses whatever the firm agreed. Resuming a service is a decision with a date on it, so it stays
 * a decision — the client card asks for it, one service at a time, and the sweep then generates
 * from that date forward.
 */
export async function restoreClient(id: string) {
  const existing = await repo.findClient(id);
  if (!existing) throw new NotFoundError("Client not found");
  if (!existing.archivedAt) throw new ConflictError("This client is not archived");
  await repo.updateClient(id, { archivedAt: null, archivedById: null });
  return getClient(id);
}

// ── files (≤ 25 MB, uploads volume, API-served) ──────────────────────────────

export async function listFiles(clientId: string) {
  await getClient(clientId);
  const files = await repo.listClientFiles(clientId);
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: f.createdAt.toISOString(),
  }));
}

export async function addFile(
  clientId: string,
  actor: User,
  file: { buffer: Buffer; filename: string; mimetype: string },
) {
  await getClient(clientId);
  if (file.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError("File must be 25 MB or smaller");
  }
  const relPath = await saveFileBytes(file.buffer, file.filename);
  const row = await repo.createClientFile({
    clientId,
    name: file.filename,
    size: file.buffer.byteLength,
    mime: file.mimetype,
    path: relPath,
    uploadedById: actor.id,
  });
  return { id: row.id, name: row.name, size: row.size, mime: row.mime };
}

export async function getFile(clientId: string, fileId: string) {
  await getClient(clientId); // 404s archived/missing clients — files go dark with the client
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  return file;
}

export async function removeFile(clientId: string, fileId: string) {
  await getClient(clientId); // 404s archived/missing clients
  const file = await repo.findClientFile(clientId, fileId);
  if (!file) throw new NotFoundError("File not found");
  await repo.deleteFileRow(file.id);
  await deleteFileBytes(file.path);
  return { ok: true as const };
}
