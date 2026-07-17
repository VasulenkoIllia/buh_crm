import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ValidationError } from "./errors.js";

// File storage boundary — bytes live on the uploads volume, metadata in the File
// table. All downloads go through the API with a permission check (no public static dir).

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file (product decision)

const uploadsRoot = resolve(config.UPLOADS_DIR);

export async function ensureUploadsDir() {
  await mkdir(uploadsRoot, { recursive: true });
}

/** Persists bytes; returns the relative path to store on the File row. */
export async function saveFileBytes(buffer: Buffer, originalName: string): Promise<string> {
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError(`File exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
  }
  const ext = originalName.includes(".") ? originalName.slice(originalName.lastIndexOf(".")) : "";
  const relPath = join(new Date().toISOString().slice(0, 7), `${randomUUID()}${ext}`);
  const absPath = join(uploadsRoot, relPath);
  await mkdir(resolve(absPath, ".."), { recursive: true });
  await writeFile(absPath, buffer);
  return relPath;
}

export function readFileStream(relPath: string) {
  const absPath = resolve(uploadsRoot, relPath);
  if (!absPath.startsWith(uploadsRoot)) {
    throw new ValidationError("Invalid file path");
  }
  return createReadStream(absPath);
}

export async function deleteFileBytes(relPath: string) {
  const absPath = resolve(uploadsRoot, relPath);
  if (!absPath.startsWith(uploadsRoot)) {
    throw new ValidationError("Invalid file path");
  }
  await rm(absPath, { force: true });
}
