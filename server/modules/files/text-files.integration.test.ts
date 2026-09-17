import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { MAX_TEXT_BYTES } from "@shared/library.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";

/**
 * **A text file made in the CRM** (files.md §7.4): `.txt` alone, 1 MB, the same names and the same
 * store as an upload. Any text file in the library may then be saved again, and a save that opened
 * an older version is refused rather than laid over somebody else's.
 */

const TAG = `text${randomUUID().slice(0, 6)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
let keeper: Person;
let clientId: string;
const people: string[] = [];
const clientIds: string[] = [];

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user", firstName: string): Promise<Person> {
  const email = `${role}-${TAG}@text.local`;
  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: TAG,
      email,
      passwordHash: await argon2.hash("password-123"),
      role,
      status: "active",
    },
  });
  people.push(user.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  return { id: user.id, cookie: cookieOf(res) };
}

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers, payload }),
    patch: (url: string, payload: object = {}) =>
      app.inject({ method: "PATCH", url, headers, payload }),
    upload: (url: string, name: string, bytes: Buffer) => {
      const boundary = "----buhcrmtext";
      return app.inject({
        method: "POST",
        url,
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
              `Content-Type: application/octet-stream\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    },
  };
}

async function setGate(who: Person, gate: GateKey, state: "open" | "closed") {
  await prisma.accessOverride.upsert({
    where: { userId_gate_action: { userId: who.id, gate, action: "*" } },
    update: { state },
    create: { userId: who.id, gate, state },
  });
  invalidateAccessCache();
}

/** A text file in Company, made the way the screen makes one. */
async function makeInCompany(name: string, text: string) {
  const res = await as(admin).post("/api/files/company/text", { name, text });
  return { status: res.statusCode, file: res.json() };
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin", "Ada");
  keeper = await person("user", "Bo");
  const client = await prisma.client.create({ data: { firstName: `${TAG} Petrenko` } });
  clientId = client.id;
  clientIds.push(client.id);
});

afterAll(async () => {
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.folder.deleteMany({ where: { createdById: { in: people } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("a text file made in the CRM (files.md §7.4)", () => {
  it("makes a .txt, gives it the extension, and opens it as text", async () => {
    const { status, file } = await makeInCompany(`${TAG} Note`, "hello");
    expect(status).toBe(201);
    expect(file.name).toBe(`${TAG} Note.txt`);
    expect(file.size).toBe(5);
    expect(file.view).toBe("text");
    expect(file.updatedAt).toEqual(expect.any(String));

    const shown = await as(admin).get(`/api/files/company/files/${file.id}/view`);
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toBe("hello");

    // a taken name is never overwritten (§6.3)
    const again = await makeInCompany(`${TAG} Note.txt`, "second");
    expect(again.file.name).toBe(`${TAG} Note (2).txt`);
  });

  it("refuses an empty name, more than 1 MB, and text that is really another format", async () => {
    expect((await makeInCompany("   ", "hello")).status).toBe(400);
    const tooLong = await makeInCompany(`${TAG} long`, "x".repeat(MAX_TEXT_BYTES + 1));
    expect(tooLong.status).toBe(400);
    // the bytes decide the type, whatever the name says (§12.2)
    expect((await makeInCompany(`${TAG} sneaky`, PDF.toString("latin1"))).status).toBe(400);
  });

  it("saves the text again, and refuses a save that opened an older version", async () => {
    const { file } = await makeInCompany(`${TAG} Minutes`, "first");
    const a = as(admin);

    const saved = await a.patch(`/api/files/company/files/${file.id}/text`, {
      text: "first, then more",
      updatedAt: file.updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().size).toBe(16);
    expect((await a.get(`/api/files/company/files/${file.id}/view`)).body).toBe(
      "first, then more",
    );

    // the version the editor opened has moved on: the second save is refused, not laid over
    const stale = await a.patch(`/api/files/company/files/${file.id}/text`, {
      text: "mine",
      updatedAt: file.updatedAt,
    });
    expect(stale.statusCode).toBe(409);

    // a file that is not text is not edited here
    const pdf = (await a.upload("/api/files/company/upload", `${TAG}-scan.pdf`, PDF)).json();
    const refused = await a.patch(`/api/files/company/files/${pdf.id}/text`, {
      text: "no",
      updatedAt: pdf.updatedAt,
    });
    expect(refused.statusCode).toBe(400);

    // nor is one in the Trash
    const binned = (await makeInCompany(`${TAG} Binned`, "bye")).file;
    await a.post("/api/files/company/delete", { fileIds: [binned.id] });
    const gone = await a.patch(`/api/files/company/files/${binned.id}/text`, {
      text: "back",
      updatedAt: binned.updatedAt,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("keeps My files to their owner", async () => {
    const bo = as(keeper);
    const mine = (
      await bo.post("/api/files/my/text", { name: `${TAG} Mine`, text: "one" })
    ).json();
    const saved = await bo.patch(`/api/files/my/files/${mine.id}/text`, {
      text: "one, two",
      updatedAt: mine.updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    // an admin is nobody in another person's My files (§11.1)
    const nosy = await as(admin).patch(`/api/files/my/files/${mine.id}/text`, {
      text: "mine now",
      updatedAt: mine.updatedAt,
    });
    expect(nosy.statusCode).toBe(404);
  });

  it("takes one in a client's zone, and refuses it to a closed gate", async () => {
    const a = as(admin);
    const made = await a.post(`/api/files/clients/${clientId}/zones/shared/text`, {
      name: `${TAG} For the client`,
      text: "please sign",
    });
    expect(made.statusCode).toBe(201);
    const file = made.json();
    const saved = await a.patch(`/api/files/clients/${clientId}/files/${file.id}/text`, {
      text: "please sign and return",
      updatedAt: file.updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().size).toBe(22);

    await setGate(keeper, "clients", "closed");
    const noClients = await as(keeper).post(
      `/api/files/clients/${clientId}/zones/internal/text`,
      { name: `${TAG} Sneak`, text: "no" },
    );
    expect(noClients.statusCode).toBe(403);
    await setGate(keeper, "clients", "open");

    await setGate(keeper, "files", "closed");
    const noFiles = await as(keeper).post("/api/files/company/text", {
      name: `${TAG} Sneak`,
      text: "no",
    });
    expect(noFiles.statusCode).toBe(403);
    await setGate(keeper, "files", "open");
  });
});
