import type { TwoFactorPolicy } from "../../generated/prisma/enums.js";
import { prisma } from "../../core/db.js";
import type { SealedSecret } from "../../core/secrets-crypto.js";

/**
 * Everything the service needs to check a code — the sealed secret included. None of it leaves the
 * server: the routes answer with a status, never with a row.
 */
const credentialFields = {
  id: true,
  userId: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  keyVersion: true,
  confirmedAt: true,
  lastStep: true,
} as const;

export function findCredential(userId: string) {
  return prisma.twoFactorCredential.findUnique({ where: { userId }, select: credentialFields });
}

export function findPerson(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true, status: true },
  });
}

/**
 * A new secret, not yet confirmed. It replaces a setup nobody finished and never a confirmed
 * credential: the `confirmedAt: null` filter is what refuses, and a setup racing a confirm loses on
 * the unique `userId`.
 */
export async function savePendingSecret(userId: string, sealed: SealedSecret): Promise<void> {
  const data = {
    ciphertext: Buffer.from(sealed.ciphertext),
    iv: Buffer.from(sealed.iv),
    authTag: Buffer.from(sealed.authTag),
    keyVersion: sealed.keyVersion,
    lastStep: null,
  };
  const { count } = await prisma.twoFactorCredential.updateMany({
    where: { userId, confirmedAt: null },
    data,
  });
  if (count > 0) return;
  try {
    await prisma.twoFactorCredential.create({ data: { userId, ...data } });
  } catch (error) {
    // a second setup for the same person landed first (a double submit): it is unconfirmed too,
    // so this one simply replaces it — the same outcome as arriving a moment later
    if ((error as { code?: unknown }).code !== "P2002") throw error;
    await prisma.twoFactorCredential.updateMany({ where: { userId, confirmedAt: null }, data });
  }
}

/**
 * Switches it on and writes its recovery codes — together or not at all, so nobody ends up with a
 * second factor and no way back. The `confirmedAt: null` condition makes a double submit harmless.
 */
export function confirmWithCodes(id: string, step: number, codeHashes: string[]) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.twoFactorCredential.updateMany({
      where: { id, confirmedAt: null },
      data: { confirmedAt: new Date(), lastStep: step },
    });
    if (count !== 1) return false;
    await tx.twoFactorRecoveryCode.deleteMany({ where: { credentialId: id } });
    await tx.twoFactorRecoveryCode.createMany({
      data: codeHashes.map((codeHash) => ({ credentialId: id, codeHash })),
    });
    return true;
  });
}

/**
 * Records an accepted step — only if it is later than the last one. The single-use rule lives in
 * this WHERE: two submissions of the same code both pass `matchStep`, and exactly one of them moves
 * this row.
 */
export async function advanceStep(id: string, step: number): Promise<boolean> {
  const { count } = await prisma.twoFactorCredential.updateMany({
    where: {
      id,
      confirmedAt: { not: null },
      OR: [{ lastStep: null }, { lastStep: { lt: step } }],
    },
    data: { lastStep: step },
  });
  return count === 1;
}

export function replaceRecoveryCodes(credentialId: string, codeHashes: string[]) {
  return prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { credentialId } }),
    prisma.twoFactorRecoveryCode.createMany({
      data: codeHashes.map((codeHash) => ({ credentialId, codeHash })),
    }),
  ]);
}

export function unusedRecoveryCodes(credentialId: string) {
  return prisma.twoFactorRecoveryCode.findMany({
    where: { credentialId, usedAt: null },
    select: { id: true, codeHash: true },
  });
}

export function countUnusedRecoveryCodes(credentialId: string) {
  return prisma.twoFactorRecoveryCode.count({ where: { credentialId, usedAt: null } });
}

/** Spends a recovery code — true for exactly one caller, however many arrive together. */
export async function consumeRecoveryCode(id: string): Promise<boolean> {
  const { count } = await prisma.twoFactorRecoveryCode.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

/** The credential, its codes and its challenges (cascade). */
export async function deleteCredential(userId: string): Promise<boolean> {
  const { count } = await prisma.twoFactorCredential.deleteMany({ where: { userId } });
  return count > 0;
}

// ── the challenge between the two steps of signing in ────────────────────────

/**
 * A new challenge closes any older one still open — at most one per person at a time. The
 * credential's row is written first, which takes its lock: two sign-ins landing together would
 * otherwise each fail to see the other's new challenge and both leave one open (security review,
 * 2026-09-12). Serialised, the second closes the first's.
 */
export function openChallenge(credentialId: string, tokenHash: string, expiresAt: Date) {
  return prisma.$transaction(async (tx) => {
    await tx.twoFactorCredential.update({
      where: { id: credentialId },
      data: { updatedAt: new Date() },
    });
    await tx.twoFactorChallenge.updateMany({
      where: { credentialId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.twoFactorChallenge.create({ data: { credentialId, tokenHash, expiresAt } });
  });
}

export function findChallenge(tokenHash: string) {
  return prisma.twoFactorChallenge.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      usedAt: true,
      credential: { select: { ...credentialFields, user: true } },
    },
  });
}

/**
 * Claims one attempt BEFORE the code is checked — false once the challenge is spent, expired or out
 * of tries. The same claim-then-act discipline `acceptInvite` uses against a double submit.
 */
export async function claimChallengeAttempt(id: string, maxAttempts: number): Promise<boolean> {
  const { count } = await prisma.twoFactorChallenge.updateMany({
    where: { id, usedAt: null, attempts: { lt: maxAttempts }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  return count === 1;
}

export function closeChallenge(id: string) {
  return prisma.twoFactorChallenge.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function deleteChallengesExpiredBefore(cutoff: Date): Promise<number> {
  const { count } = await prisma.twoFactorChallenge.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}

// ── the firm's view ──────────────────────────────────────────────────────────

export function listEnrolled() {
  return prisma.twoFactorCredential.findMany({
    where: { confirmedAt: { not: null } },
    select: { userId: true, confirmedAt: true },
  });
}

export function writePolicy(policy: TwoFactorPolicy, since: Date) {
  return prisma.firmProfile.update({
    where: { id: 1 },
    data: { require2fa: policy, require2faSince: since },
    select: { require2fa: true },
  });
}
