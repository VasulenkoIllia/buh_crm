import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { TEST_UPLOADS_DIR } from "./paths.js";

const ADMIN_URL = "postgresql://buh_crm:buh_crm_dev@localhost:5432/buh_crm";
const TEST_DB = "buh_crm_test";
const TEST_URL = `postgresql://buh_crm:buh_crm_dev@localhost:5432/${TEST_DB}`;

/** Creates the test database (if missing) and applies migrations. */
export default async function globalSetup() {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    TEST_DB,
  ]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await client.end();

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: "pipe",
  });

  /**
   * Where every successful request writes which route it took and whether anything described it —
   * read afterwards by `server/test/check-activity-routes.ts`, which `npm run verify` runs after the
   * suite. Emptied here so a run only ever reports on itself. Inherited by the test workers, which
   * start after this returns (measured, 2026-09-10).
   */
  const routeLog = new URL("../../node_modules/.cache/activity-routes.jsonl", import.meta.url)
    .pathname;
  mkdirSync(dirname(routeLog), { recursive: true });
  writeFileSync(routeLog, "");
  process.env.ACTIVITY_ROUTE_LOG = routeLog;

  /**
   * The suite's uploads (`paths.ts`), emptied here rather than after the run: a run stopped with
   * Ctrl+C, or one that crashed, leaves only its own files, and a failed test's files can be read.
   */
  rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
  mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
}
