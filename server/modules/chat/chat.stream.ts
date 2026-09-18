import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RealtimeEventName, RealtimeEvents } from "@shared/realtime.js";
import { sessionIdOf } from "../../core/auth.js";
import type { RealtimeDelivery } from "../../core/realtime.js";

/**
 * **The live connection: one Server-Sent Events stream per open CRM tab** (chat.md §7.1, and the
 * transport decision of 2026-09-07 in `decisions.md`).
 *
 * The browser holds `GET /api/chat/stream` open and everything it SENDS goes as an ordinary POST.
 * The stream carries only small events that name what changed; the tab then fetches the content
 * through the ordinary routes, whose checks apply. So this file never decides who may read what: it
 * delivers "chat X has something new" to the people the publisher named (`deliverToStreams`).
 *
 * **The body is a `PassThrough` handed to `reply.send`, not a hijacked reply.** Fastify then keeps
 * the whole lifecycle (the headers every other response gets, `onResponse`, the error handler), and
 * when the browser goes away it destroys the payload itself (`sendStream` in `fastify/lib/reply.js`),
 * which is the one signal this file needs to forget the stream.
 *
 * **One process holds these, in memory**, and that is the same bound the access cache and the
 * vault's grants record: one app container. Delivery across containers is `LISTEN/NOTIFY`
 * (`core/realtime.ts`); what each process keeps is only its own open streams.
 */

/**
 * A comment line on every stream at this interval. Cloudflare drops a connection that sends nothing
 * for about 100 seconds (documented, not yet measured here: chat.md §21), and a stream quiet for
 * that long is the normal state of a chat nobody is writing in.
 */
export const HEARTBEAT_MS = 25_000;

/** What the browser waits before reconnecting after the stream drops (the `retry:` field). */
export const RETRY_MS = 5_000;

/** Tabs one person may hold open at once (chat.md §7.3). The eleventh closes the oldest. */
export const MAX_STREAMS_PER_PERSON = 10;

/**
 * Bytes a stream may have queued and unsent before it is treated as dead. Events are a few hundred
 * bytes, so this is a stalled connection, not a busy one; without a bound, a half-open socket
 * would grow a buffer until TCP gave up on it.
 */
const MAX_QUEUED_BYTES = 256 * 1024;

/**
 * **A `bye` before the end means "do not reconnect"** (`ByeReason` in `shared/realtime.ts`). The tab
 * stops its `EventSource`: after `too_many_streams` a reconnect would close the next-oldest tab,
 * and eleven tabs would take turns for ever. A stream ended with no `bye` (a deploy, a network
 * drop) is meant to be reopened, and the browser does that by itself.
 */
type ByeReason = RealtimeEvents["bye"]["reason"];

interface OpenStream {
  id: string;
  userId: string;
  /** the session it was opened under, so ending a session can end exactly its streams (stage 0.3) */
  sessionId: string | null;
  openedAt: number;
  out: PassThrough;
}

/** Insertion order is age, which is what "close the oldest" reads. */
const streams = new Map<string, OpenStream>();

let heartbeat: NodeJS.Timeout | null = null;

function frame<K extends RealtimeEventName>(event: K, data: RealtimeEvents[K]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function write(stream: OpenStream, chunk: string) {
  const { out } = stream;
  if (out.destroyed || out.writableEnded) return;
  if (out.writableLength > MAX_QUEUED_BYTES) {
    out.destroy();
    return;
  }
  out.write(chunk);
}

function end(stream: OpenStream, reason?: ByeReason) {
  if (reason) write(stream, frame("bye", { reason }));
  if (!stream.out.writableEnded) stream.out.end();
  streams.delete(stream.id);
}

function ensureHeartbeat() {
  if (heartbeat || streams.size === 0) return;
  heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
  heartbeat.unref();
}

function stopHeartbeatIfIdle() {
  if (heartbeat && streams.size === 0) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/** One pass of the heartbeat: a comment line on every open stream. Exported for its test. */
export function heartbeatTick() {
  for (const stream of streams.values()) write(stream, ": heartbeat\n\n");
}

/**
 * Opens the caller's stream. The access hook has already run: the caller is signed in and the
 * `chat` gate is open for them.
 */
export function openStream(request: FastifyRequest, reply: FastifyReply) {
  const user = request.currentUser!;
  const out = new PassThrough();
  const stream: OpenStream = {
    id: randomUUID(),
    userId: user.id,
    sessionId: sessionIdOf(request),
    openedAt: Date.now(),
    out,
  };

  const mine = [...streams.values()].filter((s) => s.userId === user.id);
  for (const oldest of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_PERSON + 1))) {
    end(oldest, "too_many_streams");
  }

  streams.set(stream.id, stream);
  // the browser went away, or `end()` finished it: either way it is no longer ours to write to
  out.on("close", () => {
    streams.delete(stream.id);
    stopHeartbeatIfIdle();
  });
  ensureHeartbeat();

  // The first bytes go out at once: Fastify sends a stream's headers with its first chunk, and a
  // browser that has not seen them yet reports the connection as still opening.
  out.write(`retry: ${RETRY_MS}\n\n`);
  write(stream, frame("hello", { streamId: stream.id, heartbeatMs: HEARTBEAT_MS }));

  return (
    reply
      .header("content-type", "text/event-stream; charset=utf-8")
      // `no-transform` keeps a proxy from compressing the stream, which would buffer it
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(out)
  );
}

/**
 * Writes a published event to this process's streams of the people it names. Registered with
 * `onRealtime` by the module, and called for every notification, whichever process published it.
 */
export function deliverToStreams(delivery: RealtimeDelivery) {
  const chunk = frame(delivery.event, delivery.data);
  for (const stream of streams.values()) {
    if (delivery.to === "everyone" || delivery.to.includes(stream.userId)) write(stream, chunk);
  }
}

/**
 * Ends every open stream, with no `bye`: the browsers reconnect on their own, to whichever process
 * answers next. Called from the module's `preClose`, because `app.close()` waits for every open
 * connection to finish and a stream never does (chat.md §7.4).
 */
export function closeAllStreams() {
  for (const stream of [...streams.values()]) end(stream);
  stopHeartbeatIfIdle();
}

/** How many streams this process holds, for one person or for everybody. */
export function openStreamCount(userId?: string): number {
  if (!userId) return streams.size;
  let n = 0;
  for (const s of streams.values()) if (s.userId === userId) n++;
  return n;
}
