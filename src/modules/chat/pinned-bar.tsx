import { Pin, X } from "lucide-react";
import type { ChatMessage } from "@shared/schema/chat";

/**
 * **The pinned messages, in a bar at the top of the chat** (chat.md §5.2). A click goes to the
 * message; those who may pin may also take it down.
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
  if (pinned.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-divider bg-[#fafbfc] px-4 py-1.5">
      {pinned.map((message) => (
        <div key={message.id} className="flex items-center gap-2 text-[12px]">
          <Pin className="size-3 shrink-0 text-muted" />
          <button
            type="button"
            onClick={() => onGo(message)}
            className="min-w-0 flex-1 truncate text-left text-ink-700 hover:underline"
          >
            {message.text?.split("\n")[0] ?? "Message deleted"}
          </button>
          {canPin && (
            <button
              type="button"
              aria-label="Unpin"
              onClick={() => onUnpin(message)}
              className="text-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
