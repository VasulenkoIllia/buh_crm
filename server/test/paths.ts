import { fileURLToPath } from "node:url";

/**
 * Where the suite's uploads land: its own directory, never the repository's `./uploads`, which is
 * the development server's. `vitest.config.ts` hands it to the tests as `UPLOADS_DIR`, and
 * `global-setup.ts` empties it at the start of every run. So it holds the last run's files and
 * nothing older: what a failed test wrote can still be read, and nothing piles up. It lives under
 * `node_modules/.cache`, beside the route log, because git, Docker, prettier and eslint all ignore
 * that already (2026-09-13).
 */
export const TEST_UPLOADS_DIR = fileURLToPath(
  new URL("../../node_modules/.cache/test-uploads", import.meta.url),
);
