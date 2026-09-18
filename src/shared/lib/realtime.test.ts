import { describe, expect, it } from "vitest";
import {
  createRealtime,
  STREAM_URL,
  WATCHDOG_MS,
  type EventSourceLike,
  type RealtimeDeps,
} from "./realtime";

/**
 * **The tab's end of the live connection, against a fake `EventSource` and a fake clock** (chat.md
 * §7). What the browser does by itself (reconnecting a dropped stream) is not under test; what this
 * adds to it is: one stream however many screens hold it, a watchdog for a stream that died quietly,
 * a `bye` that must not be reconnected, and asking why when the server refuses.
 */

class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown) {
    this.readyState = 1;
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

function harness(probeStatus: number | null = 200) {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sources: FakeSource[] = [];
  const probes: number[] = [];
  const deps: RealtimeDeps = {
    open: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    probe: async () => {
      probes.push(clock);
      return probeStatus;
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = until;
  };
  const rt = createRealtime(deps);
  const last = () => sources[sources.length - 1];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { rt, sources, probes, advance, last, settle };
}

describe("the tab's live connection", () => {
  it("opens one stream however many screens hold it, and closes it when the last lets go", () => {
    const { rt, sources } = harness();
    const releaseA = rt.retain();
    const releaseB = rt.retain();
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe(STREAM_URL);
    expect(rt.getSnapshot().status).toBe("connecting");

    sources[0].emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    expect(rt.getSnapshot().status).toBe("open");

    releaseA();
    expect(sources[0].closed).toBe(false);
    releaseB();
    expect(sources[0].closed).toBe(true);
    expect(rt.getSnapshot().status).toBe("idle");
  });

  it("counts heartbeats and hands every other event to whoever listens", () => {
    const { rt, last } = harness();
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    last().emit("heartbeat", {});
    last().emit("heartbeat", {});
    expect(rt.getSnapshot().heartbeats).toBe(2);

    const pongs: unknown[] = [];
    const off = rt.on("pong", (data) => pongs.push(data));
    last().emit("pong", { pingId: "p1" });
    off();
    last().emit("pong", { pingId: "p2" });
    expect(pongs).toEqual([{ pingId: "p1" }]);
  });

  it("replaces a stream that went quiet for longer than two heartbeats", () => {
    const { rt, sources, advance } = harness();
    rt.retain();
    sources[0].emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    advance(WATCHDOG_MS - 1);
    expect(sources).toHaveLength(1);
    advance(1);
    expect(sources).toHaveLength(2);
    expect(sources[0].closed).toBe(true);
    expect(rt.getSnapshot().reconnects).toBe(1);
  });

  it("keeps a stream whose heartbeats keep coming", () => {
    const { rt, sources, advance, last } = harness();
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    for (let i = 0; i < 10; i++) {
      advance(25_000);
      last().emit("heartbeat", {});
    }
    expect(sources).toHaveLength(1);
  });

  it("counts a drop the browser is reconnecting by itself, and is open again on hello", () => {
    const { rt, last, sources } = harness();
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    last().fail(0);
    expect(rt.getSnapshot()).toMatchObject({ status: "connecting", reconnects: 1 });
    last().emit("hello", { streamId: "s2", heartbeatMs: 25_000 });
    expect(rt.getSnapshot().status).toBe("open");
    expect(sources).toHaveLength(1); // the browser's own reconnect, on the same object
  });

  it("stops for good on too many tabs, and reopens only when asked", async () => {
    const { rt, sources, probes, advance, last, settle } = harness();
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    const byes: unknown[] = [];
    rt.on("bye", (data) => byes.push(data));

    last().emit("bye", { reason: "too_many_streams" });
    await settle();
    expect(rt.getSnapshot()).toMatchObject({
      status: "stopped",
      stopReason: "too_many_streams",
    });
    expect(byes).toEqual([{ reason: "too_many_streams" }]);
    expect(sources[0].closed).toBe(true);
    expect(probes).toHaveLength(0);
    advance(10 * WATCHDOG_MS);
    expect(sources).toHaveLength(1);

    rt.reconnect();
    expect(sources).toHaveLength(2);
  });

  it("after 'session ended' opens again when the tab is still signed in", async () => {
    const { rt, sources, advance, last, settle } = harness(200);
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    last().emit("bye", { reason: "session_ended" });
    await settle();
    expect(sources).toHaveLength(1);
    advance(5_000);
    expect(sources).toHaveLength(2);
  });

  it("after 'session ended' stays stopped when the tab is signed out", async () => {
    const { rt, sources, advance, last, settle } = harness(401);
    rt.retain();
    last().emit("hello", { streamId: "s", heartbeatMs: 25_000 });
    last().emit("bye", { reason: "session_ended" });
    await settle();
    expect(rt.getSnapshot()).toMatchObject({ status: "stopped", stopReason: "signed_out" });
    advance(10 * WATCHDOG_MS);
    expect(sources).toHaveLength(1);
  });

  it("asks why when the server refuses the stream, and stops on a 403", async () => {
    const { rt, sources, probes, last, settle } = harness(403);
    rt.retain();
    last().fail(2);
    await settle();
    expect(probes).toHaveLength(1);
    expect(rt.getSnapshot()).toMatchObject({ status: "stopped", stopReason: "refused" });
    expect(sources).toHaveLength(1);
  });

  it("tries again later when the refusal was the server being away", async () => {
    const { rt, sources, advance, last, settle } = harness(502);
    rt.retain();
    last().fail(2);
    await settle();
    expect(rt.getSnapshot().status).toBe("connecting");
    advance(5_000);
    expect(sources).toHaveLength(2);
  });
});
