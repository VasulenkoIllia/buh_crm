import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, ChatSearchPage } from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { queryTokens, tokensOf, wordsIn } from "./chat.search.js";

/**
 * **The word search over sealed text** (chat.md §8, §19): what is stored, what is found, and what
 * a reader must not find. The rule underneath every case here is that the database holds hashes:
 * a test looks for a word of a message in the token table and finds nothing readable.
 */

const DOMAIN = "@chat-search.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let olena: Person;
let petro: Person;
let outsider: Person;

async function call(
  who: Person,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

async function find(who: Person, query: string): Promise<ChatSearchPage> {
  const res = await call(who, "GET", `/search?${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ChatSearchPage;
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
  [olena, petro, outsider] = await createPeople(app, DOMAIN, ["Olena", "Petro", "Outsider"]);
});

afterAll(async () => {
  await app?.close();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
});

describe("what is stored", () => {
  it("keeps hashes, and never a word", async () => {
    const chatId = await group(olena, "Hashes", [petro]);
    const message = await say(olena, chatId, "The Kovalenko invoice is ready");

    const tokens = await prisma.chatSearchToken.findMany({ where: { messageId: message.id } });
    expect(tokens.length).toBeGreaterThan(0);
    const bytes = Buffer.concat(tokens.map((t) => Buffer.from(t.token))).toString("utf8");
    for (const word of ["kovalenko", "invoice", "ready"]) expect(bytes).not.toContain(word);
    // every token is the same width, so none of them is a word by accident
    expect([...new Set(tokens.map((t) => t.token.length))]).toEqual([12]);
  });

  it("splits words the way people type them, and folds case and accents", () => {
    expect(wordsIn("The Kovalenko INVOICE, ready?")).toEqual([
      "the",
      "kovalenko",
      "invoice",
      "ready",
    ]);
    // shorter than three letters is not a word the search knows (§8)
    expect(wordsIn("a to of 1040")).toEqual(["1040"]);
    // the same word typed either way hashes to the same token
    expect(tokensOf(["Ірина"])).toEqual(tokensOf(["ІРИНА"]));
    expect(queryTokens("ready").map((t) => Buffer.from(t).toString("hex"))).toEqual(
      tokensOf(["ready"])
        .filter((_, i, all) => i === all.length - 1)
        .map((t) => Buffer.from(t).toString("hex")),
    );
  });
});

describe("finding", () => {
  it("finds a message by the start of a word, in any order, and says where it is", async () => {
    const chatId = await group(olena, "Kovalenko season", [petro]);
    const message = await say(olena, chatId, "The Kovalenko invoice is ready for Friday");
    await say(olena, chatId, "Nothing to do with it");

    const byPrefix = await find(petro, "q=kova");
    expect(byPrefix.hits.map((h) => h.messageId)).toContain(message.id);
    const hit = byPrefix.hits.find((h) => h.messageId === message.id)!;
    expect(hit.chatLabel).toBe("Kovalenko season");
    expect(hit.snippet).toContain("Kovalenko");
    expect(hit.authorId).toBe(olena.id);
    expect(byPrefix.people.map((p) => p.id)).toContain(olena.id);

    // every word must be somewhere, in any order
    expect((await find(petro, "q=friday%20invoice")).hits.map((h) => h.messageId)).toEqual([
      message.id,
    ]);
    // …and a word that is not there finds nothing
    expect((await find(petro, "q=invoice%20elephant")).hits).toEqual([]);
    // two letters are not a word (§8)
    expect((await find(petro, "q=is")).hits).toEqual([]);
  });

  it("searches one chat when asked, and every chat when not", async () => {
    const first = await group(olena, "First", [petro]);
    const second = await group(olena, "Second", [petro]);
    const here = await say(olena, first, "quarterly reconciliation here");
    const there = await say(olena, second, "quarterly reconciliation there");

    const everywhere = await find(petro, "q=reconciliation");
    expect(everywhere.hits.map((h) => h.messageId).sort()).toEqual([here.id, there.id].sort());

    const oneChat = await find(petro, `q=reconciliation&chatId=${second}`);
    expect(oneChat.hits.map((h) => h.messageId)).toEqual([there.id]);
  });

  it("filters by who wrote it, by day, and by whether it carried files", async () => {
    const chatId = await group(olena, "Filters", [petro]);
    const hers = await say(olena, chatId, "depreciation schedule from Olena");
    const his = await say(petro, chatId, "depreciation schedule from Petro");

    expect(
      (await find(olena, `q=depreciation&senderId=${petro.id}`)).hits.map((h) => h.messageId),
    ).toEqual([his.id]);

    const today = new Date().toISOString().slice(0, 10);
    expect((await find(olena, `q=depreciation&from=${today}`)).hits).toHaveLength(2);
    expect((await find(olena, "q=depreciation&to=2020-01-01")).hits).toEqual([]);

    // nothing here carried a file
    expect((await find(olena, "q=depreciation&hasFiles=true")).hits).toEqual([]);
    expect(hers.id).toBeTruthy();
  });

  it("finds a poll by its question and by its options", async () => {
    const chatId = await group(olena, "Polls", [petro]);
    const poll = await say(olena, chatId, "Which day for the closing call?", {
      poll: { options: ["Wednesday morning", "Thursday afternoon"], multiple: false },
    });
    expect((await find(petro, "q=closing")).hits.map((h) => h.messageId)).toContain(poll.id);
    expect((await find(petro, "q=thursday")).hits.map((h) => h.messageId)).toContain(poll.id);
  });
});

describe("what it must not find", () => {
  it("never answers with a chat the reader is not in", async () => {
    const chatId = await group(olena, "Private", [petro]);
    const message = await say(olena, chatId, "the Petrenko restructuring memo");
    expect((await find(petro, "q=restructuring")).hits.map((h) => h.messageId)).toEqual([
      message.id,
    ]);
    // a firm admin outside the group, searching the same word
    expect((await find(outsider, "q=restructuring")).hits).toEqual([]);
    expect((await call(outsider, "GET", `/search?q=memo&chatId=${chatId}`)).status).toBe(404);
  });

  it("forgets the words of a message that was edited or deleted", async () => {
    const chatId = await group(olena, "Edits", [petro]);
    const message = await say(olena, chatId, "the amortisation table is wrong");
    expect((await find(petro, "q=amortisation")).hits).toHaveLength(1);

    await call(olena, "PATCH", `/messages/${message.id}`, {
      text: "the reconciliation table is right",
    });
    expect((await find(petro, "q=amortisation")).hits).toEqual([]);
    expect(
      (await find(petro, `q=reconciliation&chatId=${chatId}`)).hits.map((h) => h.messageId),
    ).toEqual([message.id]);

    await call(olena, "DELETE", `/messages/${message.id}`);
    expect((await find(petro, `q=reconciliation&chatId=${chatId}`)).hits).toEqual([]);
    expect(await prisma.chatSearchToken.count({ where: { messageId: message.id } })).toBe(0);
  });

  it("stops answering somebody who has left the group", async () => {
    const chatId = await group(olena, "Left", [petro]);
    const message = await say(olena, chatId, "the escrow balance");
    expect((await find(petro, "q=escrow")).hits.map((h) => h.messageId)).toEqual([message.id]);

    expect((await call(petro, "POST", `/chats/${chatId}/leave`)).status).toBe(200);
    expect((await find(petro, "q=escrow")).hits).toEqual([]);
  });
});
