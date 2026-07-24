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
  service: {
    taskTemplates: {
      id: string;
      name: string;
      periodicity: string;
      dayOfPeriod: number | null;
      monthOfPeriod: number | null;
      deadlineOffsetDays: number | null;
      estimatedMinutes: number | null;
      createdAt: Date;
    }[];
  };
};

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
    // a template added mid-life must not back-fill periods before it existed
    const tplStart = fromDate(tpl.createdAt, tz);
    const from = cmp(tplStart, subStart) > 0 ? tplStart : subStart;

    return occurrencesInWindow(eff, from, today).map((occ) => ({
      title: tpl.name,
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
    service: {
      select: {
        taskTemplates: {
          select: {
            id: true,
            name: true,
            periodicity: true,
            dayOfPeriod: true,
            monthOfPeriod: true,
            deadlineOffsetDays: true,
            estimatedMinutes: true,
            createdAt: true,
          },
        },
      },
    },
  },
};

/** Full sweep — the daily run AND the startup catch-up (same idempotent scan). */
export async function generateSubscriptionTasks() {
  const deps = await loadDeps();
  if (!deps) return { created: 0 };
  const today = todayInTz(config.TZ);
  const subs = await prisma.subscription.findMany(subscriptionQuery);
  const rows = subs.flatMap((sub) => rowsForSubscription(sub, deps, today, config.TZ));
  if (rows.length === 0) return { created: 0 };
  const result = await prisma.task.createMany({ data: rows, skipDuplicates: true });
  return { created: result.count };
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
  if (rows.length === 0) return { created: 0 };
  const result = await prisma.task.createMany({ data: rows, skipDuplicates: true });
  return { created: result.count };
}
