import { useEffect, useRef, useState } from "react";
import { List, Pin, X } from "lucide-react";
import type { ChatMessage } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";

/**
 * **The pinned messages, in ONE line at the top of the chat** (chat.md §5.2), the way Telegram
 * does it (owner, 2026-09-20: "запінених може бути багато… в одній лінії і там кілька повідомлень
 * які при натиску змінюються").
 *
 * It used to list every pin, one under the other, which is fine for two and pushes the
 * conversation off the screen at ten. Now:
 *
 * - one line shows ONE pinned message, the newest first;
 * - a click goes to it and steps to the next, round and round, so the line is how a person walks
 *   through what the chat has pinned;
 * - the ladder on the left says how many there are and which one this is — up to eight rungs, and
 *   a plain "3/12" beside them when there are more than the ladder can show;
 * - the list button opens all of them, for when somebody wants to pick rather than step;
 * - × unpins the one on the line, for those who may.
 */
export function PinnedBar({
  pinned,
  canPin,
  onGo,
  onUnpin,
}: {
  pinned: ChatMessage[];
  canPin: boolean;
  onGo: (message: ChatMessage) => void;
  onUnpin: (message: ChatMessage) => void;
}) {
  /** newest first, which is the order Telegram steps in and the order a reader expects */
  const all = [...pinned].reverse();
  const [at, setAt] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // a pin taken down under the cursor must not leave the line pointing past the end
  useEffect(() => {
    setAt((was) => (all.length === 0 ? 0 : Math.min(was, all.length - 1)));
  }, [all.length]);

  useEffect(() => {
    if (!listOpen) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setListOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [listOpen]);

  if (all.length === 0) return null;
  const current = all[Math.min(at, all.length - 1)];
  const line = (message: ChatMessage) =>
    message.deletedAt
      ? "Message deleted"
      : (message.text?.split("\n")[0] ??
        (message.files.length > 0 ? `${message.files.length} files` : "Message"));

  const stepOn = () => {
    onGo(current);
    if (all.length > 1) setAt((was) => (was + 1) % all.length);
  };

  return (
    <div ref={box} className="relative border-b border-divider bg-[#fafbfc]">
      <div className="flex items-center gap-2 px-4 py-1.5">
        {/* the ladder: one rung per pinned message, the one on the line lit */}
        {all.length > 1 && (
          <span aria-hidden className="flex h-7 w-0.5 shrink-0 flex-col gap-0.5">
            {all.slice(0, 8).map((message, i) => (
              <span
                key={message.id}
                className={cn(
                  "flex-1 rounded-full",
                  i === Math.min(at, 7) ? "bg-primary" : "bg-border",
                )}
              />
            ))}
          </span>
        )}
        <Pin className="size-3 shrink-0 text-muted" />
        <button
          type="button"
          onClick={stepOn}
          className="min-w-0 flex-1 text-left"
          title={all.length > 1 ? "Go to it, then to the next pinned message" : "Go to it"}
        >
          <span className="block text-[11px] font-semibold text-primary">
            {all.length > 1 ? `Pinned message ${at + 1} of ${all.length}` : "Pinned message"}
          </span>
          <span className="block truncate text-[12px] text-ink-700">{line(current)}</span>
        </button>
        {all.length > 1 && (
          <button
            type="button"
            aria-label="All pinned messages"
            title="All pinned messages"
            onClick={() => setListOpen((open) => !open)}
            className={cn("text-muted hover:text-ink", listOpen && "text-ink")}
          >
            <List className="size-4" />
          </button>
        )}
        {canPin && (
          <button
            type="button"
            aria-label="Unpin this message"
            title="Unpin this message"
            onClick={() => onUnpin(current)}
            className="text-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {listOpen && (
        <div className="absolute inset-x-0 top-full z-30 max-h-[45vh] overflow-y-auto border-b border-border bg-surface shadow-(--shadow-modal)">
          {all.map((message, i) => (
            <div
              key={message.id}
              className={cn(
                "flex items-center gap-2 border-b border-divider px-4 py-1.5",
                i === at ? "bg-divider" : "hover:bg-divider/60",
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setAt(i);
                  setListOpen(false);
                  onGo(message);
                }}
                className="min-w-0 flex-1 truncate text-left text-[12px] text-ink-700"
              >
                {line(message)}
              </button>
              {canPin && (
                <button
                  type="button"
                  aria-label="Unpin"
                  onClick={() => onUnpin(message)}
                  className="shrink-0 text-muted hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
