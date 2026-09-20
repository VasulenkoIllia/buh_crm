/**
 * **The routes that write NO activity row at all** — not even the bare "somebody sent this" one
 * (chat.md §12.2, AGENTS.md "The activity log").
 *
 * Every other changing route leaves a row, and that is what makes "a new route is logged the day it
 * ships" true. These two are a named exception, because they are not acts: they are the chat's own
 * plumbing, they change nothing a person would ever look up, and at one ping every three seconds
 * while somebody types they would be most of the table.
 *
 * `server/activity.coverage.test.ts` holds the shipped routes to exactly this list, so a third one
 * cannot be added quietly.
 */
export const SILENT_ROUTES: Record<string, string> = {
  "POST /api/chat/chats/:id/typing":
    "\u201cOlena is typing\u2026\u201d, thrown away five seconds later and never stored. One ping " +
    "every three seconds while a person types, and nothing to look up afterwards",
  "POST /api/chat/chats/:id/read":
    "how far the reader has read their own chat. It is their own place in a conversation, moved " +
    "by scrolling; the conversation itself is the record",
};
