import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ChatDetail,
  ChatFilesOverview,
  ChatFilesPage,
  ChatMessage,
  ChatSearchPage,
  ChatSearchQuery,
  ChatMessagePage,
  ChatPeople,
  ChatSettingsInput,
  ChatSummary,
  CreateGroupInput,
  ReadBy,
  SendMessageInput,
  UpdateGroupInput,
} from "@shared/schema/chat";
import type { FileRow, PlaceInput } from "@shared/schema/files";
import { api } from "@/shared/lib/api";
import { FILES_KEY } from "@/shared/lib/query-keys";
import { CHAT_KEY, CHAT_LIST_KEY } from "@/shared/lib/query-keys";
import { realtime } from "@/shared/lib/realtime";

/**
 * **The chat's data, and how a live event changes it** (chat.md §7).
 *
 * The rule the transport decision rests on: an event names what changed, and the tab fetches it
 * through the ordinary routes. So nothing here trusts an event's contents beyond a chat id and a
 * place, and a tab that missed events while its connection was away asks for "everything after the
 * place I hold" rather than reloading a conversation.
 */

export const chatKeys = {
  chats: CHAT_LIST_KEY,
  chat: (id: string) => [...CHAT_KEY, "chats", id] as const,
  messages: (id: string) => [...CHAT_KEY, "messages", id] as const,
  pins: (id: string) => [...CHAT_KEY, "pins", id] as const,
  files: (id: string) => [...CHAT_KEY, "files", id] as const,
  search: [...CHAT_KEY, "search"] as const,
  people: [...CHAT_KEY, "people"] as const,
};

export function useChats() {
  return useQuery({
    queryKey: chatKeys.chats,
    queryFn: () => api<ChatSummary[]>("/api/chat/chats"),
  });
}

export function useChat(chatId: string | null) {
  return useQuery({
    queryKey: chatKeys.chat(chatId ?? "none"),
    queryFn: () => api<ChatDetail>(`/api/chat/chats/${chatId!}`),
    enabled: chatId !== null,
  });
}

export function useChatPeople() {
  return useQuery({
    queryKey: chatKeys.people,
    queryFn: () => api<ChatPeople>("/api/chat/people"),
  });
}

/**
 * **The search** (§8): the box above the chat list asks with no `chatId`, the one inside a chat
 * asks with it. Kept for a minute, so going back to a result that was just open costs nothing.
 */
export function useChatSearch(query: ChatSearchQuery, enabled: boolean) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return useQuery({
    queryKey: [...chatKeys.search, search],
    queryFn: () => api<ChatSearchPage>(`/api/chat/search?${search}`),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * **A chat's Files tab** (§6.4): what it still carries, filtered by a word in the name and by who
 * sent it. Asked for only while the tab is open, and refetched when a message arrives or goes.
 */
/**
 * **What every chat is holding** (§6.5), for the Chats pane on the Files screen. Asked for by a
 * screen that is not the chat's, which is why it comes through the barrel — but the answer is the
 * chat's own: only chats the reader is in, and it is the server that decides that.
 */
export function useChatFilesOverview(enabled = true) {
  return useQuery({
    queryKey: [...chatKeys.files("overview")],
    queryFn: () => api<ChatFilesOverview>("/api/chat/files/overview"),
    enabled,
  });
}

/**
 * **Keeping a chat's file in the library** (§6.5). It creates a file somewhere else entirely, so it
 * clears the FILES caches, not the chat's — nothing about the chat changes.
 */
export function useKeepChatFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileId: string; to: PlaceInput; folderId?: string }) =>
      api<FileRow>(`/api/chat/files/${input.fileId}/keep`, {
        method: "POST",
        body: { to: input.to, ...(input.folderId ? { folderId: input.folderId } : {}) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FILES_KEY }),
  });
}

export function useChatFiles(
  chatId: string | null,
  query: { q?: string; senderId?: string },
  enabled: boolean,
) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.senderId) params.set("senderId", query.senderId);
  const search = params.toString();
  return useQuery({
    queryKey: [...chatKeys.files(chatId ?? "none"), search],
    queryFn: () =>
      api<ChatFilesPage>(`/api/chat/chats/${chatId!}/files${search ? `?${search}` : ""}`),
    enabled: enabled && chatId !== null,
  });
}

/**
 * The conversation, newest page first and older pages above it (§7.2). Pages are kept newest-first
 * in the cache, so appending what just arrived touches one page.
 */
export function useMessages(chatId: string | null) {
  return useInfiniteQuery({
    queryKey: chatKeys.messages(chatId ?? "none"),
    enabled: chatId !== null,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<ChatMessagePage>(
        `/api/chat/chats/${chatId!}/messages${pageParam ? `?before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => (last.more ? last.messages[0]?.seq : undefined),
    // one page for the screen, and everything the tab holds in chat order
    select: (data) => ({
      messages: [...data.pages].reverse().flatMap((p) => p.messages),
      people: new Map(data.pages.flatMap((p) => p.people).map((p) => [p.id, p])),
      more: data.pages.at(-1)?.more ?? false,
    }),
  });
}

function highestSeq(client: QueryClient, chatId: string): number {
  const data = client.getQueryData<{ pages: ChatMessagePage[] }>(chatKeys.messages(chatId));
  let top = 0;
  for (const page of data?.pages ?? []) {
    for (const message of page.messages) top = Math.max(top, message.seq);
  }
  return top;
}

/**
 * Puts messages into the pages the tab holds: one it already has is replaced where it stands, and a
 * NEWER one is added to the newest page, in order.
 *
 * Only a newer one. A reaction to a message far above the loaded window arrives as the same shape,
 * and appending it to the newest page would draw a months-old line as today's (review, 2026-09-20).
 * It is dropped instead, and read properly when the reader scrolls that far back.
 */
function merge(client: QueryClient, chatId: string, arriving: ChatMessage[]) {
  if (arriving.length === 0) return;
  const top = highestSeq(client, chatId);
  client.setQueryData<{ pages: ChatMessagePage[]; pageParams: unknown[] }>(
    chatKeys.messages(chatId),
    (old) => {
      if (!old) return old;
      const byId = new Map(arriving.map((m) => [m.id, m]));
      const pages = old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) => byId.get(m.id) ?? m),
      }));
      const held = new Set(pages.flatMap((p) => p.messages.map((m) => m.id)));
      const fresh = arriving
        .filter((m) => !held.has(m.id) && m.seq > top)
        .sort((a, b) => a.seq - b.seq);
      if (fresh.length > 0) {
        pages[0] = { ...pages[0], messages: [...pages[0].messages, ...fresh] };
      }
      return { ...old, pages };
    },
  );
}

/** What a tab missed: everything after the place it holds (the same route a reconnect uses). */
async function catchUp(client: QueryClient, chatId: string) {
  if (!client.getQueryData(chatKeys.messages(chatId))) return;
  const after = highestSeq(client, chatId);
  const page = await api<ChatMessagePage>(`/api/chat/chats/${chatId}/messages?after=${after}`);
  merge(client, chatId, page.messages);
  addPeople(client, chatId, page);
}

/** One message that changed where it stands: edited, deleted, reacted to, pinned, voted in. */
async function refetchAt(client: QueryClient, chatId: string, seq: number) {
  if (!client.getQueryData(chatKeys.messages(chatId))) return;
  const page = await api<ChatMessagePage>(
    `/api/chat/chats/${chatId}/messages?after=${seq - 1}&limit=1`,
  );
  merge(client, chatId, page.messages);
  addPeople(client, chatId, page);
}

/**
 * The people a fetch named, ADDED to the ones the page already knows. A catch-up names only the
 * authors of what it brought, so replacing the list left every older message's author as
 * "Somebody" with no avatar (review, 2026-09-20).
 */
function addPeople(client: QueryClient, chatId: string, page: ChatMessagePage) {
  if (page.people.length === 0) return;
  client.setQueryData<{ pages: ChatMessagePage[]; pageParams: unknown[] }>(
    chatKeys.messages(chatId),
    (old) => {
      if (!old) return old;
      const known = new Map(old.pages[0].people.map((p) => [p.id, p]));
      for (const person of page.people) known.set(person.id, person);
      return {
        ...old,
        pages: [{ ...old.pages[0], people: [...known.values()] }, ...old.pages.slice(1)],
      };
    },
  );
}

/**
 * **The open conversation, kept current from the live connection.** Everything else the chat shows
 * (the list's unread counts, a chat's people) is refetched by `useRealtime` in the shell.
 */
export function useChatLive(chatId: string | null) {
  const client = useQueryClient();
  const [typing, setTyping] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!chatId) return;
    const connection = realtime();
    const offs = [
      connection.on("chat_message", (e) => {
        void client.invalidateQueries({ queryKey: chatKeys.chats });
        if (e.chatId !== chatId) return;
        void catchUp(client, chatId);
        // a message may have brought files with it (§6.4), and is a word to be found (§8)
        void client.invalidateQueries({ queryKey: chatKeys.files(chatId) });
        void client.invalidateQueries({ queryKey: chatKeys.search });
      }),
      connection.on("chat_message_changed", (e) => {
        void client.invalidateQueries({ queryKey: chatKeys.chats });
        if (e.chatId !== chatId) return;
        void refetchAt(client, chatId, e.seq);
        // …and a delete or an edit may have taken both away
        void client.invalidateQueries({ queryKey: chatKeys.files(chatId) });
        void client.invalidateQueries({ queryKey: chatKeys.search });
        // a colleague's pin: the bar above the conversation is a query of its own, and it sat
        // empty until the reader switched chats (audit, 2026-09-20)
        void client.invalidateQueries({ queryKey: chatKeys.pins(chatId) });
      }),
      connection.on("chat_read", (e) => {
        if (e.chatId !== chatId) return;
        void client.invalidateQueries({ queryKey: chatKeys.chat(chatId) });
        void client.invalidateQueries({ queryKey: chatKeys.chats });
      }),
      connection.on("typing", (e) => {
        if (e.chatId !== chatId) return;
        setTyping((was) => ({ ...was, [e.userId]: Date.now() }));
      }),
      // the connection came back and may have missed something
      connection.on("resync", () => void catchUp(client, chatId)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [chatId, client]);

  /**
   * **"Olena is typing…" stands for five seconds after the last ping** (§5.4), and then goes by
   * itself. The old version filtered the list in a memo and re-rendered on a tick the memo did not
   * depend on, so the line stayed until somebody else typed (review, 2026-09-20). Now the tick
   * PRUNES the list, and it only runs while somebody is typing: a quiet chat re-renders for
   * nothing.
   */
  useEffect(() => {
    if (Object.keys(typing).length === 0) return;
    const id = window.setInterval(() => {
      setTyping((was) => {
        const fresh = Object.fromEntries(
          Object.entries(was).filter(([, at]) => Date.now() - at < 5_000),
        );
        return Object.keys(fresh).length === Object.keys(was).length ? was : fresh;
      });
    }, 1_000);
    return () => window.clearInterval(id);
  }, [typing]);
  const typingNow = useMemo(() => Object.keys(typing), [typing]);
  return { typing: typingNow };
}

// ── writing ────────────────────────────────────────────────────────────────────

export function useSendMessage(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMessageInput) =>
      api<ChatMessage>(`/api/chat/chats/${chatId}/messages`, { method: "POST", body: input }),
    onSuccess: (message) => {
      merge(client, chatId, [message]);
      void client.invalidateQueries({ queryKey: chatKeys.chats });
    },
  });
}

export function useEditMessage(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api<ChatMessage>(`/api/chat/messages/${id}`, { method: "PATCH", body: { text } }),
    onSuccess: (message) => merge(client, chatId, [message]),
  });
}

export function useDeleteMessage(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<ChatMessage>(`/api/chat/messages/${id}`, { method: "DELETE" }),
    onSuccess: (message) => {
      merge(client, chatId, [message]);
      void client.invalidateQueries({ queryKey: chatKeys.chats });
    },
  });
}

/** **Sending a message on** (§5.2): the same words, and the same files, into other chats. */
export function useForward() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { messageIds: string[]; toChatIds: string[] }) =>
      api<{ ok: true }>("/api/chat/forward", { method: "POST", body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.chats });
    },
  });
}

export function useReact(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, emoji }: { id: string; emoji: string }) =>
      api<ChatMessage>(`/api/chat/messages/${id}/reaction`, { method: "PUT", body: { emoji } }),
    onSuccess: (message) => merge(client, chatId, [message]),
  });
}

export function useOpenDirect() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<ChatSummary>("/api/chat/direct", { method: "POST", body: { userId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.chats }),
  });
}

export function useOpenSaved() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<ChatSummary>("/api/chat/saved", { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.chats }),
  });
}

/**
 * **The reader's marker, moved at most once every two seconds** (§5.4), and only forward. The
 * server clamps it to what the chat holds, so a stale number here is harmless.
 */
export function useMarkRead(chatId: string | null) {
  const client = useQueryClient();
  const pending = useRef<number>(0);
  const sent = useRef<number>(0);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const seq = pending.current;
    if (!chatId || seq <= sent.current) return;
    sent.current = seq;
    void api(`/api/chat/chats/${chatId}/read`, { method: "POST", body: { seq } }).then(() => {
      void client.invalidateQueries({ queryKey: chatKeys.chats });
      void client.invalidateQueries({ queryKey: chatKeys.chat(chatId) });
    });
  }, [chatId, client]);

  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => {
    pending.current = 0;
    sent.current = 0;
    return () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      // **and send what was waiting.** Clearing the timer alone lost a read taken within two
      // seconds of leaving the chat, so a glance at three unread left them unread (audit,
      // 2026-09-20). `flush` is read through a ref: this runs on the way out, with the chat id it
      // was set up with
      latest.current();
    };
  }, [chatId]);

  return useCallback(
    (seq: number) => {
      if (seq <= pending.current) return;
      pending.current = seq;
      if (timer.current === null) timer.current = window.setTimeout(flush, 2_000);
    },
    [flush],
  );
}

/** A typing ping, at most one every three seconds while somebody types (§5.4). */
export function useTyping(chatId: string | null) {
  const last = useRef(0);
  return useCallback(() => {
    if (!chatId) return;
    const now = Date.now();
    if (now - last.current < 3_000) return;
    last.current = now;
    void api(`/api/chat/chats/${chatId}/typing`, { method: "POST" }).catch(() => {
      // a chat one cannot write in says so when the message is sent; a ping stays quiet
    });
  }, [chatId]);
}

// ── a group, its people, and the reader's own settings (chat.md §4.3, §4.2) ────

/**
 * A group's words, people or roles changed. The conversation is NOT invalidated: an infinite query
 * refetches every page it holds, and the notice line the change wrote arrives through the stream
 * like any other message (review, 2026-09-20).
 */
function afterChatChange(client: QueryClient, chatId: string) {
  void client.invalidateQueries({ queryKey: chatKeys.chat(chatId) });
  void client.invalidateQueries({ queryKey: chatKeys.chats });
}

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupInput) =>
      api<ChatDetail>("/api/chat/groups", { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.chats }),
  });
}

export function useUpdateGroup(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGroupInput) =>
      api<ChatDetail>(`/api/chat/chats/${chatId}`, { method: "PATCH", body: input }),
    onSuccess: () => afterChatChange(client, chatId),
  });
}

export function useAddMembers(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userIds: string[]) =>
      api<ChatDetail>(`/api/chat/chats/${chatId}/members`, {
        method: "POST",
        body: { userIds },
      }),
    onSuccess: () => afterChatChange(client, chatId),
  });
}

export function useRemoveMember(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<ChatDetail>(`/api/chat/chats/${chatId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => afterChatChange(client, chatId),
  });
}

export function useLeaveChat(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/chat/chats/${chatId}/leave`, { method: "POST" }),
    onSuccess: () => {
      client.removeQueries({ queryKey: chatKeys.chat(chatId) });
      void client.invalidateQueries({ queryKey: chatKeys.chats });
    },
  });
}

export function useChatSettings(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatSettingsInput) =>
      api<ChatSummary>(`/api/chat/chats/${chatId}/settings`, { method: "PUT", body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.chats });
      void client.invalidateQueries({ queryKey: chatKeys.chat(chatId) });
    },
  });
}

/**
 * **What the chat list's own menu does** (§4.2): the same three routes as the panel, but taking the
 * chat as an argument, because the list acts on whichever row is under the pointer.
 *
 * "Delete for me" is hiding it AND moving the reader's marker to the end: the chat leaves their
 * list with nothing left unread in it, and comes back only when somebody writes again — which is
 * what a person means by deleting a conversation they are still in (owner, 2026-09-20).
 */
export function useChatListActions() {
  const client = useQueryClient();
  const refresh = (chatId: string) => {
    void client.invalidateQueries({ queryKey: chatKeys.chats });
    void client.invalidateQueries({ queryKey: chatKeys.chat(chatId) });
  };
  const settings = useMutation({
    mutationFn: ({ chatId, ...input }: ChatSettingsInput & { chatId: string }) =>
      api<ChatSummary>(`/api/chat/chats/${chatId}/settings`, { method: "PUT", body: input }),
    onSuccess: (_, { chatId }) => refresh(chatId),
  });
  const markRead = useMutation({
    mutationFn: ({ chatId, seq }: { chatId: string; seq: number }) =>
      api<{ ok: true }>(`/api/chat/chats/${chatId}/read`, { method: "POST", body: { seq } }),
    onSuccess: (_, { chatId }) => refresh(chatId),
  });
  const leave = useMutation({
    mutationFn: (chatId: string) =>
      api<{ ok: true }>(`/api/chat/chats/${chatId}/leave`, { method: "POST" }),
    onSuccess: (_, chatId) => {
      client.removeQueries({ queryKey: chatKeys.chat(chatId) });
      void client.invalidateQueries({ queryKey: chatKeys.chats });
    },
  });
  return { settings, markRead, leave };
}

// ── pinned, polls and who has read (chat.md §5.2, §5.4, §5.5) ─────────────────

export function usePins(chatId: string | null) {
  return useQuery({
    queryKey: chatKeys.pins(chatId ?? "none"),
    queryFn: () => api<ChatMessagePage>(`/api/chat/chats/${chatId!}/pins`),
    enabled: chatId !== null,
  });
}

export function useSetPinned(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api<ChatMessage>(`/api/chat/messages/${id}/pin`, { method: "PUT", body: { pinned } }),
    onSuccess: (message) => {
      merge(client, chatId, [message]);
      void client.invalidateQueries({ queryKey: chatKeys.pins(chatId) });
    },
  });
}

export function useVote(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, options }: { id: string; options: number[] }) =>
      api<ChatMessage>(`/api/chat/messages/${id}/vote`, { method: "PUT", body: { options } }),
    onSuccess: (message) => merge(client, chatId, [message]),
  });
}

export function useClosePoll(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<ChatMessage>(`/api/chat/messages/${id}/poll/close`, { method: "POST" }),
    onSuccess: (message) => merge(client, chatId, [message]),
  });
}

export function useReadBy(messageId: string | null) {
  return useQuery({
    queryKey: [...CHAT_KEY, "read-by", messageId ?? "none"] as const,
    queryFn: () => api<ReadBy>(`/api/chat/messages/${messageId!}/read-by`),
    enabled: messageId !== null,
  });
}
