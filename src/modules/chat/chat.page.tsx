import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ChatMessage } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { useChatPresence, useRealtime } from "./use-realtime";
import {
  useChat,
  useChatLive,
  useChatPeople,
  useChats,
  useDeleteMessage,
  useEditMessage,
  useMarkRead,
  useMessages,
  useOpenDirect,
  useOpenSaved,
  useReact,
  useSendMessage,
  useTyping,
} from "./chat.api";
import { ChatList, chatTitle } from "./chat-list";
import { Composer } from "./composer";
import { Conversation } from "./conversation";

/**
 * **The Chat screen** (chat.md §17): the list on the left, the open chat on the right. One live
 * connection holds it current, and the screen asks for what an event names rather than reloading.
 *
 * The chat's panel, its pinned bar, polls and mentions are step A.6.
 */
export function ChatPage() {
  const { chatId = null } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const live = useRealtime();
  const chats = useChats();
  const people = useChatPeople();
  const presence = useChatPresence();
  const chat = useChat(chatId);
  const messages = useMessages(chatId);
  const { typing } = useChatLive(chatId);
  const markRead = useMarkRead(chatId);
  const ping = useTyping(chatId);
  const send = useSendMessage(chatId ?? "none");
  const edit = useEditMessage(chatId ?? "none");
  const remove = useDeleteMessage(chatId ?? "none");
  const react = useReact(chatId ?? "none");
  const openDirect = useOpenDirect();
  const openSaved = useOpenSaved();

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
  }, [chatId]);

  const online = useMemo(() => new Set(presence.data?.online ?? []), [presence.data]);
  const people_ = people.data ?? [];

  const cannotWrite = useMemo(() => {
    const it = chat.data;
    if (!it) return null;
    // the channel's writers are the FIRM's admins, not a member's role in the chat (§4.1)
    if (it.kind === "announcements" && user?.role !== "admin") {
      return "Only an admin posts here.";
    }
    if (it.kind === "direct" && it.peer && it.peer.status !== "active") {
      return "This colleague is blocked, so the chat is read only.";
    }
    return null;
  }, [chat.data, user?.role]);

  return (
    /* the shell's header is 3.5rem and the page's own padding is undone, as the board and the
       leads pipeline do: a conversation is a screen of its own, not a card on a page */
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] overflow-hidden border-t border-divider bg-surface">
      <ChatList
        chats={chats.data ?? []}
        people={people_}
        online={online}
        openId={chatId}
        onOpen={(id) => navigate(`/chat/${id}`)}
        onStartWith={(userId) =>
          openDirect.mutate(userId, { onSuccess: (summary) => navigate(`/chat/${summary.id}`) })
        }
        onOpenSaved={() =>
          openSaved.mutate(undefined, {
            onSuccess: (summary) => navigate(`/chat/${summary.id}`),
          })
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {!chat.data ? (
          <p className="m-auto text-[13px] text-muted">
            {chatId ? "Loading…" : "Pick a chat, or start a new one."}
          </p>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-divider px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold">{chatTitle(chat.data)}</p>
                <p className="text-[11.5px] text-muted">
                  {chat.data.kind === "direct"
                    ? chat.data.peer && online.has(chat.data.peer.id)
                      ? "online"
                      : "offline"
                    : `${chat.data.memberCount} people`}
                </p>
              </div>
              <span className="ml-auto text-[11.5px] text-muted">
                {live.status === "open" ? "" : "Connecting…"}
              </span>
            </header>

            <Conversation
              chat={chat.data}
              messages={messages.data?.messages ?? []}
              people={messages.data?.people ?? new Map()}
              more={messages.hasNextPage}
              loadingMore={messages.isFetchingNextPage}
              onLoadMore={() => void messages.fetchNextPage()}
              onRead={markRead}
              onReply={(message) => {
                setEditing(null);
                setReplyTo(message);
              }}
              onEdit={(message) => {
                setReplyTo(null);
                setEditing(message);
              }}
              onDelete={(message) => remove.mutate(message.id)}
              onReact={(message, emoji) => react.mutate({ id: message.id, emoji })}
              typing={typing}
            />

            <Composer
              chatId={chat.data.id}
              replyTo={replyTo}
              editing={editing}
              disabled={cannotWrite}
              onTyping={ping}
              onCancel={() => {
                setReplyTo(null);
                setEditing(null);
              }}
              onEdit={(text) => {
                if (editing) edit.mutate({ id: editing.id, text });
                setEditing(null);
              }}
              onSend={(text) => {
                send.mutate({
                  clientMessageId: crypto.randomUUID(),
                  text,
                  ...(replyTo ? { replyToId: replyTo.id } : {}),
                });
                setReplyTo(null);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
