/**
 * Client secrets — the credentials the firm holds for a client (tax portal, client-bank, КЕП).
 *
 * Three rules shape everything here (decision 2026-08-01):
 *   1. The value is encrypted at rest and NEVER leaves through the list endpoint.
 *   2. Revealing costs the viewer's OWN password and lasts five minutes — counted here, on the
 *      server, because a countdown in the browser is decoration.
 *   3. Every reveal, and every FAILED unlock, is journalled. A run of failures is the only signal
 *      that somebody is guessing.
 *
 * The grant is scoped to (user, client): unlocking one client's tab must not quietly open every
 * other client's. It lives in process memory rather than the database — a restart revoking every
 * grant is a feature, and there is exactly one app container.
 */
import argon2 from "argon2";
import type { ClientSecretInput, UnlockSecretsInput } from "@shared/schema/client.js";
import type { User } from "../../generated/prisma/client.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { open, seal, secretsConfigured } from "../../core/secrets-crypto.js";
import * as repo from "./secrets.repository.js";

const GRANT_MINUTES = 5;
const GRANT_MS = GRANT_MINUTES * 60_000;

/** (userId, clientId) → when the grant expires. Cleared by a restart, deliberately. */
const grants = new Map<string, number>();
const grantKey = (userId: string, clientId: string) => `${userId}:${clientId}`;

function activeGrant(userId: string, clientId: string): number | null {
  const until = grants.get(grantKey(userId, clientId));
  if (!until) return null;
  if (until <= Date.now()) {
    grants.delete(grantKey(userId, clientId));
    return null;
  }
  return until;
}

// Secrets used to be admin-only (2026-08-01). They are not any more (user, 2026-08-14): everyone
// who works a client's file needs the portal login for it, and a rule that sends half the team to
// ask an admin every time is a rule people route around — by keeping the password somewhere else.
//
// What did NOT change is the part that actually protects the value: reading one still costs the
// viewer's own password, the grant still expires after five minutes, and every look and every
// failed attempt is still journalled with a name against it. The role was never what stopped
// somebody sitting down at an unlocked laptop; the password is.

function assertConfigured(): void {
  if (!secretsConfigured()) {
    throw new ValidationError(
      "The secret vault is not configured — set SECRETS_KEY on the server (openssl rand -base64 32)",
    );
  }
}

/**
 * Labels and descriptions for a client. Anyone who can open the client sees these — knowing THAT
 * a tax-portal login exists, and what it is for, is ordinary working knowledge; the value is not.
 */
export async function listSecrets(clientId: string) {
  const rows = await repo.listSecrets(clientId);
  return rows.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    hasValue: s.ciphertext !== null,
    createdByName: s.createdBy ? `${s.createdBy.firstName} ${s.createdBy.lastName}`.trim() : null,
    updatedAt: s.updatedAt.toISOString(),
  }));
}

export async function createSecret(
  clientId: string,
  input: ClientSecretInput,
  actor: User,
  ip: string | null,
) {
  if (!(await repo.clientExists(clientId))) throw new NotFoundError("Client not found");

  // A pointer-only entry (no value) is a first-class choice, not a mistake: it is how something
  // too sensitive to hold gets recorded without being held.
  const sealed = input.value ? (assertConfigured(), seal(input.value)) : null;
  const created = await repo.createSecret({
    clientId,
    label: input.label,
    description: input.description ?? null,
    sealed,
    createdById: actor.id,
  });
  await repo.writeAudit({
    secretId: created.id,
    clientId,
    byUserId: actor.id,
    action: "created",
    label: input.label,
    ip,
  });
  return listSecrets(clientId);
}

export async function updateSecret(
  clientId: string,
  secretId: string,
  input: ClientSecretInput,
  actor: User,
  ip: string | null,
) {
  const secret = await repo.findSecret(clientId, secretId);
  if (!secret) throw new NotFoundError("Secret not found");

  // omitted value = leave the stored one alone; explicit null = drop it, keeping the entry as a
  // pointer. Only a non-empty string re-encrypts.
  let sealed: ReturnType<typeof seal> | null | undefined;
  if (input.value === null) sealed = null;
  else if (input.value !== undefined) {
    assertConfigured();
    sealed = seal(input.value);
  }

  await repo.updateSecret(secretId, {
    label: input.label,
    description: input.description ?? null,
    sealed,
  });
  await repo.writeAudit({
    secretId,
    clientId,
    byUserId: actor.id,
    action: "updated",
    label: input.label,
    ip,
  });
  return listSecrets(clientId);
}

export async function deleteSecret(
  clientId: string,
  secretId: string,
  actor: User,
  ip: string | null,
) {
  // Deleting is destructive and irreversible, so it costs the same password as reading does
  // (user, 2026-08-03). Losing a client's portal login to a stray click is its own kind of leak.
  if (!activeGrant(actor.id, clientId)) {
    throw new ForbiddenError("Enter your password before deleting a secret");
  }
  const secret = await repo.findSecret(clientId, secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  // the audit row is written FIRST and keeps `secretId` via ON DELETE SET NULL — deleting a secret
  // must not erase the record that it existed and who looked at it
  await repo.writeAudit({
    secretId,
    clientId,
    byUserId: actor.id,
    action: "deleted",
    label: secret.label,
    ip,
  });
  await repo.deleteSecret(secretId);
  return listSecrets(clientId);
}

/**
 * Re-authenticate with the caller's OWN login password and open a five-minute window on THIS
 * client. A wrong password is journalled too — that log is the only way a guessing run is visible.
 */
export async function unlock(
  clientId: string,
  input: UnlockSecretsInput,
  actor: User,
  ip: string | null,
) {
  if (!(await repo.clientExists(clientId))) throw new NotFoundError("Client not found");

  const ok = actor.passwordHash ? await argon2.verify(actor.passwordHash, input.password) : false;
  if (!ok) {
    await repo.writeAudit({
      secretId: null,
      clientId,
      byUserId: actor.id,
      action: "unlock_failed",
      label: null, // an unlock targets the client, not one secret
      ip,
    });
    // Names WHICH password, because that is the part people get wrong. The window asks for
    // re-authentication, and somebody who assumes the vault has a password of its own will try
    // one that never existed and read "Wrong password" as a fault in the app. Seven consecutive
    // failures in the access log, with no idea what to try next, is what prompted this
    // (user, 2026-09-04).
    throw new ForbiddenError("Wrong password — use the one you sign in with");
  }

  // sweep on the way in: an expired entry is otherwise only dropped when somebody happens to ask
  // about that exact (user, client) again, so the map grew by one per unlock and never shrank
  const now = Date.now();
  for (const [k, until] of grants) if (until <= now) grants.delete(k);

  const expiresAt = now + GRANT_MS;
  grants.set(grantKey(actor.id, clientId), expiresAt);
  return { expiresAt: new Date(expiresAt).toISOString() };
}

/** How long the caller's window on this client has left — drives the countdown, reveals nothing. */
export function grantStatus(clientId: string, actor: User) {
  const until = activeGrant(actor.id, clientId);
  return { expiresAt: until ? new Date(until).toISOString() : null };
}

/** Hand back the plaintext. Requires a live grant, and writes exactly one audit row. */
export async function revealSecret(
  clientId: string,
  secretId: string,
  actor: User,
  ip: string | null,
) {
  const until = activeGrant(actor.id, clientId);
  if (!until) {
    throw new ForbiddenError("Enter your password to view this client's secrets");
  }
  const secret = await repo.findSecret(clientId, secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  if (!secret.ciphertext || !secret.iv || !secret.authTag) {
    throw new ValidationError("This entry holds no value — see its description for where it lives");
  }
  assertConfigured();

  const value = open({
    ciphertext: secret.ciphertext,
    iv: secret.iv,
    authTag: secret.authTag,
    keyVersion: secret.keyVersion,
  });
  // One row per LOOK, not per click: opening the edit form reveals the value as well, so a couple
  // of clicks left a run of identical entries seconds apart and buried the rest of the log.
  const justLooked = await repo.recentReveal(secretId, actor.id, new Date(Date.now() - 60_000));
  if (!justLooked) {
    await repo.writeAudit({
      secretId,
      clientId,
      byUserId: actor.id,
      action: "revealed",
      label: secret.label,
      ip,
    });
  }
  return { value, expiresAt: new Date(until).toISOString() };
}

/** The client's access history — it names who looked at what, and when. */
const AUDIT_PAGE_SIZE = 10;

export async function listAudit(clientId: string, page = 1) {
  const { items, total } = await repo.listAudit(clientId, Math.max(1, page), AUDIT_PAGE_SIZE);
  const rows = items.map((r) => ({
    id: r.id,
    action: r.action,
    // the snapshot first; the live row only as a fallback for pre-2026-08-03 entries
    label: r.label ?? r.secret?.label ?? null,
    byName: `${r.byUser.firstName} ${r.byUser.lastName}`.trim(),
    createdAt: r.createdAt.toISOString(),
  }));
  return { items: rows, total, page: Math.max(1, page), pageSize: AUDIT_PAGE_SIZE };
}

/** Test seam: a fresh process starts with no grants, and so must a fresh test. */
export function __clearGrants() {
  grants.clear();
}
