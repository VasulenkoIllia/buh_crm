import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatMessagePage } from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { openTestStream } from "../../test/stream-probe.js";

/**
 * **Messages** (chat.md §5, §19 "Messages", "Polls"): sending with no gaps and no double posts,
 * editing, deleting for everyone, replying, forwarding, reacting, pinning, mentioning and polls.
 */

const DOMAIN = "@chat-messages.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let olena: Person;
let petro: Person;
let iryna: Person;
let outsider: Person;
let since = new Date();

beforeEach(() => {
  since = new Date();
});

async function call(
  who: Person,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function say(who: Person, chatId: string, text: string, extra: object = {}) {
  const res = await call(who, "POST", `/chats/${chatId}/messages`, {
    clientMessageId: randomUUID(),
    text,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ChatMessage;
}

async function history(who: Person, chatId: string, query = ""): Promise<ChatMessagePage> {
  const res = await call(who, "GET", `/chats/${chatId}/messages${query}`);
  expect(res.status).toBe(200);
  return res.body as ChatMessagePage;
}

async function logged(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
      select: { subjectLabel: true, changes: true },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${action} row for ${subjectId}`);
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
  await app?.close();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
});

describe("sending", () => {
  it("takes the chat's next place, seals the words, and reaches the other tabs", async () => {
    const chatId = await group(olena, "Sending", [petro]);
    const petroTab = await openTestStream(app, "/api/chat/stream", { cookie: petro.cookie });
    await petroTab.next("hello");

    const message = await say(olena, chatId, "The 1040 is ready");
    expect(message.seq).toBe(2); // after the group's own "created" line
    expect(message.text).toBe("The 1040 is ready");
    expect(message.authorId).toBe(olena.id);

    const row = await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(Buffer.from(row.ciphertext!).toString("utf8")).not.toContain("1040");

    expect((await petroTab.next("chat_message")).data).toEqual({ chatId, seq: 2 });
    petroTab.close();

    // the sender has read their own; the other has it waiting
    const listOf = async (who: Person) =>
      ((await call(who, "GET", "/chats")).body as { id: string; unread: number }[]).find(
        (c) => c.id === chatId,
      )!;
    expect((await listOf(olena)).unread).toBe(0);
    expect((await listOf(petro)).unread).toBe(2);
  });

  it("posts a send retried after a lost connection exactly once", async () => {
    const chatId = await group(olena, "Retries", [petro]);
    const clientMessageId = randomUUID();
    const body = { clientMessageId, text: "Did that go?" };
    const first = await call(olena, "POST", `/chats/${chatId}/messages`, body);
    const again = await call(olena, "POST", `/chats/${chatId}/messages`, body);
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.chatMessage.count({ where: { chatId, kind: "text" } })).toBe(1);
  });

  it("keeps the same name for a send in two chats apart, one message in each", async () => {
    const here = await group(olena, "Key here", [petro]);
    const there = await group(olena, "Key there", [petro]);
    const clientMessageId = randomUUID();
    const body = { clientMessageId, text: "the same words" };

    const first = await call(olena, "POST", `/chats/${here}/messages`, body);
    const second = await call(olena, "POST", `/chats/${there}/messages`, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // a retry is answered per chat: two messages, each where it was sent
    expect(second.body.id).not.toBe(first.body.id);
    expect((await history(petro, here)).messages.filter((m) => m.kind === "text")).toHaveLength(
      1,
    );
    expect(
      (await history(petro, there)).messages.filter((m) => m.kind === "text"),
    ).toHaveLength(1);
  });

  it("gives concurrent sends places with no gaps and no duplicates", async () => {
    const chatId = await group(olena, "At once", [petro, iryna]);
    const senders = [olena, petro, iryna, olena, petro];
    const sent = await Promise.all(senders.map((who, i) => say(who, chatId, `message ${i}`)));
    const seqs = sent.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([2, 3, 4, 5, 6]);
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    expect(chat.lastSeq).toBe(6);
  });

  it("refuses an empty message and one over four thousand characters", async () => {
    const chatId = await group(olena, "Limits", [petro]);
    const send = (text: string) =>
      call(olena, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        text,
      });
    expect((await send("   ")).status).toBe(400);
    expect((await send("x".repeat(4001))).status).toBe(400);
    expect((await send("x".repeat(4000))).status).toBe(200);
  });

  it("answers nobody outside the chat", async () => {
    const chatId = await group(olena, "Closed", [petro]);
    expect(
      (
        await call(outsider, "POST", `/chats/${chatId}/messages`, {
          clientMessageId: randomUUID(),
          text: "hello?",
        })
      ).status,
    ).toBe(404);
    expect((await call(outsider, "GET", `/chats/${chatId}/messages`)).status).toBe(404);
    expect((await call(admin, "GET", `/chats/${chatId}/messages`)).status).toBe(404);
  });

  it("marks the chat for somebody mentioned in it", async () => {
    const chatId = await group(olena, "Mentions", [petro, iryna]);
    await say(olena, chatId, "@Petro please check this", { mentions: [petro.id] });
    const listOf = async (who: Person) =>
      ((await call(who, "GET", "/chats")).body as { id: string; mentioned: boolean }[]).find(
        (c) => c.id === chatId,
      )!;
    expect((await listOf(petro)).mentioned).toBe(true);
    expect((await listOf(iryna)).mentioned).toBe(false);
  });

  it("lets only a firm admin post in the announcements channel", async () => {
    await call(admin, "GET", "/chats"); // the admin's own first look puts them in it
    const channel = (
      (await call(olena, "GET", "/chats")).body as { id: string; kind: string }[]
    ).find((c) => c.kind === "announcements")!;
    expect(
      (
        await call(olena, "POST", `/chats/${channel.id}/messages`, {
          clientMessageId: randomUUID(),
          text: "everyone!",
        })
      ).status,
    ).toBe(403);
    await say(admin, channel.id, "The office is closed on Friday");
  });

  it("makes a direct chat with a blocked colleague read only", async () => {
    const [danylo] = await createPeople(app, DOMAIN, ["Danylo"]);
    const direct = (await call(olena, "POST", "/direct", { userId: danylo.id })).body
      .id as string;
    await say(olena, direct, "before");
    await app.inject({
      method: "PATCH",
      url: `/api/users/${danylo.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: "blocked" },
    });
    expect(
      (
        await call(olena, "POST", `/chats/${direct}/messages`, {
          clientMessageId: randomUUID(),
          text: "after",
        })
      ).status,
    ).toBe(403);
    // and what was said is still there to read
    expect((await history(olena, direct)).messages).toHaveLength(1);
  });
});

describe("reading history", () => {
  it("pages from the newest up, and catches a tab up from where it stopped", async () => {
    const chatId = await group(olena, "History", [petro]);
    for (let i = 1; i <= 12; i++) await say(olena, chatId, `message ${i}`);

    const newest = await history(petro, chatId, "?limit=5");
    expect(newest.messages.map((m) => m.text)).toEqual([
      "message 8",
      "message 9",
      "message 10",
      "message 11",
      "message 12",
    ]);
    expect(newest.more).toBe(true);

    const above = await history(petro, chatId, `?limit=5&before=${newest.messages[0].seq}`);
    expect(above.messages.at(-1)!.text).toBe("message 7");

    // what a tab missed while its connection was away
    // the group's own "created" line is place 1, so message 10 stands at 11
    const missed = await history(petro, chatId, "?after=10");
    expect(missed.messages.map((m) => m.text)).toEqual([
      "message 10",
      "message 11",
      "message 12",
    ]);
    expect(missed.people.some((p) => p.id === olena.id)).toBe(true);
  });
});

describe("replying, editing and deleting", () => {
  it("quotes the first line of the original, and says so once it is gone", async () => {
    const chatId = await group(olena, "Replies", [petro]);
    const original = await say(olena, chatId, "Which form do we file?\nthe second line");
    const reply = await say(petro, chatId, "The 1120-S", { replyToId: original.id });
    expect(reply.replyTo).toMatchObject({
      id: original.id,
      seq: original.seq,
      preview: "Which form do we file?",
      deleted: false,
    });

    await call(olena, "DELETE", `/messages/${original.id}`);
    const after = await history(petro, chatId);
    expect(after.messages.at(-1)!.replyTo).toMatchObject({ preview: null, deleted: true });
  });

  it("refuses a reply to a message in another chat", async () => {
    const here = await group(olena, "Here", [petro]);
    const there = await group(olena, "There", [petro]);
    const elsewhere = await say(olena, there, "over there");
    expect(
      (
        await call(olena, "POST", `/chats/${here}/messages`, {
          clientMessageId: randomUUID(),
          text: "reply",
          replyToId: elsewhere.id,
        })
      ).status,
    ).toBe(400);
  });

  it("lets an author edit their own message and nobody else's", async () => {
    const chatId = await group(olena, "Edits", [petro]);
    const message = await say(olena, chatId, "teh 1040");
    expect(
      (await call(petro, "PATCH", `/messages/${message.id}`, { text: "mine now" })).status,
    ).toBe(403);
    const edited = (await call(olena, "PATCH", `/messages/${message.id}`, { text: "the 1040" }))
      .body as ChatMessage;
    expect(edited.text).toBe("the 1040");
    expect(edited.editedAt).not.toBeNull();
    // no earlier version is kept
    const row = await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(Buffer.from(row.ciphertext!).toString("utf8")).not.toContain("teh");
  });

  it("destroys the words on a delete for everyone, and records who deleted whose", async () => {
    const chatId = await group(olena, "Deletes", [petro]);
    const mine = await say(olena, chatId, "Petrenko's bank PIN is 4321");
    const deleted = (await call(olena, "DELETE", `/messages/${mine.id}`)).body as ChatMessage;
    expect(deleted.text).toBeNull();
    expect(deleted.deletedAt).not.toBeNull();
    const row = await prisma.chatMessage.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    const event = await logged("chat_message.deleted", mine.id);
    // the chat is named by what it is, never by its title (chat.md §12.1)
    expect(event.subjectLabel).toBe("a group");
    expect(event.changes).toEqual({ author: "their own" });
  });

  it("lets a group's admins delete anybody's message, and a plain member nobody's", async () => {
    const chatId = await group(olena, "Admin deletes", [petro, iryna]);
    const petros = await say(petro, chatId, "oops, wrong chat");
    expect((await call(iryna, "DELETE", `/messages/${petros.id}`)).status).toBe(403);

    const gone = (await call(olena, "DELETE", `/messages/${petros.id}`)).body as ChatMessage;
    expect(gone.deletedByOther).toBe(true);
    expect((await logged("chat_message.deleted", petros.id)).changes).toEqual({
      author: "Petro Tester",
    });
  });
});

describe("forwarding, reactions and pins", () => {
  it("forwards the words into another chat, keeping whom they came from", async () => {
    const from = await group(olena, "From", [petro]);
    const to = await group(petro, "To", [olena, iryna]);
    const original = await say(olena, from, "The deadline moved to 15 April");

    expect(
      (await call(petro, "POST", "/forward", { messageIds: [original.id], toChatIds: [to] }))
        .status,
    ).toBe(200);
    const last = (await history(iryna, to)).messages.at(-1)!;
    expect(last.text).toBe("The deadline moved to 15 April");
    expect(last.forwardedFromId).toBe(olena.id);
    expect(last.authorId).toBe(petro.id);
  });

  it("refuses to forward into a chat the sender is not in", async () => {
    const from = await group(olena, "Mine", [petro]);
    const theirs = await group(iryna, "Theirs", [petro]);
    const message = await say(olena, from, "not for them");
    expect(
      (await call(olena, "POST", "/forward", { messageIds: [message.id], toChatIds: [theirs] }))
        .status,
    ).toBe(404);
  });

  it("puts one of each emoji per person on a message, and takes it back", async () => {
    const chatId = await group(olena, "Reactions", [petro]);
    const message = await say(olena, chatId, "done");
    const react = (who: Person, emoji: string) =>
      call(who, "PUT", `/messages/${message.id}/reaction`, { emoji });

    await react(petro, "👍");
    const both = (await react(olena, "👍")).body as ChatMessage;
    expect(both.reactions).toEqual([
      { emoji: "👍", userIds: expect.arrayContaining([petro.id, olena.id]) },
    ]);
    const back = (await react(olena, "👍")).body as ChatMessage;
    expect(back.reactions[0].userIds).toEqual([petro.id]);
  });

  it("pins in a group by its admins alone, and lists what is pinned", async () => {
    const chatId = await group(olena, "Pins", [petro]);
    const message = await say(olena, chatId, "read this first");
    expect(
      (await call(petro, "PUT", `/messages/${message.id}/pin`, { pinned: true })).status,
    ).toBe(403);
    expect(
      (await call(olena, "PUT", `/messages/${message.id}/pin`, { pinned: true })).status,
    ).toBe(200);
    const pins = (await call(petro, "GET", `/chats/${chatId}/pins`)).body as ChatMessagePage;
    expect(pins.messages.map((m) => m.id)).toEqual([message.id]);

    await call(olena, "PUT", `/messages/${message.id}/pin`, { pinned: false });
    expect(
      ((await call(petro, "GET", `/chats/${chatId}/pins`)).body as ChatMessagePage).messages,
    ).toHaveLength(0);
  });
});

describe("polls", () => {
  it("takes one answer, changes it, and stops when the poll closes", async () => {
    const chatId = await group(olena, "Polls", [petro, iryna]);
    const res = await call(olena, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: randomUUID(),
      text: "Which day suits?",
      poll: { options: ["Monday", "Tuesday"], multiple: false },
    });
    const poll = res.body as ChatMessage;
    expect(poll.kind).toBe("poll");
    expect(poll.poll).toMatchObject({ options: ["Monday", "Tuesday"], multiple: false });

    const stored = await prisma.chatPoll.findUniqueOrThrow({ where: { messageId: poll.id } });
    expect(Buffer.from(stored.ciphertext).toString("utf8")).not.toContain("Monday");

    await call(petro, "PUT", `/messages/${poll.id}/vote`, { options: [0] });
    const changed = (await call(petro, "PUT", `/messages/${poll.id}/vote`, { options: [1] }))
      .body as ChatMessage;
    // never anonymous: everybody sees who chose what
    expect(changed.poll!.votes).toEqual([{ option: 1, userIds: [petro.id] }]);
    expect(
      (await call(petro, "PUT", `/messages/${poll.id}/vote`, { options: [0, 1] })).status,
    ).toBe(400);

    const closed = (await call(olena, "POST", `/messages/${poll.id}/poll/close`))
      .body as ChatMessage;
    expect(closed.poll!.closedAt).not.toBeNull();
    expect(
      (await call(iryna, "PUT", `/messages/${poll.id}/vote`, { options: [0] })).status,
    ).toBe(400);
  });

  it("takes several answers when it says so, and refuses an option that is not there", async () => {
    const chatId = await group(olena, "Multiple", [petro]);
    const poll = (
      await call(olena, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        text: "Which forms?",
        poll: { options: ["1040", "1120", "941"], multiple: true },
      })
    ).body as ChatMessage;
    const voted = (await call(petro, "PUT", `/messages/${poll.id}/vote`, { options: [0, 2] }))
      .body as ChatMessage;
    expect(voted.poll!.votes.map((v) => v.option).sort()).toEqual([0, 2]);
    expect(
      (await call(petro, "PUT", `/messages/${poll.id}/vote`, { options: [5] })).status,
    ).toBe(400);
  });
});
