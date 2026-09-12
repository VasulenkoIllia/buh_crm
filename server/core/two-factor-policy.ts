/**
 * **The firm's two-factor rule, and whether it holds a person back** (two-factor.md §6.4).
 *
 * In core rather than in the `two-factor` module because the access hook asks it on every request,
 * and core may not import a module. It is the one place outside that module that reads the 2FA
 * tables, and all it ever asks is whether a confirmed credential EXISTS — it never touches a secret.
 *
 * The rule is one row read on every request, so it is held in memory like the access tables, and
 * changing it invalidates this in-process — the same one-container bound `core/access.ts` records.
 * While the rule is `off`, which is how it ships, the hook's question costs no query at all.
 */
import type { UserRole } from "@shared/schema/enums.js";
import type { TwoFactorPolicy, TwoFactorSessionState } from "@shared/schema/two-factor.js";
import { isTest } from "./config.js";
import { prisma } from "./db.js";

/** The fortnight's grace, counted from the day the rule last changed. */
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = isTest ? 0 : 30_000;

interface FirmRule {
  policy: TwoFactorPolicy;
  since: Date | null;
  loadedAt: number;
}

let cached: FirmRule | null = null;
/** Bumped by every invalidation, so a load that raced a write never publishes the old rule. */
let generation = 0;

export function invalidateTwoFactorPolicy() {
  cached = null;
  generation++;
}

export async function firmTwoFactorPolicy(): Promise<{
  policy: TwoFactorPolicy;
  since: Date | null;
}> {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;
  const startedAt = generation;
  const row = await prisma.firmProfile.findUnique({
    where: { id: 1 },
    select: { require2fa: true, require2faSince: true },
  });
  const loaded: FirmRule = {
    policy: row?.require2fa ?? "off",
    since: row?.require2faSince ?? null,
    loadedAt: Date.now(),
  };
  if (generation === startedAt) cached = loaded;
  return loaded;
}

function policyCovers(policy: TwoFactorPolicy, role: UserRole): boolean {
  return policy === "everyone" || (policy === "admins" && role === "admin");
}

export function graceEndsAt(since: Date | null): Date | null {
  return since ? new Date(since.getTime() + GRACE_MS) : null;
}

async function hasTwoFactor(userId: string): Promise<boolean> {
  const row = await prisma.twoFactorCredential.findFirst({
    where: { userId, confirmedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Where this person stands — carried on their own session payload so the shell can send somebody
 * who must enrol to their profile. A rule switched on without a date (only possible by hand, in
 * the database) is treated as past its grace rather than as never-ending.
 */
export async function twoFactorStateFor(
  user: { id: string; role: UserRole },
  known?: { enabled: boolean },
  now = new Date(),
): Promise<TwoFactorSessionState> {
  const [{ policy, since }, enabled] = await Promise.all([
    firmTwoFactorPolicy(),
    known ? known.enabled : hasTwoFactor(user.id),
  ]);
  const required = policyCovers(policy, user.role);
  const ends = required && !enabled ? graceEndsAt(since) : null;
  return {
    enabled,
    required,
    graceEndsAt: ends?.toISOString() ?? null,
    mustEnrol: required && !enabled && (ends === null || ends.getTime() <= now.getTime()),
  };
}

/** The access hook's question: must this person enrol before anything but their own row answers? */
export async function mustEnrol(user: { id: string; role: UserRole }, now = new Date()) {
  const { policy, since } = await firmTwoFactorPolicy();
  if (!policyCovers(policy, user.role)) return false;
  const ends = graceEndsAt(since);
  if (ends && ends.getTime() > now.getTime()) return false;
  return !(await hasTwoFactor(user.id));
}
