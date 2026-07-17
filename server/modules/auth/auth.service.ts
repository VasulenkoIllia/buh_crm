import argon2 from "argon2";
import type { AcceptInviteInput, LoginInput, ResetPasswordInput } from "@shared/schema/user.js";
import { generateToken, hashToken, destroyAllUserSessions } from "../../core/auth.js";
import { sendEmail, webOrigin } from "../../core/email.js";
import { UnauthorizedError, ValidationError } from "../../core/errors.js";
import * as repo from "./auth.repository.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function login(input: LoginInput) {
  const user = await repo.findUserByEmail(input.email);
  const invalid = new UnauthorizedError("Invalid email or password");
  if (!user?.passwordHash) throw invalid;
  if (!(await argon2.verify(user.passwordHash, input.password))) throw invalid;
  if (user.status === "blocked") throw new UnauthorizedError("This account is blocked");
  if (user.status !== "active") throw invalid;
  return user;
}

/**
 * Invite acceptance (decision 2026-07-17): clicking the invite link proves email
 * ownership — set name + password → immediately active (no separate confirm step).
 */
export async function acceptInvite(input: AcceptInviteInput) {
  const token = await repo.findValidToken(hashToken(input.token), "invite");
  if (!token) throw new ValidationError("This invite link is invalid or has expired");
  if (token.user.status !== "invited") {
    throw new ValidationError("This invite has already been used");
  }

  const user = await repo.activateInvitedUser(token.userId, {
    firstName: input.firstName,
    lastName: input.lastName,
    passwordHash: await argon2.hash(input.password),
  });
  await repo.markTokenUsed(token.id);
  return user;
}

/** Always succeeds silently — never reveals whether the email exists. */
export async function requestPasswordReset(email: string) {
  const user = await repo.findUserByEmail(email);
  if (!user || user.status !== "active") return;

  await repo.invalidateUserTokens(user.id, "password_reset");
  const { raw, hash } = generateToken();
  await repo.createAuthToken(
    user.id,
    "password_reset",
    hash,
    new Date(Date.now() + RESET_TOKEN_TTL_MS),
  );
  void sendEmail("passwordReset", user.email, {
    resetUrl: `${webOrigin()}/reset-password?token=${raw}`,
  }).catch(() => {
    /* logged by the mailer caller; user-facing flow must not fail */
  });
}

export async function resetPassword(input: ResetPasswordInput) {
  const token = await repo.findValidToken(hashToken(input.token), "password_reset");
  if (!token) throw new ValidationError("This reset link is invalid or has expired");

  await repo.setUserPassword(token.userId, await argon2.hash(input.password));
  await repo.markTokenUsed(token.id);
  await destroyAllUserSessions(token.userId); // log out everywhere after a reset
  return token.user;
}
