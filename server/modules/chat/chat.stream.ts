import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { allowsMethod } from "@shared/access.js";
import type { ByeReason, RealtimeEventName, RealtimeEvents } from "@shared/realtime.js";
import type { User } from "../../generated/prisma/client.js";
import { stateFor } from "../../core/access.js";
import { liveSessionUsers, sessionIdOf } from "../../core/auth.js";
import { isTest } from "../../core/config.js";
import { publish, type RealtimeDelivery, type Recipients } from "../../core/realtime.js";
import * as repo from "./chat.repository.js";
import { mustEnrol } from "../../core/two-factor-policy.js";

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
 * **A stream outlives the request that opened it**, so the access hook's answer at that moment is
 * not enough (chat.md §7.4). Every heartbeat asks again, for every stream: is its session still
 * live, is `chat` still open to its person, does the firm's two-factor rule let them in. And a
 * `recheck` from another part of the app (a sign-out, a block, an access switch) asks the same at
 * once for the people it names.
 *
 * **One process holds these, in memory**, and that is the same bound the access cache and the
 * vault's grants record: one app container. Delivery across containers is `LISTEN/NOTIFY`
 * (`core/realtime.ts`); what each process keeps is only its own open streams, and "online" is
 * what this process sees.
 */

/**
 * A `heartbeat` event on every stream at this interval. Cloudflare drops a connection that sends
 * nothing for about 100 seconds (documented, not yet measured here: chat.md §21), and a stream quiet
 * for that long is the normal state of a chat nobody is writing in. The tab reads it too: a stream
 * with no heartbeat for two intervals is dead however open it looks, and the tab opens a new one.
 */
export const HEARTBEAT_MS = 25_000;

/** What the browser waits before reconnecting after the stream drops (the `retry:` field). */
export const RETRY_MS = 5_000;

/** Tabs one person may hold open at once (chat.md §7.3). The eleventh closes the oldest. */
export const MAX_STREAMS_PER_PERSON = 10;

/**
 * How long a person whose last tab closed still counts as online. A reload, or a deploy's restart,
 * closes a tab and opens it again a moment later, and without this every colleague would see them
 * blink offline and back. Short under test, where waiting ten seconds proves nothing more.
 */
export const OFFLINE_GRACE_MS = isTest ? 150 : 10_000;

/**
 * Bytes a stream may have queued and unsent before it is treated as dead. Events are a few hundred
 * bytes, so this is a stalled connection, not a busy one; without a bound, a half-open socket
 * would grow a buffer until TCP gave up on it.
 */
const MAX_QUEUED_BYTES = 256 * 1024;

interface OpenStream {
  id: string;
  userId: string;
  /** the session it was opened under, which every heartbeat checks again */
  sessionId: string | null;
  openedAt: number;
  out: PassThrough;
  /**
   * The app that opened it. Production runs one, but a test process may hold two, and closing one
   * must not end the other's streams (review, 2026-09-18).
   */
  owner: object;
  /** ended by a shutdown: its person is not announced as offline, since they will be right back */
  quiet?: true;
}

/** Insertion order is age, which is what "close the oldest" reads. */
const streams = new Map<string, OpenStream>();

/** People whose last tab closed less than `OFFLINE_GRACE_MS` ago, still shown as online. */
const leaving = new Map<string, NodeJS.Timeout>();

let heartbeat: NodeJS.Timeout | null = null;
let log: FastifyBaseLogger | null = null;

export function useStreamLogger(logger: FastifyBaseLogger) {
  log = logger;
}

/**
 * **A `bye` before the end means "do not simply reconnect"** (`ByeReason` in `shared/realtime.ts`,
 * which says what the tab does for each). A stream ended with no `bye` (a deploy, a network drop) is
 * meant to be reopened, and the browser does that by itself.
 */
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

function streamsOf(userId: string): number {
  let n = 0;
  for (const s of streams.values()) if (s.userId === userId) n++;
  return n;
}

// ── presence ──────────────────────────────────────────────────────────────────

function announce(userId: string, online: boolean) {
  void publish("everyone", "presence", { userId, online });
}

/** The last tab closed: offline once the grace has passed with no tab reopened. */
function leave(userId: string) {
  if (leaving.has(userId)) return;
  const timer = setTimeout(() => {
    leaving.delete(userId);
    if (streamsOf(userId) !== 0) return;
    announce(userId, false);
    // **when they were last online** (§5.4), which nothing wrote until 2026-09-20: the column, the
    // read and the field in the contract all existed and the answer was always null (audit)
    void repo.lastSeen(userId, new Date()).catch(() => {});
  }, OFFLINE_GRACE_MS);
  timer.unref();
  leaving.set(userId, timer);
}

/** Everybody with a tab open, or who closed their last one a moment ago. */
export function onlinePeople(): string[] {
  const people = new Set(leaving.keys());
  for (const s of streams.values()) people.add(s.userId);
  return [...people];
}

// ── the heartbeat, and asking again ───────────────────────────────────────────

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

/**
 * One pass of the heartbeat: the event on every open stream, then every stream checked again.
 * Returns the check, so a test can wait for it.
 */
export function heartbeatTick(): Promise<void> {
  const beat = frame("heartbeat", {});
  for (const stream of streams.values()) write(stream, beat);
  return recheckStreams("everyone");
}

/** What the access hook would answer this person now, as a reason to end their stream. */
async function refusal(user: User): Promise<ByeReason | null> {
  if (await mustEnrol(user)) return "two_factor_required";
  if (!allowsMethod(await stateFor(user, "chat"), "GET")) return "gate_closed";
  return null;
}

/**
 * **Checks the streams of the people named again, and ends each one its person may no longer hold.**
 *
 * A failure to ask (the database is away) ends nothing: a stream carries ids, never content, and
 * closing every tab in the firm because a query failed would be the louder mistake. The next
 * heartbeat asks again.
 */
export async function recheckStreams(to: Recipients): Promise<void> {
  const targets = [...streams.values()].filter(
    (s) => to === "everyone" || to.includes(s.userId),
  );
  if (targets.length === 0) return;
  try {
    const sids = [...new Set(targets.map((s) => s.sessionId).filter((id) => id !== null))];
    const live = await liveSessionUsers(sids);
    const verdicts = new Map<string, Promise<ByeReason | null>>();
    for (const stream of targets) {
      const user = stream.sessionId ? live.get(stream.sessionId) : undefined;
      if (!user) {
        end(stream, "session_ended");
        continue;
      }
      if (!verdicts.has(user.id)) verdicts.set(user.id, refusal(user));
      const reason = await verdicts.get(user.id)!;
      if (reason) end(stream, reason);
    }
  } catch (err) {
    log?.error(
      { err },
      "chat stream: could not check the open streams; trying on the next beat",
    );
  }
}

// ── opening, delivering, closing ──────────────────────────────────────────────

/**
 * Opens the caller's stream. The access hook has already run: the caller is signed in and the
 * `chat` gate is open for them.
 */
export function openStream(request: FastifyRequest, reply: FastifyReply, owner: object) {
  const user = request.currentUser!;
  const out = new PassThrough();
  const stream: OpenStream = {
    id: randomUUID(),
    userId: user.id,
    sessionId: sessionIdOf(request),
    openedAt: Date.now(),
    out,
    owner,
  };

  const mine = [...streams.values()].filter((s) => s.userId === user.id);
  for (const oldest of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_PERSON + 1))) {
    end(oldest, "too_many_streams");
  }

  // back within the grace: still online, so nobody is told anything
  const returning = leaving.get(user.id);
  if (returning) {
    clearTimeout(returning);
    leaving.delete(user.id);
  } else if (mine.length === 0) {
    announce(user.id, true);
  }

  streams.set(stream.id, stream);
  // the browser went away, or `end()` finished it: either way it is no longer ours to write to
  out.on("close", () => {
    streams.delete(stream.id);
    stopHeartbeatIfIdle();
    if (!stream.quiet && streamsOf(stream.userId) === 0) leave(stream.userId);
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
 * Handles a published event in this process. Registered with `onRealtime` by the module, and
 * called for every notification, whichever process published it: `recheck` is acted on here, and
 * every other event is written to the streams of the people it names.
 */
export function deliverToStreams(delivery: RealtimeDelivery) {
  if (delivery.event === "recheck") {
    void recheckStreams(delivery.to);
    return;
  }
  const chunk = frame(delivery.event, delivery.data);
  for (const stream of streams.values()) {
    if (delivery.to === "everyone" || delivery.to.includes(stream.userId)) write(stream, chunk);
  }
}

/**
 * Ends every stream this app opened, with no `bye`: the browsers reconnect on their own, to
 * whichever process answers next. Called from the module's `preClose`, because `app.close()` waits
 * for every open connection to finish and a stream never does (chat.md §7.4). Nobody is announced
 * as offline: they are back in a few seconds.
 */
export function closeAllStreams(owner: object) {
  for (const stream of [...streams.values()]) {
    if (stream.owner !== owner) continue;
    stream.quiet = true;
    end(stream);
  }
  if (streams.size === 0) {
    for (const timer of leaving.values()) clearTimeout(timer);
    leaving.clear();
  }
  stopHeartbeatIfIdle();
}

/** How many streams this process holds, for one person or for everybody. */
export function openStreamCount(userId?: string): number {
  return userId ? streamsOf(userId) : streams.size;
}
