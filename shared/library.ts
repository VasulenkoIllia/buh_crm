/**
 * **The library's fixed words and rules, shared by the server and the browser** (files.md §4,
 * §6, §14.3).
 *
 * NO IMPORTS: the browser loads this, and a value taken out of a schema module would drag the zod
 * runtime into the bundle along with it (docs/architecture.md §5).
 */

export const FILE_ZONES = ["internal", "shared", "from_client"] as const;
export type FileZone = (typeof FILE_ZONES)[number];

export const ZONE_LABEL: Record<FileZone, string> = {
  internal: "Internal",
  shared: "Shared with client",
  from_client: "From client",
};

/** What each zone is, in one line, for the screen. */
export const ZONE_NOTE: Record<FileZone, string> = {
  internal: "The client never sees these.",
  shared: "The client will see these once the portal opens.",
  from_client: "What the client sent; once the portal opens, what they upload.",
};

/** The two zones a client will see once the portal opens (§4.2). */
export const CLIENT_VISIBLE_ZONES: readonly FileZone[] = ["shared", "from_client"];

/** A file is encrypted and decrypted whole, in memory, so 25 MB a file (decision 15). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A text file made in the CRM is small on purpose: this is hundreds of pages (files.md §7.4). */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** Folder levels below a fixed level (§6.1). */
export const MAX_FOLDER_DEPTH = 8;

/**
 * **Programs and scripts are refused on upload** (§14.3). A denylist, not an allowlist: a tax
 * firm receives QuickBooks files, bank exports, saved emails and archives. The server reads the
 * extension in stage B and the detected type from stage C; the browser reads the same list to say
 * so before sending anything.
 */
export const REFUSED_EXTENSIONS: readonly string[] = [
  "exe",
  "msi",
  "bat",
  "cmd",
  "com",
  "scr",
  "ps1",
  "vbs",
  "js",
  "jar",
  "sh",
  "app",
  "dmg",
  "pkg",
];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isRefusedFile(name: string): boolean {
  return REFUSED_EXTENSIONS.includes(extensionOf(name));
}
