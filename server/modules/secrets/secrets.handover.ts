import type { Prisma } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import * as repo from "./secrets.repository.js";

/**
 * **A leaver's My secrets** (secrets.md §8). Blocking moves them into Company inside the status
 * change's own transaction, which the users module opens and hands in, and records the move after
 * that transaction, the way a leaver's My files are handed over (files.md §8.3).
 */

export type PersonalSecretsMove = NonNullable<
  Awaited<ReturnType<typeof repo.movePersonalIntoCompany>>
>;

/** The Block dialog's figure: how many secrets would move, the Trash's included. Never a title. */
export function personalSecretsCount(userId: string): Promise<number> {
  return repo.personalCount(userId);
}

/** The badge each moved secret carries in Company, and the filter that finds them there. */
export const movedFromName = (person: string) => `${person} (personal)`;

/** Blocking calls this inside its transaction, once the status has really changed. */
export function movePersonalSecrets(
  tx: Prisma.TransactionClient,
  person: { id: string; name: string },
) {
  return repo.movePersonalIntoCompany(tx, person.id, movedFromName(person.name));
}

/**
 * After the transaction: one journal row per secret, so each one's History says how it came to be
 * in Company and who did it, and one `secret.personal_moved` for the act, with the figures and no
 * title. The titles were a person's private list until a moment ago.
 */
export async function recordPersonalSecretsMove(
  moved: PersonalSecretsMove,
  person: string,
  actorId: string,
) {
  await repo.writeAudits(
    moved.map((row) => ({
      secretId: row.id,
      clientId: null,
      byUserId: actorId,
      action: "moved" as const,
      label: row.label,
      ip: null,
    })),
  );
  const trashed = moved.filter((row) => row.deletedAt !== null).length;
  record("secret.personal_moved", {
    subjectLabel: movedFromName(person),
    changes: {
      secrets: moved.length - trashed,
      trashed,
      from: `${person}'s My secrets`,
      to: "Company",
    },
  });
}
