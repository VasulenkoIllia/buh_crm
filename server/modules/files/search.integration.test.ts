import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";

/**
 * **Search** (files.md §13, stage C.4): names and details, never inside a file; what the reader
 * may see sits inside the query; the Trash is never searched; every hit says where it is. Only over
 * rows this suite made, and every search is narrowed by this suite's tag.
 */

const TAG = `srch${randomUUID().slice(0, 6)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
let keeper: Person;
let clientId: string;
let clientCode: number;
const people: string[] = [];
const clientIds: string[] = [];

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user", firstName: string): Promise<Person> {
  const email = `${role}-${TAG}@search.local`;
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
    upload: (url: string, name: string, bytes: Buffer = Buffer.from("hello")) => {
      const boundary = "----buhcrmsearch";
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

const names = (body: { hits: { name: string }[] }) => body.hits.map((h) => h.name).sort();

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin", "Ada");
  keeper = await person("user", "Bo");
  const client = await prisma.client.create({ data: { firstName: `${TAG} Petrenko` } });
  clientId = client.id;
  clientCode = client.code;
  clientIds.push(client.id);

  const a = as(admin);
  const folder = (
    await a.post("/api/files/company/folders", { name: `${TAG} Payroll`, parentId: null })
  ).json().id;
  await a.upload(`/api/files/company/upload?folderId=${folder}`, `${TAG}-march.pdf`, PDF);
  await a.upload("/api/files/company/upload", `${TAG}-policy.txt`);
  await a.upload(`/api/files/clients/${clientId}/zones/internal/upload`, `${TAG}-w2.pdf`, PDF);
  const binned = (await a.upload("/api/files/company/upload", `${TAG}-old.txt`)).json().id;
  await a.post("/api/files/company/delete", { fileIds: [binned] });
  await as(keeper).upload("/api/files/my/upload", `${TAG}-private.txt`);
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

describe("search (files.md §13)", () => {
  it("finds names and says where each one is, never the Trash, never another's My files", async () => {
    const res = await as(admin).get(`/api/files/search?q=${TAG}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(names(body)).toEqual(
      [`${TAG} Payroll`, `${TAG}-march.pdf`, `${TAG}-policy.txt`, `${TAG}-w2.pdf`].sort(),
    );
    const march = body.hits.find((h: { name: string }) => h.name === `${TAG}-march.pdf`);
    expect(march.path).toBe(`Company › ${TAG} Payroll`);
    expect(march.view).toBe("pdf");
    const w2 = body.hits.find((h: { name: string }) => h.name === `${TAG}-w2.pdf`);
    expect(w2.path).toMatch(/^Clients › .* › Internal$/);
    expect(w2.where).toEqual({
      kind: "place",
      place: { space: "client", clientId, zone: "internal" },
      folderId: null,
    });
  });

  it("matches the folder, the client's #code and the uploader, and narrows by type and space", async () => {
    const a = as(admin);
    // a folder's name finds the folder and what is in it
    const byFolder = (
      await a.get(`/api/files/search?q=${encodeURIComponent(`${TAG} Payroll`)}`)
    ).json();
    expect(names(byFolder)).toEqual([`${TAG} Payroll`, `${TAG}-march.pdf`].sort());
    // the client's code finds its files
    const byCode = (await a.get(`/api/files/search?q=%23${clientCode}&space=clients`)).json();
    expect(byCode.hits.map((h: { name: string }) => h.name)).toContain(`${TAG}-w2.pdf`);
    // only PDFs, only in Company
    const pdfs = (await a.get(`/api/files/search?q=${TAG}&type=pdf&space=company`)).json();
    expect(names(pdfs)).toEqual([`${TAG}-march.pdf`]);
    // the keeper finds their own personal file by its uploader, and nobody else sees it
    const own = (await as(keeper).get(`/api/files/search?q=${TAG}&space=my`)).json();
    expect(names(own)).toEqual([`${TAG}-private.txt`]);
    expect(own.hits[0].path).toBe("My files");
  });

  it("leaves a client's files out for somebody whose Clients is closed", async () => {
    await setGate(keeper, "clients", "closed");
    const res = (await as(keeper).get(`/api/files/search?q=${TAG}`)).json();
    expect(names(res)).not.toContain(`${TAG}-w2.pdf`);
    expect(names(res)).toContain(`${TAG}-march.pdf`);
    await setGate(keeper, "clients", "open");
  });

  it("gives every step of a path its own way there", async () => {
    const body = (await as(admin).get(`/api/files/search?q=${TAG}`)).json();
    const find = (name: string) => body.hits.find((h: { name: string }) => h.name === name);
    const company = { type: "place", place: { space: "company" }, folderId: null };
    const payroll = find(`${TAG} Payroll`);
    expect(find(`${TAG}-march.pdf`).crumbs).toEqual([
      { label: "Company", to: company },
      { label: `${TAG} Payroll`, to: { ...company, folderId: payroll.id } },
    ]);
    const w2 = find(`${TAG}-w2.pdf`);
    expect(w2.crumbs.map((c: { to: { type: string } | null }) => c.to?.type)).toEqual([
      "clients",
      "client",
      "place",
    ]);
    expect(w2.crumbs[1].to).toEqual({ type: "client", clientId });
    // a folder's path leads to where it sits, not into itself
    expect(payroll.crumbs).toEqual([{ label: "Company", to: company }]);
  });

  it("finds clients by a name or a code, with no files needed, and only with Clients open", async () => {
    const a = as(admin);
    const quiet = await prisma.client.create({ data: { firstName: `${TAG} Kovalenko` } });
    clientIds.push(quiet.id);
    type Found = { clients: { id: string; totals: { files: number } }[] };
    const get = async (query: string): Promise<Found> =>
      (await a.get(`/api/files/search?${query}`)).json();

    expect((await get(`q=${encodeURIComponent(`${TAG} Koval`)}`)).clients).toEqual([
      {
        id: quiet.id,
        label: `${TAG} Kovalenko`,
        code: quiet.code,
        totals: { files: 0, bytes: 0 },
      },
    ]);
    for (const typed of [`${quiet.code}`, `#${quiet.code}`, `C-${quiet.code}`]) {
      const found = await get(`q=${encodeURIComponent(typed)}`);
      expect(found.clients.map((c) => c.id)).toContain(quiet.id);
    }
    // a dash is part of a code only after C
    const dashed = await get(`q=${encodeURIComponent(`-${quiet.code}`)}`);
    expect(dashed.clients.map((c) => c.id)).not.toContain(quiet.id);
    // the client of a file shows too, with what its folders hold
    const petrenko = await get(`q=${encodeURIComponent(`${TAG} Petrenko`)}`);
    expect(petrenko.clients.map((c) => [c.id, c.totals.files])).toEqual([[clientId, 1]]);
    // a type, another space or a later page shows files alone
    for (const narrowed of ["&type=pdf", "&space=company", "&page=1"]) {
      expect((await get(`q=${TAG}${narrowed}`)).clients).toEqual([]);
    }
    // the code is a 32-bit column that refuses a longer number, so a pasted phone number is no code
    await expect(prisma.client.findMany({ where: { code: 5_551_234_567 } })).rejects.toThrow();
    const phone = await a.get("/api/files/search?q=5551234567");
    expect(phone.statusCode).toBe(200);
    expect(phone.json().clients).toEqual([]);
    // never to somebody whose Clients is closed, and never an archived client
    await setGate(keeper, "clients", "closed");
    expect((await as(keeper).get(`/api/files/search?q=${TAG}`)).json().clients).toEqual([]);
    await setGate(keeper, "clients", "open");
    await prisma.client.update({ where: { id: quiet.id }, data: { archivedAt: new Date() } });
    expect((await get(`q=%23${quiet.code}`)).clients).toEqual([]);
  });
});
