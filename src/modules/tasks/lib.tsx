import { isTaskOverdue } from "@shared/dates";
import type { Task } from "@shared/schema/task";
import { Chip } from "@/shared/ui/chip";

/**
 * An open task whose whole deadline DAY has passed. The rule lives in `shared/dates.ts` and is
 * the same one the invoice status uses, so the board's red ring, the "Overdue" chip and an
 * overdue invoice all mean one thing — and a task due TODAY is due today, not late.
 */
export const isOverdue = (t: Task) => isTaskOverdue(t);


/**
 * What the task is FILED AGAINST, as one chip: internal firm work, a lead, or client work
 * that's included in their plan. A lead task used to render as "internal" — it isn't, it just
 * has no client — so the board couldn't tell firm admin apart from work on a prospect.
 */
export function TaskKindChip({ task, size }: { task: Task; size?: "sm" | "md" }) {
  if (task.leadId) {
    return (
      <Chip tone="violet" size={size}>
        🌱 lead
      </Chip>
    );
  }
  if (task.kind !== "free") return null;
  return task.clientId ? (
    <Chip tone="teal" size={size}>
      included
    </Chip>
  ) : (
    <Chip tone="amber" size={size}>
      internal
    </Chip>
  );
}
