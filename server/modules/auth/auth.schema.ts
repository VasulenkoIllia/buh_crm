import type { User } from "../../generated/prisma/client.js";
import type { PublicUser, SessionUser } from "@shared/schema/user.js";
import { accessMapFor } from "../../core/access.js";
import { twoFactorStateFor } from "../../core/two-factor-policy.js";

/**
 * The caller's own payload: who they are, what they may open, and where they stand with the firm's
 * two-factor rule (two-factor.md §6.4) — the shell reads the last to send somebody who must enrol
 * to their profile.
 *
 * Separate from `toPublicUser` on purpose — the team list and an invite response return people
 * OTHER than the caller, and their gates are not the caller's business.
 */
export async function toSessionUser(user: User): Promise<SessionUser> {
  const [access, twoFactor] = await Promise.all([accessMapFor(user), twoFactorStateFor(user)]);
  return { ...toPublicUser(user), access, twoFactor };
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
