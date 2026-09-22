import type { User } from "../../generated/prisma/client.js";
import type { AccessMap, GateKey } from "@shared/access.js";
import { accessMapFor, ModuleClosedError } from "../../core/access.js";

/**
 * **Who may see what in the library** (files.md §4.3, §11.3).
 *
 * Every route declares one gate, statically; an item's place is not static. So a few reads and
 * moves cross gates in one request, and they are this module's named exception to "services never
 * consult a gate" (`core/access.ts`, beside the calendar's overlay):
 * - the tree's totals, and "All files" at its top: Files, plus Clients and Tasks for their parts;
 * - search, the same way: Files, plus Clients and Tasks for what sits behind them (§13);
 * - Company's Attachments, files on the firm's internal tasks: Files and Tasks;
 * - a move from My files or Company into a client: Files and Clients;
 * - an admin's move out of a client into Company or My files: Clients and Files;
 * - **keeping a file sent in a chat** (`copyIntoLibrary`, chat.md §6.5): the route is the CHAT's,
 *   so this module's gate is checked here and nowhere else — the route inventory and the access
 *   matrix see only `gate("chat")` and cannot know about it.
 *
 * The caller's map is read the way the activity reader reads it, once per request.
 */

export interface Reader {
  id: string;
  role: User["role"];
  access: AccessMap;
}

export async function readerOf(user: Pick<User, "id" | "role">): Promise<Reader> {
  return { id: user.id, role: user.role, access: await accessMapFor(user) };
}

/** The reader can see what sits behind this gate. */
export function opens(reader: Reader, gate: GateKey): boolean {
  return reader.access[gate] !== "closed";
}

/** A read the other gate must allow, refused the way the hook refuses one. */
export function requireReadable(reader: Reader, gate: GateKey) {
  if (reader.access[gate] === "closed") throw new ModuleClosedError(gate, false);
}

/** A write the other gate must allow. */
export function requireOpen(reader: Reader, gate: GateKey) {
  const state = reader.access[gate];
  if (state !== "open") throw new ModuleClosedError(gate, state === "read_only");
}
