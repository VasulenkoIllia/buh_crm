import type { ChatMessage, ChatMessageKind } from "@shared/schema/chat";

/**
 * The marks are for reading a message, not for a one-line preview: `**Friday**` in a list is
 * noise, and that is exactly what it looked like in use (found 2026-09-20).
 */
export function plain(text: string): string {
  return text
    .replace(/```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/(^|[\s(])_(.+?)_(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^>\s?/gm, "");
}

/**
 * **The one line that says what a message is**: the chat list's last line, the quote above a
 * reply, the composer's "Replying to" and the pinned bar.
 *
 * Each of them used to say it its own way, and only the list knew that a photo sent with no words
 * has no first line. The composer read the missing text as "Message deleted", so replying to a
 * photo announced it gone (owner, 2026-10-07); the quote showed a name and a blank; the pinned bar
 * said "1 files". `words` is the first line, as each caller holds it.
 */
export function lineOf(message: {
  deleted: boolean;
  kind: ChatMessageKind;
  words: string | null;
  files: number;
}): string {
  if (message.deleted) return "Message deleted";
  const words = plain(message.words ?? "").trim();
  if (message.kind === "poll") return `Poll: ${words}`;
  if (message.files > 0) {
    const carried = message.files === 1 ? "File" : `${message.files} files`;
    return words ? `${carried} · ${words}` : carried;
  }
  return words;
}

/** A whole message, as the composer and the pinned bar hold it. */
export const messageLine = (message: ChatMessage): string =>
  lineOf({
    deleted: message.deletedAt !== null,
    kind: message.kind,
    words: message.text?.split("\n")[0] ?? null,
    files: message.files.length,
  }) || "Message";
