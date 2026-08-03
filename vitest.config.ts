import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "src/**/*.test.ts?(x)"],
    environment: "node",
    globalSetup: "./server/test/global-setup.ts",
    fileParallelism: false, // integration tests share one test database
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://buh_crm:buh_crm_dev@localhost:5432/buh_crm_test",
      SESSION_SECRET: "test-session-secret-0123456789",
      // a fixed key so the secrets suite is deterministic; the real one lives in .env / the server
      SECRETS_KEY: "dGVzdC1zZWNyZXRzLWtleS0zMi1ieXRlcy1sb25nISE=",
      LOG_LEVEL: "silent",
    },
  },
});
