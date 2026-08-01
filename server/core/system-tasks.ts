/**
 * Raising a task the SYSTEM decided on, in one place.
 *
 * Two modules need this — Payments (the part-served period reminder) and Tasks ("service ends
 * soon") — and neither may import the other: Tasks already depends on Payments for job billing, so
 * the reverse would be a cycle. Rather than keep two near-identical copies of "look up the default
 * priority and column, insert, swallow the duplicate", the shared shape lives here and each module
 * passes its own fields (found in the 2026-07-29 audit).
 *
 * Dedupe is the database's job: the partial unique index `Task_system_period` on
 * `(subscriptionId, periodKey) WHERE systemKind IS NOT NULL` means the daily sweeps can run as
 * often as they like. A duplicate is reported as `false`, never as an error.
 */
import { SYSTEM_TASKS, type SystemTaskKind } from "@shared/system-tasks.js";
import { prisma } from "./db.js";

export interface SystemTaskTarget {
  clientId: string;
  companyId: string | null;
  serviceId: string;
  subscriptionId: string;
}

export async function raiseSystemTask(
  kind: SystemTaskKind,
  target: SystemTaskTarget,
  /** the dedupe key — a billing period, or `end-YYYY-MM-DD` for an ending date */
  periodKey: string,
  extra?: { titleSuffix?: string; deadline?: Date },
): Promise<boolean> {
  const spec = SYSTEM_TASKS[kind];
  const [priority, column] = await Promise.all([
    prisma.priority.findFirst({ where: { isDefault: true } }),
    prisma.taskColumn.findFirst({ where: { isFixed: true } }),
  ]);
  if (!priority || !column) return false; // bootstrap hasn't run yet — nothing to hang a task on

  try {
    await prisma.task.create({
      data: {
        ...target,
        title: extra?.titleSuffix ? `${spec.title} · ${extra.titleSuffix}` : spec.title,
        description: spec.description,
        periodKey,
        systemKind: kind,
        kind: "free", // firm admin work: it is never itself billable
        priorityId: priority.id,
        statusColumnId: column.id,
        ...(extra?.deadline ? { deadline: extra.deadline } : {}),
      },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // already raised
    throw err;
  }
}
