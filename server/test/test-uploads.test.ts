import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { config } from "../core/config.js";
import { TEST_UPLOADS_DIR } from "./paths.js";

/**
 * The suite used to leave every file it uploaded in the repository's `./uploads`, the development
 * server's directory: four more on every run (found 2026-09-13). This fails if `UPLOADS_DIR` ever
 * stops reaching the tests.
 */
describe("the suite's uploads", () => {
  it("land in their own directory, never the repository's ./uploads", () => {
    const repositoryUploads = fileURLToPath(new URL("../../uploads", import.meta.url));
    expect(resolve(config.UPLOADS_DIR)).toBe(TEST_UPLOADS_DIR);
    expect(resolve(config.UPLOADS_DIR)).not.toBe(repositoryUploads);
  });
});
