import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ChatFilesPage,
  ChatMessage,
  ChatMessagePage,
  ChatSearchPage,
  ChatSummary,
} from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **A working day in one chat, seen by four people** (owner, 2026-09-20: "проведи повне критичне
 * тестування з різними користувачами … відправляй все можливе в чат і переглядай як в якого
 * користувача воно відображається").
 *
 * The other chat suites each take one feature apart. This one does the opposite: it puts
 * everything a person can send into one conversation — words, a mention, a photo, a document, a
 * poll, a reply, a reaction, a forward, a link into the CRM — and then asks the same questions
 * from four sides: the sender's, two colleagues', and somebody who is not in the chat at all.
 *
 * It exists because the bugs that survive per-feature suites live BETWEEN features: a file that
 * still opens after the message carrying it is gone, a search that answers with a chat somebody
 * has left, an unread count that a read in another tab did not clear.
 */

const DOMAIN = "@chat-drill.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let olena: Person;
let petro: Person;
let iryna: Person;
let outsider: Person;

/** The day's chat, and what was put in it: filled by the first test, read by the rest. */
let chatId: string;
const said: Record<string, ChatMessage> = {};
let photo: { fileId: string; previewFileId: string | null };
let paper: { fileId: string; previewFileId: string | null };

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

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
  const json = res.headers["content-type"]?.toString().includes("application/json");
  return { status: res.statusCode, body: json && res.body ? res.json() : null };
}

function form(parts: { field: string; name: string; body: Buffer }[]) {
  const boundary = "----buhcrmdrill";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; ` +
          `filename="${part.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      part.body,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

async function attach(who: Person, id: string, name: string, body: Buffer, preview?: Buffer) {
  const parts = [{ field: "file", name, body }];
  if (preview) parts.push({ field: "preview", name: "preview.png", body: preview });
  const { headers, payload } = form(parts);
  const res = await app.inject({
    method: "POST",
    url: `/api/chat/chats/${id}/files`,
    headers: { cookie: who.cookie, ...headers },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { fileId: string; previewFileId: string | null };
}

async function say(who: Person, id: string, payload: object) {
  const res = await call(who, "POST", `/chats/${id}/messages`, {
    clientMessageId: randomUUID(),
    ...payload,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ChatMessage;
}

const history = async (who: Person, id: string) =>
  (await call(who, "GET", `/chats/${id}/messages`)).body as ChatMessagePage;

const list = async (who: Person) => (await call(who, "GET", "/chats")).body as ChatSummary[];

const rowOf = async (who: Person, id: string) => (await list(who)).find((c) => c.id === id);

const find = async (who: Person, query: string) =>
  (await call(who, "GET", `/search?${query}`)).body as ChatSearchPage;

const filesOf = async (who: Person, id: string, query = "") =>
  (await call(who, "GET", `/chats/${id}/files${query ? `?${query}` : ""}`))
    .body as ChatFilesPage;

const door = (who: Person, fileId: string, which: "view" | "download" | "preview") =>
  app.inject({
    method: "GET",
    url: `/api/chat/files/${fileId}/${which}`,
    headers: { cookie: who.cookie },
  });

async function removeChatsOf(domain: string) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: domain } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await prisma.file.deleteMany({ where: { uploadedById: { in: ids } } });
  await prisma.chat.deleteMany({
    where: { kind: { not: "announcements" }, members: { some: { userId: { in: ids } } } },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
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

describe("everything Olena can send, in one group", () => {
  it("arrives for everybody in it, in one order, and for nobody outside it", async () => {
    chatId = (
      await call(olena, "POST", "/groups", {
        title: "Tax season 2026",
        memberIds: [petro.id, iryna.id],
      })
    ).body.id as string;

    said.words = await say(olena, chatId, {
      text: "the quarterly reconciliation starts Monday",
    });
    said.mention = await say(olena, chatId, {
      text: "@Petro the Petrenko papers, please",
      mentionIds: [petro.id],
    });
    photo = await attach(olena, chatId, "office.png", PNG, PNG);
    said.photo = await say(olena, chatId, { text: "", files: [photo] });
    paper = await attach(olena, chatId, "amortisation-2026.pdf", PDF);
    said.paper = await say(olena, chatId, { text: "last year's schedule", files: [paper] });
    said.poll = await say(olena, chatId, {
      text: "Which day for the closing call?",
      poll: { options: ["Wednesday morning", "Thursday afternoon"], multiple: false },
    });
    // a message that is only a link into the CRM: the server sees text, the reader's browser draws
    // the card (chat.md §5.6) — what matters here is that it travels like any other message
    said.link = await say(olena, chatId, {
      text: `http://localhost:5173/tasks?task=${randomUUID()}`,
    });
    said.reply = await say(petro, chatId, {
      text: "on it",
      replyToId: said.mention.id,
    });

    const seen = [olena, petro, iryna].map(async (who) => {
      const page = await history(who, chatId);
      return page.messages.map((m) => m.id);
    });
    const [asOlena, asPetro, asIryna] = await Promise.all(seen);
    const inOrder = [
      said.words.id,
      said.mention.id,
      said.photo.id,
      said.paper.id,
      said.poll.id,
      said.link.id,
      said.reply.id,
    ];
    expect(asOlena.slice(-inOrder.length)).toEqual(inOrder);
    expect(asPetro).toEqual(asOlena);
    expect(asIryna).toEqual(asOlena);

    // the same conversation, to somebody who is not in it: nothing, and not a hint of it
    expect((await call(outsider, "GET", `/chats/${chatId}/messages`)).status).toBe(404);
    expect((await call(outsider, "GET", `/chats/${chatId}`)).status).toBe(404);
    expect((await call(outsider, "GET", `/chats/${chatId}/files`)).status).toBe(404);
    expect(
      (await call(outsider, "GET", `/search?q=reconciliation&chatId=${chatId}`)).status,
    ).toBe(404);
    expect((await find(outsider, "q=reconciliation")).hits).toEqual([]);
    expect((await list(outsider)).some((c) => c.id === chatId)).toBe(false);
  });

  it("counts as unread for the two who have not read it, and as a mention for the one named", async () => {
    const forPetro = await rowOf(petro, chatId);
    const forIryna = await rowOf(iryna, chatId);
    const forOlena = await rowOf(olena, chatId);

    // writing is reading: Olena's own six lines are behind her, and Petro's reply is not
    expect(forOlena!.unread).toBe(1);
    // Petro wrote last, so his own reply left him at the end of the chat — and his mention with it
    expect(forPetro!.unread).toBe(0);
    expect(forPetro!.mentioned).toBe(false);
    // Iryna has read nothing and written nothing: the whole day is hers to read
    expect(forIryna!.unread).toBe(said.reply.seq);
    // the mention was for Petro by name; Iryna reads the same words and is not called
    expect(forIryna!.mentioned).toBe(false);

    await call(olena, "POST", `/chats/${chatId}/read`, { seq: said.reply.seq });
    expect((await rowOf(olena, chatId))!.unread).toBe(0);
    // and the others are untouched by her reading
    expect((await rowOf(iryna, chatId))!.unread).toBe(forIryna!.unread);

    const readBy = (await call(olena, "GET", `/messages/${said.poll.id}/read-by`)).body as {
      people: { id: string }[];
    };
    const who = readBy.people.map((p) => p.id);
    expect(who).toContain(petro.id); // his reply came after it
    expect(who).not.toContain(iryna.id);
  });

  it("opens its files to the people in the chat, and to nobody else", async () => {
    for (const who of [olena, petro, iryna]) {
      expect((await door(who, photo.fileId, "view")).statusCode).toBe(200);
      expect((await door(who, photo.previewFileId!, "preview")).statusCode).toBe(200);
      expect((await door(who, paper.fileId, "download")).statusCode).toBe(200);
    }
    for (const which of ["view", "download", "preview"] as const) {
      expect((await door(outsider, photo.fileId, which)).statusCode).toBe(404);
    }
    // the preview door is the narrow one: it answers for a preview and never for the photo behind
    // it, which is what keeps an unlogged, cacheable read off the files themselves (§6.2)
    expect((await door(petro, photo.fileId, "preview")).statusCode).toBe(404);
  });

  it("lists what the chat carries, by name and by who sent it", async () => {
    const all = await filesOf(petro, chatId);
    expect(all.files.map((f) => f.name).sort()).toEqual([
      "amortisation-2026.pdf",
      "office.png",
    ]);

    // the owner's ask: searching the attached files, by part of a name
    expect((await filesOf(iryna, chatId, "q=ortis")).files.map((f) => f.name)).toEqual([
      "amortisation-2026.pdf",
    ]);
    expect((await filesOf(iryna, chatId, `senderId=${petro.id}`)).files).toEqual([]);
    expect((await filesOf(iryna, chatId, `senderId=${olena.id}`)).files).toHaveLength(2);
  });

  it("pages its files without losing the rest of a message that carries several", async () => {
    // a page can end in the middle of a message with ten files; the cursor is the pair (place,
    // position), so the next page picks up inside that same message (audit, 2026-09-20)
    const many = await Promise.all(
      [0, 1, 2].map((n) => attach(olena, chatId, `sheet-${n}.txt`, Buffer.from(`n${n}`))),
    );
    await say(olena, chatId, { text: "three at once", files: many });

    const first = await filesOf(petro, chatId, "");
    const all = first.files.map((f) => f.name);
    expect(all.slice(0, 3)).toEqual(["sheet-2.txt", "sheet-1.txt", "sheet-0.txt"]);

    // stop after the FIRST of the three and ask for what is older than it
    const head = first.files[0];
    const next = await filesOf(
      petro,
      chatId,
      `before=${head.seq}&beforePosition=${head.position}`,
    );
    expect(next.files.map((f) => f.name).slice(0, 2)).toEqual(["sheet-1.txt", "sheet-0.txt"]);
  });

  it("is searchable by part of a word, in this chat and across them all, by each of them", async () => {
    for (const who of [olena, petro, iryna]) {
      const here = await find(who, `q=онcил&chatId=${chatId}`);
      expect(here.hits, "a word that is not in it").toEqual([]);

      const byPart = await find(who, `q=${encodeURIComponent("oncil")}&chatId=${chatId}`);
      expect(byPart.hits.map((h) => h.messageId)).toEqual([said.words.id]);

      // the same word with no chat named searches every chat this person is in
      const everywhere = await find(who, "q=reconciliation");
      expect(everywhere.hits.map((h) => h.messageId)).toEqual([said.words.id]);

      // a poll is found by its question and by an option nobody typed as a message
      expect(
        (await find(who, "q=thursday")).hits.map((h) => h.messageId),
        "an option of the poll",
      ).toContain(said.poll.id);

      // and the filter the Files tab's sibling uses: only what carried something
      expect(
        (await find(who, `q=schedule&hasFiles=true&chatId=${chatId}`)).hits.map(
          (h) => h.messageId,
        ),
      ).toEqual([said.paper.id]);
    }
  });
});

describe("the poll, three people and a change of mind", () => {
  it("shows everybody the same counts, and the names behind them", async () => {
    await call(petro, "PUT", `/messages/${said.poll.id}/vote`, { options: [0] });
    await call(iryna, "PUT", `/messages/${said.poll.id}/vote`, { options: [1] });
    // the owner's note, 2026-09-20: an answer can be changed
    const changed = await call(petro, "PUT", `/messages/${said.poll.id}/vote`, {
      options: [1],
    });
    expect(changed.status).toBe(200);

    for (const who of [olena, petro, iryna]) {
      const page = await history(who, chatId);
      const poll = page.messages.find((m) => m.id === said.poll.id)!.poll!;
      expect(poll.votes).toEqual([
        { option: 1, userIds: expect.arrayContaining([petro.id, iryna.id]) },
      ]);
      expect(poll.votes[0].userIds).toHaveLength(2);
      expect(poll.closedAt).toBeNull();
    }

    // and taking an answer back leaves the poll with one voter, not with a ghost
    await call(iryna, "PUT", `/messages/${said.poll.id}/vote`, { options: [] });
    const after = (await history(olena, chatId)).messages.find((m) => m.id === said.poll.id)!;
    expect(after.poll!.votes).toEqual([{ option: 1, userIds: [petro.id] }]);
  });

  it("stops taking answers once its author closes it, for everybody at once", async () => {
    expect((await call(petro, "POST", `/messages/${said.poll.id}/poll/close`)).status).toBe(
      403,
    );
    expect((await call(olena, "POST", `/messages/${said.poll.id}/poll/close`)).status).toBe(
      200,
    );

    expect(
      (await call(iryna, "PUT", `/messages/${said.poll.id}/vote`, { options: [0] })).status,
    ).toBe(400);
    for (const who of [olena, petro, iryna]) {
      const poll = (await history(who, chatId)).messages.find(
        (m) => m.id === said.poll.id,
      )!.poll!;
      expect(poll.closedAt).not.toBeNull();
      expect(poll.votes).toEqual([{ option: 1, userIds: [petro.id] }]);
    }
  });
});

describe("what one person does to another's view", () => {
  it("carries a forwarded photo into a chat the others are not in, and keeps it when the first is deleted", async () => {
    const direct = (await call(petro, "POST", "/direct", { userId: iryna.id })).body
      .id as string;
    expect(
      (
        await call(petro, "POST", "/forward", {
          messageIds: [said.photo.id],
          toChatIds: [direct],
        })
      ).status,
    ).toBe(200);
    const copy = (await history(iryna, direct)).messages.at(-1)!;
    // the same file, not a copy of its bytes: one row, carried by two live messages (§6.3)
    expect(copy.files?.[0].fileId).toBe(photo.fileId);
    expect(copy.forwardedFromId).toBeTruthy();

    // Olena is not in the direct chat: the copy is not hers to read, though she sent the original
    expect((await call(olena, "GET", `/chats/${direct}/messages`)).status).toBe(404);

    await call(olena, "DELETE", `/messages/${said.photo.id}`);
    // the original is a tombstone for everybody, and a tombstone carries nothing: the conversation
    // used to draw the photo under the words "Message deleted" (audit, 2026-09-20)
    for (const who of [olena, petro, iryna]) {
      const gone = (await history(who, chatId)).messages.find((m) => m.id === said.photo.id)!;
      expect(gone.deletedAt).not.toBeNull();
      expect(gone.files).toEqual([]);
      expect(gone.text).toBeNull();
    }
    // the file itself is still there, because a live message in the direct chat carries it…
    expect((await door(iryna, photo.fileId, "view")).statusCode).toBe(200);
    // …and reaches only the people in THAT chat: Olena sent it and can no longer open it
    expect((await door(olena, photo.fileId, "view")).statusCode).toBe(404);
    // the group's Files tab has let it go with the message, and still holds what is still carried
    const tab = (await filesOf(olena, chatId)).files.map((f) => f.name);
    expect(tab).not.toContain("office.png");
    expect(tab).toContain("amortisation-2026.pdf");
  });

  it("makes the same forward twice one copy, however the first attempt ended", async () => {
    const direct = (await call(petro, "POST", "/direct", { userId: iryna.id })).body
      .id as string;
    const before = (await history(iryna, direct)).messages.length;
    const twice = { messageIds: [said.words.id], toChatIds: [direct] };
    expect((await call(petro, "POST", "/forward", twice)).status).toBe(200);
    expect((await call(petro, "POST", "/forward", twice)).status).toBe(200);
    // a forward is one request into many chats, each in its own transaction: a retry after a lost
    // connection used to duplicate every chat that had already landed (audit, 2026-09-20)
    expect((await history(iryna, direct)).messages.length).toBe(before + 1);
  });

  it("gives a destination all of a forward or none of it", async () => {
    const direct = (await call(petro, "POST", "/direct", { userId: iryna.id })).body
      .id as string;
    const before = (await history(iryna, direct)).messages.length;
    // not `said.words`: the idempotency test above already put its copy in this chat, and a copy
    // that is already there is exactly what does NOT land twice
    const three = [said.mention.id, said.paper.id, said.reply.id];
    expect(
      (await call(petro, "POST", "/forward", { messageIds: three, toChatIds: [direct] }))
        .status,
    ).toBe(200);
    // one transaction per destination: three in, three arrive, in the order they were sent
    const after = (await history(iryna, direct)).messages;
    expect(after.length).toBe(before + 3);
    expect(after.slice(-3).every((m) => m.forwardedFromId !== null)).toBe(true);
  });

  it("takes a leaver out of the conversation without taking the conversation out of it", async () => {
    await call(petro, "POST", `/chats/${chatId}/leave`);

    expect((await list(petro)).some((c) => c.id === chatId)).toBe(false);
    expect((await call(petro, "GET", `/chats/${chatId}/messages`)).status).toBe(404);
    // the group is not his to search any more; what he finds is the copy in his own direct chat,
    // which is his to keep — forwarding it there was his act
    expect((await call(petro, "GET", `/search?q=reconciliation&chatId=${chatId}`)).status).toBe(
      404,
    );
    expect((await find(petro, "q=reconciliation")).hits.map((h) => h.chatId)).not.toContain(
      chatId,
    );
    // the group's Files tab is not his either; the PDF itself he can still open, because he
    // forwarded it into his own direct chat a moment ago and a live message there carries it —
    // a file belongs to the MESSAGES that carry it, not to a chat (§6.3)
    expect((await call(petro, "GET", `/chats/${chatId}/files`)).status).toBe(404);
    expect((await door(petro, paper.fileId, "download")).statusCode).toBe(200);

    // for the two still in it, nothing of his is missing, the reply included
    const page = await history(iryna, chatId);
    expect(page.messages.map((m) => m.id)).toContain(said.reply.id);
    expect(page.messages.at(-1)).toMatchObject({
      kind: "notice",
      notice: { code: "member_left", userIds: [petro.id] },
    });
    expect(
      (await find(iryna, `q=reconciliation&chatId=${chatId}`)).hits.map((h) => h.messageId),
    ).toEqual([said.words.id]);
  });

  it("hides a chat for the one who hid it, and brings it back when somebody writes", async () => {
    await call(iryna, "PUT", `/chats/${chatId}/settings`, { hidden: true });
    expect((await list(iryna)).some((c) => c.id === chatId)).toBe(false);
    // Olena's list is her own: hiding is not leaving
    expect((await list(olena)).some((c) => c.id === chatId)).toBe(true);

    await say(olena, chatId, { text: "one more thing before Monday" });
    const back = await rowOf(iryna, chatId);
    expect(back, "a hidden chat comes back when it moves").toBeDefined();
    expect(back!.unread).toBeGreaterThan(0);
  });
});
