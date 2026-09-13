import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeBucket } from "../test/fake-bucket.js";
import { runWithActivity } from "./activity.js";
import { prisma } from "./db.js";
import { MOVE_LOCK, moveFilesToBucket, type MoveStore } from "./file-move.js";
import { ENVELOPE_OVERHEAD, createFileStore, localStore, type ByteStore } from "./files.js";

/**
 * Stage A's move (files.md §15.0, §19): against a directory of its own and a bucket in memory, and
 * only ever over the rows it made — the suite shares one database, and other files' rows are left
 * where they are.
 */

const document = Buffer.from("1099-NEC 2025 · Петренко Олена · TIN 00-0000000", "utf8");
const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

let dir: string;
let disk: ByteStore;
let uploaderId: string;
const made: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "buh_crm-move-test-"));
  disk = localStore(dir);
  const user = await prisma.user.create({
    data: {
      firstName: "Mo",
      lastName: "Ver",
      email: `mover-${randomUUID()}@move.local`,
      passwordHash: "never signs in",
      role: "user",
      status: "active",
    },
  });
  uploaderId = user.id;
});

beforeEach(async () => {
  await prisma.activityEvent.deleteMany({ where: { action: "file.bytes_moved" } });
});

afterAll(async () => {
  await prisma.file.deleteMany({ where: { id: { in: made } } });
  await prisma.activityEvent.deleteMany({ where: { action: "file.bytes_moved" } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@move.local" } } });
  await rm(dir, { recursive: true, force: true });
});

function setup(bucket = fakeBucket()) {
  return { bucket, store: createFileStore({ local: disk, s3: bucket.store }, "local") };
}

/** A file stored before encryption: as it was sent, under an old path with its extension. */
async function plainFile(bytes = document) {
  const path = `2026-08/${randomUUID()}.pdf`;
  await disk.put(path, bytes);
  const row = await prisma.file.create({
    data: {
      name: "1099.pdf",
      size: bytes.length,
      mime: "application/pdf",
      path,
      uploadedById: uploaderId,
      createdAt: new Date("2026-08-20T12:00:00Z"),
    },
  });
  made.push(row.id);
  return row;
}

/** A file stage A.1 stored: encrypted on disk, already under `YYYY-MM/<id>`. */
async function sealedFile(store: MoveStore & ReturnType<typeof createFileStore>, bytes = logo) {
  const stored = await store.store(bytes);
  const row = await prisma.file.create({
    data: {
      ...stored,
      name: "logo.png",
      size: bytes.length,
      mime: "image/png",
      uploadedById: uploaderId,
    },
  });
  made.push(row.id);
  return row;
}

const move = (store: MoveStore, only: string[], dryRun = false) =>
  runWithActivity({ actor: { kind: "system", label: "The move into the files bucket" } }, () =>
    moveFilesToBucket({ dryRun, store, only, log: () => {} }),
  );

const movedEvents = () =>
  prisma.activityEvent.findMany({ where: { action: "file.bytes_moved" } });

describe("the move into the bucket (files.md §15.0)", () => {
  it("a dry run reads every file and asks the bucket, and changes nothing", async () => {
    const { bucket, store } = setup();
    const plain = await plainFile();
    const sealed = await sealedFile(store);

    const summary = await move(store, [plain.id, sealed.id], true);

    expect(summary).toMatchObject({ found: 2, plain: 1, unreadable: 0, moved: 0 });
    expect(bucket.objects.size).toBe(0);
    expect(bucket.sent.some((c) => c instanceof ListObjectsV2Command)).toBe(true);
    const rows = await prisma.file.findMany({ where: { id: { in: [plain.id, sealed.id] } } });
    expect(rows.map((r) => r.storage)).toEqual(["local", "local"]);
    expect(await movedEvents()).toEqual([]);
  });

  it("moves both kinds, proves them, repoints their rows, and leaves the disk as it was", async () => {
    const { bucket, store } = setup();
    const plain = await plainFile();
    const sealed = await sealedFile(store);

    const summary = await move(store, [plain.id, sealed.id]);
    expect(summary).toMatchObject({
      found: 2,
      moved: 2,
      failed: 0,
      changed: 0,
      bytes: document.length + logo.length,
    });

    // stored before encryption: sealed on the way, under the key a new file would get
    const plainNow = await prisma.file.findUniqueOrThrow({ where: { id: plain.id } });
    expect(plainNow).toMatchObject({ storage: "s3", path: `2026-08/${plain.id}` });
    expect(plainNow.wrappedKey).not.toBeNull();
    const object = bucket.objects.get(plainNow.path)!;
    expect(object.length).toBe(document.length + ENVELOPE_OVERHEAD);
    expect(object.includes(document)).toBe(false);
    expect(await store.read(plainNow)).toEqual(document);

    // encrypted already: it travels as it is, under its own key and path
    const sealedNow = await prisma.file.findUniqueOrThrow({ where: { id: sealed.id } });
    expect(sealedNow).toMatchObject({
      storage: "s3",
      path: sealed.path,
      keyVersion: sealed.keyVersion,
    });
    expect(Buffer.from(sealedNow.wrappedKey!).equals(Buffer.from(sealed.wrappedKey!))).toBe(
      true,
    );
    expect(
      bucket.objects.get(sealed.path)!.equals(await readFile(join(dir, sealed.path))),
    ).toBe(true);
    expect(await store.read(sealedNow)).toEqual(logo);

    // the copies on disk stay until the directory is retired
    expect(await readFile(join(dir, plain.path))).toEqual(document);

    const events = await movedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorKind: "system", subject: "file" });
    expect(events[0]!.changes).toMatchObject({
      moved: 2,
      bytes: document.length + logo.length,
      failed: 0,
    });
  });

  it("finds nothing the second time, uploads nothing, and records nothing", async () => {
    const { bucket, store } = setup();
    const plain = await plainFile();
    await move(store, [plain.id]);
    const puts = bucket.sent.filter((c) => c instanceof PutObjectCommand).length;

    const again = await move(store, [plain.id]);

    expect(again).toMatchObject({ found: 0, moved: 0, failed: 0 });
    expect(bucket.sent.filter((c) => c instanceof PutObjectCommand)).toHaveLength(puts);
    expect(await movedEvents()).toHaveLength(1);
  });

  it("leaves a row untouched when the copy read back differs, and keeps no copy", async () => {
    const { bucket, store } = setup(fakeBucket({ damage: true }));
    const plain = await plainFile();

    const summary = await move(store, [plain.id]);

    expect(summary).toMatchObject({ found: 1, moved: 0, failed: 1 });
    const row = await prisma.file.findUniqueOrThrow({ where: { id: plain.id } });
    expect(row).toMatchObject({ storage: "local", path: plain.path, wrappedKey: null });
    expect(bucket.objects.size).toBe(0);
    expect(await store.read(row)).toEqual(document); // still read from the disk
    const events = await movedEvents();
    expect(events[0]!.changes).toMatchObject({ moved: 0, failed: 1 });
  });

  it("leaves a file it cannot read on disk, says so in a dry run, and moves the rest", async () => {
    const { store } = setup();
    const gone = await prisma.file.create({
      data: {
        name: "gone.pdf",
        size: 3,
        mime: "application/pdf",
        path: `2026-08/${randomUUID()}.pdf`,
        uploadedById: uploaderId,
      },
    });
    made.push(gone.id);
    const plain = await plainFile();

    expect(await move(store, [gone.id, plain.id], true)).toMatchObject({
      found: 2,
      unreadable: 1,
    });
    expect(await move(store, [gone.id, plain.id])).toMatchObject({ moved: 1, failed: 1 });
    const row = await prisma.file.findUniqueOrThrow({ where: { id: gone.id } });
    expect(row.storage).toBe("local");
  });

  it("keeps nothing of a file deleted while its copy was being made", async () => {
    const { bucket, store } = setup();
    const plain = await plainFile();
    const racing: MoveStore = {
      ...store,
      async copyToBucket(file) {
        const copy = await store.copyToBucket(file);
        await prisma.file.delete({ where: { id: file.id } }); // somebody deletes it just then
        return copy;
      },
    };

    const summary = await move(racing, [plain.id]);

    expect(summary).toMatchObject({ found: 1, moved: 0, changed: 1 });
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses to run beside another move, and runs once it is alone", async () => {
    const { store } = setup();
    const plain = await plainFile();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    // another move, holding the lock — `$executeRaw`, since the lock itself returns `void`
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${MOVE_LOCK}))`;
        taken();
        await released;
      },
      { timeout: 30_000 },
    );
    await lockTaken;
    try {
      await expect(move(store, [plain.id])).rejects.toThrow(/Another move is running/);
      const row = await prisma.file.findUniqueOrThrow({ where: { id: plain.id } });
      expect(row.storage).toBe("local");
    } finally {
      release();
      await other;
    }
    expect(await move(store, [plain.id])).toMatchObject({ moved: 1 });
  });

  it("refuses to start on a server with no bucket", async () => {
    const store = createFileStore({ local: disk, s3: null }, "local");
    await expect(move(store, [])).rejects.toThrow(/no files bucket/);
  });
});
