import type { PersonalFilesSummary } from "@shared/schema/files.js";
import { ZONE_LABEL } from "@shared/library.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import * as names from "./files.names.js";
import * as repo from "./files.repository.js";
import { asNameConflict } from "./files.service.js";

/**
 * **The two moves the system makes on its own** (files.md §8.3, §5.6): a blocked person's My files
 * into Company, and a converted lead's task files into its new client's Internal. Each runs inside
 * the transaction of the act that causes it (the block, the conversion), which the owning module
 * opens and hands in; each is recorded after that transaction, by its own function here.
 */

type Tx = Prisma.TransactionClient;

export type PersonalMove = NonNullable<
  Awaited<ReturnType<typeof repo.movePersonalIntoCompany>>
>;
export type FiledFile = { id: string; name: string; task: string };

/** The Block dialog's figures: the one read about somebody else's My files, and never a name. */
export function personalFilesSummary(userId: string): Promise<PersonalFilesSummary> {
  return repo.personalSummary(userId);
}

/**
 * Blocking calls this inside its transaction, once the status has really changed. A folder of the
 * same name made at the same moment fails the whole block; it comes back as a conflict the dialog
 * shows, and the admin presses Block again (§8.3).
 */
export async function movePersonalIntoCompany(
  tx: Tx,
  person: { id: string; name: string },
  actorId: string,
) {
  const base = names.personalFolderName(person.name);
  try {
    return await repo.movePersonalIntoCompany(
      tx,
      person.id,
      (taken) => names.firstFreeFolderName(base, taken),
      actorId,
    );
  } catch (error) {
    throw asNameConflict(
      error,
      "A Company folder with that name was made at the same moment; press Block again",
    );
  }
}

/**
 * One row for the whole move, beside `user.blocked`. Nobody is told: the admin who blocked saw the
 * figures in the dialog (§17). The rows written while the files were personal keep their neutral
 * labels; what happens to them in Company is logged by name from now on.
 */
export function recordPersonalMove(move: PersonalMove, person: string) {
  record("firm_folder.personal_moved", {
    subjectId: move.folderId,
    subjectLabel: move.folderName,
    changes: {
      files: move.files,
      size: move.bytes,
      trashed: move.trashed,
      from: `${person}'s My files`,
      to: `Company › ${move.folderName}`,
    },
  });
}

/** Converting a lead calls this inside its transaction, once the client exists (§5.6). */
export function fileLeadFiles(tx: Tx, leadId: string, clientId: string): Promise<FiledFile[]> {
  return repo.fileLeadTaskFiles(tx, leadId, clientId, (name, taken) =>
    names.firstFreeName(name, taken),
  );
}

/**
 * **A new file on a converted lead's task goes where the lead's files went**: the client's Internal
 * root, under a free name. The one place a file gains a client its task does not name, and it is
 * the system placing it, not a caller (§5.6).
 */
export async function placeForConvertedLead(clientId: string, name: string) {
  const scope = `client:${clientId}:internal`;
  return { scope, name: names.firstFreeName(name, await repo.takenFileNames(scope, null)) };
}

/**
 * `file.filed`, one row per file, with the person who converted (or uploaded) as the actor. The
 * row's own `clientId` renders as the client's name, so `to` names only the zone.
 */
export function recordFiled(clientId: string, filed: FiledFile[]) {
  for (const f of filed) {
    record("file.filed", {
      subjectId: f.id,
      subjectLabel: f.name,
      clientId,
      changes: { to: ZONE_LABEL.internal, task: f.task },
    });
  }
}
