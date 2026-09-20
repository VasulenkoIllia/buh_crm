import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, ChatSummary, ReadBy } from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { openTestStream, type TestStream } from "../../test/stream-probe.js";

/**
 * **Read markers, "Read by" and typing** (chat.md §5.4, §12.2, §19 "Read and typing").
 *
 * The two routes here are the named exception to the log's rule: they write no row at all, not even
 * the bare one, and that is asserted rather than assumed.
 */

const DOMAIN = "@chat-reading.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let olena: Person;
let petro: Person;
let iryna: Person;
let outsider: Person;
const opened: TestStream[] = [];

async function call(
  who: Person,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/api/chat${url}`,
    headers: { cookie: who.cookie },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function group(owner: Person, title: string, others: Person[]): Promise<string> {
  const res = await call(owner, "POST", "/groups", {
    title,
    memberIds: others.map((p) => p.id),
  });
  return res.body.id as string;
}

async function say(who: Person, chatId: string, text: string) {
  const res = await call(who, "POST", `/chats/${chatId}/messages`, {
    clientMessageId: randomUUID(),
    text,
  });
  expect(res.status).toBe(200);
  return res.body as ChatMessage;
}

async function summary(who: Person, chatId: string): Promise<ChatSummary> {
  const list = (await call(who, "GET", "/chats")).body as ChatSummary[];
  return list.find((c) => c.id === chatId)!;
}

async function streamOf(who: Person) {
  const stream = await openTestStream(app, "/api/chat/stream", { cookie: who.cookie });
  opened.push(stream);
  await stream.next("hello");
  return stream;
}

async function removeChatsOf(domain: string) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: domain } },
    select: { id: true },
  });
  await prisma.chat.deleteMany({
    where: {
      kind: { not: "announcements" },
      members: { some: { userId: { in: users.map((u) => u.id) } } },
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
  [admin] = await createPeople(app, DOMAIN, ["Admin"], "admin");
  [olena, petro, iryna, outsider] = await createPeople(app, DOMAIN, [
    "Olena",
    "Petro",
    "Iryna",
    "Outsider",
  ]);
});

afterAll(async () => {
  for (const stream of opened) stream.close();
  await app?.close();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
});

describe("read markers", () => {
  it("moves forward only, never past the chat, and tells the others", async () => {
    const chatId = await group(olena, "Reading", [petro]);
    const olenaTab = await streamOf(olena);
    const message = await say(olena, chatId, "have a look");
    await olenaTab.next("chat_message");

    expect((await summary(petro, chatId)).unread).toBe(2);
    const read = await call(petro, "POST", `/chats/${chatId}/read`, { seq: message.seq });
    expect(read.body).toEqual({ seq: message.seq });
    expect((await summary(petro, chatId)).unread).toBe(0);
    // ✓✓ for the author: how far the others have read
    expect((await summary(olena, chatId)).othersReadSeq).toBe(message.seq);
    expect((await olenaTab.next("chat_read")).data).toEqual({
      chatId,
      userId: petro.id,
      seq: message.seq,
    });

    // a marker never goes back, and never runs past what the chat holds
    await call(petro, "POST", `/chats/${chatId}/read`, { seq: 1 });
    expect((await summary(petro, chatId)).lastReadSeq).toBe(message.seq);
    await call(petro, "POST", `/chats/${chatId}/read`, { seq: 9_999 });
    expect((await summary(petro, chatId)).lastReadSeq).toBe(message.seq);
  });

  it("lists who has read a message, with when they last read", async () => {
    const chatId = await group(olena, "Read by", [petro, iryna]);
    const message = await say(olena, chatId, "who has seen this?");

    const before = (await call(olena, "GET", `/messages/${message.id}/read-by`)).body as ReadBy;
    // the author has read their own; nobody else yet
    expect(before.people.map((p) => p.id)).toEqual([olena.id]);

    await call(petro, "POST", `/chats/${chatId}/read`, { seq: message.seq });
    const after = (await call(olena, "GET", `/messages/${message.id}/read-by`)).body as ReadBy;
    expect(after.people.map((p) => p.id).sort()).toEqual([olena.id, petro.id].sort());
    expect(after.people.find((p) => p.id === petro.id)!.at).not.toBeNull();
  });

  it("answers nobody outside the chat", async () => {
    const chatId = await group(olena, "Not yours", [petro]);
    const message = await say(olena, chatId, "private");
    expect((await call(outsider, "POST", `/chats/${chatId}/read`, { seq: 1 })).status).toBe(
      404,
    );
    expect((await call(outsider, "GET", `/messages/${message.id}/read-by`)).status).toBe(404);
  });
});

describe("typing", () => {
  it("reaches the others and not the person typing, and stores nothing", async () => {
    const chatId = await group(olena, "Typing", [petro]);
    const petroTab = await streamOf(petro);
    const olenaTab = await streamOf(olena);
    const messagesBefore = await prisma.chatMessage.count({ where: { chatId } });

    expect((await call(olena, "POST", `/chats/${chatId}/typing`)).status).toBe(200);
    expect((await petroTab.next("typing")).data).toEqual({ chatId, userId: olena.id });
    await expect(olenaTab.next("typing", 300)).rejects.toThrow(/no "typing"/);

    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(messagesBefore);
  });

  it("is refused where the caller cannot write", async () => {
    const [danylo] = await createPeople(app, DOMAIN, ["Danylo"]);
    const direct = (await call(olena, "POST", "/direct", { userId: danylo.id })).body
      .id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/users/${danylo.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: "blocked" },
    });
    expect((await call(olena, "POST", `/chats/${direct}/typing`)).status).toBe(403);
  });
});

describe("the named exception to the log's rule (chat.md §12.2)", () => {
  it("writes no activity row at all for a read marker or a typing ping", async () => {
    const chatId = await group(olena, "Quiet", [petro]);
    const message = await say(olena, chatId, "anything");
    const since = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (let i = 0; i < 3; i++) {
      expect((await call(petro, "POST", `/chats/${chatId}/typing`)).status).toBe(200);
      expect(
        (await call(petro, "POST", `/chats/${chatId}/read`, { seq: message.seq })).status,
      ).toBe(200);
    }

    // the rows a request would otherwise leave: `system.request` is the bare tier-1 one
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const rows = await prisma.activityEvent.findMany({
      where: { occurredAt: { gte: since }, actorUserId: petro.id },
      select: { action: true, route: true },
    });
    expect(rows).toEqual([]);

    // and a send through the same module still leaves its row, so the exception is theirs alone
    const after = new Date();
    await say(petro, chatId, "but this one is a request like any other");
    for (let attempt = 0; attempt < 40; attempt++) {
      const written = await prisma.activityEvent.count({
        where: { occurredAt: { gte: after }, actorUserId: petro.id },
      });
      if (written > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("a send wrote no row, so the exception is wider than the two routes");
  });
});
