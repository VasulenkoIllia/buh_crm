import type { Task } from "@shared/schema/task";
import type { AssigneeInfo } from "./tasks.api";

/** An active task past its deadline. */
export const isOverdue = (t: Task) =>
  !t.done && !!t.deadline && new Date(t.deadline) < new Date();

/** dd/mm — compact, for board cards & tight rows. */
export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });

/** dd/mm/yyyy — full date, for rollup rows. (Was a second, name-colliding `fmtDue`.) */
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB");

/** Two-letter avatar initials from a team member. */
export const initials = (u?: AssigneeInfo) =>
  u ? `${u.firstName[0] ?? ""}${u.lastName[0] ?? ""}`.toUpperCase() : "?";
