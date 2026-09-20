import { useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  BellOff,
  Bell,
  Bookmark,
  Check,
  LogOut,
  Megaphone,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
  Users,
  UsersRound,
} from "lucide-react";
import type { ChatPeople, ChatSearchHit, ChatSummary } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { fmtTime, isoDay } from "@/shared/lib/format";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { useChatListActions } from "./chat.api";
import { ChatSearchBox } from "./chat-search";
import { NotifySettings } from "./notify-modal";

/**
 * **The chat list** (chat.md §4.2): newest first with the pinned on top, each row with the last
 * line said in it, its time, what is unread and an `@` when one of them names the reader.
 */

export function chatTitle(chat: ChatSummary): string {
  switch (chat.kind) {
    case "group":
      return chat.title ?? "Group";
    case "saved":
      return "Saved messages";
    case "announcements":
      return "Firm announcements";
    default:
      return chat.peer ? `${chat.peer.firstName} ${chat.peer.lastName}`.trim() : "Somebody";
  }
}

function when(iso: string): string {
  return isoDay(new Date(iso)) === isoDay(new Date())
    ? fmtTime(iso)
    : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** What the chat's own lines say in a list, where there is room for four words (§4.2). */
const NOTICE_LINE: Record<string, string> = {
  created: "The group was made",
  renamed: "The group was renamed",
  member_added: "Somebody was added",
  member_removed: "Somebody was taken out",
  member_left: "Somebody left",
  member_blocked: "Somebody was blocked",
  role_changed: "A role changed",
  owner_changed: "The group has a new owner",
};

/**
 * The marks are for reading a message, not for a one-line preview: `**Friday**` in a list is
 * noise, and that is exactly what it looked like in use (found 2026-09-20).
 */
function plain(text: string): string {
  return text
    .replace(/```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/(^|[\s(])_(.+?)_(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^>\s?/gm, "");
}

function lastLine(chat: ChatSummary): string {
  const last = chat.lastMessage;
  if (!last) return "No messages yet";
  if (last.notice) return NOTICE_LINE[last.notice] ?? "The group changed";
  if (last.deleted) return "Message deleted";
  if (last.kind === "poll") return `Poll: ${plain(last.preview ?? "")}`;
  const words = plain(last.preview ?? "");
  // a photo sent with no words would otherwise be an empty line (§4.2, §6.1)
  if (last.files > 0) {
    const carried = last.files === 1 ? "File" : `${last.files} files`;
    return words ? `${carried} · ${words}` : carried;
  }
  return words;
}

/**
 * **What a person does to a chat without opening it** (§4.2): pin it, mute it, mark it read, leave
 * a group, or take it off their list. Right-click on the row, or the ⋯ that appears on it.
 *
 * "Delete for me" hides the chat AND marks it read, so it leaves the list clean and comes back only
 * when somebody writes again. Nothing is deleted for anybody else, and nothing of what was said is
 * lost: a chat is a conversation between people, and one of them cannot end it for the others
 * (owner, 2026-09-20).
 */
function ChatRowMenu({
  chat,
  onClose,
  onLeft,
}: {
  chat: ChatSummary;
  onClose: () => void;
  onLeft: (chatId: string) => void;
}) {
  const { settings, markRead, leave } = useChatListActions();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-divider";
  const act = (run: () => void) => () => {
    run();
    onClose();
  };

  return (
    <div
      ref={box}
      className="absolute top-8 right-2 z-30 w-[190px] overflow-hidden rounded-(--radius-panel) border border-border bg-surface py-1 shadow-(--shadow-card)"
    >
      <button
        type="button"
        className={item}
        onClick={act(() => settings.mutate({ chatId: chat.id, pinned: !chat.pinnedAt }))}
      >
        {chat.pinnedAt ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        {chat.pinnedAt ? "Unpin" : "Pin to the top"}
      </button>
      <button
        type="button"
        className={item}
        onClick={act(() =>
          settings.mutate({ chatId: chat.id, mute: chat.mutedUntil ? "off" : "forever" }),
        )}
      >
        {chat.mutedUntil ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
        {chat.mutedUntil ? "Unmute" : "Mute"}
      </button>
      {chat.unread > 0 && (
        <button
          type="button"
          className={item}
          onClick={act(() => markRead.mutate({ chatId: chat.id, seq: chat.lastSeq }))}
        >
          <Check className="size-3.5" />
          Mark as read
        </button>
      )}
      {chat.kind !== "announcements" && (
        <button
          type="button"
          className={item}
          onClick={act(() => {
            markRead.mutate({ chatId: chat.id, seq: chat.lastSeq });
            settings.mutate({ chatId: chat.id, hidden: true });
            onLeft(chat.id);
          })}
        >
          <Trash2 className="size-3.5" />
          Delete for me
        </button>
      )}
      {chat.kind === "group" && (
        <button
          type="button"
          className={cn(item, "text-danger-text")}
          onClick={act(() => {
            leave.mutate(chat.id);
            onLeft(chat.id);
          })}
        >
          <LogOut className="size-3.5" />
          Leave the group
        </button>
      )}
    </div>
  );
}

export function ChatList({
  chats,
  people,
  online,
  openId,
  onOpen,
  onStartWith,
  onOpenSaved,
  onNewGroup,
  onOpenHit,
  onLeft,
  narrow,
}: {
  chats: ChatSummary[];
  people: ChatPeople;
  online: Set<string>;
  openId: string | null;
  onOpen: (chatId: string) => void;
  onStartWith: (userId: string) => void;
  onOpenSaved: () => void;
  onNewGroup: (title: string, memberIds: string[]) => void;
  /** a message the search found, in whichever chat it is in (§8) */
  onOpenHit: (hit: ChatSearchHit) => void;
  /** a chat this person has just left or taken off their list, so the screen can move off it */
  onLeft: (chatId: string) => void;
  /** the details panel is open: on a narrow screen the conversation needs the room more */
  narrow?: boolean;
}) {
  const [starting, setStarting] = useState(false);
  const [settings, setSettings] = useState(false);
  const [searching, setSearching] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <div
      className={cn(
        "flex w-[300px] shrink-0 flex-col border-r border-divider bg-surface",
        narrow && "max-[1200px]:hidden",
      )}
    >
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
        <h2 className="text-[13px] font-semibold">Chats</h2>
        <button
          type="button"
          aria-label="Chat settings"
          onClick={() => setSettings(true)}
          className="ml-auto text-muted hover:text-ink"
        >
          <Settings2 className="size-4" />
        </button>
        <Button size="sm" variant="secondary" onClick={() => setStarting(true)}>
          <Plus className="size-3.5" />
          New
        </Button>
      </div>
      {/* while it is searching the box takes the sidebar's height and its results scroll inside
          it; empty it is just the input, and the chat list has the room (audit, 2026-09-20) */}
      <div
        className={cn(
          "flex flex-col border-b border-divider",
          searching && "min-h-0 flex-1 overflow-hidden",
        )}
      >
        <ChatSearchBox people={people} onOpen={onOpenHit} onActive={setSearching} />
      </div>

      <div className={cn("flex-1 overflow-y-auto", searching && "hidden")}>
        {chats.length === 0 && (
          <p className="px-3 py-3 text-[12.5px] text-muted">
            Nothing here yet. Start with a colleague.
          </p>
        )}
        {chats.map((chat) => (
          <div key={chat.id} className="group relative">
            <button
              type="button"
              onClick={() => onOpen(chat.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(chat.id);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 border-b border-divider px-3 py-2 text-left",
                chat.id === openId ? "bg-divider" : "hover:bg-[#fafbfc]",
              )}
            >
              <Face chat={chat} online={online} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-ink">
                    {chatTitle(chat)}
                  </span>
                  {chat.pinnedAt && <Pin className="size-3 shrink-0 text-muted" />}
                  {chat.mutedUntil && <BellOff className="size-3 shrink-0 text-muted" />}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {chat.lastMessage ? when(chat.lastMessage.at) : ""}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] text-muted">{lastLine(chat)}</span>
                  {chat.mentioned && <AtSign className="size-3 shrink-0 text-primary" />}
                  {chat.unread > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white">
                      {chat.unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label="More"
              onClick={() => setMenuFor(chat.id)}
              className={cn(
                "absolute top-2 right-1.5 rounded p-0.5 text-muted opacity-0 hover:bg-divider",
                "hover:text-ink group-hover:opacity-100",
              )}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
            {menuFor === chat.id && (
              <ChatRowMenu chat={chat} onClose={() => setMenuFor(null)} onLeft={onLeft} />
            )}
          </div>
        ))}
      </div>

      {settings && <NotifySettings onClose={() => setSettings(false)} />}

      {starting && (
        <StartChat
          people={people}
          online={online}
          onPick={(userId) => {
            setStarting(false);
            onStartWith(userId);
          }}
          onSaved={() => {
            setStarting(false);
            onOpenSaved();
          }}
          onGroup={(title, ids) => {
            setStarting(false);
            onNewGroup(title, ids);
          }}
          onClose={() => setStarting(false)}
        />
      )}
    </div>
  );
}

function Face({ chat, online }: { chat: ChatSummary; online: Set<string> }) {
  if (chat.kind === "direct" && chat.peer) {
    return (
      <span className="relative">
        <UserAvatar user={chat.peer} size="md" />
        {online.has(chat.peer.id) && (
          <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface bg-success" />
        )}
      </span>
    );
  }
  const Icon =
    chat.kind === "saved" ? Bookmark : chat.kind === "announcements" ? Megaphone : Users;
  return (
    <span className="flex size-8 items-center justify-center rounded-full bg-divider text-ink-700">
      <Icon className="size-4" />
    </span>
  );
}

function StartChat({
  people,
  online,
  onPick,
  onSaved,
  onGroup,
  onClose,
}: {
  people: ChatPeople;
  online: Set<string>;
  onPick: (userId: string) => void;
  onSaved: () => void;
  onGroup: (title: string, memberIds: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<{ title: string; picked: string[] } | null>(null);
  const found = useMemo(() => {
    const words = query.trim().toLowerCase();
    return people.filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase().includes(words));
  }, [people, query]);

  if (group) {
    return (
      <Modal
        open
        onClose={onClose}
        title="New group"
        footer={
          <Button
            disabled={group.title.trim() === "" || group.picked.length === 0}
            onClick={() => onGroup(group.title.trim(), group.picked)}
          >
            Create
          </Button>
        }
      >
        <input
          autoFocus
          value={group.title}
          onChange={(e) => setGroup({ ...group, title: e.target.value })}
          placeholder="What is it about?"
          className="mb-2 w-full rounded-(--radius-field) border border-border px-3 py-2 text-[13px] outline-none focus:border-primary"
        />
        <div className="max-h-[300px] overflow-y-auto">
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() =>
                setGroup((was) =>
                  was
                    ? {
                        ...was,
                        picked: was.picked.includes(person.id)
                          ? was.picked.filter((id) => id !== person.id)
                          : [...was.picked, person.id],
                      }
                    : was,
                )
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-2 text-left",
                group.picked.includes(person.id) ? "bg-divider" : "hover:bg-divider",
              )}
            >
              <UserAvatar user={person} size="sm" />
              <span className="text-[13px]">
                {person.firstName} {person.lastName}
              </span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="New chat">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search colleagues"
        className="mb-2 w-full rounded-(--radius-field) border border-border px-3 py-2 text-[13px] outline-none focus:border-primary"
      />
      <button
        type="button"
        onClick={() => setGroup({ title: "", picked: [] })}
        className="mb-1 flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-2 text-left hover:bg-divider"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-divider">
          <UsersRound className="size-4 text-ink-700" />
        </span>
        <span className="text-[13px]">New group</span>
      </button>
      <button
        type="button"
        onClick={onSaved}
        className="mb-1 flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-2 text-left hover:bg-divider"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-divider">
          <Bookmark className="size-4 text-ink-700" />
        </span>
        <span className="text-[13px]">Saved messages</span>
      </button>
      <div className="max-h-[320px] overflow-y-auto">
        {found.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() => onPick(person.id)}
            className="flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-2 text-left hover:bg-divider"
          >
            <UserAvatar user={person} size="md" />
            <span className="text-[13px]">
              {person.firstName} {person.lastName}
            </span>
            <span className="ml-auto text-[11.5px] text-muted">
              {online.has(person.id) ? "online" : ""}
            </span>
          </button>
        ))}
        {found.length === 0 && (
          <p className="px-2 py-2 text-[12.5px] text-muted">Nobody found.</p>
        )}
      </div>
    </Modal>
  );
}
