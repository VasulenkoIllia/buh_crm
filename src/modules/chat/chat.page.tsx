import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Info, Search } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ChatFile, ChatFileItem, ChatMessage } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { FileViewer, type Viewable } from "@/modules/files";
import { useChatPresence, useRealtime } from "./use-realtime";
import {
  useChat,
  useChatLive,
  useClosePoll,
  usePins,
  useSetPinned,
  useVote,
  useChatPeople,
  useChats,
  useDeleteMessage,
  useEditMessage,
  useMarkRead,
  useMessages,
  useCreateGroup,
  useForward,
  useOpenDirect,
  useOpenSaved,
  useReact,
  useSendMessage,
  useTyping,
} from "./chat.api";
import { viewableOf } from "./attachments";
import { ChatList, chatTitle } from "./chat-list";
import { ChatPanel } from "./chat-panel";
import { ChatSearchBar } from "./chat-search";
import { ForwardModal } from "./forward-modal";
import { Composer } from "./composer";
import { Conversation } from "./conversation";
import { PinnedBar } from "./pinned-bar";
import { NewPoll } from "./poll";
import { ReadBy } from "./read-by";

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
  const forward = useForward();
  const openDirect = useOpenDirect();
  const openSaved = useOpenSaved();
  const createGroup = useCreateGroup();

  const pins = usePins(chatId);
  const setPinned = useSetPinned(chatId ?? "none");
  const vote = useVote(chatId ?? "none");
  const closePoll = useClosePoll(chatId ?? "none");

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [panel, setPanel] = useState(false);
  /** the bar under the header, which is where searching one chat lives (§8) */
  const [searchHere, setSearchHere] = useState(false);
  /** and the words it is looking for, marked inside the messages while it is open */
  const [foundWords, setFoundWords] = useState<string[]>([]);
  const takeWords = useCallback((words: string[]) => setFoundWords(words), []);
  /** the match the search is standing on: it is jumped to, and ringed while it stands there */
  const [standingOn, setStandingOn] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [readBy, setReadBy] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  /**
   * The message the conversation is being sent to, and a number that rises with every ask: the
   * SAME message asked for twice in a row is two jumps, which is what stepping through pinned
   * messages and search hits does (audit, 2026-09-20).
   */
  const [goTo, setGoTo] = useState<{ id: string; nth: number } | null>(null);
  const goToMessage = useCallback(
    (id: string) => setGoTo((was) => ({ id, nth: (was?.nth ?? 0) + 1 })),
    [],
  );
  /**
   * `?m=<place>` — a link to one message, which is what "Copy link" puts on the clipboard. The
   * conversation loads older pages until it has that place and scrolls to it.
   */
  const [params, setParams] = useSearchParams();
  const linkedSeq = Number(params.get("m")) || null;
  /** the CRM's own viewer, over the chat's files (§6.2) */
  const [viewing, setViewing] = useState<{ items: Viewable[]; index: number } | null>(null);

  const openFiles = (files: ChatFile[], index: number, at: string) => {
    // it steps through what the CRM can show; a file it cannot is a download, never a blank window
    const shown = files.filter((f) => f.view !== null);
    const items = shown.map((f) => viewableOf(f, at));
    const from = shown.indexOf(files[index]);
    if (items.length > 0) setViewing({ items, index: Math.max(0, from) });
  };

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
        narrow={panel}
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
        onLeft={(id) => {
          // the chat that is open is the one they just took off their list: come off it
          if (id === chatId) navigate("/chat");
        }}
        onOpenHit={(hit) => {
          // the conversation loads older pages until it has it, then scrolls (§8)
          if (hit.chatId !== chatId) navigate(`/chat/${hit.chatId}?m=${hit.seq}`);
          else goToMessage(hit.messageId);
        }}
        onNewGroup={(title, memberIds) =>
          createGroup.mutate(
            { title, memberIds },
            { onSuccess: (detail) => navigate(`/chat/${detail.id}`) },
          )
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
              {/* the magnifier belongs beside the chat and opens a box to type in at once, the
                  way it does in Telegram (owner, 2026-09-20) */}
              <button
                type="button"
                aria-label="Search this chat"
                title="Search this chat"
                onClick={() => setSearchHere((open) => !open)}
                className={cn("text-muted hover:text-ink", searchHere && "text-ink")}
              >
                <Search className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Details"
                title="Details"
                onClick={() => setPanel((open) => !open)}
                className="text-muted hover:text-ink"
              >
                <Info className="size-4" />
              </button>
            </header>

            {searchHere && (
              <ChatSearchBar
                chatId={chat.data.id}
                people={chat.data.members}
                onGo={(messageId) => {
                  setStandingOn(messageId);
                  if (messageId) goToMessage(messageId);
                }}
                onWords={takeWords}
                onClose={() => {
                  setSearchHere(false);
                  setFoundWords([]);
                  setStandingOn(null);
                }}
              />
            )}

            <PinnedBar
              pinned={pins.data?.messages ?? []}
              canPin={chat.data.kind !== "announcements" || user?.role === "admin"}
              onGo={(message) => goToMessage(message.id)}
              onUnpin={(message) => setPinned.mutate({ id: message.id, pinned: false })}
            />

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
              onPin={(message, pinned) => setPinned.mutate({ id: message.id, pinned })}
              onReadBy={(message) => setReadBy(message.id)}
              onVote={(message, options) => vote.mutate({ id: message.id, options })}
              onClosePoll={(message) => closePoll.mutate(message.id)}
              onForward={(message) => setForwarding(message)}
              firstUnread={
                chat.data.unread > 0 && chat.data.lastReadSeq < chat.data.lastSeq
                  ? chat.data.lastReadSeq + 1
                  : 0
              }
              onOpenFile={openFiles}
              found={foundWords}
              standingOn={standingOn}
              goTo={goTo}
              goToSeq={linkedSeq}
              onWent={() => {
                setGoTo(null);
                if (linkedSeq) setParams({}, { replace: true });
              }}
              typing={typing}
            />

            <Composer
              chatId={chat.data.id}
              members={chat.data.members}
              canPoll={chat.data.kind !== "saved"}
              onPoll={() => setAsking(true)}
              replyTo={replyTo}
              editing={editing}
              disabled={cannotWrite}
              onTyping={ping}
              onCancel={() => {
                setReplyTo(null);
                setEditing(null);
              }}
              // `mutateAsync`, so the composer knows whether it worked: it keeps the words when
              // it did not, rather than emptying into a failure nobody sees (audit, 2026-09-20)
              onEdit={async (text) => {
                if (!editing) return;
                await edit.mutateAsync({ id: editing.id, text });
                setEditing(null);
              }}
              onSend={async (text, mentions, files) => {
                await send.mutateAsync({
                  clientMessageId: crypto.randomUUID(),
                  ...(text ? { text } : {}),
                  ...(mentions.length ? { mentions } : {}),
                  ...(files.length ? { files } : {}),
                  ...(replyTo ? { replyToId: replyTo.id } : {}),
                });
                setReplyTo(null);
              }}
            />
          </>
        )}
      </div>

      {panel && chat.data && (
        <ChatPanel
          chat={chat.data}
          people={people_}
          online={online}
          onOpenFile={(files: ChatFileItem[], index: number) =>
            openFiles(files, index, files[index]?.at ?? new Date().toISOString())
          }
          onClose={() => setPanel(false)}
          onLeft={() => {
            setPanel(false);
            navigate("/chat");
          }}
        />
      )}

      {asking && chatId && (
        <NewPoll
          onClose={() => setAsking(false)}
          onCreate={({ question, options, multiple }) => {
            setAsking(false);
            send.mutate({
              clientMessageId: crypto.randomUUID(),
              text: question,
              poll: { options, multiple },
            });
          }}
        />
      )}

      {readBy && <ReadBy messageId={readBy} onClose={() => setReadBy(null)} />}

      {forwarding && (
        <ForwardModal
          chats={(chats.data ?? []).filter(
            (c) => c.kind !== "announcements" || user?.role === "admin",
          )}
          onClose={() => setForwarding(null)}
          onSend={(toChatIds) => {
            forward.mutate(
              { messageIds: [forwarding.id], toChatIds },
              { onSuccess: () => toChatIds.length === 1 && navigate(`/chat/${toChatIds[0]}`) },
            );
            setForwarding(null);
          }}
        />
      )}

      {viewing && (
        <Suspense
          // the frame stands while the viewer loads, rather than the conversation showing through
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="flex h-[92vh] w-full max-w-[1100px] items-center justify-center rounded-(--radius-panel) bg-surface text-[13px] text-muted shadow-(--shadow-modal)">
                Opening…
              </div>
            </div>
          }
        >
          <FileViewer
            items={viewing.items}
            index={viewing.index}
            onIndex={(index) => setViewing((was) => (was ? { ...was, index } : was))}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
