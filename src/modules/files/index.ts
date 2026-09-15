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
