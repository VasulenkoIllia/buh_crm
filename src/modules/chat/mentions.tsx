import type { ChatMember } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/avatar";

/**
 * **`@` names somebody in the chat** (chat.md §5.2): a picker opens on the `@` being typed, the
 * name goes into the text, and the person's id goes with the send, so the mark reaches exactly
 * them. `@all` in a group reaches everybody in it.
 */

export interface Mentionable {
  id: string;
  name: string;
}

export interface Mentioning {
  /** where the `@` stands */
  at: number;
  query: string;
}

/** The `@word` the caret is inside, if it is inside one. */
export function mentionQuery(text: string, caret: number): Mentioning | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // a space ends it, and so does a second line: a mention is one word or two
  if (/\n/.test(query) || query.split(" ").length > 2) return null;
  return { at, query };
}

/** Puts the name in place of what has been typed since the `@`. */
export function putMention(text: string, where: Mentioning, name: string) {
  const head = `${text.slice(0, where.at)}@${name} `;
  // the name is followed by one space, so a space already standing there is not a second one:
  // naming somebody in the middle of a written sentence used to leave "@Iryna Shevchuk  and"
  const tail = text.slice(where.at + 1 + where.query.length).replace(/^ /, "");
  return { text: head + tail, caret: head.length };
}

/** Who the `@` so far could mean, `@all` first: the list the picker draws and the keys walk. */
export interface MentionOption {
  /** null for `@all` */
  id: string | null;
  name: string;
  member: ChatMember | null;
}

export function mentionOptions(members: ChatMember[], query: string): MentionOption[] {
  const words = query.trim().toLowerCase();
  const people = members
    .filter((m) => `${m.firstName} ${m.lastName}`.toLowerCase().includes(words))
    .slice(0, 8)
    .map((member) => ({
      id: member.id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      member,
    }));
  return "all".startsWith(words)
    ? [{ id: null, name: "all", member: null }, ...people]
    : people;
}

/**
 * The picker itself. It draws what it is given and highlights what it is told: the arrows, Enter
 * and Tab are the composer's, because they are keys of the FIELD (found in use, 2026-09-20 — the
 * list could only be clicked).
 */
export function MentionPicker({
  options,
  active,
  onPick,
}: {
  options: MentionOption[];
  active: number;
  onPick: (person: MentionOption) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="absolute bottom-11 left-3 z-20 w-[260px] overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
      {options.map((option, index) => (
        <button
          key={option.id ?? "all"}
          type="button"
          // the field keeps the caret: a click must not take it away before the name goes in
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(option)}
          className={cn(
            "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-divider",
            index === active && "bg-divider",
          )}
        >
          {option.member ? (
            <UserAvatar user={option.member} size="xs" />
          ) : (
            <span className="flex size-6 items-center justify-center rounded-full bg-divider text-[11px]">
              @
            </span>
          )}
          {option.member ? option.name : "Everybody in this chat"}
        </button>
      ))}
    </div>
  );
}
