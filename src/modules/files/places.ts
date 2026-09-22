import type { PlaceInput } from "@shared/schema/files";
import { CLIENT_VISIBLE_ZONES, ZONE_LABEL, type FileZone } from "@shared/library";

/**
 * **A place in the library, as the screen thinks of it** (files.md §4): the reader's own My files,
 * Company, or one of a client's three zones. Each maps onto its routes; what may be done there is
 * the server's to decide, and these helpers only spell the paths.
 */
export type UiPlace =
  { kind: "my" } | { kind: "company" } | { kind: "client"; clientId: string; zone: FileZone };

/** What the right-hand pane shows. */
export type View =
  /** `focus`: the row to mark once it is open (`file:<id>` or `folder:<id>`), from a search */
  | { type: "place"; place: UiPlace; folderId: string | null; focus?: string }
  /** every client, one row each */
  | { type: "clients" }
  /** one client: its three zones and its Attachments */
  | { type: "client"; clientId: string }
  /** a client's task files, or Company's (the firm's internal tasks) when `clientId` is null */
  | { type: "attachments"; clientId: string | null }
  /**
   * Files sent in chats (chat.md §6.5), which have no place in the library at all: the reader's
   * own chats, largest first, and one chat's files when it is opened. It is a view on somebody
   * else's records, as Attachments is on a task's — nothing here is a `UiPlace`, and nothing in
   * it can be moved, renamed or filed.
   */
  | { type: "chats" }
  | { type: "chat"; chatId: string }
  | { type: "trash" }
  /** what the search box finds, the Files screen's alone (§13) */
  | { type: "search" };

export const MY: UiPlace = { kind: "my" };
export const COMPANY: UiPlace = { kind: "company" };

export function placeKey(p: UiPlace): string {
  return p.kind === "client" ? `client:${p.clientId}:${p.zone}` : p.kind;
}

/** Where a place's lists, folders and uploads live. */
export function placeBase(p: UiPlace): string {
  return p.kind === "client"
    ? `/api/files/clients/${p.clientId}/zones/${p.zone}`
    : `/api/files/${p.kind}`;
}

/** Where rename, move and delete live: a client's are client-wide, whatever the zone. */
export function areaBase(p: UiPlace): string {
  return p.kind === "client" ? `/api/files/clients/${p.clientId}` : `/api/files/${p.kind}`;
}

export function placeInput(p: UiPlace): PlaceInput {
  if (p.kind === "my") return { space: "personal" };
  if (p.kind === "company") return { space: "company" };
  return { space: "client", clientId: p.clientId, zone: p.zone };
}

/** Where a text file's text is saved again (files.md §7.4): the area's route, as a rename is. */
export function textUrl(p: UiPlace, fileId: string): string {
  return `${areaBase(p)}/files/${fileId}/text`;
}

/** A client's file downloads through the client card's own route, on the Clients gate. */
export function downloadUrl(p: UiPlace, fileId: string): string {
  return p.kind === "client"
    ? `/api/clients/${p.clientId}/files/${fileId}`
    : `/api/files/${p.kind}/files/${fileId}`;
}

/** The same file, opened in the CRM (files.md §12): its view route, beside its download. */
export function viewUrl(p: UiPlace, fileId: string): string {
  return `${downloadUrl(p, fileId)}/view`;
}

export function placeLabel(p: UiPlace, clientName?: string): string {
  if (p.kind === "my") return "My files";
  if (p.kind === "company") return "Company";
  return clientName ? `${clientName} › ${ZONE_LABEL[p.zone]}` : ZONE_LABEL[p.zone];
}

/** Putting a file here is showing it to the client, once the portal opens (§4.2). */
export function clientSees(p: UiPlace): boolean {
  return p.kind === "client" && CLIENT_VISIBLE_ZONES.includes(p.zone);
}

export function samePlace(a: UiPlace, b: UiPlace): boolean {
  return placeKey(a) === placeKey(b);
}

export function sameClient(a: UiPlace, b: UiPlace): boolean {
  return a.kind === "client" && b.kind === "client" && a.clientId === b.clientId;
}

export function sameView(a: View, b: View): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "place" && b.type === "place") {
    return samePlace(a.place, b.place) && a.folderId === b.folderId;
  }
  if (a.type === "client" && b.type === "client") return a.clientId === b.clientId;
  if (a.type === "attachments" && b.type === "attachments") return a.clientId === b.clientId;
  if (a.type === "chat" && b.type === "chat") return a.chatId === b.chatId;
  return true;
}
