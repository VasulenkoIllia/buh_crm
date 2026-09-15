import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { TEST_UPLOADS_DIR } from "../../test/paths.js";
import { purgeTrash } from "./files.trash.js";

/**
 * The Trash (files.md §9, and §19's "Trash" and "Purge"; stage B.3): every delete sets three
 * columns and destroys nothing, restoring clears them, the cards' Undo sits on the cards' own
 * gates, and the nightly purge removes for good what has waited 30 days. Only ever over rows this
 * suite made: the suite shares one database.
 */

const TAG = `trash-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
interface Named {
  id: string;
  name: string;
}
interface Batch {
  batchId: string;
  deletedBy: string;
  daysLeft: number;
  totals: { files: number; bytes: number };
  items: { kind: string; id: string; name: string; from: string; totals: object }[];
}

let admin: Person;
let keeper: Person;
let clientA: string;
let clientB: string;
let priorityId: string;
let columnId: string;
const clientIds: string[] = [];
const taskIds: string[] = [];

// what one test leaves for the next
let firstBatch: string;
let clientBatch: string;
const company: Record<string, string> = {};

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@trash.local`;
  const user = await prisma.user.create({
    data: {
      firstName: role === "admin" ? "Ada" : "Bo",
      lastName: "Keeper",
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

async function client(name: string) {
  const row = await prisma.client.create({ data: { firstName: `${TAG} ${name}` } });
  clientIds.push(row.id);
  return row.id;
}

async function task(link: { clientId?: string } = {}) {
  const row = await prisma.task.create({
    data: { title: `${TAG} task`, priorityId, statusColumnId: columnId, ...link },
  });
  taskIds.push(row.id);
  return row.id;
}

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers, payload }),
    del: (url: string) => app.inject({ method: "DELETE", url, headers }),
    upload: (url: string, name: string, body = "hello") => {
      const boundary = "----buhcrmtrash";
      return app.inject({
        method: "POST",
        url,
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n${body}\r\n--${boundary}--\r\n`,
        ),
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

/** The log is written after the response, so every assertion on it waits (activity tests). */
async function allRecorded(action: string, subjectId: string, atLeast = 1) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await prisma.activityEvent.findMany({ where: { action, subjectId } });
    if (rows.length >= atLeast) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

const recorded = async (action: string, subjectId: string) =>
  (await allRecorded(action, subjectId))[0];

const batchesSeenBy = async (who: Person): Promise<Batch[]> =>
  (await as(who).get("/api/files/trash")).json().batches;

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin");
  keeper = await person("user");
  clientA = await client("Petrenko");
  clientB = await client("BrightLine");
  priorityId = (await prisma.priority.findFirstOrThrow()).id;
  columnId = (await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } })).id;
});

afterAll(async () => {
  const people = [admin.id, keeper.id];
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.folder.deleteMany({ where: { createdById: { in: people } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("the Trash (files.md §9, stage B.3)", () => {
  it("takes a selection with everything live under it, destroys nothing, and every list forgets it", async () => {
    const a = as(admin);
    company.old = (
      await a.post("/api/files/company/folders", { name: "Old", parentId: null })
    ).json().id;
    company.sub = (
      await a.post("/api/files/company/folders", { name: "Sub", parentId: company.old })
    ).json().id;
    company.inOld = (
      await a.upload(
        `/api/files/company/upload?folderId=${company.old}`,
        "a.pdf",
        "x".repeat(10),
      )
    ).json().id;
    company.inSub = (
      await a.upload(
        `/api/files/company/upload?folderId=${company.sub}`,
        "b.pdf",
        "y".repeat(20),
      )
    ).json().id;
    company.loose = (
      await a.upload("/api/files/company/upload", "c.pdf", "z".repeat(30))
    ).json().id;

    const res = await a.post("/api/files/company/delete", {
      folderIds: [company.old],
      fileIds: [company.loose],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ files: 3, bytes: 60 });
    firstBatch = res.json().batchId;

    const rows = await prisma.file.findMany({
      where: { id: { in: [company.inOld, company.inSub, company.loose] } },
    });
    expect(rows.every((r) => r.trashBatchId === firstBatch && r.deletedAt !== null)).toBe(true);
    expect(
      (await prisma.folder.findUniqueOrThrow({ where: { id: company.sub } })).trashBatchId,
    ).toBe(firstBatch);
    // nothing is destroyed: the bytes stay until the purge
    for (const row of rows) expect(existsSync(join(TEST_UPLOADS_DIR, row.path))).toBe(true);

    const listing = (await a.get("/api/files/company/list")).json();
    expect(listing.folders.map((f: Named) => f.id)).not.toContain(company.old);
    expect(listing.files.map((f: Named) => f.id)).not.toContain(company.loose);
    expect((await recorded("firm_folder.deleted", company.old)).changes).toEqual({
      place: "Company",
      files: 2,
    });
    expect((await recorded("firm_file.deleted", company.inSub)).changes).toEqual({
      name: "b.pdf",
      place: "Company › Old › Sub",
    });
  });

  it("lists the Trash by gesture: the items at its top, who, and the days left", async () => {
    const batch = (await batchesSeenBy(admin)).find((b) => b.batchId === firstBatch);
    expect(batch).toMatchObject({
      deletedBy: "Ada Keeper",
      daysLeft: 30,
      totals: { files: 3, bytes: 60 },
    });
    expect(batch?.items.map((i) => i.name).sort()).toEqual(["Old", "c.pdf"]);
    expect(batch?.items.find((i) => i.name === "Old")).toMatchObject({
      kind: "folder",
      from: "Company",
      totals: { files: 2, bytes: 30 },
    });
    // Company is everyone's with Files, so a colleague sees the same gesture
    expect((await batchesSeenBy(keeper)).map((b) => b.batchId)).toContain(firstBatch);
  });

  it("restores one item alone, and a folder with what went in with it", async () => {
    const a = as(admin);
    const one = await a.post(`/api/files/trash/files/${company.loose}/restore`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ restored: 1, renamed: [] });
    expect(
      (await prisma.file.findUniqueOrThrow({ where: { id: company.loose } })).deletedAt,
    ).toBeNull();
    // the rest of the gesture is still in the Trash
    expect(
      (await prisma.folder.findUniqueOrThrow({ where: { id: company.old } })).trashBatchId,
    ).toBe(firstBatch);

    const folder = await a.post(`/api/files/trash/folders/${company.old}/restore`);
    expect(folder.json()).toMatchObject({ restored: 4 }); // Old, Sub, a.pdf and b.pdf
    const root = (await a.get("/api/files/company/list")).json();
    expect(root.folders.find((f: Named) => f.id === company.old).totals).toEqual({
      files: 2,
      bytes: 30,
    });
    expect((await recorded("firm_folder.restored", company.old)).changes).toEqual({
      to: "Company",
      files: 2,
    });
    expect((await recorded("firm_file.restored", company.loose)).changes).toEqual({
      to: "Company",
    });
  });

  it("restores under the nearest live folder when its own is in the Trash, taking (2) for a taken name", async () => {
    const a = as(admin);
    const archive = (
      await a.post("/api/files/company/folders", { name: "Archive", parentId: null })
    ).json().id;
    const x = (await a.upload(`/api/files/company/upload?folderId=${archive}`, "x.pdf")).json()
      .id;
    await a.post("/api/files/company/delete", { fileIds: [x] }); // the file first
    await a.post("/api/files/company/delete", { folderIds: [archive] }); // then its folder
    await a.upload("/api/files/company/upload", "x.pdf"); // and a new x.pdf at the root

    const back = await a.post(`/api/files/trash/files/${x}/restore`);
    expect(back.json().renamed).toEqual([{ id: x, name: "x (2).pdf" }]);
    // no live item ever has a trashed parent
    expect(await prisma.file.findUniqueOrThrow({ where: { id: x } })).toMatchObject({
      folderId: null,
      name: "x (2).pdf",
      deletedAt: null,
    });
  });

  it("writes that the client will see it when a restore lands in Shared with client", async () => {
    const a = as(admin);
    const doc = (
      await a.upload(`/api/files/clients/${clientA}/zones/shared/upload`, "8879.pdf")
    ).json().id;
    const gone = await a.post(`/api/files/clients/${clientA}/delete`, { fileIds: [doc] });
    expect(gone.statusCode).toBe(200);
    expect((await recorded("file.deleted", doc)).changes).toEqual({
      name: "8879.pdf",
      attachedTo: `${TAG} Petrenko › Shared with client`,
    });

    expect((await a.post(`/api/files/trash/${gone.json().batchId}/restore`)).statusCode).toBe(
      200,
    );
    // one from the upload, one from the restore
    expect(await allRecorded("file.shared_with_client", doc, 2)).toHaveLength(2);
    expect((await recorded("file.restored", doc)).changes).toEqual({
      to: `${TAG} Petrenko › Shared with client`,
    });
  });

  it("shows each person only the Trash they may see", async () => {
    // somebody's own My files: not in a colleague's Trash, and not theirs to restore
    const mine = (await as(admin).upload("/api/files/my/upload", "private.txt")).json().id;
    const mineBatch = (await as(admin).post("/api/files/my/delete", { fileIds: [mine] })).json()
      .batchId;
    const own = (await batchesSeenBy(admin)).find((b) => b.batchId === mineBatch);
    expect(own?.items[0]).toMatchObject({ name: "private.txt", from: "My files" });
    expect((await batchesSeenBy(keeper)).map((b) => b.batchId)).not.toContain(mineBatch);
    expect((await as(keeper).post(`/api/files/trash/${mineBatch}/restore`)).statusCode).toBe(
      404,
    );
    expect((await recorded("firm_file.deleted", mine)).changes).toEqual({ place: "My files" });

    // a client's: only with Clients open
    const doc = (
      await as(admin).upload(`/api/files/clients/${clientA}/zones/internal/upload`, "w2.pdf")
    ).json().id;
    clientBatch = (
      await as(admin).post(`/api/files/clients/${clientA}/delete`, { fileIds: [doc] })
    ).json().batchId;
    await setGate(keeper, "clients", "closed");
    expect((await batchesSeenBy(keeper)).map((b) => b.batchId)).not.toContain(clientBatch);
    expect((await as(keeper).post(`/api/files/trash/${clientBatch}/restore`)).statusCode).toBe(
      404,
    );
    await setGate(keeper, "clients", "open");
    expect((await batchesSeenBy(keeper)).map((b) => b.batchId)).toContain(clientBatch);

    // an archived client's: hidden with the client (decision 8)
    await prisma.client.update({ where: { id: clientA }, data: { archivedAt: new Date() } });
    expect((await batchesSeenBy(admin)).map((b) => b.batchId)).not.toContain(clientBatch);
    await prisma.client.update({ where: { id: clientA }, data: { archivedAt: null } });
  });

  it("lets the cards' Undo take a delete back on the card's own gate, with Files closed", async () => {
    const k = as(keeper);
    const card = (await as(admin).upload(`/api/clients/${clientA}/files`, "card.pdf")).json()
      .id;
    const deleted = await k.del(`/api/clients/${clientA}/files/${card}`);
    expect(deleted.statusCode).toBe(200);
    const { batchId } = deleted.json();
    expect(
      (await k.get(`/api/clients/${clientA}/files`)).json().map((f: Named) => f.id),
    ).not.toContain(card);
    expect((await k.get(`/api/clients/${clientA}/files/${card}`)).statusCode).toBe(404);

    await setGate(keeper, "files", "closed");
    const undone = await k.post(`/api/clients/${clientA}/files/undo`, { batchId });
    expect(undone.statusCode).toBe(200);
    expect(
      (await k.get(`/api/clients/${clientA}/files`)).json().map((f: Named) => f.id),
    ).toContain(card);
    expect((await recorded("file.restored", card)).clientId).toBe(clientA);
    // another client's card cannot undo this client's gesture
    const elsewhere = await k.post(`/api/clients/${clientB}/files/undo`, {
      batchId: clientBatch,
    });
    expect(elsewhere.statusCode).toBe(404);

    // the task card: a file that is not filed goes to the Trash and leaves the task's list
    const taskId = await task({ clientId: clientA });
    const onTask = (await as(admin).upload(`/api/tasks/${taskId}/files`, "receipt.pdf")).json()
      .id;
    const off = await k.del(`/api/tasks/${taskId}/files/${onTask}`);
    expect(off.json()).toMatchObject({ ok: true, files: 1 });
    expect((await k.get(`/api/tasks/${taskId}/files`)).json()).toEqual([]);
    const back = await k.post(`/api/tasks/${taskId}/files/undo`, {
      batchId: off.json().batchId,
    });
    expect(back.statusCode).toBe(200);
    expect((await k.get(`/api/tasks/${taskId}/files`)).json().map((f: Named) => f.id)).toEqual([
      onTask,
    ]);
    await setGate(keeper, "files", "open");
  });

  it("purges only what has waited 30 days, files before folders, a night's budget at a time", async () => {
    const a = as(admin);
    const folder = (
      await a.post("/api/files/company/folders", { name: "Purge me", parentId: null })
    ).json().id;
    const inside: string[] = [];
    for (const name of ["p1.pdf", "p2.pdf", "p3.pdf"]) {
      inside.push(
        (await a.upload(`/api/files/company/upload?folderId=${folder}`, name)).json().id,
      );
    }
    await a.post("/api/files/company/delete", { folderIds: [folder] });
    const young = (await a.upload("/api/files/company/upload", "young.pdf")).json().id;
    await a.post("/api/files/company/delete", { fileIds: [young] });
    const live = (await a.upload("/api/files/company/upload", "live.pdf")).json().id;
    // an archived client's trashed file, the oldest of all: archiving does not stop the purge
    const old = (
      await a.upload(`/api/files/clients/${clientB}/zones/internal/upload`, "old.pdf")
    ).json().id;
    await a.post(`/api/files/clients/${clientB}/delete`, { fileIds: [old] });
    await prisma.client.update({ where: { id: clientB }, data: { archivedAt: new Date() } });

    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * day);
    await prisma.file.updateMany({
      where: { id: { in: inside } },
      data: { deletedAt: ago(31) },
    });
    await prisma.folder.update({ where: { id: folder }, data: { deletedAt: ago(31) } });
    await prisma.file.update({ where: { id: old }, data: { deletedAt: ago(32) } });
    const paths = new Map(
      (await prisma.file.findMany({ where: { id: { in: [...inside, old] } } })).map((f) => [
        f.id,
        f.path,
      ]),
    );

    const first = await purgeTrash({ limit: 2, now });
    expect(first).toEqual({
      note: "2 files removed for good; 2 more due, for the nights ahead",
      skipped: 0,
    });
    // the oldest first, bytes and row both
    expect(await prisma.file.findUnique({ where: { id: old } })).toBeNull();
    expect(existsSync(join(TEST_UPLOADS_DIR, paths.get(old) as string))).toBe(false);
    // the folder still holds a file, so it stays (the keys are RESTRICT)
    expect(await prisma.folder.findUnique({ where: { id: folder } })).not.toBeNull();

    const second = await purgeTrash({ limit: 2, now });
    expect(second.note).toBe("2 files removed for good; 1 empty folder with them");
    expect(await prisma.folder.findUnique({ where: { id: folder } })).toBeNull();
    expect(await prisma.file.findUnique({ where: { id: young } })).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: live } })).not.toBeNull();

    expect((await recorded("file.purged", old)).changes).toEqual({
      name: "old.pdf",
      from: `${TAG} BrightLine › Internal`,
    });
    expect((await recorded("firm_file.purged", inside[2])).changes).toMatchObject({
      from: "Company › Purge me",
    });
    await prisma.client.update({ where: { id: clientB }, data: { archivedAt: null } });
  });
});
