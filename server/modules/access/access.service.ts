import type { AccessTable, SetAccessStateInput } from "@shared/schema/access.js";
import { GATES, type AccessState, type GateKey } from "@shared/access.js";
import { GATE_COPY } from "@shared/access-copy.js";
import type { UserRole } from "@shared/schema/enums.js";
import { invalidateAccessCache } from "../../core/access.js";
import * as repo from "./access.repository.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";

/**
 * The access screen's data and its four writes.
 *
 * Thin on purpose: the rules live in `shared/access.ts` (what a gate offers) and
 * `server/core/access.ts` (what a person's answer is). This module only lets the firm move a row.
 */

export async function getTable(): Promise<AccessTable> {
  const [policies, overrides, people] = await Promise.all([
    repo.listPolicies(),
    repo.listOverrides(),
    repo.listPeople(),
  ]);
  return {
    // rows naming a gate this build does not know are hidden rather than rendered as a broken
    // column — the boot log is where they are reported (see server.ts)
    policies: policies
      .filter((p) => p.gate in GATES)
      .map((p) => ({ gate: p.gate as GateKey, role: p.role, state: p.state })),
    overrides: overrides
      .filter((o) => o.gate in GATES)
      .map((o) => ({ userId: o.userId, gate: o.gate as GateKey, state: o.state })),
    people,
  };
}

/**
 * A gate offers only the states its registry entry lists, and `team` offers none at all.
 *
 * Refused here as well as hidden on the screen: a control that means nothing is worse than no
 * control, and a state written past the screen would be obeyed by the hook without ever having
 * been offered to anybody.
 */
function assertOffered(gate: GateKey, state: AccessState) {
  const spec = GATES[gate];
  if (spec.fixedAdmin) {
    throw new ValidationError(
      `${GATE_COPY[gate].label} is always admin-only and cannot be switched`,
    );
  }
  if (!spec.states.includes(state)) {
    throw new ValidationError(`${GATE_COPY[gate].label} does not offer “${state}”`);
  }
}

export async function setPolicy(gate: GateKey, role: UserRole, input: SetAccessStateInput) {
  assertOffered(gate, input.state);
  await repo.upsertPolicy(gate, role, input.state);
  invalidateAccessCache();
  return getTable();
}

export async function setOverride(userId: string, gate: GateKey, input: SetAccessStateInput) {
  assertOffered(gate, input.state);
  if (!(await repo.findUser(userId))) throw new NotFoundError("User not found");
  await repo.upsertOverride(userId, gate, input.state);
  invalidateAccessCache();
  return getTable();
}

/** Removing an override is "follow the role again" — an absent row is the whole meaning. */
export async function clearOverride(userId: string, gate: GateKey) {
  await repo.deleteOverride(userId, gate);
  invalidateAccessCache();
  return getTable();
}
