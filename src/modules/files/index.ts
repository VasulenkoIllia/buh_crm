import { lazy } from "react";

/**
 * The files module's cross-module surface. Both are big and rendered on demand, so both are
 * published already lazy: the client card and the task form are opened far more often than their
 * Files tab or their File to folder dialog, and the browser brings dnd-kit with it.
 *
 * Callers render them inside a <Suspense>.
 */
export const ClientFilesBrowser = lazy(() =>
  import("./client-files").then((m) => ({ default: m.ClientFilesBrowser })),
);
export const FileToFolderDialog = lazy(() =>
  import("./dialogs").then((m) => ({ default: m.FileToFolderDialog })),
);
/** Keeping a file that arrived in a chat (chat.md §6.5): the chat's panel opens this one. */
export const KeepChatFileDialog = lazy(() =>
  import("./dialogs").then((m) => ({ default: m.KeepChatFileDialog })),
);
/** The viewer (files.md §12), for the task card's own list: opened far less often than the card. */
export const FileViewer = lazy(() => import("./viewer").then((m) => ({ default: m.Viewer })));
export type { Viewable } from "./viewer";
