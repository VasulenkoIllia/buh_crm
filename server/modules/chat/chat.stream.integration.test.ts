import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { invalidateAccessCache } from "../../core/access.js";
import { createPeople, removePeople } from "../../test/people.js";
import { openTestStream, type TestStream } from "../../test/stream-probe.js";
import {
  HEARTBEAT_MS,
  MAX_STREAMS_PER_PERSON,
  RETRY_MS,
  heartbeatTick,
  openStreamCount,
} from "./chat.stream.js";

/**
 * **The live connection, over real sockets** (chat.md §7.1, §7.4, §19 "Stream").
 *
 * The stream opens for somebody the `chat` gate lets in and for nobody else, says hello, keeps
 * itself alive, holds at most ten tabs a person, forgets a tab that went away, and never holds up a
 * shutdown. Delivery between people is `chat.delivery.integration.test.ts`.
 */

const DOMAIN = "@chat-stream.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let userId: string;
const opened: TestStream[] = [];

async function open(headers: Record<string, string> = { cookie }) {
  const stream = await openTestStream(app, "/api/chat/stream", headers);
  opened.push(stream);
  return stream;
}

/** Streams are forgotten when their socket closes, which is a tick or two after `close()`. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  app = await buildApp();
  await removePeople(DOMAIN);
  const [olena] = await createPeople(app, DOMAIN, ["Olena"]);
  userId = olena.id;
  cookie = olena.cookie;
});

afterAll(async () => {
  for (const stream of opened) stream.close();
  await app?.close();
  await removePeople(DOMAIN);
});

describe("the chat stream", () => {
  it("opens as an event stream and says hello first", async () => {
    const stream = await open();
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["cache-control"]).toContain("no-cache");
    expect(stream.headers["cache-control"]).toContain("no-transform");

    const hello = await stream.next("hello");
    expect(hello.data).toMatchObject({ heartbeatMs: HEARTBEAT_MS });
    expect(stream.raw()).toContain(`retry: ${RETRY_MS}`);
    stream.close();
  });

  it("keeps the heartbeat well inside Cloudflare's idle limit of about 100 seconds", () => {
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(30_000);
  });

  it("sends a heartbeat event on every open stream, which the tab can see", async () => {
    const stream = await open();
    await stream.next("hello");
    await heartbeatTick();
    expect((await stream.next("heartbeat")).data).toEqual({});
    stream.close();
  });

  it("refuses a caller with no session, and one whose chat gate is closed", async () => {
    const anonymous = await open({});
    expect(anonymous.status).toBe(401);

    await prisma.accessOverride.create({ data: { userId, gate: "chat", state: "closed" } });
    invalidateAccessCache();
    try {
      const closed = await open();
      expect(closed.status).toBe(403);
      expect(closed.body).toMatchObject({ error: { code: "module_closed" } });
    } finally {
      await prisma.accessOverride.deleteMany({ where: { userId, gate: "chat" } });
      invalidateAccessCache();
    }
  });

  it("answers no HEAD, since a HEAD of a stream means nothing", async () => {
    const res = await app.inject({
      method: "HEAD",
      url: "/api/chat/stream",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("forgets a stream once the browser goes away", async () => {
    await until(() => openStreamCount(userId) === 0, "earlier streams to close");
    const stream = await open();
    await stream.next("hello");
    expect(openStreamCount(userId)).toBe(1);
    stream.close();
    await until(() => openStreamCount(userId) === 0, "the stream to be forgotten");
  });

  it("holds ten tabs a person, and the eleventh closes the oldest with a reason", async () => {
    await until(() => openStreamCount(userId) === 0, "earlier streams to close");
    const tabs: TestStream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_PERSON; i++) {
      const tab = await open();
      await tab.next("hello");
      tabs.push(tab);
    }
    expect(openStreamCount(userId)).toBe(MAX_STREAMS_PER_PERSON);

    const eleventh = await open();
    await eleventh.next("hello");
    const bye = await tabs[0].next("bye");
    expect(bye.data).toEqual({ reason: "too_many_streams" });
    await tabs[0].ended;
    expect(openStreamCount(userId)).toBe(MAX_STREAMS_PER_PERSON);

    for (const tab of [...tabs, eleventh]) tab.close();
    await until(() => openStreamCount(userId) === 0, "the tabs to close");
  });
});

describe("shutting down with streams open", () => {
  it("ends every stream so app.close() does not wait on them", async () => {
    const own = await buildApp();
    const tab = await openTestStream(own, "/api/chat/stream", { cookie });
    await tab.next("hello");

    const started = Date.now();
    await own.close();
    await tab.ended;
    expect(Date.now() - started).toBeLessThan(2_000);
    // no `bye`: a deploy is the case where the browser SHOULD reconnect
    expect(tab.raw()).not.toContain("event: bye");
  });
});
