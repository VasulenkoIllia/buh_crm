import type { AccessTable, SetAccessStateInput } from "@shared/schema/access.js";
import { GATES, type AccessState, type GateKey } from "@shared/access.js";
import { GATE_COPY } from "@shared/access-copy.js";
import type { UserRole } from "@shared/schema/enums.js";
import { invalidateAccessCache } from "../../core/access.js";
import { record } from "../../core/activity.js";
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

/**
 * **"Who took this away from me, and when" — the first question anybody asks** after the first
 * access decision, and until now it had no answer at all: these three writes upsert in place, with
 * no actor and no prior state (`permissions.md` §20.3, deferred here by name).
 *
 * The prior state is read before the write rather than reconstructed after, because after the
 * upsert it is gone. Nothing is recorded when the state did not move: re-saving a row that already
 * said `closed` is not a decision, and `record()` drops an empty diff for exactly this reason.
 */
export async function setPolicy(gate: GateKey, role: UserRole, input: SetAccessStateInput) {
  assertOffered(gate, input.state);
  const from = await repo.currentPolicyState(gate, role);
  await repo.upsertPolicy(gate, role, input.state);
  invalidateAccessCache();
  if (from !== input.state) {
    record("access.policy_changed", {
      // the gate and the role are the subject's identity, so they belong in the label a screen
      // reads, not inside the diff
      subjectLabel: `${GATE_COPY[gate].label} · ${role}`,
      changes: { state: { from, to: input.state } },
    });
  }
  return getTable();
}

export async function setOverride(userId: string, gate: GateKey, input: SetAccessStateInput) {
  assertOffered(gate, input.state);
  if (!(await repo.findUser(userId))) throw new NotFoundError("User not found");
  const from = await repo.currentOverrideState(userId, gate);
  await repo.upsertOverride(userId, gate, input.state);
  invalidateAccessCache();
  if (from !== input.state) {
    record("access.override_set", {
      // the PERSON is the subject: "what has been done to this account" is asked about them, and
      // `[subject, subjectId]` is the index that answers it
      subjectId: userId,
      subjectLabel: GATE_COPY[gate].label,
      changes: { state: { from, to: input.state } },
    });
  }
  return getTable();
}

/** Removing an override is "follow the role again" — an absent row is the whole meaning. */
export async function clearOverride(userId: string, gate: GateKey) {
  const from = await repo.currentOverrideState(userId, gate);
  await repo.deleteOverride(userId, gate);
  invalidateAccessCache();
  if (from !== null) {
    record("access.override_cleared", {
      subjectId: userId,
      subjectLabel: GATE_COPY[gate].label,
      // `to: null` is not "closed" — it is "follow the role again", which is the whole meaning of
      // an absent row and the thing a reader six months later would otherwise have to know
      changes: { state: { from, to: null } },
    });
  }
  return getTable();
}
