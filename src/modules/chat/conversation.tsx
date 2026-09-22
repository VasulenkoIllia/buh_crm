import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import type { ChatDetail, ChatFile, ChatMessage, ChatPerson } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { MessageRow, nameOf } from "./message-row";

/**
 * **The conversation** (chat.md §7.2, §17): only what is on screen is drawn, however long the chat
 * is, history comes in pages as one scrolls up, and a new message keeps the view at the bottom when
 * the reader is already there.
 */

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
  found = [],
  standingOn = null,
  goTo,
  goToSeq,
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
  /** the words this chat's search is looking for, marked inside the messages (§8) */
  found?: readonly string[];
  /** the match the search is standing on, ringed so the eye finds it without hunting */
  standingOn?: string | null;
  /** the message to go to, with the number of the ask: asking for the same one again is a jump */
  goTo: { id: string; nth: number } | null;
  /** …or one named by its place, which is what a link to a message carries (§5.2) */
  goToSeq: number | null;
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

  /**
   * **Where the list starts inside the scroll box.** Above it sit the container's own padding and
   * the "Scroll up for earlier messages" line, and a virtual item's offset is measured from the
   * list, not from the box. Without telling the virtualiser about the difference, "go to the
   * newest" landed some 36px short — under the 80px that counts as being at the bottom, so no
   * button appeared and the last message stayed clipped (audit, 2026-09-20).
   */
  const list = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  useLayoutEffect(() => {
    if (list.current) setListTop(list.current.offsetTop);
  }, [more, loadingMore]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => box.current,
    estimateSize: () => 64,
    scrollMargin: listTop,
    overscan: 8,
    getItemKey: (i) => {
      const row = rows[i];
      if (row.kind === "day") return `day-${row.day}`;
      return row.kind === "unread" ? "unread" : row.message.id;
    },
  });

  /**
   * The newest message is the one to be at, unless the reader has scrolled up to read.
   *
   * `total` is in the dependencies on purpose: a photo's row is 64px of estimate until the picture
   * decodes, and re-measuring it afterwards is what makes the total move. Without it a screenshot
   * arriving while the reader sat at the bottom scrolled 64px and then unfolded below the fold
   * (audit, 2026-09-20).
   */
  const total = virtual.getTotalSize();
  useLayoutEffect(() => {
    if (atBottom && rows.length > 0) virtual.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, total, atBottom, virtual]);

  /**
   * The pinned bar and a reply's quote ask for a message by id, ONCE. Without remembering that it
   * has been done, every live event re-ran the scroll and the conversation kept jumping back to
   * the pinned message (review, 2026-09-20).
   *
   * **The ask carries a number**, because asking for the SAME message twice is a real thing to do:
   * scroll away from a pinned message, click the bar again. Keyed by the id alone, the second
   * click set the same state, changed nothing, and did nothing for ever after (audit, 2026-09-20).
   */
  const [asked, setAsked] = useState<{ id: string; nth: number } | null>(null);
  const onGoToMessage = useCallback(
    (id: string) => setAsked((was) => ({ id, nth: (was?.nth ?? 0) + 1 })),
    [],
  );
  const wentTo = useRef<string | null>(null);
  /**
   * A message the search found can be a long way up. The conversation loads older pages until it
   * has it, at most this many — twenty pages is a thousand messages, which is further than anybody
   * scrolls and far enough that the search is not a promise the screen breaks.
   */
  const HUNT = 20;
  const hunted = useRef(0);
  /**
   * WHICH target the pages above were loaded for. The budget belongs to one target, and without
   * this it was shared: asking for a second message while the first was still being hunted let the
   * second inherit what the first had spent and give up early on a message twenty pages up
   * (audit, 2026-09-21).
   */
  const hunting = useRef<string | null>(null);
  /**
   * **Older messages arrive above, and the reader stays where they were.** A prepended page grows
   * everything below it, so without putting the scroll back by exactly that much the conversation
   * jumps on every "scroll up for more" (review, 2026-09-20). Armed by whoever asks for a page:
   * the scroll handler below, and the hunt above.
   */
  const heldHeight = useRef<number | null>(null);
  /** a link to a message this chat does not have any more; said once, above the conversation */
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    // ONE target, and the key that says whether it has already been gone to. An ask from the
    // screen wins over the address, and the two are never mixed: matching "this id OR that seq"
    // let whichever came first in the list win, so a link and a click at the same moment sent the
    // reader to the wrong message and marked the other as done (audit, 2026-09-20)
    const target = asked
      ? { key: `${asked.id}#${asked.nth}`, of: (m: ChatMessage) => m.id === asked.id }
      : goTo
        ? { key: `${goTo.id}#${goTo.nth}`, of: (m: ChatMessage) => m.id === goTo.id }
        : goToSeq !== null
          ? { key: `seq:${goToSeq}`, of: (m: ChatMessage) => m.seq === goToSeq }
          : null;
    if (!target || wentTo.current === target.key) {
      hunted.current = 0;
      hunting.current = null;
      return;
    }
    if (hunting.current !== target.key) {
      hunting.current = target.key;
      hunted.current = 0;
    }
    const at = rows.findIndex((r) => r.kind === "message" && target.of(r.message));
    if (at < 0) {
      if (more && !loadingMore && hunted.current < HUNT) {
        hunted.current++;
        // the hunt is a scroll of its own: hold the reader's place while the page arrives, and
        // stop sticking to the newest line, or the two effects pull against each other and the
        // conversation flickers all the way up (review, 2026-09-20)
        heldHeight.current = box.current?.scrollHeight ?? null;
        setAtBottom(false);
        onLoadMore();
        return;
      }
      if (loadingMore) return;
      // **the hunt is over and the message is not there** — deleted since the link was sent, or
      // further up than the hunt goes. Giving up silently left the reader stranded at the top of
      // a thousand messages with `?m=` still in the address, so a reload did it all again
      // (audit, 2026-09-20)
      wentTo.current = target.key;
      hunted.current = 0;
      hunting.current = null;
      setMissing(true);
      if (!asked) onWent?.();
      return;
    }
    wentTo.current = target.key;
    hunted.current = 0;
    hunting.current = null;
    setMissing(false);
    virtual.scrollToIndex(at, { align: "center" });
    if (!asked) onWent?.();
  }, [asked, goTo, goToSeq, rows, virtual, onWent, more, loadingMore, onLoadMore]);

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
    const mark = () => {
      if (atBottom && newest > 0 && document.hasFocus()) onRead(newest);
    };
    mark();
    // …and again when the window comes back: a message that arrived while the tab was behind
    // another one stayed unread until something else moved (audit, 2026-09-20)
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [atBottom, newest, onRead]);

  return (
    <div ref={box} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
      {missing && (
        <p className="mb-2 rounded-(--radius-field) bg-divider px-3 py-2 text-center text-[12px] text-muted">
          That message is not here any more.
        </p>
      )}
      {more && (
        <p className="pb-2 text-center text-[12px] text-muted">
          {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
        </p>
      )}
      <div
        ref={list}
        style={{ height: virtual.getTotalSize(), position: "relative", width: "100%" }}
      >
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
                transform: `translateY(${item.start - virtual.options.scrollMargin}px)`,
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
                <MessageRow
                  found={found}
                  standingOn={standingOn === row.message.id}
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
