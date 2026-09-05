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
