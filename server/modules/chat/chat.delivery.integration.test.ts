import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { LISTENER_APPLICATION_NAME, publish, realtimeListening } from "../../core/realtime.js";
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
