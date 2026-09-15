import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { PERSONAL_FOLDER } from "./files.service.js";

/**
 * **A folder upload** (files.md §7.2): the browser asks once for each directory, and the server
 * finds the folder or makes it, with the same answer however often it is asked. Too deep is refused
 * with the reason, as for a folder made by hand. Only over rows this suite made.
 */

const TAG = `ensure-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
const people: string[] = [];
const clientIds: string[] = [];

interface Ensured {
  id: string;
  name: string;
  created: boolean;
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@ensure.local`;
  const user = await prisma.user.create({
    data: {
      firstName: "En",
      lastName: `Sure ${TAG}`,
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

const ensure = (url: string, name: string, parentId: string | null = null) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: admin.cookie },
    payload: { name, parentId },
  });

/** The log is written after the response, so an assertion on it waits. */
async function recorded(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({ where: { action, subjectId } });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin");
});

afterAll(async () => {
  // the folders in one statement, before the client some of them belong to
  await prisma.folder.deleteMany({ where: { createdById: { in: people } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("a folder upload's call for each directory (files.md §7.2)", () => {
  const company = "/api/files/company/folders/ensure";

  it("finds the folder or makes it, with the same answer however often it is asked", async () => {
    const first = await ensure(company, `${TAG} Scans`);
    expect(first.statusCode).toBe(201);
    const scans = first.json() as Ensured;
    expect(scans).toMatchObject({ name: `${TAG} Scans`, created: true });

    // the same directory again, spelled in another case: the same folder, and nothing new logged
    const again = await ensure(company, `${TAG} SCANS`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: scans.id, name: `${TAG} Scans`, created: false });
    await recorded("firm_folder.created", scans.id);
    expect(
      await prisma.activityEvent.count({
        where: { action: "firm_folder.created", subjectId: scans.id },
      }),
    ).toBe(1);

    const year = (await ensure(company, "2024", scans.id)).json() as Ensured;
    expect((await ensure(company, "2024", scans.id)).json()).toMatchObject({
      id: year.id,
      created: false,
    });
    expect(await prisma.folder.findUniqueOrThrow({ where: { id: year.id } })).toMatchObject({
      parentId: scans.id,
      scope: "company",
    });

    // two calls at the same moment get one folder between them
    const [a, b] = await Promise.all([
      ensure(company, "Q1", year.id),
      ensure(company, "Q1", year.id),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((a.json() as Ensured).id).toBe((b.json() as Ensured).id);
  });

  it("goes no deeper than a folder made by hand, and says why", async () => {
    let parentId: string | null = null;
    for (let level = 1; level <= 8; level++) {
      const res = await ensure(company, `${TAG} level ${level}`, parentId);
      expect(res.statusCode).toBe(201);
      parentId = (res.json() as Ensured).id;
    }
    const tooDeep = await ensure(company, "level 9", parentId);
    expect(tooDeep.statusCode).toBe(400);
    expect((tooDeep.json() as { error: { message: string } }).error.message).toMatch(
      /at most 8 levels deep/,
    );
  });

  it("works in a client's zone under Clients, and in My files without naming it", async () => {
    const clientId = (await prisma.client.create({ data: { firstName: `${TAG} Folders` } })).id;
    clientIds.push(clientId);
    const zone = await ensure(
      `/api/files/clients/${clientId}/zones/internal/folders/ensure`,
      "Returns",
    );
    expect(zone.statusCode).toBe(201);
    const returns = zone.json() as Ensured;
    expect((await recorded("folder.created", returns.id)).clientId).toBe(clientId);
    expect(await prisma.folder.findUniqueOrThrow({ where: { id: returns.id } })).toMatchObject({
      scope: `client:${clientId}:internal`,
    });

    const mine = await ensure("/api/files/my/folders/ensure", `${TAG} Drafts`);
    expect(mine.statusCode).toBe(201);
    const row = await recorded("firm_folder.created", (mine.json() as Ensured).id);
    expect(row.subjectLabel).toBe(PERSONAL_FOLDER);
  });
});
