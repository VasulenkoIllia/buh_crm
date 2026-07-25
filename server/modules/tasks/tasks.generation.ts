import { rhythmOverridesSchema } from "@shared/schema/catalog.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";

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

// ── business-date helpers (dates live in the firm TZ, stored as UTC midnight) ─

interface Day {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

/** Today's calendar date in the firm timezone. */
function todayInTz(tz: string): Day {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

function fromDate(date: Date, tz: string): Day {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

const toUtc = ({ y, m, d }: Day) => new Date(Date.UTC(y, m - 1, d));
const cmp = (a: Day, b: Day) => toUtc(a).getTime() - toUtc(b).getTime();
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** day 1-31 clamped to the month; -1/overflow = last day. */
function calendarDay(y: number, m: number, day: number | null): Day {
  const last = daysInMonth(y, m);
  const d = day == null ? 1 : day === -1 ? last : Math.min(day, last);
  return { y, m, d };
}

/** ISO-8601 week (year + number) of a date. */
function isoWeek(day: Day): { year: number; week: number } {
  const date = toUtc(day);
  const dow = date.getUTCDay() || 7; // Mon=1..Sun=7
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** Monday of an ISO week. */
function isoWeekMonday(year: number, week: number): Day {
  const jan4 = new Date(Date.UTC(year, 0, 4)); // always in week 1
  const dow = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dow + 1 + (week - 1) * 7);
  return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() };
}

const addDays = (day: Day, n: number): Day => {
  const date = toUtc(day);
  date.setUTCDate(date.getUTCDate() + n);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

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

async function loadDeps(): Promise<GenerationDeps | null> {
  const [priority, column] = await Promise.all([
    prisma.priority.findFirst({ where: { isDefault: true } }),
    prisma.taskColumn.findFirst({ where: { isFixed: true } }),
  ]);
  if (!priority || !column) return null; // bootstrap hasn't run — nothing to do
  return { priorityId: priority.id, columnId: column.id };
}

type SubWithTemplates = {
  id: string;
  clientId: string;
  companyId: string | null;
  serviceId: string;
  createdAt: Date;
  rhythmOverrides: unknown;
  client: {
    type: "individual" | "company";
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  };
  company: { name: string } | null;
  service: {
    name: string;
    taskTemplates: {
      id: string;
      name: string;
      periodicity: string;
      dayOfPeriod: number | null;
      monthOfPeriod: number | null;
      deadlineOffsetDays: number | null;
      estimatedMinutes: number | null;
      defaultChecklist: unknown;
      createdAt: Date;
    }[];
  };
};

/** individual → "First Last"; company → the company name. */
function clientLabel(c: SubWithTemplates["client"]): string {
  if (c.type === "company") return c.companyName ?? "—";
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
}

const dayLabel = ({ y, m, d }: Day) =>
  `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;

/** Auto-task title: "client · company (if any) · service · template · date". */
function generatedTitle(sub: SubWithTemplates, templateName: string, date: Day): string {
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

function rowsForSubscription(sub: SubWithTemplates, deps: GenerationDeps, today: Day, tz: string) {
  const overrides = rhythmOverridesSchema.catch({}).parse(sub.rhythmOverrides ?? {});
  const subStart = fromDate(sub.createdAt, tz);

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

    return occurrencesInWindow(eff, from, today).map((occ) => ({
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

const subscriptionQuery = {
  where: {
    active: true,
    service: { type: "subscription" as const },
    client: { archivedAt: null },
  },
  include: {
    client: { select: { type: true, firstName: true, lastName: true, companyName: true } },
    company: { select: { name: true } },
    service: {
      select: {
        name: true,
        taskTemplates: {
          select: {
            id: true,
            name: true,
            periodicity: true,
            dayOfPeriod: true,
            monthOfPeriod: true,
            deadlineOffsetDays: true,
            estimatedMinutes: true,
            defaultChecklist: true,
            createdAt: true,
          },
        },
      },
    },
  },
};

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
    created += (await prisma.task.createMany({ data: plain, skipDuplicates: true })).count;
  }

  // checklist path — createMany can't nest subtasks, so create each NEW row individually.
  if (withChecklist.length > 0) {
    const key = (r: { subscriptionId: string | null; taskTemplateId: string | null; periodKey: string | null }) =>
      `${r.subscriptionId}|${r.taskTemplateId}|${r.periodKey}`;
    // scope the pre-check to exactly the candidate (sub, template, period) space — not all history
    const existing = await prisma.task.findMany({
      where: {
        subscriptionId: { in: uniq(withChecklist.map((r) => r.subscriptionId)) },
        taskTemplateId: { in: uniq(withChecklist.map((r) => r.taskTemplateId)) },
        periodKey: { in: uniq(withChecklist.map((r) => r.periodKey)) },
      },
      select: { subscriptionId: true, taskTemplateId: true, periodKey: true },
    });
    const seen = new Set(existing.map(key));
    for (const row of withChecklist) {
      if (seen.has(key(row))) continue;
      const { checklist, ...task } = row;
      try {
        await prisma.task.create({
          data: { ...task, subtasks: { create: checklist.map((text, order) => ({ text, order })) } },
        });
        created++;
      } catch (e) {
        // a concurrent sweep created the same (sub, template, period) first → skip
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
    }
  }

  return created;
}

/** Full sweep — the daily run AND the startup catch-up (same idempotent scan). */
export async function generateSubscriptionTasks() {
  const deps = await loadDeps();
  if (!deps) return { created: 0 };
  const today = todayInTz(config.TZ);
  const subs = await prisma.subscription.findMany(subscriptionQuery);
  const rows = subs.flatMap((sub) => rowsForSubscription(sub, deps, today, config.TZ));
  return { created: await insertGeneratedTasks(rows) };
}

/** Instant feedback after a subscription is added/tuned on the client card. */
export async function generateForSubscription(subscriptionId: string) {
  const deps = await loadDeps();
  if (!deps) return { created: 0 };
  const sub = await prisma.subscription.findFirst({
    ...subscriptionQuery,
    where: { ...subscriptionQuery.where, id: subscriptionId },
  });
  if (!sub) return { created: 0 }; // stopped / one-time / archived client — nothing to generate
  const rows = rowsForSubscription(sub, deps, todayInTz(config.TZ), config.TZ);
  return { created: await insertGeneratedTasks(rows) };
}

// ── internal task templates (recurring firm-internal tasks: no client, no billing) ────────────

type InternalService = {
  id: string;
  name: string;
  taskTemplates: {
    id: string;
    name: string;
    periodicity: string;
    dayOfPeriod: number | null;
    monthOfPeriod: number | null;
    deadlineOffsetDays: number | null;
    estimatedMinutes: number | null;
    defaultChecklist: unknown;
    description: string | null;
    defaultAssigneeIds: unknown;
    createdAt: Date;
  }[];
};

const internalServiceQuery = {
  where: { active: true, type: "internal" as const },
  select: {
    id: true,
    name: true,
    taskTemplates: {
      select: {
        id: true,
        name: true,
        periodicity: true,
        dayOfPeriod: true,
        monthOfPeriod: true,
        deadlineOffsetDays: true,
        estimatedMinutes: true,
        defaultChecklist: true,
        description: true,
        defaultAssigneeIds: true,
        createdAt: true,
      },
    },
  },
};

/** Rows for one internal service's templates. Title: `service · template · date`; no client. */
function internalRows(svc: InternalService, deps: GenerationDeps, today: Day, tz: string) {
  return svc.taskTemplates.flatMap((tpl) => {
    // an internal template generates from its own creation day (no subscription start)
    const from = fromDate(tpl.createdAt, tz);
    const eff = { periodicity: tpl.periodicity, dayOfPeriod: tpl.dayOfPeriod, monthOfPeriod: tpl.monthOfPeriod };
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
  const existing = await prisma.task.findMany({
    where: {
      subscriptionId: null,
      taskTemplateId: { in: uniq(rows.map((r) => r.taskTemplateId)) },
      periodKey: { in: uniq(rows.map((r) => r.periodKey)) },
    },
    select: { taskTemplateId: true, periodKey: true },
  });
  const seen = new Set(existing.map(key));
  let created = 0;
  for (const row of rows) {
    if (seen.has(key(row))) continue;
    const { checklist, assigneeIds, ...task } = row;
    try {
      await prisma.task.create({
        data: {
          ...task,
          subtasks: checklist.length
            ? { create: checklist.map((text, order) => ({ text, order })) }
            : undefined,
          // dedupe — a duplicate userId would hit the TaskAssignee PK (P2002) and, since the catch
          // below can't tell it from the (template,period) race, silently drop the task forever
          assignees: assigneeIds.length
            ? { create: [...new Set(assigneeIds)].map((userId) => ({ userId })) }
            : undefined,
        },
      });
      created++;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  return created;
}

/** Full sweep for internal task templates — runs alongside the subscription sweep. */
export async function generateInternalTasks() {
  const deps = await loadDeps();
  if (!deps) return { created: 0 };
  const today = todayInTz(config.TZ);
  const services = await prisma.service.findMany(internalServiceQuery);
  const rows = services.flatMap((svc) => internalRows(svc, deps, today, config.TZ));
  if (rows.length === 0) return { created: 0 };
  // only ACTIVE users get freshly assigned (same invariant manual create/update enforce) —
  // a template member blocked after being set is dropped, not carried onto new tasks
  const active = new Set(
    (await prisma.user.findMany({ where: { status: "active" }, select: { id: true } })).map((u) => u.id),
  );
  for (const row of rows) row.assigneeIds = row.assigneeIds.filter((id) => active.has(id));
  return { created: await insertInternalTasks(rows) };
}
