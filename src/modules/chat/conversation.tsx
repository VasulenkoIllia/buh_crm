import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Eye,
  Pencil,
  Pin,
  SmilePlus,
  Trash2,
} from "lucide-react";
import type { ChatDetail, ChatMessage, ChatPerson } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtTime } from "@/shared/lib/format";
import { UserAvatar } from "@/shared/ui/avatar";
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
  goTo,
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
  /** a message to scroll to, from the pinned bar or a reply's quote */
  goTo: string | null;
  typing: string[];
}) {
  const { user } = useAuth();
  const me = user?.id ?? "";
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const rows = useMemo(() => {
    const out: ({ kind: "day"; day: string } | { kind: "message"; message: ChatMessage })[] =
      [];
    let day = "";
    for (const message of messages) {
      const its = dayOf(message.createdAt);
      if (its !== day) {
        out.push({ kind: "day", day: its });
        day = its;
      }
      out.push({ kind: "message", message });
    }
    return out;
  }, [messages]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => box.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "day" ? `day-${row.day}` : row.message.id;
    },
  });

  // the newest message is the one to be at, unless the reader has scrolled up to read
  useLayoutEffect(() => {
    if (atBottom && rows.length > 0) virtual.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, atBottom, virtual]);

  // the pinned bar and a reply's quote both ask for a message by id
  useEffect(() => {
    if (!goTo) return;
    const at = rows.findIndex((r) => r.kind === "message" && r.message.id === goTo);
    if (at >= 0) virtual.scrollToIndex(at, { align: "center" });
  }, [goTo, rows, virtual]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 120 && more && !loadingMore) onLoadMore();
  }, [more, loadingMore, onLoadMore]);

  // what is on screen at the bottom has been read, while this window is the one in front
  const newest = messages.at(-1)?.seq ?? 0;
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
                />
              )}
            </div>
          );
        })}
      </div>
      {typing.length > 0 && (
        <p className="pt-1 text-[12px] text-muted">
          {typing.map((id) => nameOf(people, id).split(" ")[0]).join(", ")}{" "}
          {typing.length === 1 ? "is" : "are"} typing…
        </p>
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
}) {
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
            <div
              className={cn(
                "mb-1 border-l-2 pl-2 text-[12px]",
                mine ? "border-white/50 text-white/90" : "border-border text-muted",
              )}
            >
              <span className="font-semibold">{nameOf(people, message.replyTo.authorId)}</span>{" "}
              {message.replyTo.deleted ? "Message deleted" : message.replyTo.preview}
            </div>
          )}
          {message.deletedAt ? (
            <p>{message.deletedByOther ? "Deleted by an admin" : "Message deleted"}</p>
          ) : (
            <RichText text={message.text ?? ""} />
          )}
          {message.poll && !message.deletedAt && (
            <PollCard
              message={message}
              me={me}
              people={people}
              canClose={mine || chat.myRole !== "member"}
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
          <button
            type="button"
            aria-label="React"
            onClick={() => onReact(message, "👍")}
            className="text-muted hover:text-ink"
          >
            <SmilePlus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Reply"
            onClick={() => onReply(message)}
            className="text-muted hover:text-ink"
          >
            <CornerUpLeft className="size-3.5" />
          </button>
          {(chat.kind === "direct" || chat.myRole !== "member") && (
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
          {(mine || chat.myRole !== "member") && (
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
