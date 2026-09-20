/**
 * **What travels on the live connection** (chat.md §7.1), shared because both ends read it: the
 * server writes these events and the browser's `EventSource` listens for them by name.
 *
 * Events carry ids and small tokens, never content. The tab fetches what an event names through the
 * ordinary routes, whose checks apply, so nothing here can show anybody something they could not
 * already open. `core/realtime.ts` enforces it on every publish.
 */

/**
 * Why the server closed a stream the browser must not simply reopen (`chat.stream.ts`).
 *
 * - `too_many_streams`: the person opened an eleventh tab. Reopening would close the next-oldest,
 *   and the tabs would take turns for ever.
 * - `session_ended`: the session the stream was opened under is gone (signed out, blocked, a
 *   password changed, expired). The tab asks who it is before opening again: a password changed
 *   on THIS computer comes with a fresh session, and then the stream reopens under it.
 * - `gate_closed`: the `chat` gate is closed for this person now.
 * - `two_factor_required`: the firm's two-factor rule is holding this person back, as it would any
 *   other request.
 */
export type ByeReason =
  "too_many_streams" | "session_ended" | "gate_closed" | "two_factor_required";

/** Every event a stream can carry, by name. */
export interface RealtimeEvents {
  /** the first event of every stream */
  hello: { streamId: string; heartbeatMs: number };
  /**
   * Every `heartbeatMs`, to keep proxies from idling the connection out. An event rather than an
   * SSE comment, because a browser never sees a comment: this is also how a tab notices a connection
   * that died without closing, and opens a new one.
   */
  heartbeat: Record<string, never>;
  /** the stream is about to end, and the tab must not reconnect */
  bye: { reason: ByeReason };
  /**
   * The server may have missed events (its listener lost the database and came back), so the tab
   * refetches everything it holds. Sent by the process itself, never published.
   */
  resync: Record<string, never>;
  /** the answer to a delivery test, which measures the round trip (`POST /api/chat/stream/ping`) */
  pong: { pingId: string };
  /**
   * A colleague came online (their first tab opened) or went offline (their last tab closed, and
   * stayed closed for a short grace, so a reload does not flicker). Every colleague sees it
   * (chat.md §5.4). The list as it stands is `GET /api/chat/presence`.
   */
  presence: { userId: string; online: boolean };
  /**
   * A chat's name, people or roles changed, or the reader left or was taken out of it: the tab
   * refetches the chat list and that chat. Sent to everybody it concerns, the people taken out
   * included, so their list drops it at once.
   */
  chat_updated: { chatId: string };
  /** a message was sent: the tab fetches what is after the `seq` it holds */
  chat_message: { chatId: string; seq: number };
  /** a message changed where it stands: edited, deleted, reacted to, pinned, voted in */
  chat_message_changed: { chatId: string; seq: number };
  /** somebody's read marker moved: ✓✓ for the author, and the reader's other tabs catch up */
  chat_read: { chatId: string; userId: string; seq: number };
  /** "Olena is typing…", true for five seconds and stored nowhere (§5.4) */
  typing: { chatId: string; userId: string };
}

export type RealtimeEventName = keyof RealtimeEvents;

/** The events that go through `LISTEN/NOTIFY`; the other four are a stream's own. */
export type PublishedEventName = Exclude<
  RealtimeEventName,
  "hello" | "heartbeat" | "bye" | "resync"
>;

/**
 * Every event name, as a value: an `EventSource` hears a named event only through a listener for
 * that name. The check below fails to compile when an event is added to `RealtimeEvents` and not
 * here.
 */
export const REALTIME_EVENT_NAMES = [
  "hello",
  "heartbeat",
  "bye",
  "resync",
  "pong",
  "presence",
  "chat_updated",
  "chat_message",
  "chat_message_changed",
  "chat_read",
  "typing",
] as const satisfies readonly RealtimeEventName[];

type Unlisted = Exclude<RealtimeEventName, (typeof REALTIME_EVENT_NAMES)[number]>;
export const EVERY_EVENT_LISTED: [Unlisted] extends [never] ? true : Unlisted = true;
