import { useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatPresence } from "@shared/schema/chat";
import { ME_QUERY_KEY } from "@/app/auth";
import { api } from "@/shared/lib/api";
import { CHAT_KEY, CHAT_LIST_KEY, CHAT_PRESENCE_KEY } from "@/shared/lib/query-keys";
import { realtime, type RealtimeSnapshot } from "@/shared/lib/realtime";

/**
 * **Holds the live connection open while the calling screen is on the page**, and does what an
 * event means for the page's cache (chat.md §7). The connection itself is
 * `src/shared/lib/realtime.ts`; this is the part that knows about queries.
 *
 * - `chat_message`, `chat_message_changed`, `chat_read`: the CHAT LIST is fetched again, wherever
 *   the reader is in the CRM. This hook is held by the shell, so it is the only listener a person
 *   reading Tasks has: without it the unread badge, the chime and the tab's title waited for the
 *   next window focus, and the whole point of `chat-watch.tsx` was lost (audit, 2026-09-20). The
 *   open conversation is `useChatLive`'s business, which is why only the list is named here.
 * - `resync`: the server may have missed events, so the chat's data is fetched again — everything
 *   except the MESSAGES, which the open conversation catches up from the place it holds. Dragging
 *   ten loaded pages down with it is exactly what `catchUp` exists to avoid.
 * - `chat_updated`: a chat's name or people changed; the same.
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
    /** Everything the chat holds but the conversations themselves (see the note above). */
    const refetchChatData = () =>
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === CHAT_KEY[0] && query.queryKey[1] !== "messages",
      });
    const refetchList = () => void queryClient.invalidateQueries({ queryKey: CHAT_LIST_KEY });
    const offs = [
      connection.on("resync", refetchChatData),
      // a chat's name or people moved: the list and that chat are fetched again
      connection.on("chat_updated", refetchChatData),
      // wherever the reader is in the CRM, a new or changed message moves their chat list
      connection.on("chat_message", refetchList),
      connection.on("chat_message_changed", refetchList),
      // their own reading in another tab: the badge goes down here too
      connection.on("chat_read", refetchList),
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
export function useChatPresence() {
  return useQuery({
    queryKey: CHAT_PRESENCE_KEY,
    queryFn: () => api<ChatPresence>("/api/chat/presence"),
  });
}
