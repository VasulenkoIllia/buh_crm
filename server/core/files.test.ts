import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ValidationError } from "./errors.js";
import {
  ENVELOPE_OVERHEAD,
  MAX_FILE_SIZE,
  createFileStore,
  localStore,
  s3Store,
  type ByteStore,
} from "./files.js";

/** A bucket in memory: it answers the four commands core/files.ts sends, and remembers them. */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const sent: unknown[] = [];
  const reads: string[] = []; // bodies read into memory
  const destroyed: string[] = []; // bodies dropped unread
  const client = {
    async send(command: unknown) {
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const bytes = objects.get(command.input.Key!);
        if (!bytes) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        const key = command.input.Key!;
        return {
          ContentLength: bytes.length,
          Body: {
            transformToByteArray: async () => {
              reads.push(key);
              return new Uint8Array(bytes);
            },
            destroy: () => destroyed.push(key),
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        // two keys a page, so a listing has to follow the continuation token
        const keys = [...objects.keys()].sort();
        const start = Number(command.input.ContinuationToken ?? 0);
        const next = start + 2 < keys.length ? String(start + 2) : undefined;
        return {
          Contents: keys
            .slice(start, start + 2)
            .map((Key) => ({ Key, Size: objects.get(Key)!.length })),
          IsTruncated: next !== undefined,
          NextContinuationToken: next,
        };
      }
      throw new Error("the fake bucket does not know this command");
    },
  };
  return {
    objects,
    sent,
    reads,
    destroyed,
    store: s3Store(client as unknown as S3Client, "files-bucket"),
  };
}

async function keysOf(store: ByteStore) {
  const keys: string[] = [];
  for await (const { key } of store.list()) keys.push(key);
  return keys;
}

const document = Buffer.from("W-2 2025 · Петренко Олена · SSN 000-00-0000", "utf8");
const legacy = (path: string) =>
  ({ id: randomUUID(), path, storage: "local", wrappedKey: null, keyVersion: null }) as const;

let dir: string;
let local: ByteStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "buh_crm-files-test-"));
  local = localStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("core/files: every file is encrypted before it is stored", () => {
  it("round-trips, and what is stored is not the file", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    expect(stored.storage).toBe("local");
    expect(stored.path).toBe(`${new Date().toISOString().slice(0, 7)}/${stored.id}`);
    const onDisk = await readFile(join(dir, stored.path));
    expect(onDisk.length).toBe(document.length + ENVELOPE_OVERHEAD);
    expect(onDisk.includes(document)).toBe(false);
    expect(onDisk.includes(Buffer.from("Петренко", "utf8"))).toBe(false);
    expect(await files.read(stored)).toEqual(document);
  });

  it("gives every file its own key, so the same document never looks the same twice", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const a = await files.store(document);
    const b = await files.store(document);
    expect(Buffer.from(a.wrappedKey).equals(Buffer.from(b.wrappedKey))).toBe(false);
    const bytesA = await readFile(join(dir, a.path));
    const bytesB = await readFile(join(dir, b.path));
    expect(bytesA.equals(bytesB)).toBe(false);
  });

  it("refuses an object whose bytes were changed", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    const onDisk = await readFile(join(dir, stored.path));
    onDisk[ENVELOPE_OVERHEAD] ^= 0xff; // a bit in the ciphertext
    await writeFile(join(dir, stored.path), onDisk);
    await expect(files.read(stored)).rejects.toThrow();
  });

  it("refuses another row's object: the id is authenticated", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    await expect(files.read({ ...stored, id: randomUUID() })).rejects.toThrow();
  });

  it("refuses a damaged sealed key", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    const damaged = Buffer.from(stored.wrappedKey);
    damaged[damaged.length - 1] ^= 0xff;
    await expect(files.read({ ...stored, wrappedKey: damaged })).rejects.toThrow();
  });

  it("reads a file stored before encryption as it was sent", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    await local.put("2026-08/legacy.pdf", document);
    expect(await files.read(legacy("2026-08/legacy.pdf"))).toEqual(document);
  });

  it("refuses a file over 25 MB and stores nothing", async () => {
    const empty = localStore(await mkdtemp(join(tmpdir(), "buh_crm-files-empty-")));
    const files = createFileStore({ local: empty, s3: null }, "local");
    await expect(files.store(Buffer.alloc(MAX_FILE_SIZE + 1))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await keysOf(empty)).toEqual([]);
  });

  it("deletes from the store the row names", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    await files.remove(stored);
    await expect(readFile(join(dir, stored.path))).rejects.toThrow();
  });

  it("keeps every key inside its directory", async () => {
    await expect(local.get("../outside", MAX_FILE_SIZE)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("core/files: the bucket", () => {
  it("stores new files in the bucket, encrypted, while local rows stay readable", async () => {
    const bucket = fakeBucket();
    const files = createFileStore({ local, s3: bucket.store }, "s3");
    await local.put("2026-08/old.txt", document);
    const stored = await files.store(document);
    expect(stored.storage).toBe("s3");
    expect(bucket.objects.get(stored.path)!.includes(document)).toBe(false);
    expect(await files.read(stored)).toEqual(document);
    expect(await files.read(legacy("2026-08/old.txt"))).toEqual(document);
  });

  it("sends what the contract says: the bucket, the key, the length, and no ACL", async () => {
    const bucket = fakeBucket();
    const files = createFileStore({ local, s3: bucket.store }, "s3");
    const stored = await files.store(document);
    const put = bucket.sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: "files-bucket",
      Key: stored.path,
      ContentLength: document.length + ENVELOPE_OVERHEAD,
      ContentType: "application/octet-stream",
    });
    expect(put.input.ACL).toBeUndefined();
  });

  it("lists every object across pages, and deletes one", async () => {
    const bucket = fakeBucket();
    const files = createFileStore({ local, s3: bucket.store }, "s3");
    const stored = [await files.store(document), await files.store(document)];
    await files.store(document);
    expect(await keysOf(bucket.store)).toHaveLength(3);
    expect(bucket.sent.filter((c) => c instanceof ListObjectsV2Command)).toHaveLength(2);
    await files.remove(stored[0]!);
    expect(await keysOf(bucket.store)).not.toContain(stored[0]!.path);
  });

  it("says so when a row is in the bucket and this server has none", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const row = {
      id: randomUUID(),
      path: "2026-09/x",
      storage: "s3",
      wrappedKey: new Uint8Array(60),
      keyVersion: 1,
    } as const;
    await expect(files.read(row)).rejects.toThrow(/no bucket configured/);
    expect(files.has("s3")).toBe(false);
  });

  it("drops an object larger than anything it stores without reading it", async () => {
    const bucket = fakeBucket();
    const files = createFileStore({ local, s3: bucket.store }, "s3");
    bucket.objects.set("2026-09/huge", Buffer.alloc(MAX_FILE_SIZE + ENVELOPE_OVERHEAD + 1));
    const row = { ...legacy("2026-09/huge"), storage: "s3" } as const;
    await expect(files.read(row)).rejects.toThrow(/over the/);
    expect(bucket.reads).not.toContain("2026-09/huge");
    expect(bucket.destroyed).toContain("2026-09/huge");
  });
});

describe("core/files: limits and leftovers", () => {
  it("refuses a local file larger than anything it stores", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    await local.put("2026-09/huge", Buffer.alloc(MAX_FILE_SIZE + ENVELOPE_OVERHEAD + 1));
    await expect(files.read(legacy("2026-09/huge"))).rejects.toThrow(/over the/);
  });

  it("clears a replaced file, bytes first and then its row", async () => {
    const files = createFileStore({ local, s3: null }, "local");
    const stored = await files.store(document);
    const rowsDeleted: string[] = [];
    await files.discard(stored, async (id) => rowsDeleted.push(id), "logo");
    expect(rowsDeleted).toEqual([stored.id]);
    await expect(readFile(join(dir, stored.path))).rejects.toThrow();
  });

  it("clears best effort: a refusing store neither throws nor loses the row", async () => {
    const refusing: ByteStore = {
      ...local,
      delete: async () => {
        throw new Error("the bucket is down");
      },
    };
    const files = createFileStore({ local: refusing, s3: null }, "local");
    const stored = await files.store(document);
    const rowsDeleted: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        files.discard(stored, async (id) => rowsDeleted.push(id), "logo"),
      ).resolves.toBeUndefined();
      expect(rowsDeleted).toEqual([]); // the row stays: nothing points at bytes that are gone
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });
});
