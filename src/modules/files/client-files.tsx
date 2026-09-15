import { useMemo } from "react";
import { Library } from "./library";
import type { LibraryMode } from "./library-context";

/**
 * **A client card's Files tab** (files.md §18): the same browser as the Files screen, framed to
 * this one client. It stands on the Clients gate alone, so somebody whose Files is closed still
 * has the client's documents; moving them anywhere else is the Files screen's.
 */
export function ClientFilesBrowser({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const mode = useMemo<LibraryMode>(
    () => ({ kind: "client", clientId, clientName }),
    [clientId, clientName],
  );
  return <Library mode={mode} />;
}
