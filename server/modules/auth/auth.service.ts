import argon2 from "argon2";
import type { AcceptInviteInput, LoginInput, ResetPasswordInput } from "@shared/schema/user.js";
import { generateToken, hashToken, destroyAllUserSessions } from "../../core/auth.js";
import { sendEmail, webOrigin } from "../../core/email.js";
import { UnauthorizedError, ValidationError } from "../../core/errors.js";
import { record, SYSTEM_ACTOR } from "../../core/activity.js";
import { personName } from "../../core/names.js";
import * as repo from "./auth.repository.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Unknown-email logins still pay the argon2 cost, so response timing can't be
// used to probe which emails have accounts.
let timingDummyHash: string | null = null;
async function burnPasswordCheck(password: string) {
  timingDummyHash ??= await argon2.hash("timing-equalizer");
  await argon2.verify(timingDummyHash, password).catch(() => {});
}

/**
 * **Nothing in this product recorded a failed sign-in.**
 *
 * Not the session table, not the four journals, not the logs — a hundred attempts against one
 * account left no trace anybody could find (activity-log.md §4.5). The reason is recorded with it,
 * because "wrong password" and "this account is blocked and somebody keeps trying" are different
 * facts, and the security package's detection work reads this table rather than building a second
 * one (§15).
 *
 * The ACTOR is the system, deliberately. Nobody is signed in when a sign-in fails, and attributing
 * the attempt to the account it named would say the account holder did it — which is exactly the
 * thing in doubt.
 */
function recordFailedSignIn(email: string, reason: string, userId?: string) {
  record("session.sign_in_failed", {
    actor: SYSTEM_ACTOR,
    subjectId: userId ?? null,
    subjectLabel: email,
    changes: { email, reason },
  });
}

export async function login(input: LoginInput) {
  const user = await repo.findUserByEmail(input.email);
  const invalid = new UnauthorizedError("Invalid email or password");
  if (!user?.passwordHash) {
    await burnPasswordCheck(input.password);
    // an address with no account at all — the shape a probe leaves behind
    recordFailedSignIn(input.email, user ? "no_password_set" : "unknown_email", user?.id);
    throw invalid;
  }
  if (!(await argon2.verify(user.passwordHash, input.password))) {
    recordFailedSignIn(input.email, "wrong_password", user.id);
    throw invalid;
  }
  if (user.status === "blocked") {
    recordFailedSignIn(input.email, "blocked", user.id);
    throw new UnauthorizedError("This account is blocked");
  }
  if (user.status !== "active") {
    recordFailedSignIn(input.email, "not_active", user.id);
    throw invalid;
  }
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
  // consume atomically BEFORE acting — a concurrent double-submit loses here
  if (!(await repo.consumeToken(token.id))) {
    throw new ValidationError("This invite has already been used");
  }

  const user = await repo.activateInvitedUser(token.userId, {
    firstName: input.firstName,
    lastName: input.lastName,
    passwordHash: await argon2.hash(input.password),
  });
  // the moment an invitation becomes an account. `createSession` adds the sign-in that follows it,
  // under the same correlation id, so the pair reads as one arrival
  record("user.invite_accepted", { subjectId: user.id, subjectLabel: personName(user) });
  return user;
}

/** Always succeeds silently — never reveals whether the email exists. */
export async function requestPasswordReset(email: string) {
  const user = await repo.findUserByEmail(email);
  /**
   * Recorded for an unknown address as well as a known one, and that is the point.
   *
   * The ROUTE stays silent either way — it never reveals whether an account exists — but the log is
   * behind the `activity` gate and a run of resets aimed at addresses that do not exist is the
   * clearest signal of somebody working through a list. `known` is what tells the two apart.
   */
  record("user.password_reset_requested", {
    actor: SYSTEM_ACTOR,
    subjectId: user?.id ?? null,
    subjectLabel: email,
    changes: { email, known: Boolean(user) },
  });
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
  if (token.user.status !== "active") {
    throw new ValidationError("This account is not active");
  }
  // consume atomically BEFORE acting — a concurrent double-submit loses here
  if (!(await repo.consumeToken(token.id))) {
    throw new ValidationError("This reset link is invalid or has expired");
  }

  await repo.setUserPassword(token.userId, await argon2.hash(input.password));
  await destroyAllUserSessions(token.userId); // log out everywhere after a reset
  record("user.password_reset", {
    actor: { kind: "user", userId: token.userId, label: personName(token.user) },
    subjectId: token.userId,
    subjectLabel: personName(token.user),
  });
  return token.user;
}
