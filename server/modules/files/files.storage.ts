import { statfs } from "node:fs/promises";
import type { FirmStorage } from "@shared/schema/files.js";
import { firmStorage } from "./files.repository.js";

/**
 * **What the firm stores, and the disk it grows on** (files.md §4.4), for Settings → System.
 *
 * The files are counted from their rows, read when asked and never stored. The disk is the one the
 * app runs on, which on this server is the one the database and the backup mirror grow on too:
 * after stage A the files themselves are in the bucket, and those two are what can still fill it.
 * Free is what an ordinary process may still write (`bavail`), not what root may (`bfree`). The
 * bucket has no free-space figure; what the firm keeps there is the sum of its files.
 */
const DISK = "/";

export async function storageReport(): Promise<FirmStorage> {
  const [files, disk] = await Promise.all([firmStorage(), serverDisk()]);
  return { ...files, disk };
}

async function serverDisk(): Promise<FirmStorage["disk"]> {
  try {
    const s = await statfs(DISK);
    return { path: DISK, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch (error) {
    console.error("files: the server's disk could not be measured", error);
    return null;
  }
}
