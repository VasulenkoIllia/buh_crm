import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { personalFolderName } from "./files.names.js";
import { createFolder } from "./files.repository.js";

/**
 * **The moves the system makes on its own, and the firm's storage** (files.md §8.3, §5.6, §4.4;
 * stage B.5): blocking moves a person's whole My files into Company; converting a lead files its
 * tasks' files into the new client's Internal, and a later upload on such a task lands there too;
 * Settings → System → Storage is an admin's. Only over rows this suite made: the database is shared.
 */

const TAG = `hand-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}

const people: string[] = [];
const clientIds: string[] = [];
const leadIds: string[] = [];
const taskIds: string[] = [];
let admin: Person;
let keeper: Person;
let priorityId: string;
let columnId: string;
let stageId: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(firstName: string, lastName: string, role: "admin" | "user" = "user") {
  const email = `${randomUUID().slice(0, 8)}-${TAG}@handover.local`;
  const user = await prisma.user.create({
    data: {
      firstName,
      lastName,
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
    patch: (url: string, payload: object) =>
      app.inject({ method: "PATCH", url, headers, payload }),
    upload: (url: string, name: string, body = "hello") => {
      const boundary = "----buhcrmhandover";
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
async function recorded(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({ where: { action, subjectId } });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

const companyRoot = (name: string) =>
  prisma.folder.findMany({ where: { scope: "company", parentId: null, name } });

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("Ada", `Admin ${TAG}`, "admin");
  keeper = await person("Bo", `Keeper ${TAG}`);
  priorityId = (await prisma.priority.findFirstOrThrow()).id;
  columnId = (await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } })).id;
  stageId = (await prisma.leadStage.findFirstOrThrow()).id;
});

afterAll(async () => {
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  // children before parents: a folder's parent key refuses to lose it first
  for (let pass = 0; pass < 12; pass++) {
    const gone = await prisma.folder.deleteMany({
      where: { createdById: { in: people }, children: { none: {} } },
    });
    if (gone.count === 0) break;
  }
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("a leaver's My files (files.md §8.3)", () => {
  it("counts what would move for Team alone, then moves all of it into Company, once", async () => {
    const leaver = await person("Olena", `Petrenko ${TAG}`);
    const l = as(leaver);
    const drafts = (
      await l.post("/api/files/my/folders", { name: "Drafts", parentId: null })
    ).json().id;
    // a branch eight levels deep still moves: the depth limit is not the system's
    let parent = drafts;
    for (let level = 2; level <= 8; level++) {
      parent = (
        await l.post("/api/files/my/folders", { name: `L${level}`, parentId: parent })
      ).json().id;
    }
    const inDrafts = (await l.upload(`/api/files/my/upload?folderId=${drafts}`, "a.txt")).json()
      .id;
    const deep = (await l.upload(`/api/files/my/upload?folderId=${parent}`, "deep.txt")).json()
      .id;
    const loose = (await l.upload("/api/files/my/upload", "b.txt")).json().id;
    const binned = (await l.upload("/api/files/my/upload", "c.txt")).json().id;
    expect((await l.post("/api/files/my/delete", { fileIds: [binned] })).statusCode).toBe(200);

    const summary = await as(admin).get(`/api/users/${leaver.id}/personal-files-summary`);
    expect(summary.json()).toEqual({ files: 3, bytes: 15, trashed: 1, folders: 8 });
    // the one read about somebody else's My files is Team's, and never names a file
    expect(
      (await as(keeper).get(`/api/users/${leaver.id}/personal-files-summary`)).statusCode,
    ).toBe(403);

    const block = await as(admin).patch(`/api/users/${leaver.id}`, { status: "blocked" });
    expect(block.statusCode).toBe(200);
    const name = `Olena Petrenko ${TAG} (personal)`;
    const [folder] = await companyRoot(name);
    expect(folder).toBeDefined();

    const moved = await prisma.file.findMany({
      where: { id: { in: [inDrafts, deep, loose, binned] } },
      select: { id: true, scope: true, folderId: true, ownerId: true, deletedAt: true },
    });
    expect(moved.every((f) => f.scope === "company" && f.ownerId === null)).toBe(true);
    const byId = new Map(moved.map((f) => [f.id, f]));
    expect(byId.get(loose)?.folderId).toBe(folder?.id);
    // what was in the Trash stays in the Trash, with the days it has left
    expect(byId.get(binned)?.folderId).toBe(folder?.id);
    expect(byId.get(binned)?.deletedAt).not.toBeNull();
    const top = await prisma.folder.findUniqueOrThrow({ where: { id: drafts } });
    expect(top).toMatchObject({ scope: "company", parentId: folder?.id });
    expect(await prisma.folder.count({ where: { scope: `personal:${leaver.id}` } })).toBe(0);
    expect(await prisma.file.count({ where: { scope: `personal:${leaver.id}` } })).toBe(0);

    const row = await recorded("firm_folder.personal_moved", folder?.id as string);
    expect(row.changes).toEqual({
      files: 3,
      size: 15,
      trashed: 1,
      from: `Olena Petrenko ${TAG}'s My files`,
      to: `Company › ${name}`,
    });

    // a second Block moves nothing, and unblocking moves nothing back
    await as(admin).patch(`/api/users/${leaver.id}`, { status: "blocked" });
    await as(admin).patch(`/api/users/${leaver.id}`, { status: "active" });
    expect(await companyRoot(name)).toHaveLength(1);
    expect((await prisma.file.findUniqueOrThrow({ where: { id: loose } })).scope).toBe(
      "company",
    );
  });

  it("makes nothing for an empty space, and takes (2) past a live namesake only", async () => {
    const empty = await person("Nobody", `Here ${TAG}`);
    await as(admin).patch(`/api/users/${empty.id}`, { status: "blocked" });
    expect(await companyRoot(`Nobody Here ${TAG} (personal)`)).toHaveLength(0);

    const twin = await person("Ivan", `Twin ${TAG}`);
    const binnedOnly = (await as(twin).upload("/api/files/my/upload", "old.txt")).json().id;
    await as(twin).post("/api/files/my/delete", { fileIds: [binnedOnly] });
    const base = `Ivan Twin ${TAG} (personal)`;
    await as(admin).post("/api/files/company/folders", { name: base, parentId: null });
    const second = (
      await as(admin).post("/api/files/company/folders", {
        name: `${base} (2)`,
        parentId: null,
      })
    ).json().id;
    await as(admin).post("/api/files/company/delete", { folderIds: [second] });

    // a space holding only the Trash still moves; the trashed "(2)" does not count as taken
    await as(admin).patch(`/api/users/${twin.id}`, { status: "blocked" });
    const [landed] = await companyRoot(`${base} (2)`).then((rows) =>
      rows.filter((f) => f.deletedAt === null),
    );
    expect(landed).toBeDefined();
    expect((await prisma.file.findUniqueOrThrow({ where: { id: binnedOnly } })).folderId).toBe(
      landed?.id,
    );
  });

  it("cleans the name to fit, and refuses a write into a space whose owner has gone", async () => {
    expect(personalFolderName("A/B Petrenko")).toBe("AB Petrenko (personal)");
    const long = personalFolderName("x".repeat(130));
    expect(long.endsWith(" (personal)")).toBe(true);
    expect(`${long} (99)`.length).toBeLessThanOrEqual(120);

    const gone = await person("Racing", `Upload ${TAG}`);
    await as(admin).patch(`/api/users/${gone.id}`, { status: "blocked" });
    await expect(
      createFolder(
        { name: "late", scope: `personal:${gone.id}`, parentId: null, createdById: gone.id },
        gone.id,
      ),
    ).rejects.toThrow("no longer open");
  });
});

describe("a converted lead's files (files.md §5.6)", () => {
  it("files its tasks' files into the client's Internal, oldest first, and later uploads too", async () => {
    const a = as(admin);
    const lead = await prisma.lead.create({ data: { name: `${TAG} lead`, stageId } });
    leadIds.push(lead.id);
    const tasks = [];
    for (const title of ["intake", "follow-up"]) {
      const t = await prisma.task.create({
        data: {
          title: `${TAG} ${title}`,
          priorityId,
          statusColumnId: columnId,
          leadId: lead.id,
        },
      });
      taskIds.push(t.id);
      tasks.push(t.id);
    }
    const first = (await a.upload(`/api/tasks/${tasks[0]}/files`, "scan.pdf")).json().id;
    const second = (await a.upload(`/api/tasks/${tasks[1]}/files`, "scan.pdf")).json().id;

    const converted = await a.post(`/api/leads/${lead.id}/convert`, {
      firstName: `${TAG} Won`,
    });
    expect(converted.statusCode).toBeLessThan(300);
    const clientId = converted.json().clientId as string;
    clientIds.push(clientId);

    const filed = await prisma.file.findMany({
      where: { id: { in: [first, second] } },
      orderBy: { createdAt: "asc" },
    });
    expect(filed.map((f) => [f.scope, f.name, f.clientId, f.taskId])).toEqual([
      [`client:${clientId}:internal`, "scan.pdf", clientId, tasks[0]],
      [`client:${clientId}:internal`, "scan (2).pdf", clientId, tasks[1]],
    ]);
    expect((await recorded("file.filed", first)).clientId).toBe(clientId);

    // the lead's tasks stay live, and what arrives on them now lands with the client at once
    const later = await a.upload(`/api/tasks/${tasks[0]}/files`, "scan.pdf");
    expect(later.statusCode).toBe(201);
    const row = await prisma.file.findUniqueOrThrow({ where: { id: later.json().id } });
    expect(row).toMatchObject({
      scope: `client:${clientId}:internal`,
      folderId: null,
      name: "scan (3).pdf",
      clientId,
      taskId: tasks[0],
    });
    await recorded("file.filed", row.id);

    // an archived client's files are dark (decision 8): a new file on the old lead's task stays on
    // the task, as a lead's always did, rather than landing where nobody can open it
    await prisma.client.update({ where: { id: clientId }, data: { archivedAt: new Date() } });
    const dark = await a.upload(`/api/tasks/${tasks[1]}/files`, "late.pdf");
    expect(dark.statusCode).toBe(201);
    expect(
      await prisma.file.findUniqueOrThrow({ where: { id: dark.json().id } }),
    ).toMatchObject({
      scope: null,
      clientId: null,
      taskId: tasks[1],
    });
  });

  it("refuses a program on a task, as on every other upload (§14.3)", async () => {
    const t = await prisma.task.create({
      data: { title: `${TAG} internal`, priorityId, statusColumnId: columnId },
    });
    taskIds.push(t.id);
    const res = await as(admin).upload(`/api/tasks/${t.id}/files`, "setup.exe");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("program or a script");
  });
});

describe("Settings → System → Storage (files.md §4.4)", () => {
  it("gives an admin the firm's figures and the disk, and nobody else", async () => {
    const res = await as(admin).get("/api/settings/storage");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.all.files).toBeGreaterThanOrEqual(body.parts.company.files);
    expect(body.parts.company.files).toBeGreaterThan(0); // the leavers' files above
    expect(body.where.bucket.files + body.where.disk.files).toBe(body.all.files);
    if (body.disk) expect(body.disk.free).toBeLessThanOrEqual(body.disk.total);

    // firm-wide figures that ignore who may see what: closed even with Settings opened
    await setGate(keeper, "settings", "open");
    expect((await as(keeper).get("/api/settings/storage")).statusCode).toBe(403);
  });
});
