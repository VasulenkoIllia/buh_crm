import { execSync } from "node:child_process";
import { Client } from "pg";

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
}
