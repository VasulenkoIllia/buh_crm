import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/**
 * **A screen that was open when its area was closed must say so, and correct itself.**
 *
 * The session payload has a five-minute `staleTime`, so somebody closed out mid-session keeps the
 * sidebar item and can still click into the screen. The server refuses behind it — which makes the
 * screen dead rather than dangerous — but "Failed to load" is the wrong sentence for it, and the
 * sidebar goes on lying for up to five minutes.
 *
 * So the app watches for the one error code that means exactly this and refetches the session. The
 * sidebar item disappears, `RequireGate` moves them to the dashboard, and the next thing they see
 * is a true screen rather than a broken one. `module_closed` exists as its own code for this: it
 * has to be distinguishable from the Origin-check 403 and from an ownership refusal, neither of
 * which says anything about what this person may open.
 */
export function isModuleClosed(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "module_closed";
}

export function closedGateOf(error: unknown): string | null {
  if (!isModuleClosed(error)) return null;
  const details = error.details as { gate?: string } | undefined;
  return details?.gate ?? null;
}

export function useModuleClosedWatch(onClosed: () => void) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (isModuleClosed(event.query.state.error)) onClosed();
    });
  }, [queryClient, onClosed]);
}
