import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import {
  LISTENER_APPLICATION_NAME,
  publish,
  realtimeListening,
  releaseRealtime,
  retainRealtime,
} from "../../core/realtime.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { openTestStream, type TestStream } from "../../test/stream-probe.js";

/**
 * **An event reaches the people it names, and nobody else** (chat.md §7.1, §19 "Stream").
 *
 * Through the whole path, as production runs it: `publish()` sends a `NOTIFY`, Postgres hands it
 * to the listener, and the listener writes it to the open streams of exactly the people named.
 * Then the listener's connection is killed from the database side, as a database restart would,
 * and every stream is told to refetch.
 */

const DOMAIN = "@chat-delivery.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let olena: Person;
let petro: Person;
const opened: TestStream[] = [];

async function streamOf(person: Person) {
  const stream = await openTestStream(app, "/api/chat/stream", { cookie: person.cookie });
  opened.push(stream);
  await stream.next("hello");
  return stream;
}

/** The event must NOT arrive: wait a moment and make sure nothing did. */
async function expectNothing(stream: TestStream, event: string) {
  await expect(stream.next(event, 300)).rejects.toThrow(/no "/);
}

beforeAll(async () => {
  app = await buildApp();
  await removePeople(DOMAIN);
  [olena, petro] = await createPeople(app, DOMAIN, ["Olena", "Petro"]);
});

afterAll(async () => {
  for (const stream of opened) stream.close();
  await app?.close();
  await removePeople(DOMAIN);
});

describe("delivery through LISTEN/NOTIFY", () => {
  it("listens once the app is ready", async () => {
    await app.ready();
    expect(realtimeListening()).toBe(true);
  });

  it("brings an event to every open tab of the person named, and to nobody else", async () => {
    const olenaTab1 = await streamOf(olena);
    const olenaTab2 = await streamOf(olena);
    const petroTab = await streamOf(petro);

    const pingId = randomUUID();
    const sent = Date.now();
    await publish([olena.id], "pong", { pingId });

    for (const tab of [olenaTab1, olenaTab2]) {
      const event = await tab.next("pong");
      expect(event.data).toEqual({ pingId });
    }
    // the transport's promise is "well under a second" through Cloudflare; locally it is a few ms
    expect(Date.now() - sent).toBeLessThan(1_000);
    await expectNothing(petroTab, "pong");
  });

  it("brings an event for everyone to every open stream", async () => {
    const olenaTab = await streamOf(olena);
    const petroTab = await streamOf(petro);
    const pingId = randomUUID();
    await publish("everyone", "pong", { pingId });
    expect((await olenaTab.next("pong")).data).toEqual({ pingId });
    expect((await petroTab.next("pong")).data).toEqual({ pingId });
  });

  it("answers the delivery test with a pong to the caller alone", async () => {
    const olenaTab = await streamOf(olena);
    const petroTab = await streamOf(petro);
    const pingId = randomUUID();

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/stream/ping",
      headers: { cookie: olena.cookie },
      payload: { pingId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ listening: true });
    expect((await olenaTab.next("pong")).data).toEqual({ pingId });
    await expectNothing(petroTab, "pong");
  });

  it("refuses a delivery test whose id is not an id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/stream/ping",
      headers: { cookie: olena.cookie },
      payload: { pingId: "hello" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps one listener, and delivers once, when released and retained again mid-connect", async () => {
    const tab = await streamOf(olena);
    const listeners = async () => {
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE application_name = ${LISTENER_APPLICATION_NAME}
           AND datname = current_database()`;
      return n;
    };

    // the app holds one; let go of it, then take it, drop it and take it again before any connects
    await releaseRealtime();
    const first = retainRealtime(app.log);
    const dropped = releaseRealtime();
    const second = retainRealtime(app.log);
    await Promise.all([first, dropped, second]);
    expect(realtimeListening()).toBe(true);
    // the superseded attempt ends its own connection a moment after it finishes connecting
    for (let i = 0; i < 50 && (await listeners()) !== 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await listeners()).toBe(1);

    const pingId = randomUUID();
    await publish([olena.id], "pong", { pingId });
    await tab.next("pong");
    await new Promise((r) => setTimeout(r, 200));
    expect(tab.raw().split(pingId).length - 1).toBe(1);
  });

  it("tells every stream to refetch when the listener loses the database, then delivers again", async () => {
    const olenaTab = await streamOf(olena);
    const petroTab = await streamOf(petro);

    // what a database restart looks like from here: the server ends the listener's connection
    const [{ killed }] = await prisma.$queryRaw<{ killed: number }[]>`
      SELECT count(pg_terminate_backend(pid))::int AS killed
        FROM pg_stat_activity
       WHERE application_name = ${LISTENER_APPLICATION_NAME}
         AND datname = current_database()`;
    expect(killed).toBe(1);

    await olenaTab.next("resync", 5_000);
    await petroTab.next("resync", 5_000);
    expect(realtimeListening()).toBe(true);

    const pingId = randomUUID();
    await publish([petro.id], "pong", { pingId });
    expect((await petroTab.next("pong")).data).toEqual({ pingId });
    await expectNothing(olenaTab, "pong");
  });
});
