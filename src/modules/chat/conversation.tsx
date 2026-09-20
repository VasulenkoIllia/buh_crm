import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  CheckCheck,
  ChevronDown,
  CornerUpLeft,
  CornerUpRight,
  Eye,
  Pencil,
  Pin,
  SmilePlus,
  Trash2,
} from "lucide-react";
import type { ChatDetail, ChatFile, ChatMessage, ChatPerson } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtTime } from "@/shared/lib/format";
import { UserAvatar } from "@/shared/ui/avatar";
import { MessageFiles } from "./attachments";
import { EmojiPicker } from "./emoji-picker";
import { PollCard } from "./poll";
import { RichText } from "./rich-text";

/**
 * **The conversation** (chat.md §7.2, §17): only what is on screen is drawn, however long the chat
 * is, history comes in pages as one scrolls up, and a new message keeps the view at the bottom when
 * the reader is already there.
 */

const NOTICE: Record<string, (names: string) => string> = {
  created: () => "created the group",
  renamed: () => "changed the group",
  member_added: (names) => `added ${names}`,
  member_removed: (names) => `removed ${names}`,
  member_left: () => "left the group",
  member_blocked: (names) => `${names} was blocked`,
  role_changed: (names) => `changed ${names}'s role`,
  owner_changed: (names) => `${names} owns the group now`,
};

function nameOf(people: Map<string, ChatPerson>, id: string | null): string {
  const person = id ? people.get(id) : null;
  return person ? `${person.firstName} ${person.lastName}`.trim() : "Somebody";
}

/** One day's worth of messages sits under one date. */
function dayOf(iso: string): string {
  return fmtDate(iso);
}

export function Conversation({
  chat,
  messages,
  people,
  more,
  loadingMore,
  onLoadMore,
  onRead,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onReadBy,
  onVote,
  onClosePoll,
  onForward,
  firstUnread,
  onOpenFile,
  goTo,
  onWent,
  typing,
}: {
  chat: ChatDetail;
  messages: ChatMessage[];
  people: Map<string, ChatPerson>;
  more: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRead: (seq: number) => void;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onPin: (message: ChatMessage, pinned: boolean) => void;
  onReadBy: (message: ChatMessage) => void;
  onVote: (message: ChatMessage, options: number[]) => void;
  onClosePoll: (message: ChatMessage) => void;
  onForward: (message: ChatMessage) => void;
  /** the first place the reader has not read: the line is drawn above it */
  firstUnread: number;
  /** opens the CRM's viewer on a file a message carries (§6.2) */
  onOpenFile: (files: ChatFile[], index: number, at: string) => void;
  /** a message to scroll to, from the pinned bar or a reply's quote */
  goTo: string | null;
  /** told once the view has gone there, so the ask can be forgotten */
  onWent?: () => void;
  typing: string[];
}) {
  const { user } = useAuth();
  const me = user?.id ?? "";
  const firmAdmin = user?.role === "admin";
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  /**
   * The names a `@` may be marking: everybody in the chat now, and everybody the page names,
   * because a mention of somebody who has since left the group is still a mention of them.
   */
  const mentionNames = useMemo(
    () => [
      "all",
      ...new Set([
        ...chat.members.map((m) => `${m.firstName} ${m.lastName}`.trim()),
        ...[...people.values()].map((p) => `${p.firstName} ${p.lastName}`.trim()),
      ]),
    ],
    [chat.members, people],
  );

  /**
   * The rows the conversation draws.
   *
   * **A deleted message is not one of them** (owner, 2026-09-20). Its row stays in the database so
   * the chat's places have no hole, and the log keeps that it was deleted — but a line reading
   * "Message deleted" for ever is not what a chat looks like anywhere else.
   *
   * **Where the reader stopped gets a line of its own**: the first message they have not read,
   * which is what everybody expects on opening a chat with something waiting in it.
   */
  const rows = useMemo(() => {
    const out: (
      | { kind: "day"; day: string }
      | { kind: "unread" }
      | { kind: "message"; message: ChatMessage }
    )[] = [];
    let day = "";
    let markedUnread = false;
    for (const message of messages) {
      if (message.deletedAt) continue;
      const its = dayOf(message.createdAt);
      if (its !== day) {
        out.push({ kind: "day", day: its });
        day = its;
      }
      if (!markedUnread && firstUnread > 0 && message.seq >= firstUnread) {
        out.push({ kind: "unread" });
        markedUnread = true;
      }
      out.push({ kind: "message", message });
    }
    return out;
  }, [messages, firstUnread]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => box.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (i) => {
      const row = rows[i];
      if (row.kind === "day") return `day-${row.day}`;
      return row.kind === "unread" ? "unread" : row.message.id;
    },
  });

  // the newest message is the one to be at, unless the reader has scrolled up to read
  useLayoutEffect(() => {
    if (atBottom && rows.length > 0) virtual.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, atBottom, virtual]);

  /**
   * The pinned bar and a reply's quote ask for a message by id, ONCE. Without remembering that it
   * has been done, every live event re-ran the scroll and the conversation kept jumping back to
   * the pinned message (review, 2026-09-20).
   */
  const [asked, setAsked] = useState<string | null>(null);
  const onGoToMessage = useCallback((id: string) => setAsked(id), []);
  const wentTo = useRef<string | null>(null);
  /**
   * A message the search found can be a long way up. The conversation loads older pages until it
   * has it, at most this many — twenty pages is a thousand messages, which is further than anybody
   * scrolls and far enough that the search is not a promise the screen breaks.
   */
  const HUNT = 20;
  const hunted = useRef(0);
  /**
   * **Older messages arrive above, and the reader stays where they were.** A prepended page grows
   * everything below it, so without putting the scroll back by exactly that much the conversation
   * jumps on every "scroll up for more" (review, 2026-09-20). Armed by whoever asks for a page:
   * the scroll handler below, and the hunt above.
   */
  const heldHeight = useRef<number | null>(null);
  useEffect(() => {
    const wanted = asked ?? goTo;
    if (!wanted || wentTo.current === wanted) {
      hunted.current = 0;
      return;
    }
    const at = rows.findIndex((r) => r.kind === "message" && r.message.id === wanted);
    if (at < 0) {
      if (more && !loadingMore && hunted.current < HUNT) {
        hunted.current++;
        // the hunt is a scroll of its own: hold the reader's place while the page arrives, and
        // stop sticking to the newest line, or the two effects pull against each other and the
        // conversation flickers all the way up (review, 2026-09-20)
        heldHeight.current = box.current?.scrollHeight ?? null;
        setAtBottom(false);
        onLoadMore();
      }
      return;
    }
    wentTo.current = wanted;
    hunted.current = 0;
    virtual.scrollToIndex(at, { align: "center" });
    if (!asked) onWent?.();
  }, [asked, goTo, rows, virtual, onWent, more, loadingMore, onLoadMore]);

  useLayoutEffect(() => {
    const el = box.current;
    const was = heldHeight.current;
    if (!el || was === null || loadingMore) return;
    heldHeight.current = null;
    const grew = el.scrollHeight - was;
    if (grew > 0) el.scrollTop += grew;
  }, [rows.length, loadingMore]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 120 && more && !loadingMore) {
      heldHeight.current = el.scrollHeight;
      onLoadMore();
    }
  }, [more, loadingMore, onLoadMore]);

  // what is on screen at the bottom has been read, while this window is the one in front
  const newest = messages.at(-1)?.seq ?? 0;
  /** how many are below the reader while they are up in the history */
  const waiting = firstUnread > 0 ? Math.max(0, newest - firstUnread + 1) : 0;
  useEffect(() => {
    if (atBottom && newest > 0 && document.hasFocus()) onRead(newest);
  }, [atBottom, newest, onRead]);

  return (
    <div ref={box} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
      {more && (
        <p className="pb-2 text-center text-[12px] text-muted">
          {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
        </p>
      )}
      <div style={{ height: virtual.getTotalSize(), position: "relative", width: "100%" }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              {row.kind === "day" ? (
                <p className="my-2 text-center text-[11px] font-semibold text-muted uppercase">
                  {row.day}
                </p>
              ) : row.kind === "unread" ? (
                <p className="my-2 flex items-center gap-2 text-[11px] font-semibold text-primary uppercase">
                  <span className="h-px flex-1 bg-primary/40" />
                  New messages
                  <span className="h-px flex-1 bg-primary/40" />
                </p>
              ) : (
                <Row
                  chat={chat}
                  message={row.message}
                  people={people}
                  me={me}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReact={onReact}
                  onPin={onPin}
                  onReadBy={onReadBy}
                  onVote={onVote}
                  onClosePoll={onClosePoll}
                  onGoTo={onGoToMessage}
                  onForward={onForward}
                  firmAdmin={firmAdmin}
                  onOpenFile={onOpenFile}
                  mentionNames={mentionNames}
                />
              )}
            </div>
          );
        })}
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            setAtBottom(true);
            virtual.scrollToIndex(rows.length - 1, { align: "end" });
          }}
          aria-label="Go to the newest"
          className={cn(
            "sticky bottom-2 left-full z-10 flex size-9 items-center justify-center rounded-full",
            "border border-border bg-surface shadow-(--shadow-card) hover:bg-divider",
          )}
        >
          <ChevronDown className="size-4" />
          {waiting > 0 && (
            <span className="absolute -top-1 -right-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-white">
              {waiting}
            </span>
          )}
        </button>
      )}
      {typing.length > 0 && (
        <p className="pt-1 text-[12px] text-muted">
          {typing.map((id) => nameOf(people, id).split(" ")[0]).join(", ")}{" "}
          {typing.length === 1 ? "is" : "are"} typing…
        </p>
      )}
    </div>
  );
}

/** What a tap on the smiley offers (§5.2): the six everybody uses, and every other one behind +. */
const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function ReactionPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
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

  return (
    <div ref={box} className="relative">
      {all ? (
        <EmojiPicker onPick={onPick} onClose={onClose} />
      ) : (
        <div className="absolute top-5 right-0 z-20 flex gap-0.5 rounded-full border border-border bg-surface px-1.5 py-1 shadow-(--shadow-card)">
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className="rounded-full px-1 text-[16px] hover:bg-divider"
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            aria-label="More emoji"
            onClick={() => setAll(true)}
            className="rounded-full px-1 text-[13px] text-muted hover:bg-divider hover:text-ink"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

function Row({
  chat,
  message,
  people,
  me,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onReadBy,
  onVote,
  onClosePoll,
  onGoTo,
  onForward,
  firmAdmin,
  onOpenFile,
  mentionNames,
}: {
  chat: ChatDetail;
  message: ChatMessage;
  people: Map<string, ChatPerson>;
  me: string;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onPin: (message: ChatMessage, pinned: boolean) => void;
  onReadBy: (message: ChatMessage) => void;
  onVote: (message: ChatMessage, options: number[]) => void;
  onClosePoll: (message: ChatMessage) => void;
  onGoTo: (messageId: string) => void;
  onForward: (message: ChatMessage) => void;
  /** the FIRM's admin: the only role left, and only over what destroys or broadcasts (§4.4) */
  firmAdmin: boolean;
  /** opens the CRM's viewer on a file this message carries (§6.2) */
  onOpenFile: (files: ChatFile[], index: number, at: string) => void;
  /** the names `@` may be marking in this chat */
  mentionNames: string[];
}) {
  const [reacting, setReacting] = useState(false);

  if (message.kind === "notice") {
    const names = (message.notice?.userIds ?? []).map((id) => nameOf(people, id)).join(", ");
    const who = nameOf(people, message.authorId);
    const what = NOTICE[message.notice?.code ?? ""]?.(names) ?? "changed the group";
    return (
      <p className="my-1.5 text-center text-[12px] text-muted">
        {message.notice?.code === "member_blocked" ? what : `${who} ${what}`}
      </p>
    );
  }

  const mine = message.authorId === me;
  const author = message.authorId ? people.get(message.authorId) : null;
  const inGroup = chat.kind !== "direct" && chat.kind !== "saved";
  // ✓ the server has it, ✓✓ somebody else has read it (§5.4)
  const read = chat.othersReadSeq >= message.seq;

  return (
    <div className={cn("group flex gap-2 py-1", mine && "flex-row-reverse")}>
      {inGroup && !mine && author && <UserAvatar user={author} size="sm" className="mt-1" />}
      <div className={cn("max-w-[min(680px,78%)]", mine && "items-end")}>
        <div
          className={cn(
            "rounded-(--radius-panel) px-3 py-2 text-[13px]",
            mine ? "bg-primary text-white" : "border border-border bg-surface text-ink",
            message.deletedAt && "italic opacity-70",
          )}
        >
          {inGroup && !mine && (
            <p className="mb-0.5 text-[12px] font-semibold text-ink-700">
              {nameOf(people, message.authorId)}
            </p>
          )}
          {message.forwardedFromId && (
            <p className={cn("mb-0.5 text-[11.5px]", mine ? "text-white/80" : "text-muted")}>
              Forwarded from {nameOf(people, message.forwardedFromId)}
            </p>
          )}
          {message.replyTo && (
            <button
              type="button"
              onClick={() => onGoTo(message.replyTo!.id)}
              className={cn(
                "mb-1 block w-full border-l-2 pl-2 text-left text-[12px]",
                mine ? "border-white/50 text-white/90" : "border-border text-muted",
              )}
            >
              <span className="font-semibold">{nameOf(people, message.replyTo.authorId)}</span>{" "}
              {message.replyTo.deleted ? "Message deleted" : message.replyTo.preview}
            </button>
          )}
          {message.text && <RichText text={message.text} mentions={mentionNames} mine={mine} />}
          <MessageFiles
            files={message.files}
            mine={mine}
            onOpen={(files, index) => onOpenFile(files, index, message.createdAt)}
          />
          {message.poll && !message.deletedAt && (
            <PollCard
              message={message}
              me={me}
              people={people}
              canClose={mine || firmAdmin}
              onVote={(options) => onVote(message, options)}
              onClose={() => onClosePoll(message)}
            />
          )}
          <p
            className={cn(
              "mt-0.5 flex items-center justify-end gap-1 text-[11px]",
              mine ? "text-white/80" : "text-muted",
            )}
          >
            {message.editedAt && !message.deletedAt && <span>edited</span>}
            <span>{fmtTime(message.createdAt)}</span>
            {mine &&
              !message.deletedAt &&
              (read ? <CheckCheck className="size-3.5" /> : <Check className="size-3.5" />)}
          </p>
        </div>
        {message.reactions.length > 0 && (
          <div className={cn("mt-1 flex flex-wrap gap-1", mine && "justify-end")}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReact(message, r.emoji)}
                title={r.userIds.map((id) => nameOf(people, id)).join(", ")}
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[12px]",
                  r.userIds.includes(me)
                    ? "border-primary bg-divider"
                    : "border-border bg-surface",
                )}
              >
                {r.emoji} {r.userIds.length}
              </button>
            ))}
          </div>
        )}
      </div>
      {!message.deletedAt && (
        <div className="mt-1 flex items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="relative">
            <button
              type="button"
              aria-label="React"
              onClick={() => setReacting((open) => !open)}
              className="text-muted hover:text-ink"
            >
              <SmilePlus className="size-3.5" />
            </button>
            {reacting && (
              <ReactionPicker
                onPick={(emoji) => {
                  onReact(message, emoji);
                  setReacting(false);
                }}
                onClose={() => setReacting(false)}
              />
            )}
          </div>
          <button
            type="button"
            aria-label="Reply"
            onClick={() => onReply(message)}
            className="text-muted hover:text-ink"
          >
            <CornerUpLeft className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Forward"
            onClick={() => onForward(message)}
            className="text-muted hover:text-ink"
          >
            <CornerUpRight className="size-3.5" />
          </button>
          {(chat.kind !== "announcements" || firmAdmin) && (
            <button
              type="button"
              aria-label={message.pinned ? "Unpin" : "Pin"}
              onClick={() => onPin(message, !message.pinned)}
              className={cn("hover:text-ink", message.pinned ? "text-ink" : "text-muted")}
            >
              <Pin className="size-3.5" />
            </button>
          )}
          {mine && inGroup && (
            <button
              type="button"
              aria-label="Read by"
              onClick={() => onReadBy(message)}
              className="text-muted hover:text-ink"
            >
              <Eye className="size-3.5" />
            </button>
          )}
          {mine && message.kind !== "poll" && (
            <button
              type="button"
              aria-label="Edit"
              onClick={() => onEdit(message)}
              className="text-muted hover:text-ink"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          {(mine || firmAdmin) && (
            <button
              type="button"
              aria-label="Delete"
              onClick={() => onDelete(message)}
              className="text-muted hover:text-danger-text"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
