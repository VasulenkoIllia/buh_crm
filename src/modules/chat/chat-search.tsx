import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { IconButton } from "@/shared/ui/button";
import { IconClose, IconCollapse, IconUp } from "@/shared/ui/icons";
import { useChatSearch } from "./chat.api";
import { foundSpans } from "./rich-text";

/**
 * **The box above the chat list** (chat.md §8), which searches every chat the reader is in.
 * Searching ONE chat is `ChatSearchBar` at the foot of this file, under that chat's own header.
 *
 * It answers in two parts, the way Telegram does (owner, 2026-09-20): the CHATS whose name
 * matches, from the first letter, and then the MESSAGES. The chats are matched here, in the list
 * the screen already holds, so they appear as fast as the typing; the messages are the server's
 * answer and need three letters.
 *
 * The words are sealed, so the server matches keyed hashes of them and opens only what it is about
 * to show (`server/modules/chat/chat.search.ts`). Here that is invisible: three letters or more,
 * anywhere inside a word, and every word of the query must be somewhere in the message.
 */

/** Case and accents folded, so "Petro" finds "PETRO" and "Олена" finds "олена". */
const loose = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

export function ChatSearchBox({
  people,
  onOpen,
  placeholder = "Search messages",
  onActive,
  chats,
  onOpenChat,
}: {
  /** whom the "from" filter offers: every colleague */
  people: { id: string; firstName: string; lastName: string }[];
  onOpen: (hit: ChatSearchHit) => void;
  placeholder?: string;
  /** told while the box is showing results, so what is behind it can stand aside */
  onActive?: (active: boolean) => void;
  /** above the list: the chats to match by name, matched here rather than on the server */
  chats?: { id: string; name: string; subtitle: string }[];
  onOpenChat?: (chatId: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [senderId, setSenderId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hasFiles, setHasFiles] = useState(false);

  const typing = typed.trim();
  const q = useDebounced(typing, 350);
  const enough = q.length >= SEARCH_MIN_WORD;
  /** the chats whose name holds what is being typed, from the first letter */
  const named =
    typing.length > 0 && chats
      ? chats.filter((c) => loose(c.name).includes(loose(typing))).slice(0, 8)
      : [];
  const showing = typing.length > 0 && (enough || named.length > 0);
  const query: ChatSearchQuery = {
    q,
    ...(senderId ? { senderId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(hasFiles ? { hasFiles: true } : {}),
  };
  const found = useChatSearch(query, enough);
  const who = new Map((found.data?.people ?? []).map((p) => [p.id, p]));
  const words = enough ? q.split(/\s+/).filter((w) => w.length >= SEARCH_MIN_WORD) : [];

  useEffect(() => {
    onActive?.(showing);
  }, [showing, onActive]);

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

      {typing.length > 0 && !enough && named.length === 0 && (
        <p className="px-3 pb-2 text-[11.5px] text-muted">
          At least {SEARCH_MIN_WORD} letters, anywhere in a word.
        </p>
      )}

      {showing && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-divider">
          {named.length > 0 && (
            <>
              <p className="bg-divider/50 px-3 py-1 text-[11px] font-semibold text-muted uppercase">
                Chats
              </p>
              {named.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpenChat?.(c.id)}
                  className="flex w-full flex-col border-b border-divider px-3 py-2 text-left hover:bg-divider"
                >
                  <span className="truncate text-[12.5px] font-semibold">{c.name}</span>
                  <span className="truncate text-[11.5px] text-muted">{c.subtitle}</span>
                </button>
              ))}
              <p className="bg-divider/50 px-3 py-1 text-[11px] font-semibold text-muted uppercase">
                Messages
              </p>
            </>
          )}
          {!enough && named.length > 0 && (
            <p className="px-3 py-2 text-[12.5px] text-muted">
              At least {SEARCH_MIN_WORD} letters to search the messages.
            </p>
          )}
          {found.isLoading && <p className="px-3 py-2 text-[12.5px] text-muted">Searching…</p>}
          {found.isError && (
            <p className="px-3 py-2 text-[12.5px] text-danger-text">
              The search did not answer. Try again.
            </p>
          )}
          {enough && found.data && found.data.hits.length === 0 && (
            <p className="px-3 py-2 text-[12.5px] text-muted">
              {named.length > 0 ? "No messages with those words." : "Nothing found."}
            </p>
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
                  <span className="truncate text-[12.5px] font-semibold">{hit.chatLabel}</span>
                  {hit.files > 0 && <Paperclip className="size-3 shrink-0 text-muted" />}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {fmtDate(hit.at)}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">
                  {`${nameOf(who, hit.authorId)}: `}
                  <Found text={hit.snippet} words={words} />
                </span>
              </span>
            </button>
          ))}
          {(found.data?.more || found.data?.narrowed) && (
            <p className="px-3 py-2 text-[11.5px] text-muted">
              The newest 30 are shown. Add a word to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A snippet with the searched words marked, the same way the conversation marks them (§8). */
function Found({ text, words }: { text: string; words: readonly string[] }) {
  const spans = foundSpans(text, words);
  if (spans.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const [from, to] of spans) {
    if (from > cursor) out.push(text.slice(cursor, from));
    out.push(
      <mark key={from} className="rounded-[3px] bg-found px-px text-ink">
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

function nameOf(people: Map<string, ChatPerson>, id: string | null): string {
  const person = id ? people.get(id) : null;
  return person ? `${person.firstName} ${person.lastName}`.trim() : "Somebody";
}

/**
 * **Searching inside one chat, the way Telegram does it** (chat.md §8; owner, 2026-09-20: "треба
 * аналіз того як зроблений пошук в телеграмі і за максимально повторити його").
 *
 * The behaviour, which is the whole point of it, in the order a person meets it:
 *
 * 1. The magnifier in the chat's header opens a bar under it with the caret already inside.
 * 2. Typing shows the matches as a LIST hanging over the conversation — over it, not pushing it,
 *    so the messages do not jump about while somebody is reading the list.
 * 3. The newest match is stepped onto at once: the conversation scrolls to it, the words are
 *    marked inside it, and the message itself is ringed so the eye finds it without hunting.
 * 4. **Stepping closes the list** — with ↑ ↓, or Enter and Shift-Enter, or by clicking a row. The
 *    bar stays, with the query in it and the counter reading "3 of 12", and the conversation is
 *    free to be read.
 * 5. **Clicking the box opens the list again**, at the match currently stood on. That is the part
 *    that makes it feel like Telegram: the search is a place you step in and out of, not a panel
 *    that is either open or shut.
 * 6. Escape, or ×, closes the search and takes the marks away.
 */
export function ChatSearchBar({
  chatId,
  people,
  onGo,
  onWords,
  onClose,
}: {
  chatId: string;
  people: { id: string; firstName: string; lastName: string }[];
  /** jumps the conversation to that message, and rings it while the search stands on it */
  onGo: (messageId: string | null) => void;
  /** what to mark inside the messages while this bar is open (§8) */
  onWords: (words: string[]) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [senderId, setSenderId] = useState("");
  const [at, setAt] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const q = useDebounced(typed.trim(), 300);
  const enough = q.length >= SEARCH_MIN_WORD;
  const found = useChatSearch({ q, chatId, ...(senderId ? { senderId } : {}) }, enough);
  const hits = found.data?.hits ?? [];
  const who = new Map((found.data?.people ?? []).map((p) => [p.id, p]));
  const words = enough ? q.split(/\s+/).filter((w) => w.length >= SEARCH_MIN_WORD) : [];

  // the words the conversation marks: the same ones this bar marks in its own snippets
  const asked = words.join(" ");
  useEffect(() => {
    onWords(asked ? asked.split(" ") : []);
  }, [asked, onWords]);

  /**
   * A new answer opens the list and steps onto its newest match. `dataUpdatedAt` rather than the
   * hits themselves: it moves once per answer, so this does not re-run as the conversation around
   * it re-renders.
   */
  const answered = found.dataUpdatedAt;
  useEffect(() => {
    const first = found.data?.hits[0] ?? null;
    setAt(0);
    setListOpen(!!first);
    onGo(first?.messageId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per answer, by design
  }, [answered]);

  /** Stepping is what the arrows do, and it puts the list away: the conversation is what matters. */
  const step = (by: 1 | -1) => {
    if (hits.length === 0) return;
    const next = (at + by + hits.length) % hits.length;
    setAt(next);
    setListOpen(false);
    onGo(hits[next].messageId);
  };

  const shut = () => {
    onGo(null);
    onWords([]);
    onClose();
  };

  return (
    <div className="relative border-b border-divider bg-surface">
      <div className="flex items-center gap-1.5 px-4 py-2">
        <div className="relative flex-1">
          <Search className="absolute top-2 left-2 size-3.5 text-muted" />
          <input
            ref={field}
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            // back into the box is back into the list, at the match being stood on (step 5)
            onFocus={() => hits.length > 0 && setListOpen(true)}
            onClick={() => hits.length > 0 && setListOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                shut();
              }
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                step(e.key === "ArrowDown" ? 1 : -1);
              }
            }}
            placeholder="Search this chat"
            className="w-full rounded-(--radius-field) border border-border py-1.5 pr-7 pl-7 text-[13px] outline-none focus:border-primary"
          />
          {typed && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => {
                setTyped("");
                setListOpen(false);
                onGo(null);
                field.current?.focus();
              }}
              className="absolute top-2 right-2 text-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {people.length > 2 && (
          <select
            value={senderId}
            onChange={(e) => setSenderId(e.target.value)}
            className="rounded-(--radius-field) border border-border px-2 py-1.5 text-[12.5px] outline-none focus:border-primary"
          >
            <option value="">Anybody</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.firstName} ${p.lastName}`.trim()}
              </option>
            ))}
          </select>
        )}
        <span className="min-w-[58px] shrink-0 text-right text-[11.5px] tabular-nums text-muted">
          {!enough
            ? ""
            : found.isFetching && hits.length === 0
              ? "…"
              : hits.length === 0
                ? "none"
                : `${at + 1} of ${hits.length}`}
        </span>
        <IconButton
          label="Previous match"
          title="Previous (Shift+Enter)"
          size="sm"
          disabled={hits.length === 0}
          onClick={() => step(-1)}
        >
          <IconUp />
        </IconButton>
        <IconButton
          label="Next match"
          title="Next (Enter)"
          size="sm"
          disabled={hits.length === 0}
          onClick={() => step(1)}
        >
          <IconCollapse />
        </IconButton>
        <IconButton label="Close the search" size="sm" onClick={shut}>
          <IconClose />
        </IconButton>
      </div>

      {typed.trim().length > 0 && !enough && (
        <p className="px-4 pb-2 text-[11.5px] text-muted">
          At least {SEARCH_MIN_WORD} letters, anywhere in a word.
        </p>
      )}

      {enough && !found.isFetching && hits.length === 0 && (
        <p className="px-4 pb-2 text-[12px] text-muted">Nothing found in this chat.</p>
      )}

      {/* over the conversation, never pushing it: the messages must not shift while the list is
          being read, and they must be where they were when it closes */}
      {listOpen && hits.length > 0 && (
        <div className="absolute inset-x-0 top-full z-30 max-h-[45vh] overflow-y-auto border-b border-border bg-surface shadow-(--shadow-modal)">
          {hits.map((hit, i) => (
            <button
              key={hit.messageId}
              type="button"
              onClick={() => {
                setAt(i);
                setListOpen(false);
                onGo(hit.messageId);
              }}
              className={cn(
                "flex w-full gap-2 border-b border-divider px-4 py-1.5 text-left",
                i === at ? "bg-divider" : "hover:bg-divider/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-semibold">
                    {nameOf(who, hit.authorId)}
                  </span>
                  {hit.files > 0 && <Paperclip className="size-3 shrink-0 text-muted" />}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {fmtDate(hit.at)}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-1 block text-[12px] text-muted">
                  <Found text={hit.snippet} words={words} />
                </span>
              </span>
            </button>
          ))}
          {(found.data?.more || found.data?.narrowed) && (
            <p className="px-4 py-2 text-[11.5px] text-muted">
              The newest {hits.length} are shown. Add a word to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
