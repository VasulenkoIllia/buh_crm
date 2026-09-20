import { useMemo, useState } from "react";
import { Check, CheckCheck, CornerUpLeft, MoreHorizontal, SmilePlus } from "lucide-react";
import type { ChatDetail, ChatFile, ChatMessage, ChatPerson } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { cardsIn } from "@/shared/lib/crm-links";
import { fmtTime } from "@/shared/lib/format";
import { UserAvatar } from "@/shared/ui/avatar";
import { RecordCard } from "@/shared/ui/record-card";
import { MessageFiles } from "./attachments";
import { MessageMenu, ReactionPicker } from "./message-menu";
import { PollCard } from "./poll";
import { RichText } from "./rich-text";

/**
 * **One message, as the conversation draws it** (chat.md §5): who wrote it, what it says, what it
 * carries, what it was answered with, and everything that can be done to it.
 *
 * Its own file since the audit of 2026-09-20, beside `message-menu.tsx`; `conversation.tsx` is the
 * list and the scrolling, and nothing else.
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

export function nameOf(people: Map<string, ChatPerson>, id: string | null): string {
  const person = id ? people.get(id) : null;
  return person ? `${person.firstName} ${person.lastName}`.trim() : "Somebody";
}

/** One day's worth of messages sits under one date. */
export function MessageRow({
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
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // the links this message draws as cards, and whether its words are drawn beside them (§5.6);
  // above the notice's own return, because a hook cannot be called conditionally
  const cards = useMemo(() => cardsIn(message.text ?? ""), [message.text]);

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

  /** A two-finger tap on a Mac is a secondary click: it lands wherever the pointer is, so the whole
   *  line listens, not just the bubble (found in use, 2026-09-20). */
  const openMenu = (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
    if (message.deletedAt) return;
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      onContextMenu={openMenu}
      className={cn("group relative flex gap-2 py-1", mine && "flex-row-reverse")}
    >
      {inGroup && !mine && author && <UserAvatar user={author} size="sm" className="mt-1" />}
      <div className={cn("max-w-[min(680px,78%)]", mine && "items-end")}>
        <div
          // double-click is the quickest reaction there is, and the one everybody already knows
          // from Telegram (owner, 2026-09-20). The same again takes it back, as any reaction does
          // …but not on a card or a link inside it: a double click there is two clicks on the
          // thing it opens, not a heart on the message (audit, 2026-09-20)
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("a,button")) return;
            if (!message.deletedAt) onReact(message, "❤️");
          }}
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
          {/* a message that is nothing but links to records IS those records' cards (§5.6) */}
          {message.text && cards.wordsToo && (
            <RichText text={message.text} mentions={mentionNames} mine={mine} />
          )}
          {cards.links.map((link) => (
            <RecordCard key={`${link.kind}-${link.id}`} link={link} onPrimary={mine} />
          ))}
          {!message.deletedAt && (
            <MessageFiles
              files={message.files}
              mine={mine}
              onOpen={(files, index) => onOpenFile(files, index, message.createdAt)}
            />
          )}
          {message.poll && !message.deletedAt && (
            <PollCard
              message={message}
              me={me}
              people={people}
              onPrimary={mine}
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
        <div className="mt-1 flex items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
            aria-label="More"
            // under the ⋯ itself, and the menu then fits itself into the window. A sentinel used
            // to stand here and put the menu in the top-left corner (found in use, 2026-09-20)
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: box.right - 200, y: box.bottom + 6 });
            }}
            className="text-muted hover:text-ink"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </div>
      )}
      {menuAt && (
        <MessageMenu
          message={message}
          at={menuAt}
          can={{
            edit: mine && message.kind !== "poll",
            delete: mine || firmAdmin,
            pin: chat.kind !== "announcements" || firmAdmin,
            readBy: mine && inGroup,
          }}
          onClose={() => setMenuAt(null)}
          on={{
            react: (emoji) => onReact(message, emoji),
            reply: () => onReply(message),
            forward: () => onForward(message),
            copy: () => void navigator.clipboard?.writeText(message.text ?? ""),
            link: () =>
              void navigator.clipboard?.writeText(
                `${window.location.origin}/chat/${chat.id}?m=${message.seq}`,
              ),
            pin: () => onPin(message, !message.pinned),
            readBy: () => onReadBy(message),
            edit: () => onEdit(message),
            remove: () => onDelete(message),
          }}
        />
      )}
    </div>
  );
}
