import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "./app.js";
import { invalidateAccessCache } from "./core/access.js";
import { ensureBaseData } from "./core/bootstrap.js";
import { prisma } from "./core/db.js";

/**
 * **The cards behind a pasted link** (chat.md §5.6): what a link into this CRM shows to somebody
 * who may see the record, and what it shows to somebody who may not.
 *
 * The surface is deliberately small — a link is resolved by the READER's browser, through the
 * record's own route — so this suite guards the two reads that exist only for a card, and the one
 * rule that makes the whole design safe: **a name is shown only to somebody who may see it.** A
 * card that leaks "Petrenko audit letter.pdf" into a chat has leaked the thing the gate protects,
 * even though the bytes stayed behind the door.
 *
 * The other four kinds (task, lead, invoice, meeting) reuse their screen's own read, so their
 * access is `access-matrix.test.ts`'s answer and not repeated here.
 */

const TAG = `card-${randomUUID().slice(0, 8)}`;
const DOMAIN = `@${TAG}.local`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}

let owner: Person;
let colleague: Person;
let admin: Person;
let liveClient: string;
let goneClient: string;
let priorityId: string;
let columnId: string;

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : (raw as string)).split(";")[0];
};

async function person(name: string, role: "admin" | "user"): Promise<Person> {
  const email = `${name}${DOMAIN}`;
  const user = await prisma.user.create({
    data: {
      firstName: name,
      lastName: "Card",
      email,
      passwordHash: await argon2.hash("password-123"),
      role,
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  return { id: user.id, cookie: cookieOf(res) };
}

const get = (who: Person, url: string) =>
  app.inject({ method: "GET", url, headers: { cookie: who.cookie } });

async function setGate(who: Person, gate: GateKey, state: "open" | "closed") {
  await prisma.accessOverride.upsert({
    where: { userId_gate_action: { userId: who.id, gate, action: "*" } },
    update: { state },
    create: { userId: who.id, gate, state },
  });
  invalidateAccessCache();
}

function multipart(name: string, body: string) {
  const boundary = "----buhcrmcards";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n${body}\r\n--${boundary}--\r\n`,
    ),
  };
}

async function upload(who: Person, url: string, name: string): Promise<string> {
  const form = multipart(name, "hello");
  const res = await app.inject({
    method: "POST",
    url,
    headers: { cookie: who.cookie, ...form.headers },
    payload: form.payload,
  });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  owner = await person("owner", "user");
  colleague = await person("colleague", "user");
  admin = await person("admin", "admin");
  priorityId = (await prisma.priority.findFirstOrThrow()).id;
  columnId = (await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } })).id;
  liveClient = (await prisma.client.create({ data: { firstName: `${TAG} Petrenko` } })).id;
  // live for now: a file cannot be uploaded to an archived client, so the suite archives it
  // afterwards, which is exactly how an archived client's documents come about
  goneClient = (await prisma.client.create({ data: { firstName: `${TAG} Gone` } })).id;
});

afterAll(async () => {
  const people = [owner.id, colleague.id, admin.id];
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.folder.deleteMany({ where: { createdById: { in: people } } });
  await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.client.deleteMany({ where: { id: { in: [liveClient, goneClient] } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("a link to a file", () => {
  it("names a personal file to its owner and to nobody else", async () => {
    const id = await upload(owner, "/api/files/my/upload", "my-notes.txt");

    const mine = await get(owner, `/api/files/${id}/card`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ name: "my-notes.txt", where: "My files" });
    // the two doors travel with the card, because where the bytes come from depends on the place
    expect(mine.json().downloadUrl).toBe(`/api/files/my/files/${id}`);

    // the owner's own drawer: a colleague is told it does not exist, so the NAME never appears
    const theirs = await get(colleague, `/api/files/${id}/card`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).not.toContain("my-notes");
  });

  it("names a Company file to everybody whose Files is open, and to nobody whose is closed", async () => {
    const id = await upload(owner, "/api/files/company/upload", "price-list.txt");

    expect((await get(colleague, `/api/files/${id}/card`)).statusCode).toBe(200);

    await setGate(colleague, "files", "closed");
    const shut = await get(colleague, `/api/files/${id}/card`);
    expect(shut.statusCode).toBe(404);
    expect(shut.body).not.toContain("price-list");
    await setGate(colleague, "files", "open");
  });

  it("puts a client's document behind Clients, not behind Files", async () => {
    const id = await upload(
      owner,
      `/api/files/clients/${liveClient}/zones/internal/upload`,
      "audit.txt",
    );

    await setGate(colleague, "files", "closed");
    // Files is shut and the card still answers: a client's document belongs to Clients (§5.6)
    expect((await get(colleague, `/api/files/${id}/card`)).statusCode).toBe(200);

    await setGate(colleague, "clients", "closed");
    const shut = await get(colleague, `/api/files/${id}/card`);
    expect(shut.statusCode).toBe(404);
    expect(shut.body).not.toContain("audit");
    await setGate(colleague, "files", "open");
    await setGate(colleague, "clients", "open");
  });

  it("goes dark with an archived client, the name included", async () => {
    const id = await upload(
      owner,
      `/api/files/clients/${goneClient}/zones/internal/upload`,
      "old.txt",
    );
    expect((await get(admin, `/api/files/${id}/card`)).statusCode).toBe(200);

    await prisma.client.update({ where: { id: goneClient }, data: { archivedAt: new Date() } });
    // an archived client's files go dark with the client (files.md decision 8) — and this was the
    // one door that still named one, which is the whole point of the card's rule 2 (audit, 2026-09-20)
    const gone = await get(admin, `/api/files/${id}/card`);
    expect(gone.statusCode).toBe(404);
    expect(gone.body).not.toContain("old.txt");
  });

  it("puts a task's attachment behind Tasks", async () => {
    const task = await prisma.task.create({
      data: { title: `${TAG} internal`, priorityId, statusColumnId: columnId },
    });
    const id = await upload(owner, `/api/tasks/${task.id}/files`, "brief.txt");

    expect((await get(colleague, `/api/files/${id}/card`)).statusCode).toBe(200);
    await setGate(colleague, "tasks", "closed");
    const shut = await get(colleague, `/api/files/${id}/card`);
    expect(shut.statusCode).toBe(404);
    expect(shut.body).not.toContain("brief");
    await setGate(colleague, "tasks", "open");
  });

  it("is not found once the file is deleted, and answers nothing at all to a stranger's id", async () => {
    const id = await upload(owner, "/api/files/my/upload", "short-lived.txt");
    await app.inject({
      method: "POST",
      url: "/api/files/my/delete",
      headers: { cookie: owner.cookie },
      payload: { fileIds: [id] },
    });
    expect((await get(owner, `/api/files/${id}/card`)).statusCode).toBe(404);
    expect((await get(owner, `/api/files/${randomUUID()}/card`)).statusCode).toBe(404);
  });
});

describe("a link to a client", () => {
  it("names the client without recording that anybody opened one", async () => {
    const before = await prisma.activityEvent.count({
      where: { action: "client.viewed", subjectId: liveClient },
    });

    const card = await get(colleague, `/api/clients/${liveClient}/card`);
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ id: liveClient, name: `${TAG} Petrenko` });

    // a card is drawn by scrolling a message into view; the log must not call that a view
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      await prisma.activityEvent.count({
        where: { action: "client.viewed", subjectId: liveClient },
      }),
    ).toBe(before);
  });

  it("has no card for an archived client, the same way it has no screen", async () => {
    const gone = await get(admin, `/api/clients/${goneClient}/card`);
    expect(gone.statusCode).toBe(404);
    expect(gone.body).not.toContain("Gone");
  });
});
