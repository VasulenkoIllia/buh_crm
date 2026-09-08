import type { AccessState } from "@shared/access.js";
import type { UserRole } from "@shared/schema/enums.js";
import { prisma } from "../../core/db.js";

/**
 * `action: "*"` only — the gate-level rows, which are the whole of what this screen edits.
 *
 * The same filter as the resolver in `core/access.ts`, and for the same reason: the column is
 * inert until stage 2, and a screen that rendered an action row as if it were the gate's own would
 * show the firm a state nothing is enforcing.
 */
export function listPolicies() {
  return prisma.accessPolicy.findMany({
    where: { action: "*" },
    orderBy: [{ gate: "asc" }, { role: "asc" }],
  });
}

export function listOverrides() {
  return prisma.accessOverride.findMany({ where: { action: "*" }, orderBy: [{ gate: "asc" }] });
}

/** Blocked people are left out: they cannot sign in, so an exception for them means nothing. */
export function listPeople() {
  return prisma.user.findMany({
    where: { status: { not: "blocked" } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      status: true,
      avatarFileId: true,
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

export function findUser(id: string) {
  return prisma.user.findUnique({ where: { id }, select: { id: true } });
}

/**
 * The state BEFORE a write, for the log.
 *
 * Policies and overrides are upserted in place, so without this read the change has no "from" and
 * the log could say only that something moved — which is not the question anybody asks
 * (`permissions.md` §20.3). Two extra indexed reads on a screen used a few times a year.
 */
export async function currentPolicyState(gate: string, role: UserRole) {
  const row = await prisma.accessPolicy.findUnique({
    where: { gate_role_action: { gate, role, action: "*" } },
    select: { state: true },
  });
  return row?.state ?? null;
}

export async function currentOverrideState(userId: string, gate: string) {
  const row = await prisma.accessOverride.findUnique({
    where: { userId_gate_action: { userId, gate, action: "*" } },
    select: { state: true },
  });
  return row?.state ?? null;
}

export function upsertPolicy(gate: string, role: UserRole, state: AccessState) {
  return prisma.accessPolicy.upsert({
    where: { gate_role_action: { gate, role, action: "*" } },
    update: { state },
    create: { gate, role, state },
  });
}

export function upsertOverride(userId: string, gate: string, state: AccessState) {
  return prisma.accessOverride.upsert({
    where: { userId_gate_action: { userId, gate, action: "*" } },
    update: { state },
    create: { userId, gate, state },
  });
}

/** An absent row IS "follow the role" — deleting is the whole of clearing an exception. */
export function deleteOverride(userId: string, gate: string) {
  return prisma.accessOverride.deleteMany({ where: { userId, gate, action: "*" } });
}
