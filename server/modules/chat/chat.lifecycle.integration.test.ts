import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { destroyAllUserSessions } from "../../core/auth.js";
import { createPeople, removePeople, signIn, type Person } from "../../test/people.js";
import { openTestStream, type TestStream } from "../../test/stream-probe.js";
import { heartbeatTick, OFFLINE_GRACE_MS } from "./chat.stream.js";

/**
 * **A stream outlives the request that opened it, so it is asked again** (chat.md §7.4, §11, §19).
 *
 * Signing out, a block, a password reset and an access switch end a stream at once, through the
 * `recheck` every process hears. A session that simply runs out ends on the next heartbeat. And
 * "online" follows the tabs, with a short grace so a reload does not blink.
 */

const DOMAIN = "@chat-lifecycle.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
const opened: TestStream[] = [];

async function streamWith(cookie: string) {
  const stream = await openTestStream(app, "/api/chat/stream", { cookie });
  opened.push(stream);
  expect(stream.status).toBe(200);
  await stream.next("hello");
  return stream;
}

async function person(name: string) {
  const [someone] = await createPeople(app, DOMAIN, [name]);
  return someone;
}

/** The next `presence` event about this person, skipping everybody else's. */
async function presenceOf(stream: TestStream, userId: string, timeoutMs = 2_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const event = await stream.next("presence", Math.max(1, until - Date.now()));
    const data = event.data as { userId: string; online: boolean };
    if (data.userId === userId) return data.online;
  }
}

beforeAll(async () => {
  app = await buildApp();
  await removePeople(DOMAIN);
  [admin] = await createPeople(app, DOMAIN, ["Admin"], "admin");
});

afterAll(async () => {
  for (const stream of opened) stream.close();
  await app?.close();
  await removePeople(DOMAIN);
});

describe("a stream ends at once when its session does", () => {
  it("on signing out, and only the stream of that session", async () => {
    const olena = await person("Olena");
    const laptop = await streamWith(olena.cookie);
    const office = await streamWith(await signIn(app, olena.email));

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: olena.cookie },
    });

    expect((await laptop.next("bye")).data).toEqual({ reason: "session_ended" });
    await laptop.ended;
    await expect(office.next("bye", 300)).rejects.toThrow(/no "bye"/);
  });

  it("on a block", async () => {
    const petro = await person("Petro");
    const stream = await streamWith(petro.cookie);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${petro.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: "blocked" },
    });
    expect(res.statusCode).toBe(200);
    expect((await stream.next("bye")).data).toEqual({ reason: "session_ended" });
  });

  it("when every session goes, as a password reset does", async () => {
    const iryna = await person("Iryna");
    const one = await streamWith(iryna.cookie);
    const two = await streamWith(await signIn(app, iryna.email));

    await destroyAllUserSessions(iryna.id);

    expect((await one.next("bye")).data).toEqual({ reason: "session_ended" });
    expect((await two.next("bye")).data).toEqual({ reason: "session_ended" });
  });

  it("on the next heartbeat when the session has simply run out", async () => {
    const taras = await person("Taras");
    const stream = await streamWith(taras.cookie);
    await prisma.session.updateMany({
      where: { userId: taras.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await heartbeatTick();
    expect((await stream.next("bye")).data).toEqual({ reason: "session_ended" });
  });

  it("keeps a stream whose session and gate are both still fine", async () => {
    const mariia = await person("Mariia");
    const stream = await streamWith(mariia.cookie);
    await heartbeatTick();
    await expect(stream.next("bye", 300)).rejects.toThrow(/no "bye"/);
  });
});

describe("a stream ends at once when the chat gate closes", () => {
  it("for the person an admin switched it off for, and not for anybody else", async () => {
    const oksana = await person("Oksana");
    const roman = await person("Roman");
    const hers = await streamWith(oksana.cookie);
    const his = await streamWith(roman.cookie);

    const res = await app.inject({
      method: "PUT",
      url: `/api/access/overrides/${oksana.id}/chat`,
      headers: { cookie: admin.cookie },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);

    expect((await hers.next("bye")).data).toEqual({ reason: "gate_closed" });
    await expect(his.next("bye", 300)).rejects.toThrow(/no "bye"/);

    // and the stream cannot simply be reopened
    const again = await openTestStream(app, "/api/chat/stream", { cookie: oksana.cookie });
    expect(again.status).toBe(403);
  });
});

describe("who is online", () => {
  it("announces a colleague's first tab, lists them, and lets them go after the grace", async () => {
    const watcher = await person("Watcher");
    const anna = await person("Anna");
    const watching = await streamWith(watcher.cookie);

    const tab = await streamWith(anna.cookie);
    expect(await presenceOf(watching, anna.id)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/chat/presence",
      headers: { cookie: watcher.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().online).toContain(anna.id);

    tab.close();
    expect(await presenceOf(watching, anna.id, OFFLINE_GRACE_MS + 2_000)).toBe(false);
    const after = await app.inject({
      method: "GET",
      url: "/api/chat/presence",
      headers: { cookie: watcher.cookie },
    });
    expect(after.json().online).not.toContain(anna.id);
  });

  it("says nothing when a tab is reloaded within the grace", async () => {
    const watcher = await person("Viewer");
    const denys = await person("Denys");
    const watching = await streamWith(watcher.cookie);

    const first = await streamWith(denys.cookie);
    expect(await presenceOf(watching, denys.id)).toBe(true);

    first.close();
    await streamWith(denys.cookie); // the reload
    await expect(presenceOf(watching, denys.id, OFFLINE_GRACE_MS * 3)).rejects.toThrow(
      /no "presence"/,
    );
  });
});
