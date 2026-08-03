/** All Prisma access for client secrets (see the repository rule in eslint.config.js). */
import type { Prisma, SecretAuditAction } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import type { SealedSecret } from "../../core/secrets-crypto.js";

export function clientExists(clientId: string) {
  return prisma.client
    .findFirst({ where: { id: clientId, archivedAt: null }, select: { id: true } })
    .then(Boolean);
}

/**
 * Labels for the tab. The crypto columns are NOT selected — the only place they leave the database
 * is `findSecret`, which one audited endpoint calls.
 */
export function listSecrets(clientId: string) {
  return prisma.clientSecret.findMany({
    where: { clientId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      label: true,
      description: true,
      updatedAt: true,
      // presence only — enough to tell a real secret from a pointer-only entry
      ciphertext: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });
}

export function findSecret(clientId: string, id: string) {
  return prisma.clientSecret.findFirst({ where: { id, clientId } });
}

export function createSecret(data: {
  clientId: string;
  label: string;
  description: string | null;
  sealed: SealedSecret | null;
  createdById: string;
}) {
  return prisma.clientSecret.create({
    data: {
      clientId: data.clientId,
      label: data.label,
      description: data.description,
      ciphertext: data.sealed ? Buffer.from(data.sealed.ciphertext) : null,
      iv: data.sealed ? Buffer.from(data.sealed.iv) : null,
      authTag: data.sealed ? Buffer.from(data.sealed.authTag) : null,
      keyVersion: data.sealed?.keyVersion ?? 1,
      createdById: data.createdById,
    },
    select: { id: true },
  });
}

export function updateSecret(
  id: string,
  data: { label: string; description: string | null; sealed: SealedSecret | null | undefined },
) {
  let crypto: Prisma.ClientSecretUpdateInput = {}; // `undefined` = leave the stored value alone
  if (data.sealed === null) {
    crypto = { ciphertext: null, iv: null, authTag: null }; // becomes a pointer-only entry
  } else if (data.sealed) {
    crypto = {
      ciphertext: Buffer.from(data.sealed.ciphertext),
      iv: Buffer.from(data.sealed.iv),
      authTag: Buffer.from(data.sealed.authTag),
      keyVersion: data.sealed.keyVersion,
    };
  }
  return prisma.clientSecret.update({
    where: { id },
    data: { label: data.label, description: data.description, ...crypto },
    select: { id: true },
  });
}

export function deleteSecret(id: string) {
  return prisma.clientSecret.delete({ where: { id } });
}

export function writeAudit(entry: {
  secretId: string | null;
  clientId: string;
  byUserId: string;
  action: SecretAuditAction;
  /** snapshot of the secret's name — the FK goes null once the secret is deleted */
  label: string | null;
  ip: string | null;
}) {
  return prisma.secretAuditLog.create({ data: entry, select: { id: true } });
}

export async function listAudit(clientId: string, page: number, pageSize: number) {
  const [items, total] = await Promise.all([
    prisma.secretAuditLog.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        action: true,
        label: true,
        createdAt: true,
        secret: { select: { label: true } },
        byUser: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.secretAuditLog.count({ where: { clientId } }),
  ]);
  return { items, total };
}

/**
 * Did this user already look at this secret a moment ago? Opening the edit form reveals the value
 * too, so a few clicks used to leave a run of identical rows a second apart — one look told seven
 * times (user, 2026-08-03). One row per look is the useful record.
 */
export function recentReveal(secretId: string, byUserId: string, since: Date) {
  return prisma.secretAuditLog
    .findFirst({
      where: { secretId, byUserId, action: "revealed", createdAt: { gte: since } },
      select: { id: true },
    })
    .then(Boolean);
}
