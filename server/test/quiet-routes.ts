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
};
