import type { ChatMember } from "@shared/schema/chat";
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
  return { text: head + text.slice(where.at + 1 + where.query.length), caret: head.length };
}

export function MentionPicker({
  members,
  query,
  onPick,
}: {
  members: ChatMember[];
  query: string;
  onPick: (person: { id: string | null; name: string }) => void;
}) {
  const words = query.trim().toLowerCase();
  const found = members
    .filter((m) => `${m.firstName} ${m.lastName}`.toLowerCase().includes(words))
    .slice(0, 8);
  const all = "all".startsWith(words);
  if (found.length === 0 && !all) return null;

  return (
    <div className="absolute bottom-11 left-3 z-20 w-[260px] overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
      {all && (
        <button
          type="button"
          onClick={() => onPick({ id: null, name: "all" })}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-divider"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-divider text-[11px]">
            @
          </span>
          Everybody in this chat
        </button>
      )}
      {found.map((member) => (
        <button
          key={member.id}
          type="button"
          onClick={() =>
            onPick({ id: member.id, name: `${member.firstName} ${member.lastName}`.trim() })
          }
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-divider"
        >
          <UserAvatar user={member} size="xs" />
          {member.firstName} {member.lastName}
        </button>
      ))}
    </div>
  );
}
