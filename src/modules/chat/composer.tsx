import { useEffect, useRef, useState } from "react";
import { BarChart3, Paperclip, Send, Smile, X } from "lucide-react";
import {
  CHAT_FILES_MAX,
  MESSAGE_LIMIT,
  type ChatMember,
  type ChatMessage,
} from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { AttachmentStrip, useAttachments } from "./attachments";
import { EmojiPicker } from "./emoji-picker";
import { MentionPicker, mentionQuery, putMention, type Mentionable } from "./mentions";
import { wrapSelection } from "./rich-text";

/**
 * **What a person types** (chat.md §17, decision 13): a plain field with marks, Enter to send and
 * Shift+Enter for a new line, Ctrl+B and Ctrl+I around the selection, an emoji picker, and the bar
 * that says what is being replied to or edited.
 *
 * The draft stays on this computer while the reader walks away from the chat and comes back (§4.2).
 */

const DRAFTS = "chat.drafts";

function drafts(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(DRAFTS) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function keepDraft(chatId: string, text: string) {
  try {
    const all = drafts();
    if (text.trim()) all[chatId] = text;
    else delete all[chatId];
    window.localStorage.setItem(DRAFTS, JSON.stringify(all));
  } catch {
    // storage switched off: the draft simply does not outlive the screen
  }
}

export function Composer({
  chatId,
  members,
  replyTo,
  editing,
  disabled,
  canPoll,
  onSend,
  onEdit,
  onCancel,
  onTyping,
  onPoll,
}: {
  chatId: string;
  /** who can be named with `@` in this chat (§5.2) */
  members: ChatMember[];
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  disabled?: string | null;
  canPoll: boolean;
  onSend: (
    text: string,
    mentions: string[],
    files: { fileId: string; previewFileId: string | null }[],
  ) => void;
  onEdit: (text: string) => void;
  onCancel: () => void;
  onTyping: () => void;
  onPoll: () => void;
}) {
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const attached = useAttachments(chatId);
  const [refused, setRefused] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** whom the person has named so far, so the server marks exactly them (§5.2) */
  const [named, setNamed] = useState<Mentionable[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  /**
   * Where the caret belongs once React has drawn the new text. Setting it straight after
   * `setText` puts it on the value the field still holds, and the browser then drops it to the
   * start: typing after picking a mention landed before the name (found in the browser, A.6).
   */
  const caretAfter = useRef<{ start: number; end: number } | null>(null);
  const caret = field.current?.selectionStart ?? text.length;
  const [mentionsOff, setMentionsOff] = useState(false);
  const mentioning = mentionsOff ? null : mentionQuery(text, caret);

  useEffect(() => {
    setText(editing?.text ?? drafts()[chatId] ?? "");
    field.current?.focus();
  }, [chatId, editing]);

  useEffect(() => {
    if (!editing) keepDraft(chatId, text);
  }, [chatId, text, editing]);

  // the field grows with the text, up to about eight lines, and the caret goes where it was put
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    const want = caretAfter.current;
    if (!want) return;
    caretAfter.current = null;
    el.focus();
    el.setSelectionRange(want.start, want.end);
  }, [text]);

  const submit = () => {
    const body = text.trim();
    const files = attached.forSend();
    // a message needs words or files, and a file still going up is not one yet (§6.1)
    if (!body && files.length === 0) return;
    // …and one that did not go up at all must be dealt with rather than dropped from the send in
    // silence, which is what happened before (review, 2026-09-20)
    if (attached.busy || attached.failed > 0) return;
    if (editing) {
      if (!body) return;
      onEdit(body);
    } else {
      // everybody whose name is still in the text, and everybody when the text says `@all`
      const all = /(^|\s)@all\b/.test(body);
      const ids = all
        ? members.map((m) => m.id)
        : named.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
      onSend(body, [...new Set(ids)], files);
    }
    setText("");
    setNamed([]);
    attached.clear();
    setRefused(null);
    keepDraft(chatId, "");
  };

  /** Picked, dropped or pasted — one door, so what is refused is said the same way every time. */
  const take = (files: File[]) => {
    if (files.length === 0) return;
    const { refused: no, tooBig, tooMany } = attached.add(files);
    const said = [
      no.length > 0 ? `${no.join(", ")}: programs are not accepted` : "",
      tooBig.length > 0 ? `${tooBig.join(", ")}: over 25 MB` : "",
      tooMany ? `A message carries at most ${CHAT_FILES_MAX} files` : "",
    ].filter(Boolean);
    setRefused(said.length > 0 ? said.join(". ") : null);
  };

  const mark = (marks: string) => {
    const el = field.current;
    if (!el) return;
    const next = wrapSelection(text, el.selectionStart, el.selectionEnd, marks);
    caretAfter.current = { start: next.start, end: next.end };
    setText(next.text);
  };

  const insert = (emoji: string) => {
    const el = field.current;
    const at = el?.selectionStart ?? text.length;
    caretAfter.current = { start: at + emoji.length, end: at + emoji.length };
    setText(`${text.slice(0, at)}${emoji}${text.slice(at)}`);
    setPicking(false);
  };

  if (disabled) {
    return (
      <div className="border-t border-divider px-4 py-3 text-[12.5px] text-muted">
        {disabled}
      </div>
    );
  }

  const left = MESSAGE_LIMIT - text.length;

  return (
    <div className="border-t border-divider bg-surface">
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 border-b border-divider px-4 py-1.5 text-[12px]">
          <span className="font-semibold text-ink-700">
            {editing ? "Editing" : "Replying to"}
          </span>
          <span className="truncate text-muted">
            {(editing ?? replyTo)?.text?.split("\n")[0] ?? "Message deleted"}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="ml-auto text-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <AttachmentStrip queue={attached} />
      {attached.failed > 0 && (
        <p className="px-4 pt-1.5 text-[11.5px] text-danger-text">
          {attached.failed === 1
            ? "A file did not go up"
            : `${attached.failed} files did not go up`}
          . Try again, or take it off.
        </p>
      )}
      {refused && <p className="px-4 pt-1.5 text-[11.5px] text-danger-text">{refused}</p>}
      <div className="relative flex items-end gap-2 px-3 py-2">
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder="Write a message"
          onChange={(e) => {
            setText(e.target.value);
            setMentionsOff(false);
            onTyping();
          }}
          onPaste={(e) => {
            // a screenshot pasted into the field is a photo to send, not text (§6.1)
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            take(pasted);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            take([...e.dataTransfer.files]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
              return;
            }
            if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "i")) {
              e.preventDefault();
              mark(e.key === "b" ? "**" : "_");
            }
            if (e.key === "Escape") {
              // the @ picker first, then whatever the bar above the field is holding
              if (mentioning !== null) setMentionsOff(true);
              else if (replyTo || editing) onCancel();
            }
          }}
          className={cn(
            "max-h-[180px] flex-1 resize-none rounded-(--radius-field) border border-border px-3 py-2",
            "text-[13px] outline-none focus:border-primary",
          )}
        />
        {!editing && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                take([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="Attach"
              onClick={() => picker.current?.click()}
              className="mb-1 text-muted hover:text-ink"
            >
              <Paperclip className="size-[18px]" />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Emoji"
          onClick={() => setPicking((open) => !open)}
          className="mb-1 text-muted hover:text-ink"
        >
          <Smile className="size-[18px]" />
        </button>
        {picking && <EmojiPicker onPick={insert} onClose={() => setPicking(false)} />}
        {mentioning !== null && (
          <MentionPicker
            members={members}
            query={mentioning.query}
            onPick={(person) => {
              const next = putMention(text, mentioning, person.name);
              caretAfter.current = { start: next.caret, end: next.caret };
              setText(next.text);
              if (person.id) setNamed((was) => [...was, { id: person.id!, name: person.name }]);
            }}
          />
        )}
        {canPoll && !editing && (
          <button
            type="button"
            aria-label="Poll"
            onClick={onPoll}
            className="mb-1 text-muted hover:text-ink"
          >
            <BarChart3 className="size-[18px]" />
          </button>
        )}
        <Button
          size="sm"
          className="mb-0.5"
          disabled={
            attached.busy ||
            attached.failed > 0 ||
            (!text.trim() && (editing !== null || attached.items.length === 0))
          }
          onClick={submit}
        >
          <Send className="size-3.5" />
          {editing ? "Save" : attached.busy ? "Uploading…" : "Send"}
        </Button>
      </div>
      {left < 200 && (
        <p
          className={cn(
            "px-4 pb-1.5 text-[11px]",
            left < 0 ? "text-danger-text" : "text-muted",
          )}
        >
          {left < 0 ? `${-left} over the limit` : `${left} left`}
        </p>
      )}
    </div>
  );
}
