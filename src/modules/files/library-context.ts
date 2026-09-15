import { createContext, useContext } from "react";
import type { FileRow, FolderRow } from "@shared/schema/files";
import type { UiPlace, View } from "./places";

/**
 * **One library, two frames** (files.md §18). The Files screen shows every place the reader may
 * open; a client card shows that client's three zones and its Attachments, and nothing else. The
 * tree, the panes and the dialogs read which frame they are in, and what they may do, from here.
 */
export type LibraryMode =
  { kind: "firm" } | { kind: "client"; clientId: string; clientName: string };

/** A selection from one folder: what a move, a delete or a drag carries (§7.3). */
export interface Picked {
  place: UiPlace;
  /** the folder the items sit in; null at the place's root */
  parentId: string | null;
  folders: FolderRow[];
  files: FileRow[];
}

/** Somewhere things can be moved, dropped or uploaded to. */
export interface Target {
  place: UiPlace;
  folderId: string | null;
  /** in words, for the toast and the dialog */
  label: string;
}

export interface LibraryApi {
  mode: LibraryMode;
  view: View;
  go: (view: View) => void;
  isOpen: (nodeKey: string) => boolean;
  toggle: (nodeKey: string) => void;
  /** opens these tree nodes; a no-op when they are open already, so it is safe in an effect */
  expand: (nodeKeys: string[]) => void;
  admin: boolean;
  clientsOpen: boolean;
  /** what the screen offers; the server decides either way */
  canWrite: (place: UiPlace) => boolean;
  client: (clientId: string) => { label: string; code: number | null };
  creating: boolean;
  setCreating: (on: boolean) => void;
  /** a dialog is open, so the pane's own keys (Delete, Escape) stand down */
  busy: boolean;
  /** goes up after every move and delete, and a pane lets go of its selection */
  epoch: number;
  upload: (files: File[], target: Target) => void;
  askMove: (picked: Picked) => void;
  askDelete: (picked: Picked) => void;
  askFile: (file: { id: string; name: string }, clientId: string | null) => void;
  runMove: (picked: Picked, target: Target, url: string) => Promise<boolean>;
  movePending: boolean;
  /** folders a drag may not land in: the ones being dragged and everything under them */
  noDrop: ReadonlySet<string>;
}

export const LibraryContext = createContext<LibraryApi | null>(null);

export function useLibrary(): LibraryApi {
  const api = useContext(LibraryContext);
  if (!api) throw new Error("useLibrary() outside <Library>");
  return api;
}

/** What a selection comes to: the figures a delete asks about and a move warns with. */
export function pickedFacts(p: Picked) {
  const inFolders = p.folders.reduce((sum, f) => sum + f.totals.files, 0);
  return {
    items: p.folders.length + p.files.length,
    files: p.files.length + inFolders,
    inFolders,
    bytes:
      p.files.reduce((sum, f) => sum + f.size, 0) +
      p.folders.reduce((sum, f) => sum + f.totals.bytes, 0),
    /** the files in view only: what sits inside a folder is the server's to count */
    onTasks: p.files.filter((f) => f.task).length,
  };
}

/** Tree node keys: a place's own key (`placeKey`), `clients`, `c:<clientId>`, `f:<folderId>`. */
export const clientNodeKey = (clientId: string) => `c:${clientId}`;
export const folderNodeKey = (folderId: string) => `f:${folderId}`;
