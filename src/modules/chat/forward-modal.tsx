import { useState } from "react";
import { Search } from "lucide-react";
import type { ChatSummary } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { chatTitle } from "./chat-list";

/**
 * **Where a message goes on to** (chat.md §5.2). The route has been there since stage A; this is
 * the button it was missing, which is why nobody could forward anything from the screen
 * (found in use, 2026-09-20).
 *
 * The list is the reader's own chats, because those are the only ones the server will accept.
 */
export function ForwardModal({
  chats,
  onSend,
  onClose,
}: {
  chats: ChatSummary[];
  onSend: (chatIds: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const words = typed.trim().toLowerCase();
  const shown = words
    ? chats.filter((chat) => chatTitle(chat).toLowerCase().includes(words))
    : chats;

  return (
    <Modal open onClose={onClose} title="Forward to">
      <div className="relative mb-2">
        <Search className="absolute top-2 left-2 size-3.5 text-muted" />
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Which chat"
          className="w-full rounded-(--radius-field) border border-border py-1.5 pr-2 pl-7 text-[13px] outline-none focus:border-primary"
        />
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        {shown.length === 0 && (
          <p className="py-2 text-[12.5px] text-muted">Nothing matches.</p>
        )}
        {shown.map((chat) => {
          const on = picked.includes(chat.id);
          return (
            <button
              key={chat.id}
              type="button"
              onClick={() =>
                setPicked((was) =>
                  was.includes(chat.id)
                    ? was.filter((id) => id !== chat.id)
                    : [...was, chat.id],
                )
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-1.5 text-left text-[13px]",
                on ? "bg-divider font-semibold" : "hover:bg-divider",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{chatTitle(chat)}</span>
              {on && <span className="text-[11px] text-primary">picked</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={picked.length === 0} onClick={() => onSend(picked)}>
          Forward{picked.length > 1 ? ` to ${picked.length}` : ""}
        </Button>
      </div>
    </Modal>
  );
}
