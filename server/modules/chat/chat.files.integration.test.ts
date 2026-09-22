import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatFilesOverview,
  ChatFilesPage,
  ChatMessage,
  ChatMessagePage,
  ChatSummary,
} from "@shared/schema/chat.js";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { invalidateAccessCache } from "../../core/access.js";
import * as repo from "./chat.repository.js";
import { sweepChatFiles } from "./index.js";
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

/**
 * How many rows an action left, once the log has stopped moving. A row is written after the
 * response, so a count taken straight away is a race of its own — this waits for the first and then
 * for a moment more, which is what makes "exactly one" mean anything.
 */
async function settledCount(action: string, subjectId: string, since: Date): Promise<number> {
  const count = () =>
    prisma.activityEvent.count({ where: { action, subjectId, occurredAt: { gte: since } } });
  for (let attempt = 0; attempt < 40 && (await count()) === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return count();
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

    // the door takes a PREVIEW's id and nothing else: a photo sent as the attachment is an
    // image too, and the wider question would make this a quiet way to fetch it (review 2026-09-20)
    const photograph = await sent(olena, chatId, "screenshot.png");
    await say(olena, chatId, { files: [photograph] });
    expect((await call(petro, "GET", `/files/${photograph.fileId}/preview`)).status).toBe(404);
    expect(
      (await call(petro, "GET", `/files/${photograph.previewFileId}/preview`)).status,
    ).toBe(200);

    // a photo's preview, fetched again and again as a conversation scrolls, writes no row at all
    const photo = await sent(olena, chatId, "chart.png");
    await say(olena, chatId, { files: [photo] });
    const since = new Date();
    for (let n = 0; n < 3; n++) {
      expect((await call(petro, "GET", `/files/${photo.previewFileId}/preview`)).status).toBe(
        200,
      );
    }
    const rows = await prisma.activityEvent.count({
      where: { subjectId: photo.previewFileId!, occurredAt: { gte: since } },
    });
    expect(rows).toBe(0);
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
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(1);

    // and deleting the last one takes the file with it, for good
    const copy = (await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage;
    await call(olena, "DELETE", `/messages/${copy.files[0].messageId}`);
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
  });
});

describe("a file goes with its message (§6.3)", () => {
  async function trashList(who: Person) {
    const res = await app.inject({
      method: "GET",
      url: "/api/files/trash",
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { batches: { items: { id: string }[] }[] }).batches.flatMap(
      (b) => b.items,
    );
  }

  it("removes it for good, and says so in the log without naming it", async () => {
    const chatId = await group(olena, "Gone with it", [petro, iryna, admin]);
    const file = await sent(petro, chatId, "petros-scan.png");
    const message = await say(petro, chatId, { files: [file] });
    // a firm admin deletes somebody else's message: the one brake a group still has
    expect((await call(admin, "DELETE", `/messages/${message.id}`)).status).toBe(200);

    const deleted = await logged("chat_file.deleted", file.fileId);
    expect(deleted.subjectLabel).toBe("a chat file");

    // the rows are gone: the photo, and the small picture drawn for it
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
    expect(await prisma.file.count({ where: { id: file.previewFileId! } })).toBe(0);
    // and it is in nobody's Trash, because a chat is a conversation, not a document store
    for (const who of [petro, olena, iryna]) {
      expect((await trashList(who)).map((i) => i.id)).not.toContain(file.fileId);
    }
  });

  it("keeps it while another live message still carries it", async () => {
    const first = await group(olena, "Kept A", [petro]);
    const second = await group(olena, "Kept B", [petro]);
    const file = await sent(olena, first, "shared-photo.png");
    const original = await say(olena, first, { files: [file] });
    expect(
      (
        await call(olena, "POST", "/forward", {
          messageIds: [original.id],
          toChatIds: [second],
        })
      ).status,
    ).toBe(200);

    await call(olena, "DELETE", `/messages/${original.id}`);
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(1);
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(200);

    // …and goes with the last one
    const copy = ((await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage)
      .files[0];
    await call(olena, "DELETE", `/messages/${copy.messageId}`);
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
  });
});

/**
 * **What two people doing something in the same instant used to do** (the reviews of 2026-09-20):
 * the code was right in order and wrong at the same moment.
 *
 * Two shapes of test here, and they are not the same thing. The ones that send or delete twice at
 * once are SMOKE tests: two `app.inject` calls in one process usually serialise, so they cannot
 * force the interleaving and would pass without the fix. The ones that call the guard itself —
 * `claimUploadsTx`, `deleteIfStillUnsent`, `trashFileIfLive`, `sourceForForward` — are the proof,
 * because each asks the database the question the loser of a race asks, and each must be told no.
 */
describe("two things at once", () => {
  it("refuses an upload another message has already claimed", async () => {
    const chatId = await group(olena, "Claimed", [petro]);
    const file = await sent(olena, chatId, "claimed.png");
    const message = await say(olena, chatId, { files: [file] });
    expect(message.files).toHaveLength(1);

    // the loser's transaction, asking under the lock what the winner has just committed
    const claimed = await repo.transaction((tx) =>
      repo.claimUploadsTx(tx, chatId, olena.id, [file.fileId]),
    );
    expect(claimed).toBe(false);
    // and one nobody has taken is still claimable
    const spare = await sent(olena, chatId, "spare.png");
    expect(
      await repo.transaction((tx) => repo.claimUploadsTx(tx, chatId, olena.id, [spare.fileId])),
    ).toBe(true);
  });

  it("asks, under a lock, whether any other live message still carries a file", async () => {
    const first = await group(olena, "Carried A", [petro]);
    const second = await group(olena, "Carried B", [petro]);
    const file = await sent(olena, first, "two-homes.png");
    const here = await say(olena, first, { files: [file] });
    expect(
      (await call(olena, "POST", "/forward", { messageIds: [here.id], toChatIds: [second] }))
        .status,
    ).toBe(200);
    const there = ((await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage)
      .files[0];

    // this is the question a delete asks inside its transaction, and the answer that decides
    // whether the file goes. While the other message is live, it is held
    const whileLive = await repo.transaction((tx) =>
      repo.carriedElsewhereTx(tx, [file.fileId], here.id),
    );
    expect(whileLive.has(file.fileId)).toBe(true);

    // once the other message has gone, the same question about this one answers "nothing has it",
    // which is the half that two deletes at once used to get wrong in BOTH directions
    await prisma.chatMessage.update({
      where: { id: there.messageId },
      data: { deletedAt: new Date(), deletedById: olena.id },
    });
    const afterwards = await repo.transaction((tx) =>
      repo.carriedElsewhereTx(tx, [file.fileId], here.id),
    );
    expect(afterwards.size).toBe(0);
  });

  it("removes a file once, however many deletes ask", async () => {
    const chatId = await group(olena, "Removed once", [petro]);
    const file = await sent(olena, chatId, "once-only.png");
    await say(olena, chatId, { files: [file] });
    expect(await repo.deleteFileRowIfLive(file.fileId)).toBe(true);
    // the second caller is told it did nothing, which is what keeps the log to one disposal
    expect(await repo.deleteFileRowIfLive(file.fileId)).toBe(false);
  });

  it("posts one message when the same upload is sent twice at once", async () => {
    const chatId = await group(olena, "Two sends", [petro]);
    const file = await sent(olena, chatId, "once.png");

    const both = await Promise.all([
      call(olena, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        files: [file],
      }),
      call(olena, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        files: [file],
      }),
    ]);
    const ok = both.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(both.filter((r) => r.status === 400)).toHaveLength(1);
    // and the file hangs off exactly the one message that won
    const page = await history(petro, chatId);
    expect(page.messages.filter((m) => m.files.length > 0)).toHaveLength(1);
  });

  it("writes one disposal when two messages carrying one file are deleted at once", async () => {
    const first = await group(olena, "Shared A", [petro]);
    const second = await group(olena, "Shared B", [petro]);
    const file = await sent(olena, first, "shared-once.png");
    const original = await say(olena, first, { files: [file] });
    expect(
      (
        await call(olena, "POST", "/forward", {
          messageIds: [original.id],
          toChatIds: [second],
        })
      ).status,
    ).toBe(200);
    const copy = ((await call(petro, "GET", `/chats/${second}/files`)).body as ChatFilesPage)
      .files[0];

    const since = new Date();
    await Promise.all([
      call(olena, "DELETE", `/messages/${original.id}`),
      call(olena, "DELETE", `/messages/${copy.messageId}`),
    ]);
    // the file goes once, and the log says so once
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
    expect(await settledCount("chat_file.deleted", file.fileId, since)).toBe(1);
  });

  it("does not sweep an upload that was sent while the sweep was reading its list", async () => {
    const chatId = await group(olena, "Sweep race", [petro]);
    const file = await sent(olena, chatId, "just-in-time.png");
    // the sweep's list is read minutes before it reaches a row; this is that row, sent in between
    await say(olena, chatId, { files: [file] });
    const stale = await repo.staleUploads(new Date(Date.now() + 60_000), 100);
    expect(stale.map((f) => f.id)).not.toContain(file.fileId);
    // and even handed the id from an older list, the sweep's own delete refuses it
    expect(await repo.deleteIfStillUnsent(file.fileId)).toBe(false);
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(1);
  });

  it("tidies away a file no live message carries, whatever left it behind", async () => {
    const chatId = await group(olena, "Stranded", [petro]);
    const file = await sent(olena, chatId, "stranded.png");
    const message = await say(olena, chatId, { files: [file] });

    // a delete whose disposal never ran: the message is gone, the file is live and carried by
    // nothing — invisible to everybody and taken by no other sweep
    await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        deletedAt: new Date(),
        deletedById: olena.id,
        ciphertext: null,
        iv: null,
        authTag: null,
      },
    });
    expect((await call(petro, "GET", `/files/${file.fileId}/view`)).status).toBe(404);
    expect(await prisma.file.count({ where: { id: file.fileId, deletedAt: null } })).toBe(1);

    const { stranded } = await sweepChatFiles();
    expect(stranded).toBeGreaterThanOrEqual(1);
    // gone, exactly as the delete would have removed it, and its small picture with it
    expect(await prisma.file.count({ where: { id: file.fileId } })).toBe(0);
    expect(await prisma.file.count({ where: { id: file.previewFileId! } })).toBe(0);
    // and a file a live message DOES carry is never touched by it
    const kept = await sent(olena, chatId, "kept-by-a-message.png");
    await say(olena, chatId, { files: [kept] });
    await sweepChatFiles();
    expect(await prisma.file.count({ where: { id: kept.fileId, deletedAt: null } })).toBe(1);
  });

  it("does not forward a file that was trashed a moment before", async () => {
    const chatId = await group(olena, "Forward race", [petro]);
    const elsewhere = await group(olena, "Forward race, elsewhere", [petro]);
    const file = await sent(olena, chatId, "about-to-go.png");
    const message = await say(olena, chatId, { text: "here it is", files: [file] });

    // what the forward reads at the moment it copies, rather than what it read at the start
    expect((await repo.sourceForForward(message.id))?.files).toHaveLength(1);
    await call(olena, "DELETE", `/messages/${message.id}`);
    expect(await repo.sourceForForward(message.id)).toBeNull();

    // a message whose file alone was trashed still forwards its words, and carries no dead file
    const other = await sent(olena, elsewhere, "second.png");
    const live = await say(olena, elsewhere, { text: "and this", files: [other] });
    await prisma.file.update({
      where: { id: other.fileId },
      data: { deletedAt: new Date(), deletedById: olena.id, trashBatchId: randomUUID() },
    });
    expect((await repo.sourceForForward(live.id))?.files).toHaveLength(0);
  });
});

/**
 * **What every chat is holding** (§6.5): the read behind the Chats pane in Files, which exists so
 * that a firm can see where a year of conversation went and clean it up (owner, 2026-09-22).
 *
 * The three things it has to get right are all about COUNTING, and every one of them would be
 * invisible on a screen: a file counted twice makes the figure the pane exists for wrong.
 */
describe("what every chat is holding (chat.md §6.5)", () => {
  /** A document: no preview, which the server refuses on anything but a photo. */
  async function doc(who: Person, chatId: string, name: string) {
    const res = await upload(who, chatId, name, PDF);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { fileId: string; previewFileId: string | null };
  }

  async function overview(who: Person) {
    const res = await call(who, "GET", "/files/overview");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ChatFilesOverview;
  }
  const of = (page: ChatFilesOverview, chatId: string) =>
    page.chats.find((c) => c.chatId === chatId);

  it("names a chat with its size, and says nothing about a chat you are not in", async () => {
    const chatId = await group(olena, "Holding files", [petro]);
    const file = await doc(olena, chatId, "report.pdf");
    await say(olena, chatId, { text: "the report", files: [file] });

    const mine = of(await overview(olena), chatId);
    expect(mine?.title).toBe("Holding files");
    expect(mine?.files).toBe(1);
    expect(mine?.bytes).toBe(PDF.length);

    // the outsider is in no such chat, so it is not hidden from their answer — it is not in it
    expect(of(await overview(outsider), chatId)).toBeUndefined();
    // and a member sees it, which is the other half of the same rule
    expect(of(await overview(petro), chatId)?.files).toBe(1);
  });

  it("counts a file ONCE however many of that chat's messages carry it", async () => {
    const chatId = await group(olena, "Forwarded within", [petro]);
    const file = await doc(olena, chatId, "twice.pdf");
    const first = await say(olena, chatId, { text: "here", files: [file] });
    // forwarded back into the same chat: one file, two live messages carrying it
    const res = await call(olena, "POST", "/forward", {
      messageIds: [first.id],
      toChatIds: [chatId],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      await prisma.chatMessageFile.count({ where: { fileId: file.fileId } }),
      "the forward really did make a second link to the one file",
    ).toBe(2);

    const row = of(await overview(olena), chatId);
    expect(row?.files, "one file, not two").toBe(1);
    expect(row?.bytes, "and its bytes counted once").toBe(PDF.length);
  });

  it("counts a file in EVERY chat that holds it, because each one holds it", async () => {
    const here = await group(olena, "Forward source", [petro]);
    const there = await group(olena, "Forward destination", [petro]);
    const file = await doc(olena, here, "shared.pdf");
    const message = await say(olena, here, { text: "passing this on", files: [file] });
    const res = await call(olena, "POST", "/forward", {
      messageIds: [message.id],
      toChatIds: [there],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const page = await overview(olena);
    expect(of(page, here)?.files).toBe(1);
    expect(of(page, there)?.files).toBe(1);
  });

  it("leaves out a photo's thumbnail, and a file whose message is gone", async () => {
    const chatId = await group(olena, "Thumbnails and deletes", [petro]);
    const photo = await sent(olena, chatId, "photo.png", PNG, PNG);
    expect(photo.previewFileId, "this photo really has a preview").not.toBeNull();
    const message = await say(olena, chatId, { text: "a photo", files: [photo] });

    expect(of(await overview(olena), chatId)?.files, "the photo, not its thumbnail").toBe(1);

    await call(olena, "DELETE", `/messages/${message.id}`);
    expect(
      of(await overview(olena), chatId),
      "nothing carries it any more, so the chat holds nothing",
    ).toBeUndefined();
  });

  it("keeps a file into the library as a COPY, leaving the chat's own alone", async () => {
    const chatId = await group(olena, "Worth keeping", [petro]);
    const file = await doc(olena, chatId, "contract.pdf");
    await say(olena, chatId, { text: "the signed one", files: [file] });

    const res = await call(olena, "POST", `/files/${file.fileId}/keep`, {
      to: { space: "personal" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const kept = res.body as { id: string; name: string };
    expect(kept.id, "a new row, not the chat's").not.toBe(file.fileId);
    expect(kept.name).toBe("contract.pdf");

    const inLibrary = await prisma.file.findUniqueOrThrow({
      where: { id: kept.id },
      select: { scope: true, chatId: true, path: true, size: true },
    });
    expect(inLibrary.scope, "it is in the keeper's own place").toBe(`personal:${olena.id}`);
    expect(inLibrary.chatId, "and out of the chat entirely").toBeNull();

    const original = await prisma.file.findUniqueOrThrow({
      where: { id: file.fileId },
      select: { chatId: true, path: true, deletedAt: true },
    });
    expect(original.chatId, "the chat still has its own").toBe(chatId);
    expect(original.deletedAt).toBeNull();
    expect(inLibrary.path, "its own bytes, under its own key").not.toBe(original.path);
    expect(inLibrary.size).toBe(PDF.length);

    // and the chat is untouched: the file is still listed where it was sent
    const still = await call(olena, "GET", `/chats/${chatId}/files`);
    expect((still.body as ChatFilesPage).files).toHaveLength(1);
  });

  it("counts a chat the reader has HIDDEN, which still holds its files", async () => {
    const chatId = await group(olena, "Hidden but heavy", [petro]);
    const file = await doc(olena, chatId, "old-and-big.pdf");
    await say(olena, chatId, { text: "from last year", files: [file] });

    // hiding is a decision about a LIST of conversations, not about what a chat is holding
    const hid = await call(olena, "PUT", `/chats/${chatId}/settings`, { hidden: true });
    expect(hid.status, JSON.stringify(hid.body)).toBe(200);
    const list = (await call(olena, "GET", "/chats")).body as ChatSummary[];
    expect(
      list.some((c) => c.id === chatId),
      "really gone from the sidebar",
    ).toBe(false);

    const page = await overview(olena);
    const row = page.chats.find((c) => c.chatId === chatId);
    expect(row?.files, "and still counted, with its name").toBe(1);
    expect(row?.title).toBe("Hidden but heavy");
  });

  it("refuses to keep a file where the LIBRARY is not open to the reader", async () => {
    const chatId = await group(olena, "Nowhere to put it", [petro]);
    const file = await doc(olena, chatId, "homeless.pdf");
    await say(olena, chatId, { text: "mine", files: [file] });

    // the route is declared on the CHAT's gate; the library's is checked inside the service, and
    // nothing in the route inventory or the access matrix can see that (audit, 2026-09-22)
    await prisma.accessOverride.upsert({
      where: { userId_gate_action: { userId: olena.id, gate: "files", action: "*" } },
      update: { state: "read_only" },
      create: { userId: olena.id, gate: "files", state: "read_only" },
    });
    invalidateAccessCache();
    try {
      const res = await call(olena, "POST", `/files/${file.fileId}/keep`, {
        to: { space: "personal" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(
        await prisma.file.count({ where: { name: "homeless.pdf" } }),
        "and nothing was written",
      ).toBe(1);
    } finally {
      await prisma.accessOverride.deleteMany({ where: { userId: olena.id, gate: "files" } });
      invalidateAccessCache();
    }
  });

  it("will not keep a file out of a chat somebody is not in", async () => {
    const chatId = await group(olena, "Not yours to keep", [petro]);
    const file = await doc(olena, chatId, "private.pdf");
    await say(olena, chatId, { text: "ours", files: [file] });

    const res = await call(outsider, "POST", `/files/${file.fileId}/keep`, {
      to: { space: "personal" },
    });
    expect(res.status, "not 403: the file is not theirs to know about").toBe(404);
    expect(await prisma.file.count({ where: { name: "private.pdf" } })).toBe(1);
  });

  it("says what the bytes are, by kind", async () => {
    const chatId = await group(olena, "Two kinds", [petro]);
    const pdf = await doc(olena, chatId, "paper.pdf");
    await say(olena, chatId, { text: "a pdf", files: [pdf] });
    const photo = await sent(olena, chatId, "picture.png", PNG, PNG);
    await say(olena, chatId, { text: "a photo", files: [photo] });

    const row = of(await overview(olena), chatId);
    expect(row?.files).toBe(2);
    expect(new Set(row?.byKind.map((k) => k.kind))).toEqual(new Set(["pdf", "photo"]));
    // largest first, which is what the pane draws
    expect(row!.byKind[0].bytes).toBeGreaterThanOrEqual(row!.byKind[1].bytes);
  });
});
