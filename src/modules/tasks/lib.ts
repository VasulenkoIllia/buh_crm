import { isTaskOverdue } from "@shared/dates";
import type { Task } from "@shared/schema/task";

/**
 * An open task whose whole deadline DAY has passed. The rule lives in `shared/dates.ts` and is
 * the same one the invoice status uses, so the board's red ring, the "Overdue" chip and an
 * overdue invoice all mean one thing — and a task due TODAY is due today, not late.
 */
export const isOverdue = (t: Task) => isTaskOverdue(t);

// formatting is app-wide, not task-specific — re-exported so the board's imports stay short
export { fmtDate, fmtDay, initials } from "@/shared/lib/format";
