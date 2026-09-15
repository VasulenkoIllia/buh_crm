import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GateKey } from "@shared/access.js";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";

/**
 * The library's API (files.md §4–§7, §10, §11; stage B.2): places, folders, uploads, names, moves
 * and File to folder, through the routes, as an admin and as a bookkeeper. Only ever over rows
 * this suite made: the suite shares one database.
 */

const TAG = `files-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
interface Named {
  id: string;
  name: string;
}
interface Group {
  task: { id: string };
  files: { id: string; filedIn: string | null }[];
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
let personalFile: string;
let companyFile: string;
let companyFolder: string;
let companyYear: string;
let level3: string;
let drafts: string;
let clientFolder: string;
let clientFile: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@files.local`;
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

/** A task on a client, or with neither a client nor a lead: one of the firm's internal tasks. */
async function task(link: { clientId?: string } = {}) {
  const row = await prisma.task.create({
    data: { title: `${TAG} task`, priorityId, statusColumnId: columnId, ...link },
  });
  taskIds.push(row.id);
  return row.id;
}

function multipart(name: string, body: string) {
  const boundary = "----buhcrmfiles";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n${body}\r\n--${boundary}--\r\n`,
    ),
  };
}

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers, payload }),
    patch: (url: string, payload: object) =>
      app.inject({ method: "PATCH", url, headers, payload }),
    del: (url: string) => app.inject({ method: "DELETE", url, headers }),
    upload: (url: string, name: string, body = "hello") => {
      const form = multipart(name, body);
      return app.inject({
        method: "POST",
        url,
        headers: { ...headers, ...form.headers },
        payload: form.payload,
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
  // files first, since folders hold on to them; then the folders, in one statement
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.folder.deleteMany({ where: { createdById: { in: people } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("the library's API (files.md, stage B.2)", () => {
  it("uploads into My files, Company and a client's zones, a taken name becoming (2)", async () => {
    const a = as(admin);
    const mine = await a.upload("/api/files/my/upload", "notes.txt");
    expect(mine.statusCode).toBe(201);
    personalFile = mine.json().id;
    expect((await a.upload("/api/files/my/upload", "Notes.txt")).json().name).toBe(
      "Notes (2).txt",
    );

    const company = await a.upload("/api/files/company/upload", "Holidays 2026.pdf");
    expect(company.statusCode).toBe(201);
    companyFile = company.json().id;

    const shared = await a.upload(
      `/api/files/clients/${clientA}/zones/shared/upload`,
      "8879.pdf",
    );
    expect(shared.statusCode).toBe(201);
    const sharedId = shared.json().id;

    // programs and scripts are refused by their extension (files.md §14.3)
    expect((await a.upload("/api/files/company/upload", "setup.exe")).statusCode).toBe(400);

    // My files is logged without a name or a size (files.md §10.3)
    const personal = await recorded("firm_file.uploaded", personalFile);
    expect(personal.subjectLabel).toBe("a personal file");
    expect(personal.changes).toEqual({ place: "My files" });
    expect((await recorded("firm_file.uploaded", companyFile)).changes).toMatchObject({
      name: "Holidays 2026.pdf",
      place: "Company",
    });
    const uploaded = await recorded("file.uploaded", sharedId);
    expect(uploaded.clientId).toBe(clientA);
    expect(uploaded.changes).toMatchObject({
      attachedTo: `${TAG} Petrenko › Shared with client`,
    });
    expect((await recorded("file.shared_with_client", sharedId)).changes).toEqual({
      place: `${TAG} Petrenko › Shared with client`,
    });
  });

  it("lists a place with its folders' totals, subfolders included, and the path down", async () => {
    const a = as(admin);
    const top = await a.post("/api/files/company/folders", {
      name: "Templates",
      parentId: null,
    });
    expect(top.statusCode).toBe(201);
    companyFolder = top.json().id;
    companyYear = (
      await a.post("/api/files/company/folders", { name: "2026", parentId: companyFolder })
    ).json().id;
    const organizer = await a.upload(
      `/api/files/company/upload?folderId=${companyYear}`,
      "organizer.pdf",
      "x".repeat(100),
    );
    expect(organizer.statusCode).toBe(201);

    const root = (await a.get("/api/files/company/list")).json();
    expect(root.crumbs).toEqual([]);
    expect(root.folders.find((f: Named) => f.id === companyFolder).totals).toEqual({
      files: 1,
      bytes: 100,
    });
    const open = (await a.get(`/api/files/company/list?folderId=${companyYear}`)).json();
    expect(open.crumbs.map((c: Named) => c.name)).toEqual(["Templates", "2026"]);
    expect(open.files.map((f: Named) => f.name)).toEqual(["organizer.pdf"]);
    expect(open.totals).toEqual({ files: 1, bytes: 100 });
    const tree = (await a.get("/api/files/company/folders")).json();
    expect(tree.find((f: Named) => f.id === companyYear)).toMatchObject({
      parentId: companyFolder,
      totals: { files: 1, bytes: 100 },
    });

    // one live name per folder, case-insensitively (files.md §6.3)
    const twin = await a.post("/api/files/company/folders", {
      name: "templates",
      parentId: null,
    });
    expect(twin.statusCode).toBe(409);

    // eight levels below a fixed level, and no ninth (files.md §6.1)
    let parent = companyYear;
    for (let level = 3; level <= 8; level++) {
      const res = await a.post("/api/files/company/folders", {
        name: `L${level}`,
        parentId: parent,
      });
      expect(res.statusCode).toBe(201);
      parent = res.json().id;
      if (level === 3) level3 = parent;
    }
    const ninth = await a.post("/api/files/company/folders", { name: "L9", parentId: parent });
    expect(ninth.statusCode).toBe(400);
    expect((await recorded("firm_folder.created", companyFolder)).changes).toEqual({
      place: "Company",
    });
  });

  it("renames, and refuses a name the folder already has", async () => {
    const a = as(admin);
    const renamed = await a.patch(`/api/files/company/folders/${companyFolder}`, {
      name: "Firm templates",
    });
    expect(renamed.statusCode).toBe(200);
    expect((await recorded("firm_folder.renamed", companyFolder)).changes).toEqual({
      name: { from: "Templates", to: "Firm templates" },
    });

    const office = (await a.upload("/api/files/company/upload", "Office.pdf")).json().id;
    const onto = await a.patch(`/api/files/company/files/${office}`, {
      name: "holidays 2026.PDF",
    });
    expect(onto.statusCode).toBe(409);
    expect(
      (await a.patch(`/api/files/company/files/${office}`, { name: "run.sh" })).statusCode,
    ).toBe(400);
    expect(
      (await a.patch(`/api/files/company/files/${office}`, { name: "Office hours.pdf" }))
        .statusCode,
    ).toBe(200);

    // in My files the act is logged and the name is not
    drafts = (await a.post("/api/files/my/folders", { name: "Drafts", parentId: null })).json()
      .id;
    expect(
      (await a.patch(`/api/files/my/folders/${drafts}`, { name: "Old drafts" })).statusCode,
    ).toBe(200);
    expect(
      (await a.patch(`/api/files/my/files/${personalFile}`, { name: "call notes.txt" }))
        .statusCode,
    ).toBe(200);
    expect((await recorded("firm_file.renamed", personalFile)).changes).toEqual({
      place: "My files",
    });
    expect((await recorded("firm_folder.renamed", drafts)).subjectLabel).toBe(
      "a personal folder",
    );

    clientFolder = (
      await a.post(`/api/files/clients/${clientA}/zones/internal/folders`, {
        name: "Docs",
        parentId: null,
      })
    ).json().id;
    const folderRename = await a.patch(
      `/api/files/clients/${clientA}/folders/${clientFolder}`,
      {
        name: "2025 documents",
      },
    );
    expect(folderRename.statusCode).toBe(200);
    expect((await recorded("folder.renamed", clientFolder)).clientId).toBe(clientA);
    clientFile = (
      await a.upload(
        `/api/files/clients/${clientA}/zones/internal/upload?folderId=${clientFolder}`,
        "W2.pdf",
      )
    ).json().id;
    const fileRename = await a.patch(`/api/files/clients/${clientA}/files/${clientFile}`, {
      name: "W-2 2025.pdf",
    });
    expect(fileRename.statusCode).toBe(200);
    expect((await recorded("file.renamed", clientFile)).changes).toEqual({
      name: { from: "W2.pdf", to: "W-2 2025.pdf" },
    });
  });

  it("keeps My files private: another person's ids answer not found", async () => {
    const k = as(keeper);
    expect((await k.get("/api/files/my/list")).json().files).toEqual([]);
    expect(
      (await k.patch(`/api/files/my/files/${personalFile}`, { name: "x.txt" })).statusCode,
    ).toBe(404);
    expect((await k.get(`/api/files/my/files/${personalFile}`)).statusCode).toBe(404);
    const move = await k.post("/api/files/my/move", {
      fileIds: [personalFile],
      to: { space: "company" },
    });
    expect(move.statusCode).toBe(404);
    expect((await k.get(`/api/files/company/files/${personalFile}`)).statusCode).toBe(404);
  });

  it("downloads from Company and My files, and logs the read", async () => {
    const a = as(admin);
    const company = await a.get(`/api/files/company/files/${companyFile}`);
    expect(company.statusCode).toBe(200);
    expect(company.body).toBe("hello");
    expect(company.headers["content-disposition"]).toContain("attachment");
    await recorded("firm_file.downloaded", companyFile);
    expect((await a.get(`/api/files/my/files/${personalFile}`)).statusCode).toBe(200);
    expect((await recorded("firm_file.downloaded", personalFile)).subjectLabel).toBe(
      "a personal file",
    );
  });

  it("moves between My files and Company, and a folder with everything under it", async () => {
    const a = as(admin);
    const out = await a.post("/api/files/my/move", {
      fileIds: [personalFile],
      to: { space: "company" },
      toFolderId: companyFolder,
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toMatchObject({ moved: 1, detached: 0 });
    const back = await a.post("/api/files/company/move", {
      fileIds: [personalFile],
      to: { space: "personal" },
    });
    expect(back.statusCode).toBe(200);
    // inside My files the act is logged, and the file is not named
    await a.post("/api/files/my/move", {
      fileIds: [personalFile],
      to: { space: "personal" },
      toFolderId: drafts,
    });
    const moves = await allRecorded("firm_file.moved", personalFile, 3);
    expect(moves.map((m) => m.changes)).toEqual(
      expect.arrayContaining([
        { from: "My files", to: "Company › Firm templates" },
        { from: "Company › Firm templates", to: "My files" },
        { place: "My files" },
      ]),
    );

    const intoItself = await a.post("/api/files/company/move", {
      folderIds: [companyYear],
      to: { space: "company" },
      toFolderId: level3,
    });
    expect(intoItself.statusCode).toBe(400);
    const up = await a.post("/api/files/company/move", {
      folderIds: [companyYear],
      to: { space: "company" },
      toFolderId: null,
    });
    expect(up.json()).toMatchObject({ moved: 1 });
    expect((await recorded("firm_folder.moved", companyYear)).changes).toEqual({
      from: "Company › Firm templates",
      to: "Company",
      files: 1,
    });
    await a.post("/api/files/company/folders", { name: "2026", parentId: companyFolder });
    const onto = await a.post("/api/files/company/move", {
      folderIds: [companyYear],
      to: { space: "company" },
      toFolderId: companyFolder,
    });
    expect(onto.statusCode).toBe(409);
  });

  it("moves a Company document into a client only with Clients open", async () => {
    const k = as(keeper);
    const doc = (await k.upload("/api/files/company/upload", "engagement.pdf")).json().id;
    const to = { space: "client", clientId: clientA, zone: "shared" };
    await setGate(keeper, "clients", "closed");
    const refused = await k.post("/api/files/company/move", { fileIds: [doc], to });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("module_closed");
    await setGate(keeper, "clients", "open");

    expect((await k.post("/api/files/company/move", { fileIds: [doc], to })).statusCode).toBe(
      200,
    );
    expect((await recorded("file.moved", doc)).clientId).toBe(clientA);
    expect((await recorded("file.shared_with_client", doc)).changes).toEqual({
      place: `${TAG} Petrenko › Shared with client`,
    });
  });

  it("moves between a client's zones, and leaves moving out of a client to an admin", async () => {
    const k = as(keeper);
    const toShared = await k.post(`/api/files/clients/${clientA}/move`, {
      folderIds: [clientFolder],
      to: { space: "client", clientId: clientA, zone: "shared" },
    });
    expect(toShared.statusCode).toBe(200);
    const shared = (await k.get(`/api/files/clients/${clientA}/zones/shared/list`)).json();
    expect(shared.folders.map((f: Named) => f.id)).toContain(clientFolder);
    expect((await recorded("folder.moved", clientFolder)).changes).toMatchObject({ files: 1 });
    expect((await recorded("file.shared_with_client", clientFile)).clientId).toBe(clientA);

    const elsewhere = {
      folderIds: [clientFolder],
      to: { space: "client", clientId: clientB, zone: "internal" },
    };
    expect((await k.post(`/api/files/clients/${clientA}/move`, elsewhere)).statusCode).toBe(
      400,
    );
    const notAdmin = await k.post(`/api/files/clients/${clientA}/move-out`, elsewhere);
    expect(notAdmin.statusCode).toBe(403);
    expect(notAdmin.json().error.code).toBe("admin_only");

    const out = await as(admin).post(`/api/files/clients/${clientA}/move-out`, elsewhere);
    expect(out.statusCode).toBe(200);
    const refiled = await recorded("file.refiled", clientFile);
    expect(refiled.clientId).toBe(clientA);
    expect(refiled.changes).toEqual({
      from: `${TAG} Petrenko › Shared with client › 2025 documents`,
      to: `${TAG} BrightLine › Internal › 2025 documents`,
    });
    expect((await recorded("file.unshared", clientFile)).clientId).toBe(clientA);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: clientFile } })).toMatchObject({
      clientId: clientB,
      zone: "internal",
    });
  });

  it("files a task's file into its client's folder, and the task card only takes it off", async () => {
    const a = as(admin);
    const taskId = await task({ clientId: clientA });
    // the same name at Internal's root already, so filing gives (2)
    await a.upload(`/api/files/clients/${clientA}/zones/internal/upload`, "receipt.pdf");
    const attached = await a.upload(`/api/tasks/${taskId}/files`, "receipt.pdf");
    expect(attached.statusCode).toBe(201);
    const fileId = attached.json().id;

    const groups: Group[] = (await a.get(`/api/files/clients/${clientA}/attachments`)).json();
    expect(groups.find((g) => g.task.id === taskId)?.files).toEqual([
      expect.objectContaining({ id: fileId, filedIn: null }),
    ]);

    // only into its own task's client (files.md §5.3)
    const wrong = await a.post(`/api/files/clients/${clientB}/attachments/${fileId}/file`, {
      zone: "internal",
    });
    expect(wrong.statusCode).toBe(404);
    const filed = await a.post(`/api/files/clients/${clientA}/attachments/${fileId}/file`, {
      zone: "internal",
      folderId: null,
    });
    expect(filed.statusCode).toBe(200);
    expect(filed.json().name).toBe("receipt (2).pdf");
    const refreshed: Group[] = (
      await a.get(`/api/files/clients/${clientA}/attachments`)
    ).json();
    expect(refreshed.find((g) => g.task.id === taskId)?.files[0].filedIn).toBe("Internal");
    expect((await recorded("file.filed", fileId)).changes).toEqual({
      to: `${TAG} Petrenko › Internal`,
      task: `${TAG} task`,
    });
    expect((await a.get(`/api/tasks/${taskId}/files`)).json()).toEqual([
      expect.objectContaining({ id: fileId, name: "receipt (2).pdf", filed: true }),
    ]);

    // deleted on the task card, a filed file only leaves its task (files.md §5.4)
    expect((await a.del(`/api/tasks/${taskId}/files/${fileId}`)).statusCode).toBe(200);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
      taskId: null,
      scope: `client:${clientA}:internal`,
    });
    expect((await recorded("file.detached", fileId)).changes).toEqual({ task: `${TAG} task` });
  });

  it("shows an internal task's files under Company's Attachments, behind Tasks", async () => {
    const a = as(admin);
    const taskId = await task();
    const fileId = (await a.upload(`/api/tasks/${taskId}/files`, "timesheet.xlsx")).json().id;
    const groups: Group[] = (await a.get("/api/files/company/attachments")).json();
    expect(groups.find((g) => g.task.id === taskId)?.files[0]).toMatchObject({
      id: fileId,
      filedIn: null,
    });

    const filed = await a.post(`/api/files/company/attachments/${fileId}/file`, {
      folderId: companyFolder,
    });
    expect(filed.statusCode).toBe(200);
    expect((await recorded("firm_file.filed", fileId)).changes).toEqual({
      to: "Company › Firm templates",
      task: `${TAG} task`,
    });
    const listed: Group[] = (await a.get("/api/files/company/attachments")).json();
    expect(listed.find((g) => g.task.id === taskId)?.files[0].filedIn).toBe(
      "Company › Firm templates",
    );

    // the document is Company's now, and its task stays out of sight of a reader without Tasks
    await setGate(keeper, "tasks", "closed");
    const k = as(keeper);
    expect((await k.get("/api/files/company/attachments")).statusCode).toBe(403);
    const hidden = (await k.get(`/api/files/company/list?folderId=${companyFolder}`)).json();
    expect(hidden.files.find((f: Named) => f.id === fileId)).toMatchObject({ task: null });
    await setGate(keeper, "tasks", "open");
    const shown = (await a.get(`/api/files/company/list?folderId=${companyFolder}`)).json();
    expect(shown.files.find((f: Named) => f.id === fileId).task).toMatchObject({ id: taskId });

    // into My files: off its task first, which the database would otherwise refuse
    const mine = await a.post("/api/files/company/move", {
      fileIds: [fileId],
      to: { space: "personal" },
    });
    expect(mine.json()).toMatchObject({ moved: 1, detached: 1 });
    expect((await recorded("firm_file.detached", fileId)).changes).toEqual({
      task: `${TAG} task`,
    });
    expect(await prisma.file.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
      taskId: null,
      space: "personal",
    });
  });

  it("totals what the reader can see, each part only where its gate is open", async () => {
    const forAdmin = (await as(admin).get("/api/files/overview")).json();
    expect(forAdmin.clients).not.toBeNull();
    expect(forAdmin.companyAttachments).not.toBeNull();

    await setGate(keeper, "clients", "closed");
    await setGate(keeper, "tasks", "closed");
    const narrowed = (await as(keeper).get("/api/files/overview")).json();
    expect(narrowed.clients).toBeNull();
    expect(narrowed.companyAttachments).toBeNull();
    expect(narrowed.all).toEqual({
      files: narrowed.mine.files + narrowed.company.files,
      bytes: narrowed.mine.bytes + narrowed.company.bytes,
    });
    await setGate(keeper, "clients", "open");
    await setGate(keeper, "tasks", "open");

    const k = as(keeper);
    const nodes: { id: string; totals: { files: number } }[] = (
      await k.get("/api/files/clients")
    ).json();
    expect(nodes.find((n) => n.id === clientA)?.totals.files).toBeGreaterThan(0);
    const detail = (await k.get(`/api/files/clients/${clientA}`)).json();
    expect(detail.zones.shared.files).toBe(2); // 8879.pdf and engagement.pdf
    expect(
      (await k.get(`/api/files/clients/${clientA}/zones/internal/folders`)).statusCode,
    ).toBe(200);
  });

  it("hides an archived client's files", async () => {
    await prisma.client.update({ where: { id: clientB }, data: { archivedAt: new Date() } });
    const a = as(admin);
    expect((await a.get(`/api/files/clients/${clientB}/zones/internal/list`)).statusCode).toBe(
      404,
    );
    const nodes: Named[] = (await a.get("/api/files/clients")).json();
    expect(nodes.some((n) => n.id === clientB)).toBe(false);
    await prisma.client.update({ where: { id: clientB }, data: { archivedAt: null } });
  });
});
