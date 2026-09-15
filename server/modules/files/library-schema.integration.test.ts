import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";

/**
 * What the database itself guarantees about the library (files.md §14.2, §15.1, and §19's "Scope"
 * and "Names"), before any service is written on top of it. Only ever over rows this suite made:
 * the suite shares one database.
 */

const TAG = `lib-${randomUUID().slice(0, 8)}`;
let userId: string;
let priorityId: string;
let columnId: string;
let stageId: string;
const clientIds: string[] = [];
const fileIds: string[] = [];
const folderIds: string[] = [];
const leadIds: string[] = [];
const taskIds: string[] = [];

beforeAll(async () => {
  await ensureBaseData();
  const user = await prisma.user.create({
    data: {
      firstName: "Li",
      lastName: "Brary",
      email: `${TAG}@library.local`,
      passwordHash: "never signs in",
      role: "user",
      status: "active",
    },
  });
  userId = user.id;
  priorityId = (await prisma.priority.findFirstOrThrow()).id;
  columnId = (await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } })).id;
  stageId = (await prisma.leadStage.findFirstOrThrow()).id;
});

afterAll(async () => {
  await prisma.user.update({ where: { id: userId }, data: { avatarFileId: null } });
  await prisma.file.deleteMany({ where: { id: { in: fileIds } } });
  // every folder in one statement: the tree's own key is RESTRICT, and nothing is left under them
  await prisma.folder.deleteMany({ where: { id: { in: folderIds } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.delete({ where: { id: userId } });
});

async function client(name: string) {
  const row = await prisma.client.create({ data: { firstName: `${TAG} ${name}` } });
  clientIds.push(row.id);
  return row.id;
}

async function task(link: { clientId: string } | { leadId: string }) {
  const row = await prisma.task.create({
    data: { title: `${TAG} task`, priorityId, statusColumnId: columnId, ...link },
  });
  taskIds.push(row.id);
  return row.id;
}

async function file(data: {
  name: string;
  scope?: string | null;
  folderId?: string | null;
  clientId?: string | null;
  taskId?: string | null;
  createdAt?: Date;
}) {
  const row = await prisma.file.create({
    data: {
      size: 10,
      mime: "application/pdf",
      path: `library-test/${randomUUID()}`,
      uploadedById: userId,
      ...data,
    },
  });
  fileIds.push(row.id);
  return row;
}

async function folder(name: string, scope: string, parentId: string | null = null) {
  const row = await prisma.folder.create({ data: { name, scope, parentId } });
  folderIds.push(row.id);
  return row;
}

/** Everything a refusal says, whichever layer wrapped it: the driver's code and text survive. */
function describeError(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 4) return String(error);
  const parts = [String((error as Error).message ?? "")];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = (error as Record<string, unknown>)[key];
    parts.push(
      `${key}=${typeof value === "object" ? describeError(value, depth + 1) : String(value)}`,
    );
  }
  return parts.join(" ");
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return describeError(error);
  }
  throw new Error("expected the database to refuse this");
}

const trash = { deletedAt: new Date(), trashBatchId: randomUUID() };

describe("the library's schema", () => {
  it("copies a place out of its scope, for folders and for files", async () => {
    const clientA = await client("Petrenko");
    expect(await folder(`${TAG} Templates`, "company")).toMatchObject({
      space: "company",
      ownerId: null,
      clientId: null,
      zone: null,
    });
    expect(await folder(`${TAG} Drafts`, `personal:${userId}`)).toMatchObject({
      space: "personal",
      ownerId: userId,
      clientId: null,
      zone: null,
    });
    expect(await folder(`${TAG} For signature`, `client:${clientA}:shared`)).toMatchObject({
      space: "client",
      ownerId: null,
      clientId: clientA,
      zone: "shared",
    });
    expect(
      await file({ name: "W-2.pdf", scope: `client:${clientA}:from_client` }),
    ).toMatchObject({
      space: "client",
      clientId: clientA,
      zone: "from_client",
    });
  });

  it("moves a subtree to another zone, then to another client, in one statement each", async () => {
    const clientA = await client("Kovalenko");
    const clientB = await client("BrightLine");
    const internal = `client:${clientA}:internal`;
    const top = await folder(`${TAG} 2025 return`, internal);
    const sub = await folder("Workpapers", internal, top.id);
    const deep = await folder("Scans", internal, sub.id);
    const a = await file({ name: "1040.pdf", scope: internal, folderId: sub.id });
    const b = await file({ name: "scan1.pdf", scope: internal, folderId: deep.id });
    // a trashed row moves with its folder, and stays in the Trash (files.md §6.2)
    const c = await file({ name: "old.pdf", scope: internal, folderId: deep.id, ...trash });

    await prisma.folder.update({
      where: { id: top.id },
      data: { scope: `client:${clientA}:shared` },
    });
    const shared = {
      scope: `client:${clientA}:shared`,
      space: "client",
      clientId: clientA,
      zone: "shared",
    };
    for (const id of [sub.id, deep.id]) {
      expect(await prisma.folder.findUniqueOrThrow({ where: { id } })).toMatchObject(shared);
    }
    for (const id of [a.id, b.id, c.id]) {
      expect(await prisma.file.findUniqueOrThrow({ where: { id } })).toMatchObject(shared);
    }
    expect(await prisma.file.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      deletedAt: trash.deletedAt,
    });

    // an admin's re-file to another client: every file below takes that client
    await prisma.folder.update({
      where: { id: top.id },
      data: { scope: `client:${clientB}:internal` },
    });
    for (const id of [a.id, b.id, c.id]) {
      expect(await prisma.file.findUniqueOrThrow({ where: { id } })).toMatchObject({
        clientId: clientB,
        zone: "internal",
      });
    }
  });

  it("refuses a child in another scope, and a file that claims a folder outside the library", async () => {
    const clientA = await client("Melnyk");
    const top = await folder(`${TAG} Payroll`, `client:${clientA}:internal`);

    expect(await refusal(folder("Stray", "company", top.id))).toMatch(
      /Folder_parentId_scope_fkey|23503|foreign key/i,
    );
    expect(await refusal(file({ name: "stray.pdf", folderId: top.id, scope: null }))).toMatch(
      /File_place_matches_scope|23514|check constraint/i,
    );
  });

  it("refuses a copy written by hand, and a scope that is not a place", async () => {
    const templates = await folder(`${TAG} Policies`, "company");

    expect(
      await refusal(
        prisma.folder.update({ where: { id: templates.id }, data: { space: "client" } }),
      ),
    ).toMatch(/Folder_place_matches_scope|23514|check constraint/i);
    expect(await refusal(folder(`${TAG} x`, "clients:everyone"))).toMatch(
      /not a place in the library|23514/i,
    );
    // the key is the canonical id, or a second spelling of one place would dodge the name index
    expect(await refusal(folder(`${TAG} y`, `personal:${userId.toUpperCase()}`))).toMatch(
      /Folder_place_matches_scope|23514|check constraint/i,
    );
  });

  it("keeps a task's file out of anybody's My files", async () => {
    const clientA = await client("Bondar");
    const onTask = await file({
      name: "receipt.pdf",
      clientId: clientA,
      taskId: await task({ clientId: clientA }),
    });

    // Company is the service's call (an internal task's file may be filed there), My files never
    expect(
      await refusal(
        prisma.file.update({ where: { id: onTask.id }, data: { scope: `personal:${userId}` } }),
      ),
    ).toMatch(/File_attachment_not_personal|23514|check constraint/i);

    const filed = await prisma.file.update({
      where: { id: onTask.id },
      data: { scope: `client:${clientA}:internal` },
    });
    expect(filed).toMatchObject({ clientId: clientA, taskId: onTask.taskId, zone: "internal" });
  });

  it("holds one live name per folder, case-insensitively, but not in the Trash or among attachments", async () => {
    const clientA = await client("Shevchuk");
    const root = `client:${clientA}:internal`;

    const first = await file({ name: "W-2.pdf", scope: root });
    expect(await refusal(file({ name: "w-2.PDF", scope: root }))).toMatch(
      /File_live_name|23505|unique/i,
    );
    await prisma.file.update({ where: { id: first.id }, data: trash });
    await file({ name: "w-2.PDF", scope: root });

    await folder("Docs", root);
    expect(await refusal(folder("DOCS", root))).toMatch(/Folder_live_name|23505|unique/i);

    // two tasks may each hold a scan.pdf: an attachment that is not filed has no place
    await file({
      name: "scan.pdf",
      clientId: clientA,
      taskId: await task({ clientId: clientA }),
    });
    await file({
      name: "scan.pdf",
      clientId: clientA,
      taskId: await task({ clientId: clientA }),
    });
  });

  it("deletes no folder that still holds something", async () => {
    const top = await folder(`${TAG} Holidays`, "company");
    await file({ name: "2026.pdf", scope: "company", folderId: top.id });
    const child = await folder("Archive", "company", top.id);

    expect(
      await refusal(
        prisma.folder
          .delete({ where: { id: child.id } })
          .then(() => prisma.folder.delete({ where: { id: top.id } })),
      ),
    ).toMatch(/File_folderId_scope_fkey|23503|foreign key/i);
    folderIds.splice(folderIds.indexOf(child.id), 1); // the child did go
  });
});

describe("the migration's backfill (files.md §15.1)", () => {
  it("files card files and a converted lead's files into Internal, the younger duplicate renamed", async () => {
    const clientC = await client("Olena");
    const lead = await prisma.lead.create({
      data: { name: `${TAG} lead`, stageId, convertedClientId: clientC },
    });
    leadIds.push(lead.id);
    const day = (d: string) => new Date(`2026-${d}T12:00:00Z`);

    const cardW2 = await file({ name: "W-2.pdf", clientId: clientC, createdAt: day("01-05") });
    const cardW2Again = await file({
      name: "w-2.pdf",
      clientId: clientC,
      createdAt: day("02-05"),
    });
    const cardScan = await file({
      name: "scan.pdf",
      clientId: clientC,
      createdAt: day("08-05"),
    });
    // older than every card file, and still second: card files come first
    const leadScan = await file({
      name: "scan.pdf",
      taskId: await task({ leadId: lead.id }),
      createdAt: day("01-01"),
    });
    const leadScanAgain = await file({
      name: "scan.pdf",
      taskId: await task({ leadId: lead.id }),
      createdAt: day("01-02"),
    });
    const onClientTask = await file({
      name: "notes.pdf",
      clientId: clientC,
      taskId: await task({ clientId: clientC }),
    });
    const avatar = await file({ name: "me.png", clientId: clientC });
    await prisma.user.update({ where: { id: userId }, data: { avatarFileId: avatar.id } });

    const ids = [
      cardW2,
      cardW2Again,
      cardScan,
      leadScan,
      leadScanAgain,
      onClientTask,
      avatar,
    ].map((f) => f.id);
    const [{ filed }] = await prisma.$queryRaw<{ filed: number }[]>`
      SELECT "library_backfill"(${ids}::uuid[]) AS filed
    `;
    expect(filed).toBe(5);

    const after = new Map(
      (await prisma.file.findMany({ where: { id: { in: ids } } })).map((f) => [f.id, f]),
    );
    const internal = `client:${clientC}:internal`;
    expect(after.get(cardW2.id)).toMatchObject({ name: "W-2.pdf", scope: internal });
    expect(after.get(cardW2Again.id)).toMatchObject({ name: "w-2 (2).pdf", scope: internal });
    expect(after.get(cardScan.id)).toMatchObject({ name: "scan.pdf", scope: internal });
    expect(after.get(leadScan.id)).toMatchObject({
      name: "scan (2).pdf",
      scope: internal,
      clientId: clientC,
      taskId: leadScan.taskId,
    });
    expect(after.get(leadScanAgain.id)).toMatchObject({
      name: "scan (3).pdf",
      scope: internal,
    });
    expect(after.get(onClientTask.id)).toMatchObject({ scope: null, clientId: clientC });
    expect(after.get(avatar.id)).toMatchObject({ scope: null });

    // run again, it finds nothing left to file
    const [{ again }] = await prisma.$queryRaw<{ again: number }[]>`
      SELECT "library_backfill"(${ids}::uuid[]) AS again
    `;
    expect(again).toBe(0);
  });
});
