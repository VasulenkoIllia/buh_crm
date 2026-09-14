import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeBucket } from "../test/fake-bucket.js";
import { prisma } from "./db.js";
import {
  ENVELOPE_OVERHEAD,
  createFileStore,
  localStore,
  type ByteStore,
  type FileBytes,
  type StoredFile,
} from "./files.js";
import { checkStoredFiles, filesToCheck, type CheckedFile } from "./storage-check.js";

/**
 * `files:storage-check` (files.md §14.4, §19): it must fail on a missing or a damaged object, tell a
 * key that does not open apart from a damaged file, and never name a file — its words reach a
 * screen and an email. Against a directory of its own and a bucket in memory.
 */

const document = Buffer.from("W-2 2025 · Петренко Олена · SSN 000-00-0000", "utf8");

let dir: string;
let disk: ByteStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "buh_crm-storage-check-test-"));
  disk = localStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stores() {
  const bucket = fakeBucket();
  return {
    bucket,
    onDisk: createFileStore({ local: disk, s3: bucket.store }, "local"),
    inBucket: createFileStore({ local: disk, s3: bucket.store }, "s3"),
  };
}

const checked = (stored: StoredFile, size = document.length): CheckedFile => ({
  ...stored,
  size,
});

const check = (files: CheckedFile[], read: (file: FileBytes) => Promise<Buffer>) =>
  checkStoredFiles({ pick: async () => files, read, log: () => {} });

describe("files:storage-check", () => {
  it("opens files sealed on disk and in the bucket, and one stored before encryption", async () => {
    const { onDisk, inBucket } = stores();
    const onTheDisk = checked(await onDisk.store(document));
    const inTheBucket = checked(await inBucket.store(document));
    await disk.put("2026-08/legacy.pdf", document);
    const legacy: CheckedFile = {
      id: randomUUID(),
      path: "2026-08/legacy.pdf",
      storage: "local",
      wrappedKey: null,
      keyVersion: null,
      size: document.length,
    };

    const note = await check([onTheDisk, inTheBucket, legacy], (f) => onDisk.read(f));

    expect(note).toMatch(/^3 stored files opened and matched their size /);
    expect(note).toContain("1 in the bucket, 2 on the server's disk");
    expect(note).toContain("1 stored before encryption, read as it was");
  });

  it("says so when nothing is stored yet", async () => {
    expect(await check([], vi.fn())).toBe("No files are stored yet.");
  });

  it("fails on a file missing from the bucket, counting it and never naming it", async () => {
    const { bucket, inBucket } = stores();
    const gone = checked(await inBucket.store(document));
    bucket.objects.delete(gone.path);

    const err = await check([gone], (f) => inBucket.read(f)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe("1 of 1 stored file could not be opened: 1 missing from the bucket.");
    expect(message).not.toContain(gone.id);
    expect(message).not.toContain(gone.path);
  });

  it("fails on a damaged object", async () => {
    const { bucket, inBucket } = stores();
    const damaged = checked(await inBucket.store(document));
    bucket.objects.get(damaged.path)![ENVELOPE_OVERHEAD] ^= 0xff;

    await expect(check([damaged], (f) => inBucket.read(f))).rejects.toThrow(
      /1 damaged in the bucket\.$/,
    );
  });

  it("tells a key this server cannot open apart from a damaged file", async () => {
    const { onDisk } = stores();
    const stored = checked(await onDisk.store(document));
    const otherKey = Buffer.from(stored.wrappedKey!);
    otherKey[otherKey.length - 1] ^= 0xff;

    await expect(
      check([{ ...stored, wrappedKey: otherKey }], (f) => onDisk.read(f)),
    ).rejects.toThrow(
      /1 not opened by this server's key\. Is SECRETS_KEY the one they were stored with\?$/,
    );
  });

  it("fails on a file that opens at another size than its row records", async () => {
    const { onDisk } = stores();
    const wrongSize = checked(await onDisk.store(document), document.length + 1);

    await expect(check([wrongSize], (f) => onDisk.read(f))).rejects.toThrow(
      /1 damaged on the server's disk\.$/,
    );
  });

  it("tells a bucket that does not answer apart from a missing file", async () => {
    const { inBucket } = stores();
    const stored = checked(await inBucket.store(document));
    const down = async (): Promise<Buffer> => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };

    await expect(check([stored], down)).rejects.toThrow(/1 unreadable in the bucket\.$/);
  });

  it("counts every failure of a night, not the first", async () => {
    const { bucket, inBucket, onDisk } = stores();
    const good = checked(await onDisk.store(document));
    const gone = checked(await inBucket.store(document));
    const alsoGone = checked(await inBucket.store(document));
    bucket.objects.delete(gone.path);
    bucket.objects.delete(alsoGone.path);

    await expect(check([good, gone, alsoGone], (f) => onDisk.read(f))).rejects.toThrow(
      "2 of 3 stored files could not be opened: 2 missing from the bucket.",
    );
  });
});

describe("tonight's files", () => {
  // The suite shares one database: these rows are dated in the future, so nothing else is newer,
  // and the test looks only at them.
  let uploader = "";
  const made: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        firstName: "Stor",
        lastName: "Age",
        email: `storage-${randomUUID()}@storage-check.local`,
        passwordHash: "never signs in",
        role: "user",
        status: "active",
      },
    });
    uploader = user.id;
  });

  afterAll(async () => {
    await prisma.file.deleteMany({ where: { id: { in: made } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@storage-check.local" } } });
  });

  it("takes the two newest and up to three more, each once", async () => {
    for (let i = 1; i <= 4; i++) {
      const row = await prisma.file.create({
        data: {
          name: `doc${i}.pdf`,
          size: 1,
          mime: "application/pdf",
          path: `2026-09/${randomUUID()}`,
          uploadedById: uploader,
          createdAt: new Date(Date.now() + i * 3_600_000),
        },
      });
      made.push(row.id);
    }

    const picked = await filesToCheck();

    expect(picked.length).toBeGreaterThanOrEqual(4);
    expect(picked.length).toBeLessThanOrEqual(5);
    expect(new Set(picked.map((f) => f.id)).size).toBe(picked.length);
    expect(picked.slice(0, 2).map((f) => f.id)).toEqual([made[3], made[2]]);
  });
});
