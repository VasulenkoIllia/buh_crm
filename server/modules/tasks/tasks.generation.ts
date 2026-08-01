import { rhythmOverridesSchema } from "@shared/schema/catalog.js";
import { firstDayInForce, inForceOn } from "../../core/coverage.js";
import { raiseSystemTask } from "../../core/system-tasks.js";
import { config } from "../../core/config.js";
import {
  type Day,
  addDays,
  calendarDay,
  cmp,
  dayLabel,
  fromDate,
  isoWeek,
  isoWeekMonday,
  todayInTz,
  toUtc,
} from "../../core/dates.js";
import { clientLabel } from "../../core/names.js";
import * as repo from "./tasks.repository.js";
import type { GeneratingSubscription, InternalService } from "./tasks.repository.js";

/**
 * Scheduler job #1 (S6): subscription → tasks, ON THE RHYTHM DAY (decision
 * 2026-07-23). Every run scans the full window [subscription start .. today]
 * and inserts what's missing — idempotent via the unique key
 * (subscriptionId, taskTemplateId, periodKey) + skipDuplicates, so the daily
 * run and the startup catch-up are literally the same function; downtime and
 * mid-period subscription/override changes heal themselves.
 *
 * Only ACTIVE subscriptions of SUBSCRIPTION-type services generate — one-time
 * services are containers for manual jobs (their presets are prefills only).
 * Generated tasks land UNASSIGNED in the fixed "New" column, kind=sub,
 * deadline = rhythm date + effective offset, plannedMinutes from the template
 * merged with the per-client override (enabled:false skips the task).
 */

interface Occurrence {
  periodKey: string;
  date: Day;
}

/** All rhythm occurrences with `from <= date <= to`. */
export function occurrencesInWindow(
  rhythm: { periodicity: string; dayOfPeriod: number | null; monthOfPeriod: number | null },
  from: Day,
  to: Day,
): Occurrence[] {
  const out: Occurrence[] = [];
  const push = (periodKey: string, date: Day) => {
    if (cmp(date, from) >= 0 && cmp(date, to) <= 0) out.push({ periodKey, date });
  };

  switch (rhythm.periodicity) {
    case "once": {
      // a single task at the start of the subscription
      push("once", from);
      break;
    }
    case "weekly": {
      const start = isoWeek(from);
      let { year, week } = start;
      for (let i = 0; i < 400; i++) {
        const monday = isoWeekMonday(year, week);
        if (cmp(monday, to) > 0) break;
        push(
          `${year}-W${String(week).padStart(2, "0")}`,
          addDays(monday, (rhythm.dayOfPeriod ?? 1) - 1),
        );
        const next = isoWeek(addDays(monday, 7));
        year = next.year;
        week = next.week;
      }
      break;
    }
    case "monthly": {
      for (let y = from.y, m = from.m; y < to.y || (y === to.y && m <= to.m); m === 12 ? (y++, (m = 1)) : m++) {
        push(`${y}-${String(m).padStart(2, "0")}`, calendarDay(y, m, rhythm.dayOfPeriod));
      }
      break;
    }
    case "quarterly": {
      for (let y = from.y; y <= to.y; y++) {
        for (let q = 1; q <= 4; q++) {
          const m = (q - 1) * 3 + (rhythm.monthOfPeriod ?? 1);
          push(`${y}-Q${q}`, calendarDay(y, m, rhythm.dayOfPeriod));
        }
      }
      break;
    }
    case "yearly": {
      for (let y = from.y; y <= to.y; y++) {
        push(`${y}`, calendarDay(y, rhythm.monthOfPeriod ?? 1, rhythm.dayOfPeriod));
      }
      break;
    }
  }
  return out;
}

// ── the job ──────────────────────────────────────────────────────────────────

interface GenerationDeps {
  priorityId: string;
  columnId: string;
}

/** Auto-task title: "client · company (if any) · service · template · date". */
function generatedTitle(sub: GeneratingSubscription, templateName: string, date: Day): string {
  return [
    clientLabel(sub.client),
    sub.company?.name,
    sub.service.name,
    templateName,
    dayLabel(date),
  ]
    .filter(Boolean)
    .join(" · ");
}

function rowsForSubscription(
  sub: GeneratingSubscription,
  deps: GenerationDeps,
  today: Day,
  tz: string,
) {
  const overrides = rhythmOverridesSchema.catch({}).parse(sub.rhythmOverrides ?? {});
  // the window opens on the first day ever served, and every occurrence inside it is then checked
  // against the served periods — a date that fell during a pause is skipped, for good. It used to
  // run from `createdAt`, which is why resuming after a pause dumped the whole missed tail onto
  // the board with deadlines in the past (decision 2026-07-29).
  const subStart = firstDayInForce(sub.periods);
  if (!subStart) return [];

  return sub.service.taskTemplates.flatMap((tpl) => {
    const ov = overrides[tpl.id];
    if (ov && ov.enabled === false) return []; // skipped for this client
    const eff = {
      periodicity: ov?.periodicity ?? tpl.periodicity,
      dayOfPeriod: ov?.dayOfPeriod !== undefined ? ov.dayOfPeriod : tpl.dayOfPeriod,
      monthOfPeriod: ov?.monthOfPeriod !== undefined ? ov.monthOfPeriod : tpl.monthOfPeriod,
      deadlineOffsetDays:
        ov?.deadlineOffsetDays !== undefined ? ov.deadlineOffsetDays : tpl.deadlineOffsetDays,
      estimatedMinutes:
        ov?.estimatedMinutes !== undefined ? ov.estimatedMinutes : tpl.estimatedMinutes,
    };
    // per-client checklist: present key overrides (null = removed → []); absent = template default
    const checklist =
      ov?.checklist !== undefined
        ? (ov.checklist ?? [])
        : ((tpl.defaultChecklist as string[] | null) ?? []);
    // a template added mid-life must not back-fill periods before it existed
    const tplStart = fromDate(tpl.createdAt, tz);
    const from = cmp(tplStart, subStart) > 0 ? tplStart : subStart;

    return occurrencesInWindow(eff, from, today)
      .filter((occ) => inForceOn(sub.periods, occ.date))
      .map((occ) => ({
      title: generatedTitle(sub, tpl.name, occ.date),
      clientId: sub.clientId,
      companyId: sub.companyId,
      serviceId: sub.serviceId,
      kind: "sub" as const,
      priorityId: deps.priorityId,
      statusColumnId: deps.columnId,
      deadline: toUtc(addDays(occ.date, eff.deadlineOffsetDays ?? 0)),
      plannedMinutes: eff.estimatedMinutes,
      subscriptionId: sub.id,
      taskTemplateId: tpl.id,
      periodKey: occ.periodKey,
      checklist,
    }));
  });
}

/** Distinct non-null values — used to scope the existing-keys pre-check `IN` lists. */
const uniq = <T,>(xs: (T | null)[]) => [...new Set(xs)].filter((x): x is T => x != null);

type GeneratedRow = ReturnType<typeof rowsForSubscription>[number];

/**
 * Insert only the rows whose (subscriptionId, taskTemplateId, periodKey) doesn't exist yet,
 * Idempotent (the `(subscription, template, period)` unique index) AND never rewrites — a task's
 * checklist is seeded once, at creation. Rows WITHOUT a checklist go in one bulk
 * `createMany({ skipDuplicates })`; only rows WITH a checklist need per-row `create` (createMany
 * can't nest subtasks), pre-filtered against existing keys with a race-safe P2002 fallback.
 */
async function insertGeneratedTasks(rows: GeneratedRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // split once: checklist-less rows (the common case) vs. rows that must seed subtasks
  const plain: Omit<GeneratedRow, "checklist">[] = [];
  const withChecklist: GeneratedRow[] = [];
  for (const row of rows) {
    const { checklist, ...task } = row;
    if (checklist.length === 0) plain.push(task);
    else withChecklist.push(row);
  }

  let created = 0;

  // bulk path — one idempotent insert (ON CONFLICT DO NOTHING via the unique index)
  if (plain.length > 0) {
    created += await repo.createTasksSkippingDuplicates(plain);
  }

  // checklist path — createMany can't nest subtasks, so create each NEW row individually.
  if (withChecklist.length > 0) {
    const key = (r: { subscriptionId: string | null; taskTemplateId: string | null; periodKey: string | null }) =>
      `${r.subscriptionId}|${r.taskTemplateId}|${r.periodKey}`;
    // scope the pre-check to exactly the candidate (sub, template, period) space — not all history
    const existing = await repo.listExistingGeneratedKeys({
      subscriptionId: { in: uniq(withChecklist.map((r) => r.subscriptionId)) },
      taskTemplateId: { in: uniq(withChecklist.map((r) => r.taskTemplateId)) },
      periodKey: { in: uniq(withChecklist.map((r) => r.periodKey)) },
    });
    const seen = new Set(existing.map(key));
    for (const row of withChecklist) {
      if (seen.has(key(row))) continue;
      const { checklist, ...task } = row;
      try {
        await repo.createTaskWithChildren(task, checklist);
        created++;
      } catch (e) {
        // a concurrent sweep created the same (sub, template, period) first → skip
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
    }
  }

  return created;
}

/** How far ahead a subscription's end date is announced. */
const ENDING_NOTICE_DAYS = 7;

/**
 * Announce subscriptions whose END DATE is a week out.
 *
 * Nothing renews a subscription — open-ended has no end to renew — so an end date is always
 * something a person set on purpose. This keeps that deliberate ending from arriving as a
 * surprise weeks later (decision 2026-07-29).
 */
async function remindEndingSubscriptions() {
  const today = todayInTz(config.TZ);
  // strictly AFTER today: `endsBefore == today` means the last served day was yesterday, i.e. it
  // has already ended, and announcing that as "ends soon" would be a day late (2026-07-29 audit)
  const from = toUtc(addDays(today, 1));
  const until = toUtc(addDays(today, ENDING_NOTICE_DAYS));
  let reminded = 0;
  for (const sub of await repo.listEndingSubscriptions(from, until)) {
    const endsBefore = sub.periods
      .map((p) => p.endsBefore)
      .filter((d): d is Date => !!d && d >= from && d <= until)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!endsBefore) continue;
    // `endsBefore` is exclusive — the last day actually served is the one before it
    const lastDay = new Date(endsBefore.getTime() - 86_400_000);
    const raised = await raiseSystemTask(
      "subscription_ending",
      {
        clientId: sub.clientId,
        companyId: sub.companyId,
        serviceId: sub.serviceId,
        subscriptionId: sub.id,
      },
      `end-${lastDay.toISOString().slice(0, 10)}`,
      { titleSuffix: lastDay.toISOString().slice(0, 10), deadline: lastDay },
    );
    if (raised) reminded++;
  }
  return reminded;
}

/** Full sweep — the daily run AND the startup catch-up (same idempotent scan). */
export async function generateSubscriptionTasks() {
  const deps = await repo.findGenerationDefaults();
  if (!deps) return { created: 0, reminded: 0 }; // bootstrap hasn't run — nothing to do
  const today = todayInTz(config.TZ);
  const subs = await repo.listGeneratingSubscriptions();
  const rows = subs.flatMap((sub) => rowsForSubscription(sub, deps, today, config.TZ));
  const created = await insertGeneratedTasks(rows);
  return { created, reminded: await remindEndingSubscriptions() };
}

/** Instant feedback after a subscription is added/tuned on the client card. */
export async function generateForSubscription(subscriptionId: string) {
  const deps = await repo.findGenerationDefaults();
  if (!deps) return { created: 0 };
  const sub = await repo.findGeneratingSubscription(subscriptionId);
  if (!sub) return { created: 0 }; // stopped / one-time / archived client — nothing to generate
  const rows = rowsForSubscription(sub, deps, todayInTz(config.TZ), config.TZ);
  return { created: await insertGeneratedTasks(rows) };
}

// ── internal task templates (recurring firm-internal tasks: no client, no billing) ────────────

/** Rows for one internal service's templates. Title: `service · template · date`; no client. */
function internalRows(svc: InternalService, deps: GenerationDeps, today: Day, tz: string) {
  return svc.taskTemplates.flatMap((tpl) => {
    // an internal template generates from its own creation day (no subscription start)
    const from = fromDate(tpl.createdAt, tz);
    const eff = { periodicity: tpl.periodicity, dayOfPeriod: tpl.dayOfPeriod, monthOfPeriod: tpl.monthOfPeriod };
    // internal firm work belongs to no client, so there is nothing to be "in force" for
    return occurrencesInWindow(eff, from, today).map((occ) => ({
      title: `${svc.name} · ${tpl.name} · ${dayLabel(occ.date)}`,
      serviceId: svc.id, // belonging (grouping/reports) — but no client/company/subscription
      kind: "free" as const,
      priorityId: deps.priorityId,
      statusColumnId: deps.columnId,
      deadline: toUtc(addDays(occ.date, tpl.deadlineOffsetDays ?? 0)),
      plannedMinutes: tpl.estimatedMinutes,
      description: tpl.description,
      taskTemplateId: tpl.id,
      periodKey: occ.periodKey,
      checklist: (tpl.defaultChecklist as string[] | null) ?? [],
      assigneeIds: (tpl.defaultAssigneeIds as string[] | null) ?? [],
    }));
  });
}

type InternalRow = ReturnType<typeof internalRows>[number];

/**
 * Insert new internal tasks. subscriptionId is always null, so idempotency comes from the partial
 * unique index on (taskTemplateId, periodKey) WHERE subscriptionId IS NULL. Per-row create (nests
 * subtasks + assignees), pre-filtered against existing keys, with a race-safe P2002 fallback.
 */
async function insertInternalTasks(rows: InternalRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const key = (r: { taskTemplateId: string | null; periodKey: string | null }) =>
    `${r.taskTemplateId}|${r.periodKey}`;
  const existing = await repo.listExistingGeneratedKeys({
    subscriptionId: null,
    taskTemplateId: { in: uniq(rows.map((r) => r.taskTemplateId)) },
    periodKey: { in: uniq(rows.map((r) => r.periodKey)) },
  });
  const seen = new Set(existing.map(key));
  let created = 0;
  for (const row of rows) {
    if (seen.has(key(row))) continue;
    const { checklist, assigneeIds, ...task } = row;
    try {
      await repo.createTaskWithChildren(task, checklist, assigneeIds);
      created++;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  return created;
}

/** Full sweep for internal task templates — runs alongside the subscription sweep. */
export async function generateInternalTasks() {
  const deps = await repo.findGenerationDefaults();
  if (!deps) return { created: 0 };
  const today = todayInTz(config.TZ);
  const services = await repo.listInternalServices();
  const rows = services.flatMap((svc) => internalRows(svc, deps, today, config.TZ));
  if (rows.length === 0) return { created: 0 };
  // only ACTIVE users get freshly assigned (same invariant manual create/update enforce) —
  // a template member blocked after being set is dropped, not carried onto new tasks
  const active = new Set(await repo.listActiveUserIds());
  for (const row of rows) row.assigneeIds = row.assigneeIds.filter((id) => active.has(id));
  return { created: await insertInternalTasks(rows) };
}
