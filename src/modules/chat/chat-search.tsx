import { useEffect, useState } from "react";
import { Paperclip, Search, SlidersHorizontal, X } from "lucide-react";
import {
  SEARCH_MIN_WORD,
  type ChatPerson,
  type ChatSearchHit,
  type ChatSearchQuery,
} from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { useDebounced } from "@/shared/lib/use-debounced";
import { UserAvatar } from "@/shared/ui/avatar";
import { useChatSearch } from "./chat.api";

/**
 * **The two search boxes** (chat.md §8): the same component above the chat list, where it searches
 * every chat the reader is in, and inside a chat, where `chatId` holds it to that one.
 *
 * The words are sealed, so the server matches keyed hashes of them and opens only what it is about
 * to show (`server/modules/chat/chat.search.ts`). Here that is invisible: three letters or more,
 * anywhere inside a word, and every word of the query must be somewhere in the message.
 */

export function ChatSearchBox({
  chatId,
  people,
  onOpen,
  placeholder = "Search messages",
  onActive,
}: {
  /** set inside a chat, left out above the list */
  chatId?: string;
  /** whom the "from" filter offers: the chat's members, or every colleague */
  people: { id: string; firstName: string; lastName: string }[];
  onOpen: (hit: ChatSearchHit) => void;
  placeholder?: string;
  /** told while the box is showing results, so what is behind it can stand aside */
  onActive?: (active: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [senderId, setSenderId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hasFiles, setHasFiles] = useState(false);

  const q = useDebounced(typed.trim(), 350);
  const enough = q.length >= SEARCH_MIN_WORD;
  const query: ChatSearchQuery = {
    q,
    ...(chatId ? { chatId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(hasFiles ? { hasFiles: true } : {}),
  };
  const found = useChatSearch(query, enough);
  const who = new Map((found.data?.people ?? []).map((p) => [p.id, p]));

  useEffect(() => {
    onActive?.(enough);
  }, [enough, onActive]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <div className="relative flex-1">
          <Search className="absolute top-2 left-2 size-3.5 text-muted" />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-(--radius-field) border border-border py-1.5 pr-7 pl-7 text-[13px] outline-none focus:border-primary"
          />
          {typed && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setTyped("")}
              className="absolute top-2 right-2 text-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Filters"
          onClick={() => setFiltering((open) => !open)}
          className={cn("text-muted hover:text-ink", filtering && "text-ink")}
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </div>

      {filtering && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          <select
            value={senderId}
            onChange={(e) => setSenderId(e.target.value)}
            className="w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[12.5px] outline-none focus:border-primary"
          >
            <option value="">Anybody</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full rounded-(--radius-field) border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-(--radius-field) border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-700">
            <input
              type="checkbox"
              checked={hasFiles}
              onChange={(e) => setHasFiles(e.target.checked)}
            />
            With files
          </label>
        </div>
      )}

      {typed.trim().length > 0 && !enough && (
        <p className="px-3 pb-2 text-[11.5px] text-muted">
          At least {SEARCH_MIN_WORD} letters, anywhere in a word.
        </p>
      )}

      {enough && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-divider">
          {found.isLoading && <p className="px-3 py-2 text-[12.5px] text-muted">Searching…</p>}
          {found.isError && (
            <p className="px-3 py-2 text-[12.5px] text-danger-text">
              The search did not answer. Try again.
            </p>
          )}
          {found.data && found.data.hits.length === 0 && (
            <p className="px-3 py-2 text-[12.5px] text-muted">Nothing found.</p>
          )}
          {found.data?.hits.map((hit) => (
            <button
              key={hit.messageId}
              type="button"
              onClick={() => onOpen(hit)}
              className="flex w-full gap-2 border-b border-divider px-3 py-2 text-left hover:bg-divider"
            >
              {hit.authorId && who.has(hit.authorId) && (
                <UserAvatar user={who.get(hit.authorId) as ChatPerson} size="sm" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-semibold">
                    {chatId ? nameOf(who, hit.authorId) : hit.chatLabel}
                  </span>
                  {hit.files > 0 && <Paperclip className="size-3 shrink-0 text-muted" />}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {fmtDate(hit.at)}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">
                  {chatId ? hit.snippet : `${nameOf(who, hit.authorId)}: ${hit.snippet}`}
                </span>
              </span>
            </button>
          ))}
          {found.data?.more && (
            <p className="px-3 py-2 text-[11.5px] text-muted">
              The newest 30 are shown. Add a word to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function nameOf(people: Map<string, ChatPerson>, id: string | null): string {
  const person = id ? people.get(id) : null;
  return person ? `${person.firstName} ${person.lastName}`.trim() : "Somebody";
}
