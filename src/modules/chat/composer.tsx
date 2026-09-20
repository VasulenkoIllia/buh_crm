import { useEffect, useRef, useState } from "react";
import { Send, Smile, X } from "lucide-react";
import { MESSAGE_LIMIT, type ChatMessage } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { EmojiPicker } from "./emoji-picker";
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
  replyTo,
  editing,
  disabled,
  onSend,
  onEdit,
  onCancel,
  onTyping,
}: {
  chatId: string;
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  disabled?: string | null;
  onSend: (text: string) => void;
  onEdit: (text: string) => void;
  onCancel: () => void;
  onTyping: () => void;
}) {
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(editing?.text ?? drafts()[chatId] ?? "");
    field.current?.focus();
  }, [chatId, editing]);

  useEffect(() => {
    if (!editing) keepDraft(chatId, text);
  }, [chatId, text, editing]);

  // the field grows with the text, up to about eight lines
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    if (editing) onEdit(body);
    else onSend(body);
    setText("");
    keepDraft(chatId, "");
  };

  const mark = (marks: string) => {
    const el = field.current;
    if (!el) return;
    const next = wrapSelection(text, el.selectionStart, el.selectionEnd, marks);
    setText(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };

  const insert = (emoji: string) => {
    const el = field.current;
    const at = el?.selectionStart ?? text.length;
    setText(`${text.slice(0, at)}${emoji}${text.slice(at)}`);
    setPicking(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + emoji.length, at + emoji.length);
    });
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
      <div className="relative flex items-end gap-2 px-3 py-2">
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder="Write a message"
          onChange={(e) => {
            setText(e.target.value);
            onTyping();
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
            if (e.key === "Escape" && (replyTo || editing)) onCancel();
          }}
          className={cn(
            "max-h-[180px] flex-1 resize-none rounded-(--radius-field) border border-border px-3 py-2",
            "text-[13px] outline-none focus:border-primary",
          )}
        />
        <button
          type="button"
          aria-label="Emoji"
          onClick={() => setPicking((open) => !open)}
          className="mb-1 text-muted hover:text-ink"
        >
          <Smile className="size-[18px]" />
        </button>
        {picking && <EmojiPicker onPick={insert} onClose={() => setPicking(false)} />}
        <Button size="sm" className="mb-0.5" disabled={!text.trim()} onClick={submit}>
          <Send className="size-3.5" />
          {editing ? "Save" : "Send"}
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
