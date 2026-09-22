import { readStoredFile, type FileBytes, type FileStorage } from "../../core/files.js";
import { failureOf, type Failure } from "../../core/storage-check.js";
import * as repo from "./files.repository.js";

/**
 * **Where every file is, and whether it belongs there** (files.md §15.3): the check run before and
 * after a deploy that moves files, and whenever somebody wants to know. It reads the rows and, when
 * asked, every file's bytes. It changes nothing and records nothing, and it names files by id alone,
 * since what it prints ends up pasted into chats.
 */

export interface FilesReport {
  files: number;
  bytes: number;
  onDisk: number;
  inBucket: number;
  beforeEncryption: number;
  trashed: number;
  withArchivedClients: number;
  /** where the live files belong, each with how many */
  places: { label: string; count: number }[];
  /** a file where it cannot be right: each one must be looked at */
  problems: { what: string; ids: string[] }[];
  /** a file that may well be right, and is worth a look */
  notes: { what: string; ids: string[] }[];
}

/** Where a live file can belong, in the order they are printed. */
const PLACES = [
  "Client documents, in their client's zones",
  "Client task files, in the client's Attachments",
  "Client task files, filed into the client's zones",
  "Converted leads' task files, with their client",
  "Lead task files, on the lead's task",
  "Internal task files, in Company's Attachments",
  "Internal task files, filed into Company",
  "Company",
  "My files, everyone's together",
  "Logos and avatars, outside the library",
  "Attached to secrets, in the vault",
  "Sent in a chat",
] as const;
type PlaceLabel = (typeof PLACES)[number];

type Verdict = { place: PlaceLabel } | { problem: string } | { note: string };

const clientIn = (scope: string | null) =>
  scope?.startsWith("client:") ? (scope.split(":")[1] ?? null) : null;

/** Where one live file belongs, or what is wrong with it. */
function judge(f: repo.FileForCheck): Verdict {
  const inClient = clientIn(f.scope);
  if (inClient && inClient !== f.clientId) {
    return { problem: "in one client's zone while carrying another client" };
  }
  if (f.folder?.deletedAt) return { problem: "live inside a folder that is in the Trash" };
  // a CHECK keeps a secret's file out of everything else, so this only names where it is
  if (f.secretId) return { place: "Attached to secrets, in the vault" };
  // and the same CHECK for a chat's (File_chat_stands_alone). Without this branch every file ever
  // sent in a chat fell through to "belongs to nothing" at the bottom, which would have turned a
  // report meant to be empty into a list of thousands the first year (owner's question, 2026-09-22)
  if (f.chatId) return { place: "Sent in a chat" };
  if (f.avatarOfUser || f.logoOfProfile || f.mailLogoOfProfile) {
    return f.scope
      ? { problem: "a logo or an avatar inside the library" }
      : { place: "Logos and avatars, outside the library" };
  }

  const task = f.task;
  if (task?.clientId) {
    if (f.clientId !== task.clientId)
      return { problem: "on a client's task without that client" };
    return inClient
      ? { place: "Client task files, filed into the client's zones" }
      : { place: "Client task files, in the client's Attachments" };
  }
  if (task?.leadId) {
    const client = task.lead?.convertedClientId ?? null;
    if (!client) {
      return f.scope || f.clientId
        ? { problem: "on a lead's task while placed with a client" }
        : { place: "Lead task files, on the lead's task" };
    }
    if (inClient === client) return { place: "Converted leads' task files, with their client" };
    return f.scope
      ? { problem: "a converted lead's file placed with another client" }
      : {
          note: "a converted lead's file only on its task (right if its client was archived then)",
        };
  }
  if (task) {
    if (f.clientId) return { problem: "on an internal task while carrying a client" };
    if (f.scope === "company") return { place: "Internal task files, filed into Company" };
    return f.scope
      ? { problem: "on an internal task while placed outside Company" }
      : { place: "Internal task files, in Company's Attachments" };
  }

  if (f.clientId) {
    return inClient
      ? { place: "Client documents, in their client's zones" }
      : { problem: "a client's document outside the library" };
  }
  if (f.scope === "company") return { place: "Company" };
  if (f.scope?.startsWith("personal:")) {
    return f.owner?.status === "blocked"
      ? {
          problem: "in the My files of somebody blocked, where the move into Company missed it",
        }
      : { place: "My files, everyone's together" };
  }
  return { note: "belongs to nothing: no client, no task, no place, not a logo" };
}

export async function filesReport(): Promise<FilesReport> {
  const rows = await repo.everyFileForCheck();
  const places = new Map<PlaceLabel, number>();
  const problems = new Map<string, string[]>();
  const notes = new Map<string, string[]>();
  const flag = (into: Map<string, string[]>, what: string, id: string) => {
    const ids = into.get(what);
    if (ids) ids.push(id);
    else into.set(what, [id]);
  };
  let trashed = 0;
  let withArchivedClients = 0;
  for (const f of rows) {
    // a trashed file's place is where it will come back to; the Trash itself has its own rules
    if (f.deletedAt) {
      trashed++;
      continue;
    }
    if (f.client?.archivedAt) withArchivedClients++;
    const verdict = judge(f);
    if ("place" in verdict) places.set(verdict.place, (places.get(verdict.place) ?? 0) + 1);
    else if ("problem" in verdict) flag(problems, verdict.problem, f.id);
    else flag(notes, verdict.note, f.id);
  }
  const listed = (m: Map<string, string[]>) =>
    [...m.entries()].map(([what, ids]) => ({ what, ids }));
  return {
    files: rows.length,
    bytes: rows.reduce((sum, f) => sum + f.size, 0),
    onDisk: rows.filter((f) => f.storage === "local").length,
    inBucket: rows.filter((f) => f.storage === "s3").length,
    beforeEncryption: rows.filter((f) => f.wrappedKey === null).length,
    trashed,
    withArchivedClients,
    places: PLACES.flatMap((label) => {
      const count = places.get(label);
      return count ? [{ label, count }] : [];
    }),
    problems: listed(problems),
    notes: listed(notes),
  };
}

export interface BytesCheck {
  opened: number;
  failed: { id: string; storage: FileStorage; why: Failure }[];
}

/**
 * Every stored file read back, opened and measured against its row, trashed ones included since
 * their bytes are still kept: the nightly storage check (core/storage-check.ts) over all of them
 * rather than five.
 */
export async function checkFileBytes(
  read: (file: FileBytes) => Promise<Buffer> = readStoredFile,
): Promise<BytesCheck> {
  const result: BytesCheck = { opened: 0, failed: [] };
  for (const f of await repo.everyFileForCheck()) {
    try {
      const bytes = await read(f);
      if (bytes.length === f.size) result.opened++;
      else result.failed.push({ id: f.id, storage: f.storage, why: "damaged" });
    } catch (error) {
      result.failed.push({ id: f.id, storage: f.storage, why: failureOf(error) });
    }
  }
  return result;
}
