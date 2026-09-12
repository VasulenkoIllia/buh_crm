import argon2 from "argon2";
import type { AcceptInviteInput, LoginInput, ResetPasswordInput } from "@shared/schema/user.js";
import type { User } from "../../generated/prisma/client.js";
import { generateToken, hashToken, destroyAllUserSessions } from "../../core/auth.js";
import { sendEmail, webOrigin } from "../../core/email.js";
import { TooManyAttemptsError, UnauthorizedError, ValidationError } from "../../core/errors.js";
import { record, SYSTEM_ACTOR } from "../../core/activity.js";
import { personName } from "../../core/names.js";
import { alertOnRun, type AttemptOrigin } from "../../core/security-mail.js";
import * as throttle from "../../core/sign-in-throttle.js";
import { startChallenge } from "../two-factor/index.js";
import * as repo from "./auth.repository.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Step one's two answers: a session, or — with a second factor on the account — a challenge. */
type LoginOutcome =
  { kind: "signed_in"; user: User } | { kind: "second_factor"; challenge: string };

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

export async function login(input: LoginInput, origin: AttemptOrigin): Promise<LoginOutcome> {
  // the two counters an attempt is charged to (two-factor.md §9) — see `accountKey`
  const keys = [throttle.accountKey(input.email), throttle.pairKey(input.email, origin.ip)];

  /**
   * **Before anything is checked.** An attempt inside the wait never reaches the password, so it
   * neither counts nor tells anything — a correct password typed too soon is refused exactly like a
   * wrong one. Recorded, with its own reason, because a run of these is what an attack looks like.
   */
  const wait = await throttle.secondsToWait(keys);
  if (wait > 0) {
    recordFailedSignIn(input.email, "throttled");
    throw new TooManyAttemptsError(wait);
  }

  const user = await repo.findUserByEmail(input.email);
  const invalid = new UnauthorizedError("Invalid email or password");
  if (!user?.passwordHash) {
    await burnPasswordCheck(input.password);
    // an address with no account at all — the shape a probe leaves behind
    return refuse(input.email, user ? "no_password_set" : "unknown_email", invalid, {
      user,
      keys,
      origin,
    });
  }
  if (!(await argon2.verify(user.passwordHash, input.password))) {
    return refuse(input.email, "wrong_password", invalid, { user, keys, origin });
  }
  if (user.status === "blocked") {
    return refuse(input.email, "blocked", new UnauthorizedError("This account is blocked"), {
      user,
      keys,
      origin,
    });
  }
  if (user.status !== "active") {
    return refuse(input.email, "not_active", invalid, { user, keys, origin });
  }

  /**
   * **The password is right. With a second factor on the account that is not yet a sign-in**
   * (two-factor.md §5.1): no session, a challenge instead — and the counters stay as they are until
   * the code is right too, because a correct password alone is exactly what an attacker who lacks
   * the phone has. The status checks above have already run, so step two cannot become a thinner
   * door into them.
   */
  const challenge = await startChallenge(user.id);
  if (challenge) return { kind: "second_factor", challenge };

  // a success must stay a success: a counter that could not be cleared costs, at worst, one wait
  await throttle
    .clearFailures(keys)
    .catch((err) => console.error("sign-in throttle: could not clear the count", err));
  return { kind: "signed_in", user };
}

/**
 * Records the failure, counts it, starts the letter a run earns, and throws.
 *
 * **Counting and the letter never change the answer** (security review, 2026-09-12). A refused
 * sign-in is the same 401 whatever the counter table is doing, so a failure to count is logged and
 * the refusal goes out as it would have. And the letter is not awaited: its extra reads happen only
 * for a real, active account on the attempt that crosses the threshold, and a response that waited
 * for them — or failed with them — would be slower, or a 500, for exactly the addresses that have
 * accounts. That is the question `burnPasswordCheck` exists to leave unanswered.
 */
async function refuse(
  email: string,
  reason: string,
  error: Error,
  attempt: { user: User | null; keys: string[]; origin: AttemptOrigin },
): Promise<never> {
  recordFailedSignIn(email, reason, attempt.user?.id);
  const run = await throttle
    .recordFailure(attempt.keys)
    .then(([account]) => account)
    .catch((err) => {
      console.error("sign-in throttle: could not count a failure", err);
      return null;
    });
  // only an account somebody can actually lose: an unknown address has nobody to tell, an invited
  // one has not been used yet, and a blocked one is already out
  if (run && attempt.user?.status === "active") {
    void alertOnRun(attempt.user, run, attempt.origin, "password").catch((err) =>
      console.error("sign-in alert: could not send", err),
    );
  }
  throw error;
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

/**
 * A new password, from the emailed link. It leaves a second factor exactly as it was: the link
 * creates no session, so the new password leads back to the two-step sign-in, code and all
 * (two-factor.md §5.1) — a mailbox is not a second factor.
 */
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
