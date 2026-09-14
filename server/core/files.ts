import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { AppError, ValidationError } from "./errors.js";
import { openBytes, sealBytes, secretsConfigured } from "./secrets-crypto.js";

/**
 * The file storage boundary. Bytes live in a store, metadata in the File table, and every download
 * goes through the API with a permission check: there is no public directory and no presigned link,
 * so the check and `file.downloaded` always apply.
 *
 * **Every file is encrypted before it is stored**, wherever that is (files.md §14.4; owner,
 * 2026-09-13). Each gets its own AES-256-GCM key, the row's id is authenticated with it, and the
 * key is sealed with SECRETS_KEY into the row. The local store that development and the tests use
 * runs exactly the code production runs against the bucket.
 *
 * **Each row says where its bytes are** (`File.storage`), so `FILES_STORAGE` decides only where NEW
 * files go. A row written before encryption has no `wrappedKey` and is read as it was sent.
 */

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file (product decision)

/** Mirrors the `FileStorage` enum of the File table. */
export type FileStorage = "local" | "s3";

/** What a new File row records about its bytes: everything but the name, the size and the type. */
export interface StoredFile {
  id: string;
  path: string;
  storage: FileStorage;
  wrappedKey: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

/** What reading a file needs from its row. */
export interface FileBytes {
  id: string;
  path: string;
  storage: FileStorage;
  wrappedKey: Uint8Array | null;
  keyVersion: number | null;
}

/** What moving a file into the bucket needs from its row (files.md §15.0). */
export interface MovableFile extends FileBytes {
  createdAt: Date;
}

/** One place that keeps bytes under a key, a directory or a bucket. It knows nothing of encryption. */
export interface ByteStore {
  put(key: string, bytes: Buffer): Promise<void>;
  /** Refuses anything over `limit` bytes before reading it into memory. */
  get(key: string, limit: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(): AsyncIterable<{ key: string; size: number }>;
}

// ── the envelope ──────────────────────────────────────────────────────────────

const FORMAT_V1 = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = 1 + IV_BYTES;

/** What an encrypted object carries over the file itself: the format byte, the IV and the tag. */
export const ENVELOPE_OVERHEAD = HEADER_BYTES + TAG_BYTES;

/** Binds an object to its row: another row's object, swapped in, fails its tag. */
const authenticated = (fileId: string) => Buffer.from(`buh_crm/file/${fileId}`, "utf8");

function seal(plain: Buffer, fileId: string) {
  const fileKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", fileKey, iv);
  cipher.setAAD(authenticated(fileId));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const object = Buffer.concat([Buffer.from([FORMAT_V1]), iv, ciphertext, cipher.getAuthTag()]);
  const wrapped = sealBytes(fileKey);
  fileKey.fill(0);
  return {
    object,
    // one column for the sealed key: its IV, its tag, then the 32 sealed bytes
    wrappedKey: Buffer.concat([wrapped.iv, wrapped.authTag, wrapped.ciphertext]),
    keyVersion: wrapped.keyVersion,
  };
}

/**
 * Why a stored file would not open, for the one reader who acts on the difference: the nightly
 * storage check (core/storage-check.ts). `key`: its sealed key does not open with this server's
 * SECRETS_KEY, so every file stored under the other key is shut as well. `damaged`: the object
 * itself fails its tag, its format or its size.
 */
export class StoredFileError extends Error {
  readonly reason: "key" | "damaged";
  constructor(reason: "key" | "damaged", message: string) {
    super(message);
    this.name = "StoredFileError";
    this.reason = reason;
  }
}

function openFileKey(fileId: string, wrappedKey: Uint8Array, keyVersion: number): Buffer {
  const sealedKey = Buffer.from(wrappedKey);
  try {
    return openBytes({
      iv: sealedKey.subarray(0, IV_BYTES),
      authTag: sealedKey.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
      ciphertext: sealedKey.subarray(IV_BYTES + TAG_BYTES),
      keyVersion,
    });
  } catch {
    throw new StoredFileError(
      "key",
      `File ${fileId}: its key does not open with this server's SECRETS_KEY`,
    );
  }
}

function unseal(object: Buffer, fileId: string, wrappedKey: Uint8Array, keyVersion: number) {
  if (object.length < ENVELOPE_OVERHEAD || object[0] !== FORMAT_V1) {
    throw new StoredFileError(
      "damaged",
      `File ${fileId}: not an encrypted object this version can read`,
    );
  }
  const fileKey = openFileKey(fileId, wrappedKey, keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", fileKey, object.subarray(1, HEADER_BYTES));
    decipher.setAAD(authenticated(fileId));
    decipher.setAuthTag(object.subarray(object.length - TAG_BYTES));
    const body = object.subarray(HEADER_BYTES, object.length - TAG_BYTES);
    // final() checks the tag, and nothing reaches a caller before it has
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new StoredFileError("damaged", `File ${fileId}: the object fails its check`);
  } finally {
    fileKey.fill(0);
  }
}

// ── the stores ────────────────────────────────────────────────────────────────

/** An object larger than anything this code stores: tampered with, or not ours. Never read. */
const tooLarge = (key: string, size: number, limit: number) =>
  new StoredFileError(
    "damaged",
    `${key}: ${size} bytes, over the ${limit} a stored file can be`,
  );

/** A directory. Keys are relative paths, and none may leave the directory. */
export function localStore(root: string): ByteStore {
  const at = (key: string) => {
    const abs = resolve(root, key);
    // with a separator, so a sibling directory like `uploads-x` cannot pass
    if (!abs.startsWith(root + sep)) throw new ValidationError("Invalid file path");
    return abs;
  };
  return {
    async put(key, bytes) {
      const abs = at(key);
      await mkdir(resolve(abs, ".."), { recursive: true });
      await writeFile(abs, bytes);
    },
    // async, like the others: a key outside the directory is a rejected promise, never a sync throw
    async get(key, limit) {
      const abs = at(key);
      const { size } = await stat(abs);
      if (size > limit) throw tooLarge(key, size, limit);
      return readFile(abs);
    },
    async delete(key) {
      await rm(at(key), { force: true });
    },
    async *list() {
      // one level of YYYY-MM directories, then the files inside them
      for (const month of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!month.isDirectory()) continue;
        for (const entry of await readdir(join(root, month.name), { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const key = `${month.name}/${entry.name}`;
          yield { key, size: (await stat(at(key))).size };
        }
      }
    },
  };
}

/**
 * A bucket, through the subset of S3 the contract names (backups-hardening.md §7.8): put, get, a
 * plain delete, list. No `CopyObject`, no bulk delete, no ACL.
 */
export function s3Store(client: S3Client, bucket: string): ByteStore {
  return {
    async put(key, bytes) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          // ciphertext, and nothing about the object may say what the file is
          ContentType: "application/octet-stream",
        }),
      );
    },
    async get(key, limit) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!out.Body) throw new Error(`Object ${key} came back without a body`);
      if ((out.ContentLength ?? 0) > limit) {
        // never read into memory: nothing this size was written by this code
        (out.Body as unknown as { destroy?: () => void }).destroy?.();
        throw tooLarge(key, out.ContentLength ?? 0, limit);
      }
      const bytes = Buffer.from(await out.Body.transformToByteArray());
      if (bytes.length > limit) throw tooLarge(key, bytes.length, limit);
      return bytes;
    },
    async delete(key) {
      // a plain delete: the versioned bucket keeps the hidden version for 30 days (files.md §3.4)
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async *list() {
      let token: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        );
        for (const object of out.Contents ?? []) {
          if (object.Key) yield { key: object.Key, size: object.Size ?? 0 };
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
    },
  };
}

/** The files bucket, when this server has its settings; built without touching the network. */
function bucketFromConfig(): ByteStore | null {
  const endpoint = config.FILES_S3_ENDPOINT;
  const region = config.FILES_S3_REGION;
  const bucket = config.FILES_S3_BUCKET;
  const accessKeyId = config.FILES_S3_ACCESS_KEY_ID;
  const secretAccessKey = config.FILES_S3_SECRET_ACCESS_KEY;
  // a missing or malformed setting leaves the bucket off here; config.ts refuses it with s3
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (!URL.canParse(endpoint)) return null;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: config.FILES_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId, secretAccessKey },
    // since 2025 the SDK checksums every request by default, which S3-compatible stores have refused
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    // the SDK's own default is no timeout at all
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
  });
  return s3Store(client, bucket);
}

// ── the API ───────────────────────────────────────────────────────────────────

const unavailable = (message: string) => new AppError(503, "files_unavailable", message);

export function createFileStore(
  stores: { local: ByteStore; s3: ByteStore | null },
  writeTo: FileStorage,
) {
  const storeFor = (storage: FileStorage): ByteStore => {
    if (storage === "local") return stores.local;
    if (stores.s3) return stores.s3;
    throw unavailable(
      "This file is in the files bucket, and this server has no bucket configured",
    );
  };

  return {
    /** Encrypts and stores new bytes; the result goes onto the new File row as it is. */
    async store(bytes: Buffer): Promise<StoredFile> {
      if (bytes.byteLength > MAX_FILE_SIZE) {
        throw new ValidationError(`File exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
      }
      if (!secretsConfigured()) {
        throw unavailable(
          "Files cannot be stored: SECRETS_KEY is not configured on this server",
        );
      }
      const id = randomUUID();
      // the month keeps a directory listable; the id names the object, and no extension says what
      // it holds
      const path = `${new Date().toISOString().slice(0, 7)}/${id}`;
      const sealed = seal(bytes, id);
      await storeFor(writeTo).put(path, sealed.object);
      return {
        id,
        path,
        storage: writeTo,
        wrappedKey: sealed.wrappedKey,
        keyVersion: sealed.keyVersion,
      };
    },

    /** The file as it was uploaded. Refuses, rather than returns, bytes that fail their tag. */
    async read(file: FileBytes): Promise<Buffer> {
      // nothing larger was ever stored, so nothing larger is read into memory
      const bytes = await storeFor(file.storage).get(
        file.path,
        MAX_FILE_SIZE + ENVELOPE_OVERHEAD,
      );
      if (file.wrappedKey === null) return bytes; // stored before encryption, as it was sent
      if (file.keyVersion === null) {
        throw new Error(`File ${file.id}: a sealed key without its version`);
      }
      return unseal(bytes, file.id, file.wrappedKey, file.keyVersion);
    },

    async remove(file: Pick<FileBytes, "path" | "storage">): Promise<void> {
      await storeFor(file.storage).delete(file.path);
    },

    /**
     * Copies a file kept on disk into the bucket, and proves the copy before anything points at it
     * (files.md §15.0): read back from the bucket, opened, and compared with the file itself by
     * SHA-256. A file stored before encryption is sealed on the way, with a key of its own; an
     * encrypted one travels as it is. The result is what its row says from then on. Changing the
     * row is the caller's, and the file on disk stays until the directory is retired.
     *
     * The object gets the key a new file would, `YYYY-MM/<the row's id>`: an old path carried the
     * file's extension, and an object's name should say nothing of what it holds.
     */
    async copyToBucket(file: MovableFile): Promise<StoredFile> {
      if (file.storage !== "local") throw new Error(`File ${file.id} is not on disk`);
      const bucket = storeFor("s3");
      const onDisk = await stores.local.get(file.path, MAX_FILE_SIZE + ENVELOPE_OVERHEAD);

      let plain: Buffer;
      let sealed: { object: Buffer; wrappedKey: Uint8Array<ArrayBuffer>; keyVersion: number };
      if (file.wrappedKey === null) {
        if (!secretsConfigured()) {
          throw unavailable(
            "Files cannot be moved: SECRETS_KEY is not configured on this server",
          );
        }
        plain = onDisk;
        sealed = seal(onDisk, file.id);
      } else {
        if (file.keyVersion === null) {
          throw new Error(`File ${file.id}: a sealed key without its version`);
        }
        // opened here as well: a copy is only ever made of a file that still opens
        plain = unseal(onDisk, file.id, file.wrappedKey, file.keyVersion);
        sealed = {
          object: onDisk,
          wrappedKey: Buffer.from(file.wrappedKey),
          keyVersion: file.keyVersion,
        };
      }
      const path = file.path.endsWith(`/${file.id}`)
        ? file.path
        : `${file.createdAt.toISOString().slice(0, 7)}/${file.id}`;

      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
      await bucket.put(path, sealed.object);
      try {
        const back = await bucket.get(path, MAX_FILE_SIZE + ENVELOPE_OVERHEAD);
        const opened = unseal(back, file.id, sealed.wrappedKey, sealed.keyVersion);
        if (!digest(opened).equals(digest(plain))) {
          throw new Error(`File ${file.id}: the copy in the bucket is not the file on disk`);
        }
      } catch (err) {
        // nothing points at a copy that failed its proof; removing it is best effort
        await bucket.delete(path).catch(() => {});
        throw err;
      }
      return {
        id: file.id,
        path,
        storage: "s3",
        wrappedKey: sealed.wrappedKey,
        keyVersion: sealed.keyVersion,
      };
    },

    /**
     * Clears a file nothing points at any more: a replaced logo or avatar, a removed letterhead.
     * Best effort, because the act that freed it has already happened, and a store that refuses
     * must neither undo that nor skip its record. The bytes go first, so a failure leaves a row
     * nobody points at rather than bytes nobody can name, and the failure is logged, not swallowed.
     */
    async discard(file: FileBytes, deleteRow: (id: string) => Promise<unknown>, what: string) {
      try {
        await storeFor(file.storage).delete(file.path);
        await deleteRow(file.id);
      } catch (err) {
        console.error(`[files] the old ${what} (file ${file.id}) could not be cleared:`, err);
      }
    },

    list: (storage: FileStorage) => storeFor(storage).list(),
    has: (storage: FileStorage) => storage === "local" || stores.s3 !== null,
  };
}

const uploadsRoot = resolve(config.UPLOADS_DIR);
const files = createFileStore(
  { local: localStore(uploadsRoot), s3: bucketFromConfig() },
  config.FILES_STORAGE,
);

export async function ensureUploadsDir() {
  await mkdir(uploadsRoot, { recursive: true });
}

export const storeFile = (bytes: Buffer) => files.store(bytes);
export const readStoredFile = (file: FileBytes) => files.read(file);
export const deleteStoredFile = (file: Pick<FileBytes, "path" | "storage">) =>
  files.remove(file);
export const listStoredFiles = (storage: FileStorage) => files.list(storage);
export const storageConfigured = (storage: FileStorage) => files.has(storage);
export const copyFileToBucket = (file: MovableFile) => files.copyToBucket(file);
export type FileStore = ReturnType<typeof createFileStore>;
export const discardFile = (
  file: FileBytes,
  deleteRow: (id: string) => Promise<unknown>,
  what: string,
) => files.discard(file, deleteRow, what);
