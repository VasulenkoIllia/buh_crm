/**
 * **Changing routes allowed to describe nothing.**
 *
 * `server/test/check-activity-routes.ts` fails `npm run verify` when a route that changes something
 * leaves only a bare "sent /api/…" row on every successful call. These are the exceptions, and each
 * says why the request is not an act on the firm's records. "It would take effort" is not a reason —
 * see AGENTS.md, "The activity log". The rows are still written; the screen hides them unless asked.
 */
export const QUIET_ROUTES: Record<string, string> = {
  "POST /api/notifications/:id/read":
    "marks the reader's own notification read — their inbox, not the firm's records",
  "POST /api/notifications/read-all": "the same, for every notification the reader has",
  "PUT /api/notifications/preferences": "the reader's own settings for what reaches them",
  "PUT /api/clients/:id/pin":
    "pins a client in the reader's own list — a bookmark, not a change to the client",
  "DELETE /api/clients/:id/pin": "removes that bookmark",
  "POST /api/mailouts/preview": "renders a letter to look at; nothing is stored or sent",
  "POST /api/mailouts/preview/letter": "the same, for a single letter",
  "POST /api/two-factor/me/setup":
    "stores an UNCONFIRMED secret on the caller's own row — nothing is switched on until the " +
    "confirm, which is the act and records `user.two_factor_enabled` (two-factor.md §6.1)",
  "POST /api/chat/direct":
    "opens the caller's direct chat with a colleague, made the first time; a conversation is its " +
    "own record, and the log's meaning starts where a group's people change (chat.md §12.1)",
  "POST /api/chat/saved": "opens the caller's own Saved messages, made the first time",
  "PUT /api/chat/chats/:id/settings":
    "mutes, pins or hides a chat in the caller's own list; nobody else's chat changes",
  "POST /api/chat/chats/:id/messages":
    "a message sent. The conversation is its own record, with its authors and times; the log's " +
    "meaning starts where membership or a deletion changes (chat.md §12.1, §12.2)",
  "PATCH /api/chat/messages/:messageId": "a message edited by its author, for the same reason",
  "POST /api/chat/forward": "the same words sent again in another chat the sender is in",
  "PUT /api/chat/messages/:messageId/reaction": "an emoji on a message, and taking it back",
  "PUT /api/chat/messages/:messageId/pin":
    "a message pinned at the top of its chat, or unpinned",
  "PUT /api/chat/messages/:messageId/vote": "an answer in a poll, which the poll itself shows",
  "POST /api/chat/messages/:messageId/poll/close":
    "a poll closed by its author or a group's admin",
  "POST /api/chat/stream/ping":
    "the live connection's delivery test: sends the caller an event of their own and stores " +
    "nothing (chat.md §15.1, step 0.4)",
};
