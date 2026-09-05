import type { User } from "../../generated/prisma/client.js";
import type { PublicUser, SessionUser } from "@shared/schema/user.js";
import { accessMapFor } from "../../core/access.js";

/**
 * The caller's own payload: who they are, plus what they may open.
 *
 * Separate from `toPublicUser` on purpose — the team list and an invite response return people
 * OTHER than the caller, and their gates are not the caller's business.
 */
export async function toSessionUser(user: User): Promise<SessionUser> {
  return { ...toPublicUser(user), access: await accessMapFor(user) };
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    avatarFileId: user.avatarFileId,
  };
}
