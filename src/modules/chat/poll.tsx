import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import type { ChatMessage, ChatPerson } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";

/**
 * **A poll** (chat.md §5.5): a question with 2 to 10 options, one answer or several, and never
 * anonymous, so everybody in the chat sees who chose what. A vote changes until its author or the
 * firm's admin closes it.
 *
 * **It is drawn twice**, because a bubble the reader sent is the primary colour and one they
 * received is the surface (owner, 2026-09-20: "не чітке опитування — вигляд"). The first version
 * used the surface palette in both, so on the sender's own bubble the counts, the bar and the
 * "Close the poll" line were dark blue on blue. Every colour here is chosen by `onPrimary`.
 *
 * **An answer changes**, and the card says so: the option the reader chose carries a filled mark,
 * and the line under the options reads "Tap an option to change your answer" until the poll is
 * closed. Choosing the same option again takes the vote back.
 */

export function PollCard({
  message,
  me,
  people,
  onPrimary = false,
  canClose,
  onVote,
  onClose,
}: {
  message: ChatMessage;
  me: string;
  people: Map<string, ChatPerson>;
  /** drawn on the reader's own bubble, which is the primary colour */
  onPrimary?: boolean;
  canClose: boolean;
  onVote: (options: number[]) => void;
  onClose: () => void;
}) {
  const poll = message.poll;
  if (!poll) return null;
  const mine = new Set(poll.votes.filter((v) => v.userIds.includes(me)).map((v) => v.option));
  const voters = new Set(poll.votes.flatMap((v) => v.userIds));
  const closed = poll.closedAt !== null;
  const faint = onPrimary ? "text-white/80" : "text-muted";

  const choose = (option: number) => {
    if (closed) return;
    if (poll.multiple) {
      const next = mine.has(option) ? [...mine].filter((o) => o !== option) : [...mine, option];
      onVote(next);
    } else {
      onVote(mine.has(option) ? [] : [option]);
    }
  };

  return (
    <div className="mt-1 w-[min(420px,100%)]">
      <p className={cn("text-[11.5px]", faint)}>
        {poll.multiple ? "Several answers" : "One answer"}
        {closed ? " · closed" : ""} · {voters.size} voted
      </p>
      {poll.options.map((option, i) => {
        const count = poll.votes.find((v) => v.option === i)?.userIds.length ?? 0;
        const share = voters.size === 0 ? 0 : Math.round((count / voters.size) * 100);
        const chosen = mine.has(i);
        const names = (poll.votes.find((v) => v.option === i)?.userIds ?? [])
          .map((id) => {
            const person = people.get(id);
            return person ? `${person.firstName} ${person.lastName}`.trim() : "Somebody";
          })
          .join(", ");
        return (
          <button
            key={i}
            type="button"
            disabled={closed}
            onClick={() => choose(i)}
            title={names}
            aria-pressed={chosen}
            className={cn(
              "relative mt-1 block w-full overflow-hidden rounded-(--radius-field) border px-2 py-1.5 text-left text-[12.5px]",
              onPrimary
                ? cn("text-white", chosen ? "border-white" : "border-white/40")
                : chosen
                  ? "border-primary"
                  : "border-border",
              !closed && (onPrimary ? "hover:border-white" : "hover:border-primary"),
              closed && "cursor-default",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-0 transition-[width]",
                onPrimary ? "bg-white/25" : "bg-divider",
              )}
              style={{ width: `${share}%` }}
            />
            <span className="relative flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "grid size-3.5 shrink-0 place-items-center border",
                  poll.multiple ? "rounded-[3px]" : "rounded-full",
                  onPrimary
                    ? chosen
                      ? "border-white bg-white"
                      : "border-white/60"
                    : chosen
                      ? "border-primary bg-primary"
                      : "border-border",
                )}
              >
                {chosen && (
                  <Check
                    className={cn("size-2.5", onPrimary ? "text-primary" : "text-white")}
                    strokeWidth={3}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 break-words">{option}</span>
              <span className={cn("shrink-0 text-[11.5px] tabular-nums", faint)}>
                {share}% · {count}
              </span>
            </span>
          </button>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className={cn("text-[11.5px]", faint)}>
          {closed
            ? "The poll is closed"
            : mine.size > 0
              ? "Tap an option to change your answer"
              : "Tap an option to answer"}
        </p>
        {!closed && canClose && (
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "shrink-0 text-[11.5px] hover:underline",
              onPrimary ? "text-white" : "text-primary-link",
            )}
          >
            Close the poll
          </button>
        )}
      </div>
    </div>
  );
}

export function NewPoll({
  onCreate,
  onClose,
}: {
  onCreate: (poll: { question: string; options: string[]; multiple: boolean }) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const ready = question.trim() !== "" && options.filter((o) => o.trim()).length >= 2;

  return (
    <Modal
      open
      onClose={onClose}
      title="New poll"
      footer={
        <Button
          disabled={!ready}
          onClick={() =>
            onCreate({
              question: question.trim(),
              options: options.map((o) => o.trim()).filter(Boolean),
              multiple,
            })
          }
        >
          Ask
        </Button>
      }
    >
      <input
        autoFocus
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Question"
        className="mb-2 w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary"
      />
      {options.map((option, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1">
          <input
            value={option}
            onChange={(e) =>
              setOptions((was) => was.map((o, j) => (i === j ? e.target.value : o)))
            }
            placeholder={`Option ${i + 1}`}
            className="flex-1 rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary"
          />
          {options.length > 2 && (
            <button
              type="button"
              aria-label="Remove option"
              onClick={() => setOptions((was) => was.filter((_, j) => j !== i))}
              className="text-muted hover:text-danger-text"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      {options.length < 10 && (
        <button
          type="button"
          onClick={() => setOptions((was) => [...was, ""])}
          className="mb-2 text-[12px] text-primary-link hover:underline"
        >
          <Plus className="mr-1 inline size-3.5" />
          Add an option
        </button>
      )}
      <label className="flex items-center gap-2 text-[12.5px]">
        <input
          type="checkbox"
          checked={multiple}
          onChange={(e) => setMultiple(e.target.checked)}
        />
        Several answers
      </label>
      <p className="mt-2 text-[12px] text-muted">Everybody in the chat sees who chose what.</p>
    </Modal>
  );
}
