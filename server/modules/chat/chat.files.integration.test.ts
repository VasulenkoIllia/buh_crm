import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatFilesPage,
  ChatMessage,
  ChatMessagePage,
  ChatSummary,
} from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { purgeTrash } from "../files/index.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { sweepUnsentChatUploads } from "./index.js";

/**
 * **Files in chats** (chat.md §6, §19): the upload and its photo preview, the send that carries
 * them, who may open one, what a delete does to it, and the sweep for uploads nobody sent.
 *
 * The rule under all of it is §6.3: a chat file belongs to the MESSAGES that carry it, not to a
 * chat, so every check here is about what a person's live messages reach.
 */

const DOMAIN = "@chat-files.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let olena: Person;
let petro: Person;
let iryna: Person;
let outsider: Person;
let since = new Date();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(126)]);

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
  const json = res.headers["content-type"]?.toString().includes("application/json");
  return { status: res.statusCode, body: json && res.body ? res.json() : null, raw: res };
}

/** One file, and the small JPEG the browser drew for a photo beside it, as the composer sends it. */
function form(parts: { field: string; name: string; body: Buffer }[]) {
  const boundary = "----buhcrmchatfiles";
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

async function upload(
  who: Person,
  chatId: string,
  name: string,
  body: Buffer,
  preview?: Buffer,
) {
  const parts = [{ field: "file", name, body }];
  if (preview) parts.push({ field: "preview", name: "preview.png", body: preview });
  const { headers, payload } = form(parts);
  const res = await app.inject({
    method: "POST",
    url: `/api/chat/chats/${chatId}/files`,
    headers: { cookie: who.cookie, ...headers },
    payload,
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function sent(who: Person, chatId: string, name: string, body = PNG, preview = PNG) {
  const res = await upload(who, chatId, name, body, preview);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { fileId: string; previewFileId: string | null };
}

async function say(who: Person, chatId: string, payload: object) {
  const res = await call(who, "POST", `/chats/${chatId}/messages`, {
    clientMessageId: randomUUID(),
    ...payload,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ChatMessage;
}

async function group(owner: Person, title: string, others: Person[]): Promise<string> {
  const res = await call(owner, "POST", "/groups", {
    title,
    memberIds: others.map((p) => p.id),
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function history(who: Person, chatId: string): Promise<ChatMessagePage> {
  const res = await call(who, "GET", `/chats/${chatId}/messages`);
  expect(res.status).toBe(200);
  return res.body as ChatMessagePage;
}

async function logged(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
      select: { subjectLabel: true, changes: true },
      orderBy: { occurredAt: "desc" },
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

describe("sending a file", () => {
  it("carries the photo and its preview to everybody in the chat, and logs both acts", async () => {
    const chatId = await group(olena, "Photos", [petro]);
    const file = await sent(olena, chatId, "balance.png");
    expect(file.previewFileId).not.toBeNull();

    const uploadRow = await logged("chat_file.uploaded", file.fileId);
    // never the name, never the chat: the activity screen is read outside the chat (§12.1)
    expect(uploadRow.subjectLabel).toBe("a chat file");
    expect(uploadRow.changes).toMatchObject({ size: PNG.byteLength });

    const message = await say(olena, chatId, { text: "here", files: [file] });
    expect(message.files).toHaveLength(1);
    expect(message.files[0]).toMatchObject({
      fileId: file.fileId,
      name: "balance.png",
      size: PNG.byteLength,
      detectedMime: "image/png",
      view: "image",
      previewFileId: file.previewFileId,
      position: 0,
    });

    // the other member sees it in the history and can open all three doors
    const page = await history(petro, chatId);
    expect(page.messages.at(-1)!.files[0].fileId).toBe(file.fileId);

    const view = await call(petro, "GET", `/files/${file.fileId}/view`);
    expect(view.status).toBe(200);
    expect(view.raw.headers["content-type"]).toBe("image/png");
    const download = await call(petro, "GET", `/files/${file.fileId}/download`);
    expect(download.status).toBe(200);
    expect(download.raw.headers["content-disposition"]).toContain("attachment");
    const preview = await call(petro, "GET", `/files/${file.previewFileId}/preview`);
    expect(preview.status).toBe(200);
    // a preview may be cached: its bytes never change and its id is unique (§6.2)
    expect(preview.raw.headers["cache-control"]).toContain("max-age");

    // an open and a download are the same act, and each row says which
    const opened = await logged("chat_file.downloaded", file.fileId);
    expect(opened.subjectLabel).toBe("a chat file");
    expect(opened.changes).toMatchObject({ via: "download" });
  });

  it("carries a file with no words at all, and the list says so", async () => {
    const chatId = await group(olena, "Wordless", [petro]);
    const file = await sent(olena, chatId, "scan.png");
    const message = await say(olena, chatId, { files: [file] });
    expect(message.text).toBeNull();

    const chats = (await call(petro, "GET", "/chats")).body as ChatSummary[];
    const row = chats.find((c) => c.id === chatId)!;
    expect(row.lastMessage).toMatchObject({ preview: null, files: 1 });
  });

  it("refuses a program, whatever its name says, and keeps no row for it", async () => {
    const chatId = await group(olena, "Programs", [petro]);
    const res = await upload(olena, chatId, "notes.txt", EXE);
    expect(res.status).toBe(400);
    expect(await prisma.file.count({ where: { chatId, name: "notes.txt" } })).toBe(0);
  });

  it("gives a preview only to a photo, and takes the pair back when it cannot", async () => {
    const chatId = await group(olena, "Papers", [petro]);
    const res = await upload(olena, chatId, "return.pdf", PDF, PNG);
    expect(res.status).toBe(400);
    // the document went back with the preview: half a pair is an upload the composer cannot draw
    expect(await prisma.file.count({ where: { chatId } })).toBe(0);

    const alone = await upload(olena, chatId, "return.pdf", PDF);
    expect(alone.status).toBe(201);
    expect(alone.body.previewFileId).toBeNull();
    expect(alone.body.view).toBe("pdf");
  });
});

describe("who may open one", () => {
  it("answers a member of a chat holding a live message that carries it, and nobody else", async () => {
    const chatId = await group(olena, "Members only", [petro]);
    const file = await sent(olena, chatId, "payroll.png");

    // before the send only its uploader reaches it: the composer drawing what is about to go
    expect((await call(olena, "GET", `/files/${file.fileId}/view`)).status).toBe(200);
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(404);

    await say(olena, chatId, { files: [file] });
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(200);
    // a firm admin who is not in the group is told it does not exist, as everywhere in the chat
    expect((await call(admin, "GET", `/files/${file.fileId}/view`)).status).toBe(404);
    expect((await call(outsider, "GET", `/files/${file.fileId}/download`)).status).toBe(404);
    expect((await call(outsider, "GET", `/files/${file.previewFileId}/preview`)).status).toBe(
      404,
    );
  });

  it("takes a file out of reach when the message carrying it is deleted", async () => {
    const chatId = await group(olena, "Deleted", [petro]);
    const file = await sent(olena, chatId, "wrong.png");
    const message = await say(olena, chatId, { files: [file] });
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(200);

    expect((await call(olena, "DELETE", `/messages/${message.id}`)).status).toBe(200);
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(404);
    expect((await call(petro, "GET", `/files/${file.previewFileId}/preview`)).status).toBe(404);
  });

  it("serves pictures alone through the preview door, which is the read that is never logged", async () => {
    const chatId = await group(olena, "Preview door", [petro]);
    const doc = (await upload(olena, chatId, "return.pdf", PDF)).body as { fileId: string };
    await say(olena, chatId, { files: [doc] });
    expect((await call(petro, "GET", `/files/${doc.fileId}/preview`)).status).toBe(404);
    expect((await call(petro, "GET", `/files/${doc.fileId}/view`)).status).toBe(200);
  });
});

describe("what a send may name", () => {
  it("refuses somebody else's upload, another chat's, and the same file twice", async () => {
    const mine = await group(olena, "Mine", [petro]);
    const other = await group(olena, "Other", [petro]);
    const file = await sent(olena, mine, "one.png");
    const petros = await sent(petro, mine, "petro.png");

    const wrongChat = await call(petro, "POST", `/chats/${other}/messages`, {
      clientMessageId: randomUUID(),
      files: [{ fileId: petros.fileId }],
    });
    expect(wrongChat.status).toBe(400);

    const notMine = await call(petro, "POST", `/chats/${mine}/messages`, {
      clientMessageId: randomUUID(),
      files: [{ fileId: file.fileId }],
    });
    expect(notMine.status).toBe(400);

    const twice = await call(olena, "POST", `/chats/${mine}/messages`, {
      clientMessageId: randomUUID(),
      files: [{ fileId: file.fileId }, { fileId: file.fileId }],
    });
    expect(twice.status).toBe(400);

    // and once it is sent it cannot be sent again: nothing is left unsent to name
    await say(olena, mine, { files: [file] });
    const again = await call(olena, "POST", `/chats/${mine}/messages`, {
      clientMessageId: randomUUID(),
      files: [{ fileId: file.fileId }],
    });
    expect(again.status).toBe(400);
  });

  it("holds the chat's own rule about who may put something in it", async () => {
    // opening the list is what puts a person in the channel when a boot has not (chat.service)
    for (const who of [admin, petro])
      expect((await call(who, "GET", "/chats")).status).toBe(200);
    const channel = await prisma.chat.findFirstOrThrow({ where: { kind: "announcements" } });
    const refused = await upload(petro, channel.id, "notice.png", PNG);
    expect(refused.status).toBe(403);
    const allowed = await upload(admin, channel.id, "notice.png", PNG);
    expect(allowed.status).toBe(201);
    await prisma.file.deleteMany({ where: { id: allowed.body.fileId } });
  });
});

describe("the nightly sweep", () => {
  it("takes uploads nobody sent, and never one a message carries", async () => {
    const chatId = await group(olena, "Sweep", [petro]);
    const abandoned = await sent(olena, chatId, "abandoned.png");
    const kept = await sent(olena, chatId, "kept.png");
    await say(olena, chatId, { files: [kept] });

    // yesterday's, so the sweep is due; today's upload is left alone whatever happens to it
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await prisma.file.updateMany({
      where: { chatId, id: { in: [abandoned.fileId, kept.fileId] } },
      data: { createdAt: yesterday },
    });

    await sweepUnsentChatUploads();
    expect(await prisma.file.count({ where: { id: abandoned.fileId } })).toBe(0);
    expect(await prisma.file.count({ where: { id: kept.fileId } })).toBe(1);
    // the sent one still opens for the chat
    expect((await call(petro, "GET", `/files/${kept.fileId}/view`)).status).toBe(200);
  });
});

describe("a chat's Files tab (§6.4)", () => {
  it("lists what the chat still carries, newest first, by name and by sender", async () => {
    const chatId = await group(olena, "The tab", [petro]);
    const one = await sent(olena, chatId, "balance-sheet.png");
    await say(olena, chatId, { files: [one] });
    const two = (await upload(petro, chatId, "payroll-june.pdf", PDF)).body as {
      fileId: string;
    };
    await say(petro, chatId, { text: "the payroll", files: [two] });

    const all = (await call(olena, "GET", `/chats/${chatId}/files`)).body as ChatFilesPage;
    expect(all.files.map((f) => f.name)).toEqual(["payroll-june.pdf", "balance-sheet.png"]);
    expect(all.files[0]).toMatchObject({ senderId: petro.id, view: "pdf" });
    expect(all.more).toBe(false);

    const byName = (await call(olena, "GET", `/chats/${chatId}/files?q=PAYROLL`))
      .body as ChatFilesPage;
    expect(byName.files.map((f) => f.name)).toEqual(["payroll-june.pdf"]);

    const bySender = (await call(olena, "GET", `/chats/${chatId}/files?senderId=${olena.id}`))
      .body as ChatFilesPage;
    expect(bySender.files.map((f) => f.name)).toEqual(["balance-sheet.png"]);

    // and it is the chat's own: somebody outside is told the chat does not exist
    expect((await call(outsider, "GET", `/chats/${chatId}/files`)).status).toBe(404);
  });

  it("drops a file from the tab when the message carrying it is deleted", async () => {
    const chatId = await group(olena, "Tab after a delete", [petro]);
    const file = await sent(olena, chatId, "mistake.png");
    const message = await say(olena, chatId, { files: [file] });
    expect(
      ((await call(petro, "GET", `/chats/${chatId}/files`)).body as ChatFilesPage).files,
    ).toHaveLength(1);

    await call(olena, "DELETE", `/messages/${message.id}`);
    expect(
      ((await call(petro, "GET", `/chats/${chatId}/files`)).body as ChatFilesPage).files,
    ).toHaveLength(0);
  });
});

describe("forwarding a file (§6.3)", () => {
  it("sends the same file on, without copying it, and keeps it while a live message carries it", async () => {
    const first = await group(olena, "From", [petro]);
    const second = await group(olena, "To", [petro]);
    const file = await sent(olena, first, "shared.png");
    const message = await say(olena, first, { files: [file] });

    const forwarded = await call(olena, "POST", "/forward", {
      messageIds: [message.id],
      toChatIds: [second],
    });
    expect(forwarded.status).toBe(200);

    // one file, two messages: the bucket holds one object, and the link table says both
    const there = (await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage;
    expect(there.files.map((f) => f.fileId)).toEqual([file.fileId]);
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(1);

    // deleting the first message leaves it alone: the forward still carries it
    await call(olena, "DELETE", `/messages/${message.id}`);
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(200);
    expect(
      (await prisma.file.findUniqueOrThrow({ where: { id: file.fileId } })).deletedAt,
    ).toBeNull();

    // and deleting the last one puts it in the Trash
    const copy = (await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage;
    await call(olena, "DELETE", `/messages/${copy.files[0].messageId}`);
    expect(
      (await prisma.file.findUniqueOrThrow({ where: { id: file.fileId } })).deletedAt,
    ).not.toBeNull();
  });
});

describe("the Trash, and coming back (§6.3)", () => {
  async function trashList(who: Person) {
    const res = await app.inject({
      method: "GET",
      url: "/api/files/trash",
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      batches: { items: { id: string; name: string; from: string }[] }[];
    };
  }

  it("shows a deleted message's file to its uploader and to whoever deleted it, and to nobody else", async () => {
    const chatId = await group(olena, "Trash", [petro, iryna]);
    const file = await sent(petro, chatId, "petros-scan.png");
    const message = await say(petro, chatId, { files: [file] });
    // an admin of the group deletes somebody else's message
    expect((await call(olena, "DELETE", `/messages/${message.id}`)).status).toBe(200);

    const deleted = await logged("chat_file.deleted", file.fileId);
    expect(deleted.subjectLabel).toBe("a chat file");

    const items = (who: Awaited<ReturnType<typeof trashList>>) =>
      who.batches.flatMap((b) => b.items);
    expect(items(await trashList(petro)).map((i) => i.name)).toContain("petros-scan.png");
    const olenas = items(await trashList(olena)).find((i) => i.id === file.fileId);
    expect(olenas?.from).toBe("A chat");
    // never which chat, and never to a colleague who was only in the group
    expect(items(await trashList(iryna)).map((i) => i.id)).not.toContain(file.fileId);

    // the photo's preview is not in the Trash beside it: it went with the message
    expect(await prisma.file.count({ where: { id: file.previewFileId! } })).toBe(0);
  });

  it("brings it back into the restorer's own My files", async () => {
    const chatId = await group(olena, "Restoring", [petro]);
    const file = await sent(petro, chatId, "return-2025.png");
    const message = await say(petro, chatId, { files: [file] });
    await call(petro, "DELETE", `/messages/${message.id}`);

    const restored = await app.inject({
      method: "POST",
      url: `/api/files/trash/files/${file.fileId}/restore`,
      headers: { cookie: petro.cookie },
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const row = await prisma.file.findUniqueOrThrow({ where: { id: file.fileId } });
    expect(row).toMatchObject({
      scope: `personal:${petro.id}`,
      space: "personal",
      ownerId: petro.id,
      chatId: null,
      deletedAt: null,
      folderId: null,
    });
    // it is an ordinary file of theirs now, and the chat's own door no longer opens it
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(404);
    const mine = await app.inject({
      method: "GET",
      url: "/api/files/my/list",
      headers: { cookie: petro.cookie },
    });
    expect((mine.json().files as { name: string }[]).map((f) => f.name)).toContain(
      "return-2025.png",
    );
    await prisma.file.delete({ where: { id: file.fileId } });
  });

  it("is emptied by the nightly purge, which says so without naming the file", async () => {
    const chatId = await group(olena, "Purge", [petro]);
    const file = await sent(olena, chatId, "old.png");
    const message = await say(olena, chatId, { files: [file] });
    await call(olena, "DELETE", `/messages/${message.id}`);

    await prisma.file.update({
      where: { id: file.fileId },
      data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    await purgeTrash();
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
    const purged = await logged("chat_file.purged", file.fileId);
    expect(purged.subjectLabel).toBe("a chat file");
  });
});
