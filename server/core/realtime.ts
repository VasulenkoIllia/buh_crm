import { Client, type Notification } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { PublishedEventName, RealtimeEvents } from "@shared/realtime.js";
import { prisma } from "./db.js";
import { config, isTest } from "./config.js";

/**
 * **Fan-out for the live connection: Postgres `LISTEN/NOTIFY`** (chat.md §7.1, `decisions.md`
 * "Realtime transport", 2026-09-07).
 *
 * A write calls `publish()` once it has committed. Postgres hands the notification to every
 * listening connection, one per app process, and each process passes it to the streams it holds
 * itself. So a message written on one container reaches a tab connected to another, and no Redis
 * is involved. With one container today, the publishing process simply hears itself.
 *
 * **The listener is its own connection, outside Prisma's pool.** Prisma cannot `LISTEN`, and a
 * pooled connection would stop listening the moment the pool handed it to somebody else. It is
 * opened when the app is ready and closed with it, counted, so a test that builds a second app does
 * not close the first one's listener.
 *
 * **A notification is not durable.** One sent while the listener is reconnecting is lost, which is
 * why events carry ids rather than content and the chat's own tables are the record: when the
 * listener comes back, every stream this process holds is told to `resync` and refetches.
 */

export const REALTIME_CHANNEL = "realtime";

/** How the listener's connection names itself in `pg_stat_activity`, which is how its test finds it. */
export const LISTENER_APPLICATION_NAME = "buh_crm realtime";

/** Postgres refuses a `NOTIFY` payload of 8,000 bytes or more; this leaves room for the envelope. */
const NOTIFY_LIMIT_BYTES = 7_900;

const RECONNECT_MAX_MS = 30_000;

/** Who an event is for: user ids, or every stream this process holds. */
export type Recipients = readonly string[] | "everyone";

/**
 * **Between app processes only; no browser sees these.**
 *
 * `recheck` asks every process to look again, now, at the streams of the people named: their
 * session, their `chat` gate, the firm's two-factor rule. Signing out, blocking, a changed password
 * and a changed role or access switch send it, so a stream ends at once rather than on its next
 * heartbeat (chat.md §7.4). It names people, never a session: a session id is a credential.
 */
export interface ControlEvents {
  recheck: Record<string, never>;
}

type EventMap = RealtimeEvents & ControlEvents;
type EventName = keyof EventMap;

export type RealtimeDelivery<K extends EventName = EventName> = {
  [E in K]: { to: Recipients; event: E; data: EventMap[E] };
}[K];

type Handler = (delivery: RealtimeDelivery) => void;

/** A set, so a module registered by two apps in one test process delivers once, not twice. */
const handlers = new Set<Handler>();

export function onRealtime(handler: Handler) {
  handlers.add(handler);
}

let logger: FastifyBaseLogger | null = null;

function dispatch(delivery: RealtimeDelivery) {
  for (const handler of handlers) {
    try {
      handler(delivery);
    } catch (err) {
      logger?.error({ err, event: delivery.event }, "realtime: a handler failed");
    }
  }
}

// ── publishing ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** an event's kind or a reason: lower case, no spaces, short */
const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * **Ids, numbers and short tokens, nothing a person wrote** (chat.md §7.1, §19).
 *
 * A notification passes through the database's memory and any connection that listens, and it
 * skips every membership check, because the stream does not check anything. A message's text in
 * one would reach a stream the membership check never saw. So the shape is enforced here, on every
 * publish, rather than trusted to each caller.
 */
function contentFree(value: unknown): boolean {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value === "string") return UUID.test(value) || TOKEN.test(value);
  if (Array.isArray(value)) return value.every(contentFree);
  if (typeof value === "object") return Object.values(value).every(contentFree);
  return false;
}

export class RealtimePayloadError extends Error {}

/**
 * Sends an event to the named people's open streams, in every app process.
 *
 * Call it AFTER the write has committed: an event for a row that a rollback took back would send
 * every tab to fetch something that is not there.
 *
 * It never fails the request that called it. The write is already done, and a tab that misses an
 * event catches up on its next refetch. Under test a payload that breaks the rules throws, so a
 * producer that would leak text cannot ship.
 */
export async function publish<K extends PublishedEventName | keyof ControlEvents>(
  to: Recipients,
  event: K,
  data: EventMap[K],
): Promise<void> {
  const alone = Buffer.byteLength(JSON.stringify({ to: [], event, data }));
  const problem =
    !contentFree(data) || (to !== "everyone" && !to.every((id) => UUID.test(id)))
      ? "carries something other than ids, numbers and short tokens"
      : alone > NOTIFY_LIMIT_BYTES
        ? `is ${alone} bytes before its recipients, over the ${NOTIFY_LIMIT_BYTES} a ` +
          `notification may carry`
        : null;
  if (problem) {
    const message = `realtime: the "${event}" event ${problem}; nothing was sent`;
    if (isTest) throw new RealtimePayloadError(message);
    if (logger) logger.error(message);
    else console.error(message);
    return;
  }
  // only after the check, so a producer that would leak text fails its test even when it names nobody
  if (to !== "everyone" && to.length === 0) return;

  /**
   * **The recipients are sent in as many notifications as they need** (audit, 2026-09-20).
   *
   * `pg_notify` takes just under 8 kB, and a list of ids is most of a chat event: at 201 people —
   * one over what a group's own schema allows, and far under what the announcements channel holds
   * in a firm of any size — the payload crossed the line and the WHOLE event was dropped with one
   * line in the log. Nobody's tab heard anything. Every recipient gets the same event, so the list
   * simply goes in bites that fit.
   */
  for (const slice of to === "everyone" ? [to] : bites(to, NOTIFY_LIMIT_BYTES - alone)) {
    const payload = JSON.stringify({ to: slice, event, data });
    try {
      await prisma.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${payload})`;
    } catch (err) {
      logger?.error({ err, event }, "realtime: could not publish");
    }
  }
}

/** Ids in groups whose JSON stays inside `room`; a uuid costs its 36 characters, quotes and comma. */
function bites(ids: readonly string[], room: number): string[][] {
  const per = 39;
  const most = Math.max(1, Math.floor(room / per));
  const out: string[][] = [];
  for (let at = 0; at < ids.length; at += most) out.push(ids.slice(at, at + most));
  return out;
}

// ── listening ─────────────────────────────────────────────────────────────────

let client: Client | null = null;
let retainers = 0;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
/**
 * **Only the newest attempt to connect may become the listener.** Released and retained again while
 * one attempt was still connecting, a second starts; without this, whichever finished last replaced
 * the other without ending it, and every notification was then delivered twice by two connections
 * (review, 2026-09-18). An attempt that is no longer the newest ends itself.
 */
let newest = 0;

/** Whether this process is listening right now; the System screen shows it (stage 0.4). */
export function realtimeListening(): boolean {
  return client !== null;
}

function onNotification(message: Notification) {
  if (message.channel !== REALTIME_CHANNEL || !message.payload) return;
  let delivery: RealtimeDelivery;
  try {
    delivery = JSON.parse(message.payload) as RealtimeDelivery;
  } catch (err) {
    logger?.error({ err }, "realtime: a notification was not JSON");
    return;
  }
  dispatch(delivery);
}

function scheduleReconnect() {
  if (retainers === 0 || reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** attempt);
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(true);
  }, delay);
  reconnectTimer.unref();
}

/** The listening connection died (the database restarted, the network dropped): start again. */
function lost(c: Client, err?: Error) {
  if (client !== c) return; // one we already replaced, or ended ourselves
  client = null;
  logger?.warn({ err }, "realtime: lost the database; listening again shortly");
  c.end().catch(() => {});
  scheduleReconnect();
}

async function connect(isReconnect: boolean) {
  const attemptNo = ++newest;
  const c = new Client({
    connectionString: config.DATABASE_URL,
    application_name: LISTENER_APPLICATION_NAME,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
  });
  // attached before anything can fail: an `error` with no listener would take the process down
  c.on("error", (err) => lost(c, err));
  c.on("end", () => lost(c));
  // only the listener speaks: a superseded attempt that got as far as LISTEN stays silent
  c.on("notification", (message) => {
    if (client === c) onNotification(message);
  });
  try {
    await c.connect();
    await c.query(`LISTEN ${REALTIME_CHANNEL}`);
  } catch (err) {
    c.end().catch(() => {});
    if (attemptNo !== newest) return; // superseded: the newer attempt decides
    logger?.error({ err }, "realtime: could not listen; trying again shortly");
    scheduleReconnect();
    return;
  }
  if (retainers === 0 || attemptNo !== newest) {
    await c.end().catch(() => {}); // released, or superseded, while it was connecting
    return;
  }
  client = c;
  attempt = 0;
  if (isReconnect) {
    logger?.info("realtime: listening again; every open stream refetches");
    dispatch({ to: "everyone", event: "resync", data: {} });
  }
}

/** Starts listening, or counts one more app that needs it. Never throws: a failure retries. */
export async function retainRealtime(log: FastifyBaseLogger) {
  logger = log;
  retainers++;
  if (retainers === 1) await connect(false);
}

/** The last app to release it closes the connection. */
export async function releaseRealtime() {
  retainers = Math.max(0, retainers - 1);
  if (retainers > 0) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  attempt = 0;
  newest++; // an attempt still connecting now ends itself
  const c = client;
  client = null;
  await c?.end().catch(() => {});
}
