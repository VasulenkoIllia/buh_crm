import { MAX_STAGES, type ServiceStage } from "@shared/schema/catalog";

/**
 * One row of the stages editor. `key` is the row's identity on the screen; `id` is the stage's in
 * the database, absent for a row added in this form. Kept apart because a new row has no id and a
 * renamed one must keep its own: the server keeps the stage, and the tasks on it, by that id.
 */
export interface StageRow {
  key: string;
  id?: string;
  name: string;
}

let counter = 0;
const nextKey = () => `stage-${++counter}`;

export const rowsOf = (stages: ServiceStage[]): StageRow[] =>
  stages.map((s) => ({ key: s.id, id: s.id, name: s.name }));

export const addRow = (rows: StageRow[], name = ""): StageRow[] =>
  rows.length >= MAX_STAGES ? rows : [...rows, { key: nextKey(), name }];

/** Copied names come in as NEW stages: another service's rows are its own. */
export const copyRows = (stages: ServiceStage[]): StageRow[] =>
  stages.slice(0, MAX_STAGES).map((s) => ({ key: nextKey(), name: s.name }));

/** The row at `from` put down at `to`, the rows between closing up behind it: what a drag does. */
export function moveRow(rows: StageRow[], from: number, to: number): StageRow[] {
  const inside = (i: number) => i >= 0 && i < rows.length;
  if (from === to || !inside(from) || !inside(to)) return rows;
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

/**
 * What is wrong with a row, by its key: empty, or a name already used above it (however it is
 * cased, which is how the server and the tasks filter compare them).
 */
export const NAMELESS_STAGE = "Give the stage a name, or remove it";

export function stageProblems(rows: StageRow[]): Map<string, string> {
  const problems = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (!name) problems.set(row.key, NAMELESS_STAGE);
    else if (seen.has(name)) problems.set(row.key, "Already in the list");
    seen.add(name);
  }
  return problems;
}

/** The list as the API takes it: the whole of it, in order. */
export const toStagesInput = (rows: StageRow[]) =>
  rows.map((r) => (r.id ? { id: r.id, name: r.name.trim() } : { name: r.name.trim() }));

/**
 * What a save sends: the list when it differs from the saved one, nothing when it does not. Every
 * save of a service used to resend its whole list, so a price changed in a form opened before a
 * colleague added a stage quietly removed that stage again (review, 2026-10-08).
 */
export function stagesToSend(rows: StageRow[], saved: ServiceStage[]) {
  const input = toStagesInput(rows);
  const same =
    input.length === saved.length &&
    input.every((s, i) => s.id === saved[i].id && s.name === saved[i].name);
  return same ? undefined : input;
}
