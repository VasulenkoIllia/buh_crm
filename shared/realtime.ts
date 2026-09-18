/**
 * **What travels on the live connection** (chat.md §7.1), shared because both ends read it: the
 * server writes these events and the browser's `EventSource` listens for them by name.
 *
 * Events carry ids and small tokens, never content. The tab fetches what an event names through the
 * ordinary routes, whose checks apply, so nothing here can show anybody something they could not
 * already open. `core/realtime.ts` enforces it on every publish.
 */

/** Why the server closed a stream the browser must not reopen by itself (`chat.stream.ts`). */
export type ByeReason = "too_many_streams" | "session_ended" | "gate_closed";

/** Every event a stream can carry, by name. */
export interface RealtimeEvents {
  /** the first event of every stream */
  hello: { streamId: string; heartbeatMs: number };
  /** the stream is about to end, and the tab must not reconnect */
  bye: { reason: ByeReason };
  /**
   * The server may have missed events (its listener lost the database and came back), so the tab
   * refetches everything it holds. Sent by the process itself, never published.
   */
  resync: Record<string, never>;
  /** the answer to a delivery test, which measures the round trip (stage 0.4) */
  pong: { pingId: string };
}

export type RealtimeEventName = keyof RealtimeEvents;

/** The events that go through `LISTEN/NOTIFY`; `hello`, `bye` and `resync` are a stream's own. */
export type PublishedEventName = Exclude<RealtimeEventName, "hello" | "bye" | "resync">;
