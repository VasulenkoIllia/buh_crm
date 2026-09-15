import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { checkFileBytes, filesReport } from "./files.check.js";

/**
 * **The check before and after a deploy** (files.md §15.3): where every file belongs, what cannot
 * be right, and whether every file opens. The test database holds other suites' rows too, so each
 * assertion is about the rows this suite made.
 */

const TAG = `check-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: { id: string; cookie: string };
const people: string[] = [];
const clientIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  const email = `admin-${TAG}@check.local`;
  const user = await prisma.user.create({
    data: {
      firstName: "Che",
      lastName: `Cker ${TAG}`,
      email,
      passwordHash: await argon2.hash("password-123"),
      role: "admin",
      status: "active",
    },
  });
  people.push(user.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  admin = { id: user.id, cookie: raw.split(";")[0] };
});

afterAll(async () => {
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

function upload(url: string, name: string) {
  const boundary = "----buhcrmcheck";
  return app.inject({
    method: "POST",
    url,
    headers: {
      cookie: admin.cookie,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n%PDF-1.4 hello\r\n--${boundary}--\r\n`,
    ),
  });
}

describe("the check before and after a deploy (files.md §15.3)", () => {
  let stray: string;

  it("says where each file belongs, and flags one that cannot be right", async () => {
    const clientId = (await prisma.client.create({ data: { firstName: `${TAG} Checked` } })).id;
    clientIds.push(clientId);
    const placed = (
      await upload(`/api/files/clients/${clientId}/zones/internal/upload`, "w2.pdf")
    ).json().id as string;

    // a client's document with no place: what the migration's backfill would have missed
    stray = (
      await prisma.file.create({
        data: {
          name: "stray.pdf",
          size: 5,
          mime: "application/pdf",
          path: `test/${TAG}-stray`,
          clientId,
          uploadedById: admin.id,
        },
      })
    ).id;
    // somebody blocked who still has a personal file: the move into Company missed it
    const leaver = await prisma.user.create({
      data: {
        firstName: "Le",
        lastName: `Aver ${TAG}`,
        email: `leaver-${TAG}@check.local`,
        passwordHash: "never signs in",
        role: "user",
        status: "blocked",
      },
    });
    people.push(leaver.id);
    const left = (
      await prisma.file.create({
        data: {
          name: "notes.txt",
          size: 5,
          mime: "text/plain",
          path: `test/${TAG}-left`,
          scope: `personal:${leaver.id}`,
          uploadedById: leaver.id,
        },
      })
    ).id;

    const report = await filesReport();
    const flagged = (what: RegExp) =>
      report.problems.filter((p) => what.test(p.what)).flatMap((p) => p.ids);
    expect(flagged(/outside the library/)).toContain(stray);
    expect(flagged(/blocked/)).toContain(left);
    expect([...report.problems, ...report.notes].flatMap((p) => p.ids)).not.toContain(placed);
    expect(
      report.places.find((p) => p.label.startsWith("Client documents"))?.count,
    ).toBeGreaterThan(0);
  });

  it("opens every stored file, and names the one that does not open by its id", async () => {
    const result = await checkFileBytes(async (file) => {
      if (file.id === stray) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return Buffer.alloc(
        (await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).size,
      );
    });
    expect(result.failed).toContainEqual({ id: stray, storage: "local", why: "missing" });
    expect(result.failed.map((f) => f.id)).toEqual([stray]);
  });
});
