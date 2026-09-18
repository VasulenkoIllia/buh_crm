import { useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatPresence } from "@shared/schema/chat";
import { ME_QUERY_KEY } from "@/app/auth";
import { api } from "@/shared/lib/api";
import { CHAT_KEY, CHAT_PRESENCE_KEY } from "@/shared/lib/query-keys";
import { realtime, type RealtimeSnapshot } from "@/shared/lib/realtime";

/**
 * **Holds the live connection open while the calling screen is on the page**, and does what an
 * event means for the page's cache (chat.md §7). The connection itself is
 * `src/shared/lib/realtime.ts`; this is the part that knows about queries.
 *
 * - `resync`: the server may have missed events, so everything under the chat's key is refetched.
 * - `chat_updated`: a chat's name, people or roles changed; the same, for now (the chat screen
 *   narrows it to that chat).
 * - a stop other than "too many tabs": who the person is, and what they may open, may have changed
 *   (signed out, a gate closed, the two-factor rule), so the app shell asks again.
 * - `presence`: the list of who is online is patched in place, with no request.
 */
export function useRealtime(): RealtimeSnapshot {
  const queryClient = useQueryClient();
  const connection = realtime();
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot);

  useEffect(() => {
    const release = connection.retain();
    const offs = [
      connection.on("resync", () => void queryClient.invalidateQueries({ queryKey: CHAT_KEY })),
      // a chat's name, people or roles moved: the list and that chat are fetched again
      connection.on(
        "chat_updated",
        () => void queryClient.invalidateQueries({ queryKey: CHAT_KEY }),
      ),
      connection.on("presence", ({ userId, online }) =>
        queryClient.setQueryData<ChatPresence>(CHAT_PRESENCE_KEY, (list) => {
          if (!list) return list;
          const others = list.online.filter((id) => id !== userId);
          return { online: online ? [...others, userId] : others };
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
      release();
    };
  }, [connection, queryClient]);

  const { status, stopReason } = snapshot;
  useEffect(() => {
    if (status === "stopped" && stopReason !== "too_many_streams") {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    }
  }, [status, stopReason, queryClient]);

  return snapshot;
}

/** Opens the connection again after it stopped, when the person asks. */
export function reconnectRealtime() {
  realtime().reconnect();
}

/** Who has a CRM tab open now; `useRealtime` keeps it current while the connection is held. */
export function useChatPresence(enabled = true) {
  return useQuery({
    queryKey: CHAT_PRESENCE_KEY,
    queryFn: () => api<ChatPresence>("/api/chat/presence"),
    enabled,
  });
}
