/**
 * **Two-factor sign-in** (docs/modules/two-factor.md).
 *
 * Enrolment, the second step of signing in, recovery codes, switching it off, an admin's reset and
 * the firm's rule. The pieces that do not care WHO is signing in — the codes, the recovery codes,
 * the counters, the rule's enforcement, the security letters — live in core, so the client portal
 * calls them rather than copying this module (§4.2).
 */
import argon2 from "argon2";
import QRCode from "qrcode";
import type {
  LoginSecondFactorInput,
  TwoFactorPolicy,
  TwoFactorSetup,
  TwoFactorStatus,
  TwoFactorTeamOverview,
} from "@shared/schema/two-factor.js";
import type { User } from "../../generated/prisma/client.js";
import { destroyAllUserSessions, generateToken, hashToken } from "../../core/auth.js";
import { record, SYSTEM_ACTOR } from "../../core/activity.js";
import {
  AppError,
  ConflictError,
  NotFoundError,
  TooManyAttemptsError,
  ValidationError,
} from "../../core/errors.js";
import { firmName } from "../../core/firm.js";
import { personName } from "../../core/names.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShape,
  matchRecoveryCode,
} from "../../core/recovery-codes.js";
import { open, seal, secretsConfigured } from "../../core/secrets-crypto.js";
import {
  alertOnRun,
  tellAdminsOfReset,
  tellOwner,
  type AttemptOrigin,
} from "../../core/security-mail.js";
import * as throttle from "../../core/sign-in-throttle.js";
import {
  base32Decode,
  base32Encode,
  formatSecret,
  generateTotpSecret,
  matchStep,
  otpauthUri,
} from "../../core/totp.js";
import {
  firmTwoFactorPolicy,
  graceEndsAt,
  invalidateTwoFactorPolicy,
  twoFactorStateFor,
} from "../../core/two-factor-policy.js";
import * as repo from "./two-factor.repository.js";

/** Step one's receipt lives five minutes (§5.2). */
const CHALLENGE_TTL_MS = 5 * 60_000;
/** Five tries at the code per password (§5.2): a typo is not a trip back to the password. */
const CHALLENGE_ATTEMPTS = 5;
/** Challenges nobody finished are kept a day past their expiry, then pruned with the sessions. */
const CHALLENGE_KEEP_MS = 24 * 60 * 60 * 1000;

const POLICY_WORDS: Record<TwoFactorPolicy, string> = {
  off: "Off",
  admins: "Admins",
  everyone: "Everyone",
};

interface Person {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

type Credential = NonNullable<Awaited<ReturnType<typeof repo.findCredential>>>;
type FailureReason = "wrong_code" | "reused_code" | "wrong_recovery_code" | "secret_unreadable";
type Verdict =
  | { ok: true; via: "app" }
  | { ok: true; via: "recovery_code"; codesLeft: number }
  | { ok: false; reason: FailureReason };

const logFailure = (what: string) => (error: unknown) => console.error(what, error);

// ── the profile's view ───────────────────────────────────────────────────────

export async function statusFor(user: Pick<User, "id" | "role">): Promise<TwoFactorStatus> {
  const credential = await repo.findCredential(user.id);
  const enabled = Boolean(credential?.confirmedAt);
  const [state, recoveryCodesLeft] = await Promise.all([
    twoFactorStateFor(user, { enabled }),
    credential && enabled ? repo.countUnusedRecoveryCodes(credential.id) : Promise.resolve(0),
  ]);
  return {
    ...state,
    enabledAt: credential?.confirmedAt?.toISOString() ?? null,
    recoveryCodesLeft,
    available: secretsConfigured(),
  };
}

// ── switching it on ──────────────────────────────────────────────────────────

/**
 * Step one of enrolment (§6.1): the password, then a new secret stored sealed and UNCONFIRMED, and
 * the QR code. Nothing is switched on here — that waits for a code the person reads off their own
 * phone, which is how the day-one lockout is prevented by construction rather than by care.
 */
export async function beginSetup(
  user: User,
  password: string,
  origin: AttemptOrigin,
): Promise<TwoFactorSetup> {
  if (!secretsConfigured()) {
    throw new ValidationError(
      "Two-factor sign-in is not available yet: the server has no SECRETS_KEY. " +
        "Ask whoever runs it to set one.",
    );
  }
  await requirePassword(user, password, origin);
  const existing = await repo.findCredential(user.id);
  if (existing?.confirmedAt) throw new ConflictError("Two-factor sign-in is already on");

  const secret = base32Encode(generateTotpSecret());
  await repo.savePendingSecret(user.id, seal(secret));
  const uri = otpauthUri({ issuer: firmName(), account: user.email, secret });
  return {
    secret: formatSecret(secret),
    otpauthUri: uri,
    // drawn here, never by a third-party QR service — that would hand the secret to whoever runs it
    qrDataUrl: await QRCode.toDataURL(uri, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
    }),
  };
}

/**
 * Step two (§6.1): a code from the app proves the secret reached it. Then it is on, the ten
 * recovery codes exist — shown this once — and the owner gets a letter. The ROUTE ends every other
 * session and re-issues this one.
 */
export async function confirmSetup(user: User, code: string): Promise<string[]> {
  const credential = await repo.findCredential(user.id);
  if (!credential) throw new ValidationError("There is no setup in progress. Start again.");
  if (credential.confirmedAt) throw new ConflictError("Two-factor sign-in is already on");
  const key = openSecret(credential);
  if (!key) throw new ValidationError("This setup can no longer be read. Start again.");

  const step = matchStep(key, code, Date.now(), null);
  if (step === null) {
    throw new ValidationError(
      "That code did not match. Check your phone sets its time automatically, then enter the " +
        "newest code.",
    );
  }
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));
  if (!(await repo.confirmWithCodes(credential.id, step, hashes))) {
    throw new ConflictError("Two-factor sign-in is already on");
  }
  record("user.two_factor_enabled", { subjectId: user.id, subjectLabel: personName(user) });
  tellOwner(user, "enabled");
  return codes;
}

/** New codes; every old one stops working (§6.2). The password first, as for enrolment. */
export async function regenerateRecoveryCodes(
  user: User,
  password: string,
  origin: AttemptOrigin,
): Promise<string[]> {
  await requirePassword(user, password, origin);
  const credential = await repo.findCredential(user.id);
  if (!credential?.confirmedAt) throw new ValidationError("Two-factor sign-in is not on");
  const codes = generateRecoveryCodes();
  await repo.replaceRecoveryCodes(
    credential.id,
    await Promise.all(codes.map(hashRecoveryCode)),
  );
  record("user.recovery_codes_regenerated", {
    subjectId: user.id,
    subjectLabel: personName(user),
  });
  return codes;
}

// ── switching it off ─────────────────────────────────────────────────────────

/**
 * The password AND a code (§6.3). The password alone is exactly what an attacker who lacks the
 * phone has, and would otherwise simply remove the obstacle. The ROUTE ends every other session.
 */
export async function disable(
  user: User,
  password: string,
  code: string,
  origin: AttemptOrigin,
): Promise<void> {
  await requirePassword(user, password, origin);
  const credential = await repo.findCredential(user.id);
  if (!credential?.confirmedAt) throw new ValidationError("Two-factor sign-in is not on");
  await refuseWhileWaiting(user);
  const verdict = await verifyAndCount(user, credential, code, origin);
  if (!verdict.ok) throw new ValidationError(refusalFor(verdict.reason));

  await throttle
    .clearFailures([throttle.secondFactorKey(user.id)])
    .catch(logFailure("sign-in throttle: could not clear the count"));
  await repo.deleteCredential(user.id);
  record("user.two_factor_disabled", { subjectId: user.id, subjectLabel: personName(user) });
  tellOwner(user, "disabled");
}

/**
 * **An admin's reset** (§7). Not a quiet convenience: the admin's own password first (decision 10),
 * never their own account — theirs comes off through `disable`, with a code, or a stolen admin
 * session would remove the one thing in its way — the credential and its codes gone, every session
 * of the account ended, the act journalled, and the owner AND the other admins told (decision 11).
 */
export async function adminReset(
  admin: User,
  targetId: string,
  password: string,
  origin: AttemptOrigin,
): Promise<void> {
  if (targetId === admin.id) {
    throw new ValidationError(
      "Your own two-factor sign-in is turned off from your profile, with a code — not from here",
    );
  }
  await requirePassword(admin, password, origin);
  const target = await repo.findPerson(targetId);
  if (!target) throw new NotFoundError("User not found");
  const credential = await repo.findCredential(target.id);
  if (!credential?.confirmedAt) {
    throw new ValidationError(`${personName(target)} has no two-factor sign-in to reset`);
  }
  await repo.deleteCredential(target.id);
  await destroyAllUserSessions(target.id);
  record("user.two_factor_reset", { subjectId: target.id, subjectLabel: personName(target) });
  tellOwner(target, "reset", { by: personName(admin) });
  void tellAdminsOfReset(target, admin).catch(
    logFailure("two-factor: could not tell the admins"),
  );
}

// ── the firm's rule ──────────────────────────────────────────────────────────

export async function teamOverview(): Promise<TwoFactorTeamOverview> {
  const [{ policy, since }, enrolled] = await Promise.all([
    firmTwoFactorPolicy(),
    repo.listEnrolled(),
  ]);
  return {
    policy,
    policySince: since?.toISOString() ?? null,
    graceEndsAt: policy === "off" ? null : (graceEndsAt(since)?.toISOString() ?? null),
    members: enrolled.map((row) => ({
      userId: row.userId,
      enabledAt: (row.confirmedAt ?? new Date(0)).toISOString(),
    })),
  };
}

/**
 * Off, admins or everyone (§6.4, decision 9). The fortnight is counted from the day the rule last
 * CHANGED, so whoever a change newly covers gets their own fortnight rather than the remains of
 * somebody else's.
 */
export async function setPolicy(policy: TwoFactorPolicy): Promise<TwoFactorTeamOverview> {
  const current = await firmTwoFactorPolicy();
  if (current.policy !== policy) {
    await repo.writePolicy(policy, new Date());
    invalidateTwoFactorPolicy();
    record("settings.two_factor_policy_changed", {
      subjectLabel: "Two-factor sign-in",
      changes: { policy: { from: POLICY_WORDS[current.policy], to: POLICY_WORDS[policy] } },
    });
  }
  return teamOverview();
}

// ── signing in, step two ────────────────────────────────────────────────────

/**
 * Called by `auth` once the password and the account's status are right: a challenge if this
 * person has a second factor, null if they do not (§5.1). A new challenge closes any older one.
 */
export async function startChallenge(userId: string): Promise<string | null> {
  const credential = await repo.findCredential(userId);
  if (!credential?.confirmedAt) return null;
  const { raw, hash } = generateToken();
  await repo.openChallenge(credential.id, hash, new Date(Date.now() + CHALLENGE_TTL_MS));
  return raw;
}

/**
 * **The second step** (§5.2). The challenge is claimed before the code is looked at; a blocked
 * account, a reset second factor or a spent challenge sends the person back to their password; a
 * run of wrong codes waits and writes the letter that says somebody has the password and not the
 * phone. Returns the person — the ROUTE creates the session.
 */
export async function completeSignIn(
  input: LoginSecondFactorInput,
  origin: AttemptOrigin,
): Promise<User> {
  const expired = (message = "This sign-in has expired. Enter your password again.") =>
    new AppError(401, "challenge_expired", message);

  const challenge = await repo.findChallenge(hashToken(input.challenge));
  if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) {
    throw expired();
  }
  const { user, ...credential } = challenge.credential;
  // blocked, or their second factor reset, between the two steps
  if (user.status !== "active" || !credential.confirmedAt) throw expired();

  await refuseWhileWaiting(user);
  if (!(await repo.claimChallengeAttempt(challenge.id, CHALLENGE_ATTEMPTS))) {
    await repo.closeChallenge(challenge.id);
    throw expired("Too many wrong codes. Enter your password again.");
  }
  const verdict = await verifyAndCount(user, credential, input.code, origin);
  if (!verdict.ok) throw new AppError(401, "invalid_code", refusalFor(verdict.reason));

  await repo.closeChallenge(challenge.id);
  await throttle
    .clearFailures([
      throttle.accountKey(user.email),
      throttle.pairKey(user.email, origin.ip),
      throttle.secondFactorKey(user.id),
    ])
    .catch(logFailure("sign-in throttle: could not clear the count"));
  if (verdict.via === "recovery_code") {
    record("session.recovery_code_used", {
      actor: { kind: "user", userId: user.id, label: personName(user) },
      subjectId: user.id,
      subjectLabel: personName(user),
      changes: { codesLeft: verdict.codesLeft },
    });
    tellOwner(user, "recovery_code_used", { codesLeft: verdict.codesLeft });
  }
  return user;
}

/** Nightly, with the expired sessions (`sessions:cleanup`). */
export function deleteStaleChallenges(now = new Date()): Promise<number> {
  return repo.deleteChallengesExpiredBefore(new Date(now.getTime() - CHALLENGE_KEEP_MS));
}

// ── the checks ───────────────────────────────────────────────────────────────

/**
 * **The caller's own password, re-asked** — before enrolment, new codes, switching it off, and an
 * admin's reset. Charged to the same counter as signing in, and a run earns the same letter: a
 * password guess is a password guess wherever it is typed, and somebody at a borrowed, unlocked,
 * signed-in screen trying passwords must be as visible as somebody trying them at the door (audit,
 * 2026-09-12 — the first version counted these and told nobody).
 */
async function requirePassword(
  person: User,
  password: string,
  origin: AttemptOrigin,
): Promise<void> {
  const key = throttle.accountKey(person.email);
  const wait = await throttle.secondsToWait([key]);
  if (wait > 0) throw new TooManyAttemptsError(wait);
  if (!person.passwordHash || !(await argon2.verify(person.passwordHash, password))) {
    const run = await throttle
      .recordFailure([key])
      .then(([state]) => state)
      .catch((error) => {
        console.error("sign-in throttle: could not count a failure", error);
        return null;
      });
    if (run) {
      void alertOnRun(person, run, origin, "password").catch(
        logFailure("sign-in alert: could not send"),
      );
    }
    throw new ValidationError("That password is not right");
  }
  await throttle.clearFailures([key]).catch(logFailure("sign-in throttle: could not clear"));
}

/**
 * The secret, opened — or null, logged loudly. A secret that will not open is a restore paired
 * with the wrong `.env`, or a missing key (§4.1); it is never answered as a wrong code, and recovery
 * codes, which do not depend on the key, still work.
 */
function openSecret(credential: Credential): Buffer | null {
  try {
    return base32Decode(open(credential));
  } catch (error) {
    console.error(
      "two-factor: a stored secret could not be opened — is SECRETS_KEY the key that sealed it? " +
        "(two-factor.md §4.1)",
      error,
    );
    return null;
  }
}

/** A code from the app, or a recovery code — whichever it looks like — spent if it is right. */
async function verifySecondFactor(credential: Credential, input: string): Promise<Verdict> {
  if (isRecoveryCodeShape(input)) {
    const id = await matchRecoveryCode(input, await repo.unusedRecoveryCodes(credential.id));
    if (!id || !(await repo.consumeRecoveryCode(id))) {
      return { ok: false, reason: "wrong_recovery_code" };
    }
    return {
      ok: true,
      via: "recovery_code",
      codesLeft: await repo.countUnusedRecoveryCodes(credential.id),
    };
  }
  const key = openSecret(credential);
  if (!key) return { ok: false, reason: "secret_unreadable" };
  const step = matchStep(key, input, Date.now(), null);
  if (step === null) return { ok: false, reason: "wrong_code" };
  // fresh by the clock, and still unspent in the database — only the conditional write can say both
  const spent = credential.lastStep !== null && step <= credential.lastStep;
  if (spent || !(await repo.advanceStep(credential.id, step))) {
    return { ok: false, reason: "reused_code" };
  }
  return { ok: true, via: "app" };
}

async function refuseWhileWaiting(user: Person): Promise<void> {
  const wait = await throttle.secondsToWait([throttle.secondFactorKey(user.id)]);
  if (wait > 0) {
    recordSecondFactorFailure(user, "throttled");
    throw new TooManyAttemptsError(wait);
  }
}

/**
 * Checks the code; on a failure records it, counts it and — on a run — starts the letter. The
 * letter is not awaited: its extra reads would make exactly these answers slower.
 */
async function verifyAndCount(
  user: Person,
  credential: Credential,
  code: string,
  origin: AttemptOrigin,
): Promise<Verdict> {
  const verdict = await verifySecondFactor(credential, code);
  if (verdict.ok) return verdict;
  recordSecondFactorFailure(user, verdict.reason);
  const run = await throttle
    .recordFailure([throttle.secondFactorKey(user.id)])
    .then(([state]) => state)
    .catch((error) => {
      console.error("sign-in throttle: could not count a failure", error);
      return null;
    });
  if (run) {
    void alertOnRun(user, run, origin, "code").catch(
      logFailure("sign-in alert: could not send"),
    );
  }
  return verdict;
}

/**
 * The counterpart of `session.sign_in_failed`, and the most useful sentence this module writes:
 * somebody had the password and not the phone. The system is the actor, for the same reason.
 */
function recordSecondFactorFailure(user: Person, reason: FailureReason | "throttled") {
  record("session.second_factor_failed", {
    actor: SYSTEM_ACTOR,
    subjectId: user.id,
    subjectLabel: personName(user),
    changes: { email: user.email, reason },
  });
}

function refusalFor(reason: FailureReason): string {
  switch (reason) {
    case "reused_code":
      return "That code has already been used. Wait for the next one.";
    case "secret_unreadable":
      return "Your authenticator cannot be checked right now. Use one of your recovery codes.";
    case "wrong_recovery_code":
      return "That recovery code is not right, or it has already been used.";
    case "wrong_code":
      return "That code is not right.";
  }
}
