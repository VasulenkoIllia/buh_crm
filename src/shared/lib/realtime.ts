import {
  REALTIME_EVENT_NAMES,
  type ByeReason,
  type RealtimeEventName,
  type RealtimeEvents,
} from "@shared/realtime";

/**
 * **The tab's end of the live connection: one `EventSource`, shared by everything that needs it**
 * (chat.md §7). The server's end is `server/modules/chat/chat.stream.ts`.
 *
 * It opens when the first part of the page needs it (`retain`) and closes when the last lets go.
 * What arrives is small events naming what changed; whoever listens (`on`) refetches through the
 * ordinary routes. The browser reconnects a dropped stream by itself; this adds the three things it
 * cannot do:
 *
 * - **a watchdog**: a stream with no event for two heartbeats is dead, however open it looks (a
 *   laptop that slept, a proxy that dropped the connection without closing it), so it is replaced;
 * - **a `bye`**: the server closed the stream on purpose, and reopening it would be wrong, or would
 *   only close the next tab (`ByeReason` in `shared/realtime.ts`);
 * - **a refusal**: when the server answers with an error the browser gives up for good, so this
 *   asks the chat's own cheapest route why, and either stops or tries again later.
 *
 * Framework-free, so it is testable with a fake `EventSource` (`realtime.test.ts`). The React side,
 * which also refetches what an event names, is `src/modules/chat/use-realtime.ts`.
 */

export const STREAM_URL = "/api/chat/stream";
/** read to find out why a stream was refused: the chat's cheapest route, behind the same gate */
const PROBE_URL = "/api/chat/presence";
/** two heartbeats and some: the server sends one every 25 s */
export const WATCHDOG_MS = 60_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

export type RealtimeStatus = "idle" | "connecting" | "open" | "stopped";

/** Why the connection stopped and will not reopen by itself. */
export type StopReason = ByeReason | "signed_out" | "refused";

export interface RealtimeSnapshot {
  status: RealtimeStatus;
  stopReason: StopReason | null;
  /** when the current stream said hello */
  openedAt: number | null;
  lastEventAt: number | null;
  /** since this page opened */
  heartbeats: number;
  /** a stream that was open and dropped, since this page opened */
  reconnects: number;
}

/** What this needs of an `EventSource`, so a test can hand it a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

const CLOSED = 2; // EventSource.CLOSED, spelled out so this runs where EventSource does not exist

type Handler<K extends RealtimeEventName> = (data: RealtimeEvents[K]) => void;

export interface RealtimeDeps {
  open: (url: string) => EventSourceLike;
  /** the HTTP status of the probe, or `null` when the network failed */
  probe: () => Promise<number | null>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const browserDeps = (): RealtimeDeps => ({
  open: (url) => new EventSource(url, { withCredentials: true }),
  probe: () =>
    fetch(PROBE_URL, { credentials: "same-origin" }).then(
      (res) => res.status,
      () => null,
    ),
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
});

export function createRealtime(deps: RealtimeDeps) {
  let source: EventSourceLike | null = null;
  let retainers = 0;
  let attempt = 0;
  let watchdog: unknown = null;
  let retry: unknown = null;
  let snapshot: RealtimeSnapshot = {
    status: "idle",
    stopReason: null,
    openedAt: null,
    lastEventAt: null,
    heartbeats: 0,
    reconnects: 0,
  };
  const watchers = new Set<() => void>();
  const handlers = new Map<RealtimeEventName, Set<(data: never) => void>>();

  function set(patch: Partial<RealtimeSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const watch of watchers) watch();
  }

  function clearTimers() {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    if (retry !== null) deps.clearTimeout(retry);
    watchdog = retry = null;
  }

  function drop() {
    const old = source;
    source = null;
    old?.close();
    clearTimers();
  }

  function emit<K extends RealtimeEventName>(event: K, data: RealtimeEvents[K]) {
    for (const handler of handlers.get(event) ?? []) (handler as Handler<K>)(data);
  }

  function armWatchdog() {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    watchdog = deps.setTimeout(() => {
      watchdog = null;
      // silent for two heartbeats: dead, whatever the socket says
      set({ reconnects: snapshot.reconnects + 1 });
      connect();
    }, WATCHDOG_MS);
  }

  function stop(reason: StopReason) {
    drop();
    set({ status: "stopped", stopReason: reason, openedAt: null });
  }

  function retryLater() {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt++;
    set({ status: "connecting", openedAt: null });
    retry = deps.setTimeout(() => {
      retry = null;
      if (retainers > 0) connect();
    }, delay);
  }

  /** The browser gave up on the stream, or the server said the session ended: ask why. */
  async function probeThenDecide() {
    const status = await deps.probe();
    if (retainers === 0 || source) return; // released, or reopened, while it asked
    if (status === 401) stop("signed_out");
    else if (status === 403) stop("refused");
    else retryLater();
  }

  function onEvent(from: EventSourceLike, name: RealtimeEventName, raw: string) {
    if (from !== source) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const at = deps.now();
    armWatchdog();
    if (name === "hello") {
      attempt = 0;
      set({ status: "open", stopReason: null, openedAt: at, lastEventAt: at });
    } else if (name === "heartbeat") {
      set({ heartbeats: snapshot.heartbeats + 1, lastEventAt: at });
    } else {
      set({ lastEventAt: at });
    }
    if (name === "bye") {
      const { reason } = data as RealtimeEvents["bye"];
      stop(reason);
      emit("bye", { reason });
      // a password changed on THIS computer ends the old session and signs this one in again, so
      // the stream may open under the new one; a real sign-out answers 401 and stays stopped
      if (reason === "session_ended") void probeThenDecide();
      return;
    }
    emit(name, data as never);
  }

  function connect() {
    drop();
    set({ status: "connecting", stopReason: null, openedAt: null });
    const next = deps.open(STREAM_URL);
    source = next;
    for (const name of REALTIME_EVENT_NAMES) {
      next.addEventListener(name, (event) => onEvent(next, name, event.data));
    }
    next.onerror = () => {
      if (next !== source) return;
      if (next.readyState === CLOSED) {
        // an error status: the browser will not try again by itself
        drop();
        set({ status: "connecting", openedAt: null });
        void probeThenDecide();
      } else if (snapshot.status === "open") {
        // dropped; the browser is reconnecting on its own after the server's `retry:`
        set({ status: "connecting", openedAt: null, reconnects: snapshot.reconnects + 1 });
      }
    };
    armWatchdog();
  }

  return {
    /** Keeps the connection open while the returned function has not been called. */
    retain(): () => void {
      retainers++;
      if (retainers === 1) connect();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainers--;
        if (retainers === 0) {
          drop();
          set({ status: "idle", openedAt: null });
        }
      };
    },

    /** Opens again after a stop, when a person asks for it. */
    reconnect() {
      attempt = 0;
      if (retainers > 0) connect();
    },

    on<K extends RealtimeEventName>(event: K, handler: Handler<K>): () => void {
      let bucket = handlers.get(event);
      if (!bucket) handlers.set(event, (bucket = new Set()));
      const entry = handler as (data: never) => void;
      bucket.add(entry);
      return () => bucket.delete(entry);
    },

    subscribe(watch: () => void): () => void {
      watchers.add(watch);
      return () => watchers.delete(watch);
    },

    getSnapshot: (): RealtimeSnapshot => snapshot,
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

let shared: Realtime | null = null;

/** The page's one connection, made on first use so nothing runs where there is no browser. */
export function realtime(): Realtime {
  shared ??= createRealtime(browserDeps());
  return shared;
}
