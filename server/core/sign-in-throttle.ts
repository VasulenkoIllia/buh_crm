/**
 * **Failed sign-ins, counted — and answered with a wait, never a lock.**
 *
 * docs/modules/two-factor.md §9. The product recorded every failed sign-in and did nothing about
 * any of them; this is the reaction. It knows nothing about users on purpose: a key is a string, so
 * the second sign-in step counts `2fa:<userId>` with the same code, and the client portal can count
 * its own sign-ins without a second implementation (§4.2).
 *
 * **Why a table, and not the two obvious places.** The activity log already holds every failure,
 * but the firm can switch any event off in Settings → Activity — a throttle that read it would stop
 * protecting anybody the day somebody silenced a noisy event. The rate-limit plugin keeps its
 * counters in process memory, the single-container assumption this module refuses everywhere else,
 * and computes its key before the body is parsed, so it cannot see which account was named.
 *
 * **No hard lock, ever** (decision 7). With addresses that are easy to guess, a lock is a denial of
 * service the attacker controls: anybody could hold any employee out indefinitely by typing wrong
 * passwords. The ceiling below is seconds, and a refused attempt waits rather than being refused
 * for good.
 */
import { prisma } from "./db.js";

/** Failures that cost nothing — a person who mistypes their password a few times never waits. */
export const FREE_FAILURES = 4;
/** The ceiling, "seconds, not minutes". At 60 s one key can be tried about 1,400 times a day. */
export const MAX_DELAY_SECONDS = 60;
/** A quiet quarter of an hour forgives the count. */
const QUIET_MS = 15 * 60_000;
/** Rows nobody has failed against for this long are pruned nightly — longer than anything reads. */
const STALE_MS = 24 * 60 * 60_000;

/** How long the NEXT attempt waits after `failures` failures in a row: 0 … 0, 2, 4, 8 … 60. */
export function delayAfter(failures: number): number {
  if (failures <= FREE_FAILURES) return 0;
  return Math.min(2 ** (failures - FREE_FAILURES), MAX_DELAY_SECONDS);
}

export interface ThrottleState {
  key: string;
  failures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  alertedAt: Date | null;
}

/**
 * Seconds the caller must still wait before any of these keys may be tried again, or 0.
 *
 * Derived from the last failure rather than stored as a deadline, so two failures landing together
 * cannot race each other into writing a shorter wait over a longer one.
 */
export async function secondsToWait(keys: string[], now = new Date()): Promise<number> {
  const rows = await prisma.signInThrottle.findMany({ where: { key: { in: keys } } });
  let wait = 0;
  for (const row of rows) {
    if (now.getTime() - row.lastFailureAt.getTime() > QUIET_MS) continue;
    const until = row.lastFailureAt.getTime() + delayAfter(row.failures) * 1000;
    wait = Math.max(wait, Math.ceil((until - now.getTime()) / 1000));
  }
  return wait;
}

/**
 * Counts one failure against every key and returns their states, in the order given.
 *
 * The increment happens in the database (`failures + 1`), not as a read-then-write, so two
 * simultaneous failures count as two. A key that has been quiet for a quarter of an hour starts
 * again from one — but keeps `alertedAt`: otherwise an attacker pausing sixteen minutes between
 * runs would earn the owner a letter per run.
 */
export async function recordFailure(
  keys: string[],
  now = new Date(),
): Promise<ThrottleState[]> {
  const quietSince = new Date(now.getTime() - QUIET_MS);
  const states: ThrottleState[] = [];
  for (const key of keys) {
    await prisma.signInThrottle.updateMany({
      where: { key, lastFailureAt: { lt: quietSince } },
      data: { failures: 0, firstFailureAt: now },
    });
    states.push(
      await prisma.signInThrottle.upsert({
        where: { key },
        create: { key, failures: 1, firstFailureAt: now, lastFailureAt: now },
        update: { failures: { increment: 1 }, lastFailureAt: now },
      }),
    );
  }
  return states;
}

/** A successful sign-in forgives the count. `alertedAt` stays, and with it the letter's dedupe. */
export async function clearFailures(keys: string[]): Promise<void> {
  await prisma.signInThrottle.updateMany({
    where: { key: { in: keys }, failures: { gt: 0 } },
    data: { failures: 0 },
  });
}

/**
 * Claims the one letter a run of failures earns — true for exactly one caller.
 *
 * A conditional update, not a read: two failures arriving together would both see "no letter yet",
 * and only one of them may act on it.
 */
export async function claimAlert(
  key: string,
  dedupeMs: number,
  now = new Date(),
): Promise<boolean> {
  const { count } = await prisma.signInThrottle.updateMany({
    where: {
      key,
      OR: [{ alertedAt: null }, { alertedAt: { lt: new Date(now.getTime() - dedupeMs) } }],
    },
    data: { alertedAt: now },
  });
  return count === 1;
}

/** Nightly housekeeping, beside the expired sessions (`sessions:cleanup`). */
export async function deleteStaleThrottles(now = new Date()): Promise<number> {
  const { count } = await prisma.signInThrottle.deleteMany({
    where: { lastFailureAt: { lt: new Date(now.getTime() - STALE_MS) } },
  });
  return count;
}

// ── the keys ─────────────────────────────────────────────────────────────────
//
// Named here, once, because three callers charge them: signing in, the second step, and every
// place that re-asks for a password (enrolment, new recovery codes, an admin's reset). A password
// guess is a password guess wherever it is typed, so all of them share the account's budget.

/**
 * Password attempts against the address TYPED — normalised, whether or not an account has it. The
 * brake an attacker cannot route around: ten network addresses are still one account. Keyed by
 * account instead, real accounts would slow down and unknown ones would not, and the difference
 * would say which addresses have accounts.
 */
export const accountKey = (email: string) => `acct:${email}`;
/** …and against that address from one network address. */
export const pairKey = (email: string, ip: string) => `pair:${email}|${ip}`;
/** Codes tried after a correct password (two-factor.md §5.3). */
export const secondFactorKey = (userId: string) => `2fa:${userId}`;
