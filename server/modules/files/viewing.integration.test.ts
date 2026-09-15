import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { detectStoredTypes } from "./files.backfill.js";

/**
 * **Viewing in the CRM** (files.md §12, stage C.1–C.2): a file's type is read from its bytes at
 * upload, a renamed program is refused, a view sends the headers its type calls for and nothing
 * else opens inline, and one open is one logged view. Only over rows this suite made.
 */

const TAG = `view-${randomUUID().slice(0, 8)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
const people: string[] = [];
const clientIds: string[] = [];
const taskIds: string[] = [];

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(126)]);
const HTML = Buffer.from("<html><body><script>alert(document.cookie)</script></body></html>");
const PDF_POLICY =
  "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@viewing.local`;
  const user = await prisma.user.create({
    data: {
      firstName: "Vi",
      lastName: `Ewer ${TAG}`,
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
    head: (url: string) => app.inject({ method: "HEAD", url, headers }),
    upload: (url: string, name: string, bytes: Buffer) => {
      const boundary = "----buhcrmviewing";
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

/** The log is written after the response, so an assertion on it waits; the newest row wins. */
async function recorded(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId },
      orderBy: { occurredAt: "desc" },
    });
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
  await prisma.file.deleteMany({ where: { uploadedById: { in: people } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("viewing in the CRM (files.md §12)", () => {
  it("reads a file's type from its bytes, and refuses a program whatever its name says", async () => {
    const a = as(admin);
    const refused = await a.upload("/api/files/company/upload", `${TAG}-invoice.pdf`, EXE);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain("is a program");

    const pdf = (await a.upload("/api/files/company/upload", `${TAG}-return.pdf`, PDF)).json();
    expect(pdf.view).toBe("pdf");
    const stored = await prisma.file.findUniqueOrThrow({ where: { id: pdf.id } });
    expect(stored.detectedMime).toBe("application/pdf");

    const fake = await a.upload("/api/files/company/upload", `${TAG}-page.pdf`, HTML);
    expect(fake.json().view).toBeNull();
    const text = await a.upload(
      "/api/files/company/upload",
      `${TAG}-notes.txt`,
      Buffer.from("héllo, world"),
    );
    expect(text.json().view).toBe("text");
    // a NUL byte is not text, whatever the name says
    const binary = await a.upload(
      "/api/files/company/upload",
      `${TAG}-blob.txt`,
      Buffer.from([0x61, 0x00, 0x62]),
    );
    expect(binary.json().view).toBeNull();
  });

  it("opens a PDF with its own headers, and logs one view per open", async () => {
    const a = as(admin);
    const id = (await a.upload("/api/files/company/upload", `${TAG}-w9.pdf`, PDF)).json().id;
    const res = await a.get(`/api/files/company/files/${id}/view`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^inline;/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // exactly one policy, the view's own: helmet's is replaced, not merged, and never `sandbox`
    expect(res.headers["content-security-policy"]).toBe(PDF_POLICY);
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect((await recorded("firm_file.downloaded", id)).changes).toEqual({ via: "view" });

    // a download is the same event, saying so, and typed as its bytes are
    const download = await a.get(`/api/files/company/files/${id}`);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);
    const rows = await prisma.activityEvent.findMany({
      where: { action: "firm_file.downloaded", subjectId: id },
    });
    for (let attempt = 0; rows.length < 2 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows.splice(
        0,
        rows.length,
        ...(await prisma.activityEvent.findMany({
          where: { action: "firm_file.downloaded", subjectId: id },
        })),
      );
    }
    expect(rows.map((r) => r.changes)).toEqual(
      expect.arrayContaining([{ via: "view" }, { via: "download" }]),
    );
  });

  it("sandboxes images and text, and never opens anything else inline", async () => {
    const a = as(admin);
    const png = (await a.upload("/api/files/company/upload", `${TAG}-scan.png`, PNG)).json().id;
    const image = await a.get(`/api/files/company/files/${png}/view`);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-security-policy"]).toBe("sandbox");

    const txt = (
      await a.upload("/api/files/company/upload", `${TAG}-memo.txt`, Buffer.from("one\ntwo"))
    ).json().id;
    const text = await a.get(`/api/files/company/files/${txt}/view`);
    expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(text.headers["content-security-policy"]).toBe("sandbox");

    // an HTML page named .pdf stays a download, typed as nothing in particular
    const fake = (await a.upload("/api/files/company/upload", `${TAG}-fake.pdf`, HTML)).json()
      .id;
    expect((await a.get(`/api/files/company/files/${fake}/view`)).statusCode).toBe(400);
    expect(
      await prisma.activityEvent.count({
        where: { subjectId: fake, action: "firm_file.downloaded" },
      }),
    ).toBe(0);
    const download = await a.get(`/api/files/company/files/${fake}`);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);

    // no HEAD on a view: it would run the handler and log a view nobody made
    expect((await a.head(`/api/files/company/files/${png}/view`)).statusCode).toBe(404);
  });

  it("opens a client's file on the Clients gate, and an internal task's on its task's", async () => {
    const a = as(admin);
    const clientId = (await prisma.client.create({ data: { firstName: `${TAG} Viewed` } })).id;
    clientIds.push(clientId);
    const onClient = (
      await a.upload(`/api/files/clients/${clientId}/zones/internal/upload`, "1040.pdf", PDF)
    ).json().id;
    const view = await a.get(`/api/clients/${clientId}/files/${onClient}/view`);
    expect(view.statusCode).toBe(200);
    expect(view.headers["content-security-policy"]).toBe(PDF_POLICY);
    expect((await recorded("file.downloaded", onClient)).changes).toEqual({ via: "view" });

    const priorityId = (await prisma.priority.findFirstOrThrow()).id;
    const columnId = (await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } }))
      .id;
    const task = await prisma.task.create({
      data: { title: `${TAG} task`, priorityId, statusColumnId: columnId },
    });
    taskIds.push(task.id);
    const onTask = (await a.upload(`/api/tasks/${task.id}/files`, "receipt.png", PNG)).json()
      .id;
    // the card's own list says what its viewer can open
    const list = (await a.get(`/api/tasks/${task.id}/files`)).json() as {
      id: string;
      view: string | null;
    }[];
    expect(list.find((f) => f.id === onTask)?.view).toBe("image");
    const image = await a.get(`/api/tasks/${task.id}/files/${onTask}/view`);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-security-policy"]).toBe("sandbox");
    expect((await recorded("firm_file.downloaded", onTask)).changes).toEqual({ via: "view" });
  });

  it("types the files stored before, once, and leaves what names nothing as a download", async () => {
    const a = as(admin);
    const id = (await a.upload("/api/files/company/upload", `${TAG}-old.pdf`, PDF)).json().id;
    // as it was before stage C: no type read
    await prisma.file.update({ where: { id }, data: { detectedMime: null } });
    const first = await detectStoredTypes({ log: () => undefined });
    expect(first.typed).toBeGreaterThanOrEqual(1);
    expect((await prisma.file.findUniqueOrThrow({ where: { id } })).detectedMime).toBe(
      "application/pdf",
    );
    const second = await detectStoredTypes({ log: () => undefined });
    expect(second.typed).toBe(0);
  });
});
